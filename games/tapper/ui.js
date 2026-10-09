import { CATEGORIES } from "./categories.js";
import {
  ABC,
  BOMB_OPTIONS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROUND_OPTIONS,
  TIMERS,
  afterBoom,
  checkDeadline,
  defaultSettings,
  enabledLetters,
  explode,
  freshState,
  isGameOver,
  isRunning,
  letterCountOk,
  movePlayer,
  normalizeSettings,
  otherCategory,
  pause,
  ranking,
  readSave,
  rejectTerm,
  replay,
  resumeTurn,
  scoreLabel,
  startTurn,
  tapLetter,
  uniqueCategories,
} from "./logic.js";
import { getAudioContext, isSoundEnabled, playTone, unlock } from "../../shared/sound.js";
import { get, set } from "../../shared/storage.js";
import { requestWakeLock } from "../../shared/wakelock.js";
import { initUpdates } from "../../shared/update.js";

const GAME_KEY = "kajuete:tapper";
const SETTINGS_KEY = "kajuete:tapper-settings";
const NAMES_KEY = "kajuete:tapper-names";
const CATS_KEY = "kajuete:tapper-kategorien";

let state = null;
let step = "players";
let names = get(NAMES_KEY, ["", ""]);
let draft = normalizeSettings(get(SETTINGS_KEY, defaultSettings()));
let customCats = uniqueCategories(get(CATS_KEY, []));
let bootNotice = null;
let showingResume = false;
let showingStandings = false;
let toastTimer = 0;
let tickTimer = 0;
let boomTimer = 0;
let deadlineTimer = 0;

const app = document.getElementById("app");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function pool() {
  return uniqueCategories([...CATEGORIES, ...customCats]);
}

function saveGame() {
  if (state && (state.phase === "play" || state.phase === "boom" || state.phase === "end")) set(GAME_KEY, state);
}

function saveNames() {
  set(NAMES_KEY, names.map((name) => String(name).trim()).filter(Boolean));
}

function toast(message) {
  document.querySelector(".toast")?.remove();
  const node = el("div", "toast", message);
  node.setAttribute("role", "status");
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 1600);
}

function backLink() {
  const link = el("a", "back");
  link.href = "../../index.html";
  const arrow = el("span", "", "←");
  arrow.setAttribute("aria-hidden", "true");
  link.append(arrow, document.createTextNode(" Zurück"));
  return link;
}

function confirmDialog(message, onYes) {
  const back = el("div", "dialog-back");
  const dialog = el("div", "dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.append(el("p", "", message));
  const yes = el("button", "btn primary", "Ja, neu beginnen");
  yes.type = "button";
  const no = el("button", "btn", "Abbrechen");
  no.type = "button";
  yes.addEventListener("click", () => {
    back.remove();
    onYes();
  });
  no.addEventListener("click", () => back.remove());
  dialog.append(yes, no);
  back.append(dialog);
  document.body.append(back);
  yes.focus();
}

function askNewGame() {
  if (state && (state.phase === "play" || state.phase === "boom")) {
    confirmDialog("Neues Spiel beginnen? Der laufende Spielstand wird gelöscht.", startFresh);
    return;
  }
  startFresh();
}

function startFresh() {
  stopTimers();
  showingStandings = false;
  showingResume = false;
  state = null;
  step = "players";
  set(GAME_KEY, null);
  render();
}

function readyNames() {
  return names.map((name) => String(name).trim()).filter(Boolean);
}

function allCategories() {
  return pool();
}

function stopTimers() {
  clearTimeout(deadlineTimer);
  clearInterval(tickTimer);
  deadlineTimer = 0;
  tickTimer = 0;
}

function armTimer() {
  stopTimers();
  if (!state || state.phase !== "play" || !state.started || state.paused || state.deadline == null) return;
  const wait = Math.max(0, state.deadline - Date.now());
  deadlineTimer = setTimeout(() => {
    const result = checkDeadline(state, Date.now());
    if (result.effect !== "boom") return;
    burst(result);
  }, wait);
  if (state.settings.tick) {
    tickTimer = setInterval(() => {
      if (!isSoundEnabled()) return;
      playTone({ frequency: 220, duration: 0.05, type: "sine", gain: 0.04 });
    }, 900);
  }
}

function burst(result) {
  stopTimers();
  state = result.state;
  saveGame();
  playBoom();
  render();
}

async function playBoom() {
  await unlock();
  if (!isSoundEnabled()) return;
  const ctx = getAudioContext();
  if (!ctx || ctx.state !== "running") return;
  try {
    const seconds = 0.55;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const noise = ctx.createBufferSource();
    const noiseGain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 900;
    noise.buffer = buffer;
    noiseGain.gain.setValueAtTime(0.28, ctx.currentTime);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + seconds);
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noise.start();
    noise.stop(ctx.currentTime + seconds);
    playTone({ frequency: 70, duration: 0.5, type: "sine", gain: 0.22 });
    setTimeout(() => playTone({ frequency: 48, duration: 0.35, type: "triangle", gain: 0.18 }), 80);
  } catch {
    playTone({ frequency: 80, duration: 0.4, type: "sawtooth", gain: 0.2 });
  }
}

function applyNames(next) {
  names = next;
  if (names.length < MIN_PLAYERS) names = names.concat(Array(MIN_PLAYERS - names.length).fill(""));
  if (names.length > MAX_PLAYERS) names = names.slice(0, MAX_PLAYERS);
  saveNames();
  render();
}

function renderPlayers() {
  const view = el("section", "screen setup");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  body.append(backLink());
  body.append(el("h1", "", "Tapper"));
  body.append(el("p", "lead", "Ein Handy in die Mitte. Wer dran ist, nennt einen Begriff und tippt den Anfangsbuchstaben."));
  if (bootNotice) body.append(el("p", "note is-bad", bootNotice));
  body.append(el("h2", "group-label", "Spieler in Sitzreihenfolge"));
  names.forEach((name, index) => {
    const row = el("div", "player-row");
    const input = document.createElement("input");
    input.className = "text-input";
    input.type = "text";
    input.maxLength = 18;
    input.placeholder = `Spieler ${index + 1}`;
    input.value = name;
    input.setAttribute("aria-label", `Name von Sitzplatz ${index + 1}`);
    input.addEventListener("input", () => {
      names[index] = input.value;
      saveNames();
    });
    const up = el("button", "btn", "↑");
    up.type = "button";
    up.disabled = index === 0;
    up.setAttribute("aria-label", "Nach oben");
    up.addEventListener("click", () => applyNames(movePlayer(names, index, -1)));
    const down = el("button", "btn", "↓");
    down.type = "button";
    down.disabled = index === names.length - 1;
    down.setAttribute("aria-label", "Nach unten");
    down.addEventListener("click", () => applyNames(movePlayer(names, index, 1)));
    const remove = el("button", "btn", "×");
    remove.type = "button";
    remove.disabled = names.length <= MIN_PLAYERS;
    remove.setAttribute("aria-label", "Entfernen");
    remove.addEventListener("click", () => applyNames(names.filter((_, i) => i !== index)));
    row.append(input, up, down, remove);
    body.append(row);
  });
  if (names.length < MAX_PLAYERS) {
    const add = el("button", "btn", "Spieler hinzufügen");
    add.type = "button";
    add.addEventListener("click", () => applyNames([...names, ""]));
    body.append(add);
  }
  const next = el("button", "btn primary", "Weiter");
  next.type = "button";
  next.addEventListener("click", () => {
    const filled = [...body.querySelectorAll(".player-row .text-input")]
      .map((field) => field.value.trim())
      .filter(Boolean);
    if (filled.length < MIN_PLAYERS) {
      toast("Mindestens zwei Namen eingeben.");
      return;
    }
    names = filled;
    saveNames();
    step = "settings";
    render();
  });
  dock.append(next);
  view.append(body, dock);
  app.replaceChildren(view);
}

function renderSettings() {
  const view = el("section", "screen setup");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  body.append(backLink());
  body.append(el("h1", "", "Einstellungen"));

  body.append(el("h2", "group-label", "Timer"));
  const timers = el("div", "choices");
  for (const timer of Object.values(TIMERS)) {
    const button = el("button", draft.timer === timer.id ? "choice is-on" : "choice");
    button.type = "button";
    button.append(el("strong", "", timer.label), el("small", "", `${timer.min}–${timer.max} Sekunden, unsichtbar`));
    button.addEventListener("click", () => {
      draft = { ...draft, timer: timer.id };
      render();
    });
    timers.append(button);
  }
  body.append(timers);

  body.append(el("h2", "group-label", "Punktesystem"));
  const bombs = el("button", draft.scoring === "bombs" ? "choice is-on" : "choice");
  bombs.type = "button";
  bombs.append(el("strong", "", "Bombenpunkte"), el("small", "", "Wer explodiert, bekommt 1 Punkt. Die wenigsten Punkte gewinnen."));
  bombs.addEventListener("click", () => {
    draft = { ...draft, scoring: "bombs" };
    render();
  });
  const live = el("button", draft.scoring === "survive" ? "choice is-on" : "choice");
  live.type = "button";
  live.append(el("strong", "", "Überleben"), el("small", "", "Alle außer dem Explodierten bekommen 1 Punkt. Die meisten Punkte gewinnen."));
  live.addEventListener("click", () => {
    draft = { ...draft, scoring: "survive", endMode: "rounds" };
    render();
  });
  body.append(bombs, live);

  body.append(el("h2", "group-label", "Spielende"));
  if (draft.scoring === "bombs") {
    const byRound = el("button", draft.endMode === "rounds" ? "choice is-on" : "choice");
    byRound.type = "button";
    byRound.append(el("strong", "", "Nach Runden"));
    byRound.addEventListener("click", () => {
      draft = { ...draft, endMode: "rounds" };
      render();
    });
    const byBombs = el("button", draft.endMode === "bombs" ? "choice is-on" : "choice");
    byBombs.type = "button";
    byBombs.append(el("strong", "", "Nach Bombenpunkten"));
    byBombs.addEventListener("click", () => {
      draft = { ...draft, endMode: "bombs" };
      render();
    });
    body.append(byRound, byBombs);
  }
  if (draft.scoring === "survive" || draft.endMode === "rounds") {
    const row = el("div", "btn-row");
    for (const count of ROUND_OPTIONS) {
      const button = el("button", draft.rounds === count ? "btn primary" : "btn", `${count} Runden`);
      button.type = "button";
      button.addEventListener("click", () => {
        draft = { ...draft, rounds: count };
        render();
      });
      row.append(button);
    }
    body.append(row);
  }
  if (draft.scoring === "bombs" && draft.endMode === "bombs") {
    const row = el("div", "btn-row");
    for (const count of BOMB_OPTIONS) {
      const button = el("button", draft.bombLimit === count ? "btn primary" : "btn", `${count} Bombenpunkte`);
      button.type = "button";
      button.addEventListener("click", () => {
        draft = { ...draft, bombLimit: count };
        render();
      });
      row.append(button);
    }
    body.append(row);
  }

  const tick = el("button", draft.tick ? "switch-row is-on" : "switch-row");
  tick.type = "button";
  tick.setAttribute("role", "switch");
  tick.setAttribute("aria-checked", draft.tick ? "true" : "false");
  tick.append(el("strong", "", "Leises Ticken"), el("small", "", draft.tick ? "An: leises Ticken während eines Zugs." : "Aus: völlig still, bis es knallt."));
  tick.addEventListener("click", () => {
    draft = { ...draft, tick: !draft.tick };
    render();
  });
  body.append(tick);

  body.append(el("h2", "group-label", "Buchstaben"));
  body.append(el("p", "lead", "Standard ohne C, Q, X und Y."));
  const toggles = el("div", "letter-toggles");
  for (const letter of ABC) {
    const button = el("button", draft.letters[letter] ? "letter-toggle is-on" : "letter-toggle", letter);
    button.type = "button";
    button.setAttribute("aria-pressed", draft.letters[letter] ? "true" : "false");
    button.addEventListener("click", () => {
      draft = { ...draft, letters: { ...draft.letters, [letter]: !draft.letters[letter] } };
      render();
    });
    toggles.append(button);
  }
  body.append(toggles);
  if (!letterCountOk(draft)) body.append(el("p", "note is-bad", "Mindestens einen Buchstaben einschalten."));

  body.append(el("h2", "group-label", "Eigene Kategorien"));
  const addRow = el("div", "preset");
  const input = document.createElement("input");
  input.className = "text-input";
  input.type = "text";
  input.maxLength = 48;
  input.placeholder = "Neue Kategorie";
  input.setAttribute("aria-label", "Eigene Kategorie");
  const add = el("button", "btn", "Hinzufügen");
  add.type = "button";
  add.addEventListener("click", () => {
    const name = input.value.trim();
    if (!name) {
      toast("Bitte eine Kategorie eingeben.");
      return;
    }
    customCats = uniqueCategories([name, ...customCats]);
    set(CATS_KEY, customCats);
    input.value = "";
    render();
  });
  addRow.append(input, add);
  body.append(addRow);
  for (const cat of customCats) {
    const row = el("div", "preset");
    row.append(el("span", "", cat));
    const del = el("button", "btn", "Löschen");
    del.type = "button";
    del.addEventListener("click", () => {
      customCats = customCats.filter((item) => item !== cat);
      set(CATS_KEY, customCats);
      render();
    });
    row.append(del);
    body.append(row);
  }

  const back = el("button", "btn", "Zu den Spielern");
  back.type = "button";
  back.addEventListener("click", () => {
    step = "players";
    render();
  });
  const go = el("button", "btn primary", "Los geht’s");
  go.type = "button";
  go.disabled = !letterCountOk(draft);
  go.addEventListener("click", () => {
    if (!letterCountOk(draft)) return;
    set(SETTINGS_KEY, draft);
    state = freshState(names, draft, allCategories());
    saveGame();
    render();
  });
  dock.append(go, back);
  view.append(body, dock);
  app.replaceChildren(view);
}

function renderPlay() {
  const view = el("section", "screen play");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  const bar = el("div", "play-bar");
  bar.append(backLink());
  const standingsBtn = el("button", "btn", "Stand");
  standingsBtn.type = "button";
  standingsBtn.addEventListener("click", () => {
    showingStandings = true;
    render();
  });
  const fresh = el("button", "btn", "Neues Spiel");
  fresh.type = "button";
  fresh.addEventListener("click", askNewGame);
  bar.append(el("span", "spacer"), standingsBtn, fresh);
  body.append(bar);
  const who = state.players[state.current];
  body.append(el("p", "who", who.name));
  body.append(el("p", "category", state.category));
  const hint = state.settings.endMode === "bombs" && state.settings.scoring === "bombs"
    ? `Runde ${state.round} · bis ${state.settings.bombLimit} Bombenpunkte`
    : `Runde ${state.round} von ${state.settings.rounds}`;
  body.append(el("p", "round-hint", hint));

  const grid = el("div", "letters");
  const active = enabledLetters(state.settings);
  for (const letter of active) {
    const locked = state.locked.includes(letter);
    const button = el("button", locked ? "letter is-locked" : "letter", letter);
    button.type = "button";
    button.disabled = locked || !state.started || state.paused;
    button.addEventListener("click", () => {
      const late = checkDeadline(state, Date.now());
      if (late.effect === "boom") {
        burst(late);
        return;
      }
      const tapped = tapLetter(state, letter, allCategories(), Date.now());
      if (tapped.effect === "ignore") return;
      state = tapped.state;
      saveGame();
      render();
    });
    grid.append(button);
  }
  body.append(grid);

  if (!state.started) {
    const other = el("button", "btn", "Andere Kategorie");
    other.type = "button";
    other.addEventListener("click", () => {
      state = otherCategory(state, allCategories());
      saveGame();
      render();
    });
    const start = el("button", "btn primary", "Start");
    start.type = "button";
    start.addEventListener("click", () => {
      state = startTurn(state, Date.now());
      saveGame();
      render();
      unlock();
    });
    dock.append(start, other);
  } else {
    const invalid = el("button", "btn", "Ungültig");
    invalid.type = "button";
    invalid.disabled = state.paused;
    invalid.addEventListener("click", () => {
      const late = checkDeadline(state, Date.now());
      if (late.effect === "boom") {
        burst(late);
        return;
      }
      const rejected = rejectTerm(state);
      if (rejected.effect !== "boom") return;
      burst(rejected);
    });
    const pauseBtn = el("button", "btn", "Pause");
    pauseBtn.type = "button";
    pauseBtn.disabled = state.paused;
    pauseBtn.addEventListener("click", () => {
      state = pause(state);
      saveGame();
      render();
    });
    const row = el("div", "btn-row");
    row.append(invalid, pauseBtn);
    dock.append(row);
  }

  view.append(body, dock);
  app.replaceChildren(view);
  if (state.paused) renderPause();
  if (showingStandings) renderStandings(false);
  armTimer();
}

function renderPause() {
  const back = el("div", "pause-back");
  const card = el("div", "dialog");
  card.append(el("strong", "", "Pausiert"));
  const go = el("button", "btn primary", "Weiter");
  go.type = "button";
  go.addEventListener("click", () => {
    state = resumeTurn(state, Date.now());
    saveGame();
    render();
    unlock();
  });
  card.append(go);
  back.append(card);
  app.append(back);
  go.focus();
}

function rankList(stateNow) {
  const list = el("ol", "rank");
  const label = scoreLabel(stateNow.settings);
  for (const row of ranking(stateNow)) {
    const item = el("li", row.winner ? "is-win" : "");
    item.append(el("span", "", row.name), el("span", "", `${row.score} ${label}`));
    list.append(item);
  }
  return list;
}

function renderStandings(fromButton) {
  const back = el("div", "standings-back");
  const dialog = el("div", "dialog");
  dialog.setAttribute("role", "dialog");
  dialog.append(el("h2", "", "Zwischenstand"));
  dialog.append(rankList(state));
  const close = el("button", "btn primary", "Schließen");
  close.type = "button";
  close.addEventListener("click", () => {
    showingStandings = false;
    back.remove();
    if (fromButton) render();
  });
  dialog.append(close);
  back.append(dialog);
  app.append(back);
}

function renderBoom() {
  const view = el("section", "screen");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  body.append(backLink());
  body.append(el("h1", "", "BUMM!"));
  body.append(el("p", "who", state.burst || state.players[state.current].name));
  body.append(el("p", "lead", isGameOver(state) ? "Das Spiel ist aus." : "Kurzer Zwischenstand"));
  body.append(rankList(state));
  const next = el("button", "btn primary", isGameOver(state) ? "Zur Rangliste" : "Nächste Runde");
  next.type = "button";
  next.addEventListener("click", () => {
    state = afterBoom(state, allCategories());
    saveGame();
    render();
  });
  dock.append(next);
  view.append(body, dock);
  const flash = el("div", "boom-back");
  const card = el("div", "boom-card");
  card.append(el("h1", "", "BUMM!"));
  card.append(el("p", "who", state.burst || ""));
  flash.append(card);
  flash.addEventListener("click", () => flash.remove());
  app.replaceChildren(view, flash);
  clearTimeout(boomTimer);
  boomTimer = setTimeout(() => flash.remove(), 1600);
}

function renderEnd() {
  const view = el("section", "screen");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  body.append(backLink());
  body.append(el("h1", "", "Ergebnis"));
  const winners = ranking(state).filter((row) => row.winner).map((row) => row.name);
  body.append(el("p", "lead", winners.length ? `Gewonnen: ${winners.join(", ")}` : "Unentschieden"));
  body.append(rankList(state));
  const again = el("button", "btn primary", "Nochmal");
  again.type = "button";
  again.addEventListener("click", () => {
    state = replay(state, allCategories());
    saveGame();
    render();
  });
  const hub = el("a", "btn", "Zum Hub");
  hub.href = "../../index.html";
  dock.append(again, hub);
  view.append(body, dock);
  app.replaceChildren(view);
}

function renderResume() {
  const view = el("section", "screen setup");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  body.append(backLink());
  body.append(el("h1", "", "Tapper"));
  body.append(el("p", "lead", "Es gibt ein angefangenes Spiel auf diesem Handy."));
  const resume = el("button", "btn primary", "Spiel fortsetzen");
  resume.type = "button";
  resume.addEventListener("click", () => {
    showingResume = false;
    render();
  });
  const fresh = el("button", "btn", "Neues Spiel");
  fresh.type = "button";
  fresh.addEventListener("click", startFresh);
  dock.append(resume, fresh);
  view.append(body, dock);
  app.replaceChildren(view);
}

function render() {
  document.body.classList.toggle("is-play", Boolean(state && state.phase === "play"));
  if (showingResume) {
    renderResume();
    return;
  }
  if (!state) {
    if (step === "settings") renderSettings();
    else renderPlayers();
    return;
  }
  if (state.phase === "play") renderPlay();
  else if (state.phase === "boom") renderBoom();
  else renderEnd();
}

function boot() {
  document.title = "Tapper – Kajütenspiele";
  requestWakeLock();
  initUpdates();
  if (!Array.isArray(names) || names.length < MIN_PLAYERS) names = ["", ""];
  const loaded = readSave(get(GAME_KEY, null));
  bootNotice = loaded.notice;
  if (loaded.notice) set(GAME_KEY, null);
  if (loaded.state) {
    state = loaded.state;
    names = state.players.map((player) => player.name);
    draft = normalizeSettings(state.settings);
    showingResume = true;
  }
  render();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  if (!state || state.phase !== "play" || !state.started || state.paused) return;
  state = pause(state);
  saveGame();
  render();
});
window.addEventListener("pagehide", saveGame);

boot();
