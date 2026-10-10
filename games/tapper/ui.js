import { CATEGORIES } from "./categories.js";
import {
  ABC,
  BOMB_OPTIONS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROUND_OPTIONS,
  TIMERS,
  FREE_LABEL,
  afterBoom,
  checkDeadline,
  continueFreeCategory,
  defaultSettings,
  dropPlayer,
  displayCategory,
  enabledLetters,
  freshState,
  isFreeMode,
  isGameOver,
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
  setFreeCategory,
  skipCurrent,
  startTurn,
  summarizeSettings,
  tapLetter,
  uniqueCategories,
  waitForHost,
  migrateState,
} from "./logic.js";
import { getAudioContext, isSoundEnabled, playTone, unlock } from "../../shared/sound.js";
import { get, set } from "../../shared/storage.js";
import { preserveScreenScroll } from "../../shared/scroll.js";
import { requestWakeLock } from "../../shared/wakelock.js";
import { initUpdates } from "../../shared/update.js";
import { layoutLetterRing } from "./ring.js";

const GAME_KEY = "kajuete:tapper";
const SETTINGS_KEY = "kajuete:tapper-settings";
const NAMES_KEY = "kajuete:tapper-names";
const CATS_KEY = "kajuete:tapper-kategorien";
const FREE_KEY = "kajuete:tapper-freie-kategorien";

let state = null;
let step = "mode";
let playMode = "local";
let names = get(NAMES_KEY, ["", ""]);
let draft = normalizeSettings(get(SETTINGS_KEY, defaultSettings()));
let customCats = uniqueCategories(get(CATS_KEY, []));
let freeSuggestions = uniqueCategories(get(FREE_KEY, [])).slice(0, 5);
let freeDraft = "";
let bootNotice = null;
let showingResume = false;
let showingStandings = false;
let showingRingMenu = false;
let toastTimer = 0;
let tickTimer = 0;
let boomTimer = 0;
let deadlineTimer = 0;
let onlineApi = null;
let lobbyHandle = null;
let onlineRoom = null;
let unsubRoom = null;
let unsubAction = null;
let unsubNet = null;
let unsubBadge = null;
let userPausedBeforeWait = false;
let lastTurnKey = "";
let enteringOnline = false;
let ringObserver = null;
let leavingUi = false;
let leftHandled = new Set();
let lobbyTools = null;

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

function isOnline() {
  return playMode === "online";
}

function iAmHost() {
  return isOnline() && Boolean(onlineApi?.isHost());
}

function myId() {
  return onlineApi?.getPlayerId?.() || null;
}

function isMyTurn(data = state) {
  if (!data?.players?.length) return false;
  if (!isOnline()) return true;
  return data.players[data.current]?.id === myId();
}

function hostPlayer() {
  return onlineRoom?.players?.find((player) => player.isHost) || null;
}

function hostMissing() {
  if (!isOnline() || !onlineRoom || iAmHost()) return false;
  if (state?.waitingForHost) return true;
  const host = hostPlayer();
  return Boolean(host) && host.online === false;
}

function currentSeatOnline() {
  if (!isOnline() || !state) return true;
  const seat = state.players[state.current];
  if (!seat) return true;
  const row = onlineRoom?.players?.find((player) => player.id === seat.id);
  return row ? row.online !== false : true;
}

function saveGame() {
  if (isOnline()) return;
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

function reportError(context, err) {
  console.error(`[tapper] ${context}`, err);
  toast(err?.message || "Etwas ist schiefgelaufen.");
}

function showOnlineCrash(err) {
  reportError("Online-Spiel", err);
  stopTimers();
  step = "play";
  const view = el("section", "screen setup");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  body.append(backLink());
  body.append(el("h1", "", "Verbindungsfehler"));
  body.append(el("p", "note is-bad", err?.message || "Das Spiel konnte nicht gestartet werden."));
  const back = el("button", "btn primary", "Zur Auswahl");
  back.type = "button";
  back.addEventListener("click", () => {
    leaveOnline().then(() => {
      playMode = "online";
      step = "mode";
      render();
    });
  });
  dock.append(back);
  view.append(body, dock);
  app.replaceChildren(view);
}

function backLink() {
  const link = el("a", "back");
  link.href = "../../index.html";
  const arrow = el("span", "", "←");
  arrow.setAttribute("aria-hidden", "true");
  link.append(arrow, document.createTextNode(" Zurück"));
  return link;
}

function vibrateTurn() {
  try {
    navigator.vibrate?.([80, 50, 160]);
  } catch {
    /* Desktop oder iOS */
  }
}

function vibrateBoom() {
  try {
    navigator.vibrate?.([200, 80, 280, 80, 420]);
  } catch {
    /* Desktop oder iOS */
  }
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
  if (isOnline()) {
    askLeaveRoom();
    return;
  }
  if (state && (state.phase === "play" || state.phase === "boom")) {
    confirmDialog("Neues Spiel beginnen? Der laufende Spielstand wird gelöscht.", startFresh);
    return;
  }
  startFresh();
}

function startFresh() {
  stopTimers();
  showingStandings = false;
  showingRingMenu = false;
  showingResume = false;
  state = null;
  step = "mode";
  playMode = "local";
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

function rememberFreeCategory(text) {
  const name = String(text || "").trim();
  if (!name || name === FREE_LABEL) return;
  freeSuggestions = uniqueCategories([name, ...freeSuggestions]).slice(0, 5);
  set(FREE_KEY, freeSuggestions);
}

function freeInputValue() {
  const current = String(state?.category || "").trim();
  if (freeDraft) return freeDraft;
  if (current && current !== FREE_LABEL) return current;
  return "";
}

function appendFreeCategoryForm(parent, options = {}) {
  const { title, onPick } = options;
  parent.append(el("p", "lead", title));
  const input = document.createElement("input");
  input.className = "text-input";
  input.type = "text";
  input.maxLength = 48;
  input.placeholder = "Optional eintippen";
  input.value = freeInputValue();
  input.setAttribute("aria-label", "Freie Kategorie");
  input.addEventListener("input", () => {
    freeDraft = input.value;
    if (!state || (state.started && !state.needCategory)) return;
    const next = setFreeCategory(state, freeDraft);
    if (next !== state) publishState(next, { silent: true });
    const label = document.querySelector(".category");
    if (label) label.textContent = displayCategory(next);
  });
  parent.append(input);
  if (freeSuggestions.length) {
    parent.append(el("p", "group-label", "Zuletzt"));
    const chips = el("div", "btn-row free-suggestions");
    for (const cat of freeSuggestions) {
      const chip = el("button", "btn", cat);
      chip.type = "button";
      chip.addEventListener("click", () => {
        freeDraft = cat;
        input.value = cat;
        input.dispatchEvent(new Event("input"));
        if (onPick) onPick(cat);
      });
      chips.append(chip);
    }
    parent.append(chips);
  }
  return input;
}

function maybeSignalTurn(next) {
  if (!isOnline() || !next || next.phase !== "play" || !next.started || next.paused || next.needCategory) return;
  if (!isMyTurn(next)) return;
  const key = `${next.round}:${next.current}:${next.locked.join("")}`;
  if (key === lastTurnKey) return;
  lastTurnKey = key;
  vibrateTurn();
}

async function publishState(next, options = {}) {
  const prevPhase = state?.phase;
  state = next;
  if (!isOnline()) saveGame();
  else if (iAmHost()) {
    try {
      await onlineApi.setState(next);
    } catch (err) {
      reportError("Zustand schreiben", err);
    }
  }
  if (prevPhase !== "boom" && next?.phase === "boom") {
    playBoom();
    if (isOnline()) vibrateBoom();
  }
  maybeSignalTurn(next);
  if (!options.silent) render();
}

function armTimer() {
  stopTimers();
  if (!state || state.phase !== "play" || !state.started || state.paused || state.needCategory || state.deadline == null) return;
  if (hostMissing()) return;
  const canExplode = !isOnline() || iAmHost();
  if (canExplode) {
    const wait = Math.max(0, state.deadline - Date.now());
    deadlineTimer = setTimeout(() => {
      const result = checkDeadline(state, Date.now());
      if (result.effect !== "boom") return;
      burst(result);
    }, wait);
  }
  if (state.settings.tick) {
    tickTimer = setInterval(() => {
      if (!isSoundEnabled()) return;
      playTone({ frequency: 220, duration: 0.05, type: "sine", gain: 0.04 });
    }, 900);
  }
}

function burst(result) {
  stopTimers();
  publishState(result.state);
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

function wantsOnline() {
  try {
    return Boolean(new URL(location.href).searchParams.get("join"));
  } catch {
    return false;
  }
}

function clearOnlineSubs() {
  if (unsubRoom) {
    unsubRoom();
    unsubRoom = null;
  }
  if (unsubAction) {
    unsubAction();
    unsubAction = null;
  }
  if (unsubNet) {
    unsubNet();
    unsubNet = null;
  }
  if (unsubBadge) {
    unsubBadge();
    unsubBadge = null;
  }
}

async function leaveOnline() {
  stopTimers();
  clearOnlineSubs();
  lobbyHandle?.destroy();
  lobbyHandle = null;
  enteringOnline = false;
  try {
    await onlineApi?.leaveRoom?.();
  } catch (err) {
    console.error("[tapper] Raum verlassen", err);
  }
  onlineRoom = null;
  state = null;
  lastTurnKey = "";
  leavingUi = false;
  leftHandled = new Set();
}

async function askLeaveRoom() {
  if (!onlineApi) return;
  if (!lobbyTools) lobbyTools = await import("../../shared/lobby.js");
  if (!(await lobbyTools.confirmRoomExit(iAmHost()))) return;
  leavingUi = true;
  try {
    if (iAmHost()) await onlineApi.closeRoom();
    else await onlineApi.leavePlay();
  } catch (err) {
    leavingUi = false;
    reportError("Verlassen", err);
    return;
  }
  await leaveOnline();
  playMode = "online";
  step = "mode";
  render();
}

function notePeerLeft(player) {
  if (!player?.id || leftHandled.has(player.id)) return;
  leftHandled.add(player.id);
  toast(`${player.name} hat den Raum verlassen`);
  if (!iAmHost() || !state) return;
  handlePeerLeft(player.id).catch((err) => reportError("Mitspieler weg", err));
}

async function handlePeerLeft(playerId) {
  if (!state || state.phase === "end") return;
  const next = dropPlayer(state, playerId);
  if (next === state) return;
  await publishState(next);
}

async function enterOnline() {
  if (enteringOnline && lobbyHandle) return;
  enteringOnline = true;
  playMode = "online";
  step = "lobby";
  showingResume = false;
  state = null;
  try {
    const [lobbyMod, api] = await Promise.all([
      import("../../shared/lobby.js"),
      import("../../shared/online.js"),
    ]);
    lobbyTools = lobbyMod;
    onlineApi = api;
    lobbyHandle?.destroy();
    lobbyHandle = lobbyMod.mountLobby(app, {
      gameId: "tapper",
      title: "Tapper",
      lead: "Zuerst den Raum, dann die Regeln. Mitspielen geht per Code.",
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      settingsPanel: {
        initial: draft,
        summarize: summarizeSettings,
        render(container, { settings: current, onChange }) {
          const paint = (settings) => {
            const top = container.parentElement?.closest(".screen-body")?.scrollTop ?? 0;
            container.innerHTML = "";
            appendSettingsControls(container, normalizeSettings(settings), (next) => {
              draft = next;
              set(SETTINGS_KEY, next);
              paint(next);
              onChange(next);
            });
            const scroller = container.parentElement?.closest(".screen-body");
            if (scroller) {
              scroller.scrollTop = top;
              requestAnimationFrame(() => {
                scroller.scrollTop = top;
              });
            }
          };
          paint(current);
        },
      },
      async onBeforeStart(room) {
        const players = room.players.slice(0, MAX_PLAYERS).map((player) => ({
          id: player.id,
          name: player.name,
        }));
        const rules = normalizeSettings(room.settings || draft);
        if (!letterCountOk(rules)) {
          throw new Error("Mindestens einen Buchstaben einschalten.");
        }
        const next = freshState(players, rules, allCategories());
        await onlineApi.setState(next);
        state = next;
      },
      onStart(room) {
        beginOnlinePlay(room);
      },
      onLeave() {
        lobbyHandle = null;
        enteringOnline = false;
        playMode = "online";
        step = "mode";
        render();
      },
    });
  } catch (err) {
    enteringOnline = false;
    step = "mode";
    reportError("Lobby", err);
    render();
  }
}

function beginOnlinePlay(room) {
  try {
    lobbyHandle?.destroy();
    lobbyHandle = null;
    enteringOnline = false;
    playMode = "online";
    step = "play";
    onlineRoom = room;
    const incoming = room?.state ? migrateState(room.state) : state;
    if (incoming) adoptOnlineState(incoming);
    clearOnlineSubs();
    unsubRoom = onlineApi.onRoomChange((next) => {
      if (leavingUi) return;
      if (onlineApi.isRoomGone(next)) {
        leavingUi = true;
        const msg = onlineApi.roomExitMessage(next);
        leaveOnline().then(() => {
          playMode = "online";
          step = "mode";
          toast(msg);
          render();
        });
        return;
      }
      for (const player of onlineApi.playersWhoLeft(onlineRoom, next)) notePeerLeft(player);
      onlineRoom = next;
      if (next.state) adoptOnlineState(next.state);
      else render();
    });
    unsubAction = onlineApi.onAction((action) => {
      handleOnlineAction(action).catch((err) => reportError("Aktion", err));
    });
    unsubNet = onlineApi.onConnectionChange((ok) => {
      if (iAmHost() && ok) recoverHostAfterAway().catch((err) => reportError("Host zurück", err));
      else render();
    });
    if (!state) render();
  } catch (err) {
    showOnlineCrash(err);
  }
}

function adoptOnlineState(next) {
  if (!next || typeof next !== "object") return;
  const incoming = migrateState(next);
  const prevPhase = state?.phase;
  state = incoming;
  if (prevPhase !== "boom" && incoming.phase === "boom") {
    playBoom();
    vibrateBoom();
  }
  maybeSignalTurn(incoming);
  render();
}

async function handleOnlineAction(action) {
  if (!iAmHost() || !state) return;
  if (action.type === "tap") {
    const late = checkDeadline(state, Date.now());
    if (late.effect === "boom") {
      burst(late);
      return;
    }
    const current = state.players[state.current];
    if (!current || action.from !== current.id) return;
    const tapped = tapLetter(state, action.payload?.letter, allCategories(), Date.now());
    if (tapped.effect === "ignore") return;
    if (tapped.effect === "need-category") freeDraft = "";
    await publishState(tapped.state);
    return;
  }
  if (action.type === "replay") {
    freeDraft = "";
    await publishState(replay(state, allCategories()));
    return;
  }
  if (action.type === "leave") {
    const who = state.players.find((player) => player.id === action.from);
    notePeerLeft({ id: action.from, name: action.payload?.name || who?.name || "Jemand" });
  }
}

async function recoverHostAfterAway() {
  if (!iAmHost() || !state || state.phase !== "play" || !state.started) return;
  if (state.needCategory) return;
  if (state.waitingForHost) {
    if (userPausedBeforeWait) {
      userPausedBeforeWait = false;
      await publishState({ ...state, waitingForHost: false, paused: true, deadline: null });
      return;
    }
    await publishState(resumeTurn(state, Date.now()));
    return;
  }
  if (!state.paused && state.deadline != null && Date.now() >= state.deadline) {
    await publishState(resumeTurn({ ...state, paused: true }, Date.now()));
  }
}

async function hostGoAway() {
  if (!iAmHost() || !state || state.phase !== "play" || !state.started || state.needCategory) return;
  userPausedBeforeWait = state.paused && !state.waitingForHost;
  const next = waitForHost(state);
  if (next !== state) await publishState(next);
}

async function onLetter(letter) {
  if (!state) return;
  if (isOnline() && !isMyTurn()) return;
  if (isOnline() && !iAmHost()) {
    try {
      await onlineApi.sendAction({ type: "tap", payload: { letter } });
    } catch (err) {
      reportError("Buchstabe senden", err);
    }
    return;
  }
  const late = checkDeadline(state, Date.now());
  if (late.effect === "boom") {
    burst(late);
    return;
  }
  const tapped = tapLetter(state, letter, allCategories(), Date.now());
  if (tapped.effect === "ignore") return;
  if (tapped.effect === "need-category") freeDraft = "";
  await publishState(tapped.state);
}

function renderMode() {
  const view = el("section", "screen setup");
  const body = el("div", "screen-body");
  body.append(backLink());
  body.append(el("h1", "", "Tapper"));
  body.append(el("p", "lead", "Wie wollt ihr spielen?"));
  if (bootNotice) body.append(el("p", "note is-bad", bootNotice));
  const localBtn = el("button", "choice", "");
  localBtn.type = "button";
  localBtn.append(el("strong", "", "Ein Handy (in die Mitte legen)"), el("small", "", "Ein Gerät in die Mitte. Wer dran ist, tippt den Buchstaben."));
  localBtn.addEventListener("click", () => {
    playMode = "local";
    step = "players";
    render();
  });
  const onlineBtn = el("button", "choice", "");
  onlineBtn.type = "button";
  onlineBtn.append(el("strong", "", "Online (mehrere Handys)"), el("small", "", "Jeder auf seinem Handy. Der Host steuert Timer und Regeln."));
  onlineBtn.addEventListener("click", () => {
    playMode = "online";
    enterOnline();
  });
  body.append(localBtn, onlineBtn);
  view.append(body);
  app.replaceChildren(view);
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
  const back = el("button", "btn", "Zur Auswahl");
  back.type = "button";
  back.addEventListener("click", () => {
    step = "mode";
    render();
  });
  dock.append(next, back);
  view.append(body, dock);
  app.replaceChildren(view);
}

function appendSettingsControls(parent, current, apply, options = {}) {
  if (options.showLayout) {
    parent.append(el("h2", "group-label", "Anordnung"));
    const ring = el("button", current.layout !== "grid" ? "choice is-on" : "choice");
    ring.type = "button";
    ring.append(el("strong", "", "Ring"), el("small", "", "Buchstaben am Rand. Handy flach in die Mitte legen."));
    ring.addEventListener("click", () => apply({ ...current, layout: "ring" }));
    const grid = el("button", current.layout === "grid" ? "choice is-on" : "choice");
    grid.type = "button";
    grid.append(el("strong", "", "Raster"), el("small", "", "Buchstaben als Gitter, wie bisher."));
    grid.addEventListener("click", () => apply({ ...current, layout: "grid" }));
    parent.append(ring, grid);
  }

  parent.append(el("h2", "group-label", "Timer"));
  const timers = el("div", "choices");
  for (const timer of Object.values(TIMERS)) {
    const button = el("button", current.timer === timer.id ? "choice is-on" : "choice");
    button.type = "button";
    button.append(el("strong", "", timer.label), el("small", "", `${timer.min}–${timer.max} Sekunden, unsichtbar`));
    button.addEventListener("click", () => apply({ ...current, timer: timer.id }));
    timers.append(button);
  }
  parent.append(timers);

  parent.append(el("h2", "group-label", "Punktesystem"));
  const bombs = el("button", current.scoring === "bombs" ? "choice is-on" : "choice");
  bombs.type = "button";
  bombs.append(el("strong", "", "Bombenpunkte"), el("small", "", "Wer explodiert, bekommt 1 Punkt. Die wenigsten Punkte gewinnen."));
  bombs.addEventListener("click", () => apply({ ...current, scoring: "bombs" }));
  const live = el("button", current.scoring === "survive" ? "choice is-on" : "choice");
  live.type = "button";
  live.append(el("strong", "", "Überleben"), el("small", "", "Alle außer dem Explodierten bekommen 1 Punkt. Die meisten Punkte gewinnen."));
  live.addEventListener("click", () => apply({ ...current, scoring: "survive", endMode: "rounds" }));
  parent.append(bombs, live);

  parent.append(el("h2", "group-label", "Kategorie"));
  const listMode = el("button", current.categoryMode === "list" ? "choice is-on" : "choice");
  listMode.type = "button";
  listMode.append(el("strong", "", "Zufällig aus Liste"), el("small", "", "Eingebaute und eigene Kategorien, keine Wiederholung."));
  listMode.addEventListener("click", () => apply({ ...current, categoryMode: "list" }));
  const freeMode = el("button", current.categoryMode === "free" ? "choice is-on" : "choice");
  freeMode.type = "button";
  freeMode.append(el("strong", "", "Frei (selbst absprechen)"), el("small", "", "Ihr einigt euch vor jeder Runde auf eine Kategorie."));
  freeMode.addEventListener("click", () => apply({ ...current, categoryMode: "free" }));
  parent.append(listMode, freeMode);

  parent.append(el("h2", "group-label", "Spielende"));
  if (current.scoring === "bombs") {
    const byRound = el("button", current.endMode === "rounds" ? "choice is-on" : "choice");
    byRound.type = "button";
    byRound.append(el("strong", "", "Nach Runden"));
    byRound.addEventListener("click", () => apply({ ...current, endMode: "rounds" }));
    const byBombs = el("button", current.endMode === "bombs" ? "choice is-on" : "choice");
    byBombs.type = "button";
    byBombs.append(el("strong", "", "Nach Bombenpunkten"));
    byBombs.addEventListener("click", () => apply({ ...current, endMode: "bombs" }));
    parent.append(byRound, byBombs);
  }
  if (current.scoring === "survive" || current.endMode === "rounds") {
    const row = el("div", "btn-row");
    for (const count of ROUND_OPTIONS) {
      const button = el("button", current.rounds === count ? "btn primary" : "btn", `${count} Runden`);
      button.type = "button";
      button.addEventListener("click", () => apply({ ...current, rounds: count }));
      row.append(button);
    }
    parent.append(row);
  }
  if (current.scoring === "bombs" && current.endMode === "bombs") {
    const row = el("div", "btn-row");
    for (const count of BOMB_OPTIONS) {
      const button = el("button", current.bombLimit === count ? "btn primary" : "btn", `${count} Bombenpunkte`);
      button.type = "button";
      button.addEventListener("click", () => apply({ ...current, bombLimit: count }));
      row.append(button);
    }
    parent.append(row);
  }

  const tick = el("button", current.tick ? "switch-row is-on" : "switch-row");
  tick.type = "button";
  tick.setAttribute("role", "switch");
  tick.setAttribute("aria-checked", current.tick ? "true" : "false");
  tick.append(el("strong", "", "Leises Ticken"), el("small", "", current.tick ? "An: leises Ticken während eines Zugs." : "Aus: völlig still, bis es knallt."));
  tick.addEventListener("click", () => apply({ ...current, tick: !current.tick }));
  parent.append(tick);

  parent.append(el("h2", "group-label", "Buchstaben"));
  parent.append(el("p", "lead", "Standard ohne C, Q, X und Y."));
  const toggles = el("div", "letter-toggles");
  for (const letter of ABC) {
    const button = el("button", current.letters[letter] ? "letter-toggle is-on" : "letter-toggle", letter);
    button.type = "button";
    button.setAttribute("aria-pressed", current.letters[letter] ? "true" : "false");
    button.addEventListener("click", () =>
      apply({ ...current, letters: { ...current.letters, [letter]: !current.letters[letter] } })
    );
    toggles.append(button);
  }
  parent.append(toggles);
  if (!letterCountOk(current)) parent.append(el("p", "note is-bad", "Mindestens einen Buchstaben einschalten."));

  if (current.categoryMode === "list") {
    parent.append(el("h2", "group-label", "Eigene Kategorien"));
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
      apply(current);
    });
    addRow.append(input, add);
    parent.append(addRow);
    for (const cat of customCats) {
      const row = el("div", "preset");
      row.append(el("span", "", cat));
      const del = el("button", "btn", "Löschen");
      del.type = "button";
      del.addEventListener("click", () => {
        customCats = customCats.filter((item) => item !== cat);
        set(CATS_KEY, customCats);
        apply(current);
      });
      row.append(del);
      parent.append(row);
    }
  }
}

function renderSettings() {
  const view = el("section", "screen setup");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  body.append(backLink());
  body.append(el("h1", "", "Einstellungen"));

  appendSettingsControls(
    body,
    draft,
    (next) => {
      draft = next;
      render();
    },
    { showLayout: true }
  );

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
    freeDraft = "";
    state = freshState(names, draft, allCategories());
    saveGame();
    render();
  });
  dock.append(go, back);
  view.append(body, dock);
  app.replaceChildren(view);
}

function useLetterRing() {
  return !isOnline() && state?.settings?.layout !== "grid";
}

function setRingLock(on) {
  document.documentElement.classList.toggle("tapper-ring", on);
  document.body.classList.toggle("tapper-ring", on);
  try {
    if (on) screen.orientation?.lock?.("portrait");
    else screen.orientation?.unlock?.();
  } catch {
    /* Lock nur in installierter App / Fullscreen */
  }
}

function stopRingLayout() {
  if (ringObserver) {
    ringObserver.disconnect();
    ringObserver = null;
  }
  setRingLock(false);
}

function bindRingLayout(stage, buttons, center) {
  if (ringObserver) {
    ringObserver.disconnect();
    ringObserver = null;
  }
  const place = () => layoutLetterRing(stage, buttons, center);
  place();
  requestAnimationFrame(place);
  if (typeof ResizeObserver !== "undefined") {
    ringObserver = new ResizeObserver(place);
    ringObserver.observe(stage);
  }
}

function letterButtons() {
  const nodes = [];
  const active = enabledLetters(state.settings);
  const lettersBlocked = !state.started || state.paused || state.needCategory || hostMissing();
  const canTap = !lettersBlocked && (!isOnline() || isMyTurn());
  for (const letter of active) {
    const locked = (state.locked || []).includes(letter);
    const last = state.lastLetter === letter;
    const watch = isOnline() && !isMyTurn() && !locked;
    const button = el(
      "button",
      `letter${locked ? " is-locked" : ""}${last ? " is-last" : ""}${watch ? " is-watch" : ""}`,
      letter
    );
    button.type = "button";
    button.disabled = locked || !canTap;
    button.addEventListener("click", () => onLetter(letter));
    nodes.push(button);
  }
  return nodes;
}

function roundHintText() {
  return state.settings.endMode === "bombs" && state.settings.scoring === "bombs"
    ? `Runde ${state.round} · bis ${state.settings.bombLimit} Bombenpunkte`
    : `Runde ${state.round} von ${state.settings.rounds}`;
}

function appendPlayActions(parent, options = {}) {
  const ring = options.ring === true;
  const who = state.players[state.current];
  const hostControls = !isOnline() || iAmHost();
  if (!state.started) {
    let freeField = null;
    if (isFreeMode(state.settings) && hostControls && !ring) {
      freeField = appendFreeCategoryForm(parent, {
        title: "Sprecht eine Kategorie ab",
      });
    } else if (isFreeMode(state.settings) && !hostControls) {
      parent.append(el("p", "lead", "Der Host legt die Kategorie fest."));
    }
    if (hostControls) {
      const start = el("button", ring ? "btn primary ring-start" : "btn primary", "Start");
      start.type = "button";
      start.addEventListener("click", () => {
        if (isFreeMode(state.settings)) {
          const typed = freeField ? freeField.value : freeDraft;
          rememberFreeCategory(typed);
          state = setFreeCategory(state, typed);
          freeDraft = "";
        }
        publishState(startTurn(state, Date.now()));
        unlock();
      });
      parent.append(start);
      if (!isFreeMode(state.settings)) {
        const other = el("button", ring ? "btn ring-other" : "btn", "Andere Kategorie");
        other.type = "button";
        other.addEventListener("click", () => {
          publishState(otherCategory(state, allCategories()));
        });
        parent.append(other);
      }
    } else if (!isFreeMode(state.settings)) {
      parent.append(el("p", "lead", "Warten auf den Host …"));
    }
    return;
  }
  if (state.needCategory) return;
  if (!hostControls) return;
  const pauseBtn = el("button", "btn", "Pause");
  pauseBtn.type = "button";
  pauseBtn.disabled = state.paused;
  pauseBtn.addEventListener("click", () => {
    publishState(pause(state));
  });
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
  const row = el("div", "btn-row");
  row.append(pauseBtn, invalid);
  parent.append(row);
  if (isOnline() && !currentSeatOnline() && !state.paused) {
    const skip = el("button", "btn", `${who?.name || "Spieler"} überspringen`);
    skip.type = "button";
    skip.addEventListener("click", () => {
      const result = skipCurrent(state, Date.now());
      if (result.effect === "ignore") return;
      publishState(result.state);
    });
    parent.append(skip);
  }
}

function finishPlayScreen() {
  if (hostMissing() && state.started) renderWaitHost();
  else if (state.needCategory) renderNeedCategory();
  else if (state.paused) renderPause();
  if (showingRingMenu) renderRingMenu();
  if (showingStandings) renderStandings(false);
  armTimer();
}

function renderPlayGrid() {
  const view = el("section", "screen play");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  const bar = el("div", "play-bar");
  bar.append(backLink());
  if (isOnline()) {
    const badge = el("div");
    if (unsubBadge) unsubBadge();
    unsubBadge = onlineApi.mountConnectionBadge(badge);
    bar.append(badge);
  }
  const standingsBtn = el("button", "btn", "Stand");
  standingsBtn.type = "button";
  standingsBtn.addEventListener("click", () => {
    showingStandings = true;
    render();
  });
  bar.append(el("span", "spacer"), standingsBtn);
  if (isOnline()) lobbyTools?.appendRoomMenu(bar, { isHost: iAmHost(), onExit: askLeaveRoom });
  else {
    const fresh = el("button", "btn", "Neues Spiel");
    fresh.type = "button";
    fresh.addEventListener("click", askNewGame);
    bar.append(fresh);
  }
  body.append(bar);

  const who = state.players[state.current];
  const myTurn = isOnline() && isMyTurn() && state.started && !state.paused && !state.needCategory && !hostMissing();
  if (myTurn) body.append(el("p", "your-turn", "DU BIST DRAN!"));
  body.append(el("p", "who", who?.name || "Spieler"));
  body.append(el("p", "category", displayCategory(state)));
  body.append(el("p", "round-hint", roundHintText()));

  const grid = el("div", "letters");
  for (const button of letterButtons()) grid.append(button);
  body.append(grid);
  appendPlayActions(dock);
  view.append(body, dock);
  app.replaceChildren(view);
  finishPlayScreen();
}

function renderRingMenu() {
  const back = el("div", "dialog-back ring-menu-back");
  const dialog = el("div", "dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.append(el("h2", "", "Menü"));
  const hub = backLink();
  hub.classList.add("btn");
  const standingsBtn = el("button", "btn", "Stand");
  standingsBtn.type = "button";
  standingsBtn.addEventListener("click", () => {
    showingRingMenu = false;
    showingStandings = true;
    render();
  });
  const fresh = el("button", "btn", isOnline() ? (iAmHost() ? "Raum schließen" : "Raum verlassen") : "Neues Spiel");
  fresh.type = "button";
  fresh.addEventListener("click", () => {
    showingRingMenu = false;
    askNewGame();
  });
  const close = el("button", "btn primary", "Schließen");
  close.type = "button";
  close.addEventListener("click", () => {
    showingRingMenu = false;
    back.remove();
  });
  dialog.append(hub, standingsBtn, fresh, close);
  back.addEventListener("click", (event) => {
    if (event.target !== back) return;
    showingRingMenu = false;
    back.remove();
  });
  back.append(dialog);
  app.append(back);
}

function renderPlayRing() {
  setRingLock(true);
  const view = el("section", "screen play play-ring");
  const stage = el("div", "ring-stage");
  const letters = letterButtons();
  for (const button of letters) stage.append(button);

  const center = el("div", "ring-center");
  const cat = displayCategory(state);
  const whoName = state.players[state.current]?.name || "Spieler";
  center.append(el("p", "category", cat));
  center.append(el("p", "who", whoName));
  center.append(el("p", "round-hint", roundHintText()));

  const menu = el("button", "btn ring-menu-btn", "⋯");
  menu.type = "button";
  menu.setAttribute("aria-label", "Menü");
  menu.addEventListener("click", () => {
    showingRingMenu = true;
    render();
  });
  center.append(menu);

  const actions = el("div", "ring-actions");
  appendPlayActions(actions, { ring: true });
  center.append(actions);
  center.append(el("p", "who is-flip", whoName));
  center.append(el("p", "category is-flip", cat));
  stage.append(center);
  view.append(stage);
  app.replaceChildren(view);
  bindRingLayout(stage, letters, center);
  finishPlayScreen();
}

function renderPlay() {
  if (useLetterRing()) renderPlayRing();
  else {
    stopRingLayout();
    renderPlayGrid();
  }
}

function renderWaitHost() {
  const back = el("div", "pause-back");
  const card = el("div", "dialog");
  card.append(el("strong", "", "Warte auf Host"));
  card.append(el("p", "lead", "Der Timer ist angehalten. Weiter geht’s, sobald der Host wieder da ist."));
  back.append(card);
  app.append(back);
}

function renderNeedCategory() {
  const back = el("div", "pause-back");
  const card = el("div", "dialog");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  if (isOnline() && !iAmHost()) {
    card.append(el("strong", "", "Neue Kategorie"));
    card.append(el("p", "lead", "Der Host legt die nächste freie Kategorie fest."));
    back.append(card);
    app.append(back);
    return;
  }
  const field = appendFreeCategoryForm(card, {
    title: "Alle Buchstaben weg – neue Kategorie absprechen",
  });
  const go = el("button", "btn primary", "Weiter");
  go.type = "button";
  go.addEventListener("click", () => {
    const typed = field.value;
    rememberFreeCategory(typed);
    freeDraft = "";
    publishState(continueFreeCategory(state, typed, Date.now()));
    unlock();
  });
  card.append(go);
  back.append(card);
  app.append(back);
  field.focus();
}

function renderPause() {
  const back = el("div", "pause-back");
  const card = el("div", "dialog");
  card.append(el("strong", "", "Pausiert"));
  if (!isOnline() || iAmHost()) {
    const go = el("button", "btn primary", "Weiter");
    go.type = "button";
    go.addEventListener("click", () => {
      publishState(resumeTurn(state, Date.now()));
      unlock();
    });
    card.append(go);
    back.append(card);
    app.append(back);
    go.focus();
    return;
  }
  card.append(el("p", "lead", "Der Host hat pausiert."));
  back.append(card);
  app.append(back);
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
  if (!isOnline() || iAmHost()) {
    const next = el("button", "btn primary", isGameOver(state) ? "Zur Rangliste" : "Nächste Runde");
    next.type = "button";
    next.addEventListener("click", () => {
      publishState(afterBoom(state, allCategories()));
    });
    dock.append(next);
  } else {
    dock.append(el("p", "lead", isGameOver(state) ? "Warten auf den Host …" : "Der Host startet die nächste Runde."));
  }
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
  const bar = el("div", "play-bar");
  bar.append(backLink());
  if (isOnline()) lobbyTools?.appendRoomMenu(bar, { isHost: iAmHost(), onExit: askLeaveRoom });
  body.append(bar);
  body.append(el("h1", "", "Ergebnis"));
  const winners = ranking(state).filter((row) => row.winner).map((row) => row.name);
  body.append(el("p", "lead", winners.length ? `Gewonnen: ${winners.join(", ")}` : "Unentschieden"));
  body.append(rankList(state));
  const again = el("button", "btn primary", "Nochmal");
  again.type = "button";
  again.addEventListener("click", async () => {
    if (isOnline() && !iAmHost()) {
      try {
        await onlineApi.sendAction({ type: "replay" });
      } catch (err) {
        reportError("Nochmal", err);
      }
      return;
    }
    freeDraft = "";
    publishState(replay(state, allCategories()));
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
  preserveScreenScroll(app, () => {
    document.body.classList.toggle("is-play", Boolean(state && state.phase === "play"));
    if (!(state && state.phase === "play" && useLetterRing())) stopRingLayout();
    if (unsubBadge && (step !== "play" || state?.phase !== "play")) {
      unsubBadge();
      unsubBadge = null;
    }
    if (step === "lobby") return;
    if (showingResume) {
      renderResume();
      return;
    }
    if (step === "play" && !state) {
      const view = el("section", "screen setup");
      const body = el("div", "screen-body");
      body.append(backLink());
      body.append(el("h1", "", "Tapper"));
      body.append(el("p", "note", "Warten auf den Host …"));
      view.append(body);
      app.replaceChildren(view);
      return;
    }
    if (!state) {
      if (step === "settings") renderSettings();
      else if (step === "players") renderPlayers();
      else renderMode();
      return;
    }
    if (state.phase === "play") renderPlay();
    else if (state.phase === "boom") renderBoom();
    else renderEnd();
  });
}

function boot() {
  document.title = "Tapper – Kajütenspiele";
  requestWakeLock();
  initUpdates();
  if (!Array.isArray(names) || names.length < MIN_PLAYERS) names = ["", ""];
  if (wantsOnline()) {
    playMode = "online";
    step = "lobby";
    enterOnline();
    return;
  }
  const loaded = readSave(get(GAME_KEY, null));
  bootNotice = loaded.notice;
  if (loaded.notice) set(GAME_KEY, null);
  if (loaded.state) {
    state = loaded.state;
    names = state.players.map((player) => player.name);
    draft = normalizeSettings(state.settings);
    showingResume = true;
    step = "players";
    playMode = "local";
  }
  render();
}

document.addEventListener("visibilitychange", () => {
  if (isOnline()) {
    if (!iAmHost()) return;
    if (document.visibilityState === "hidden") hostGoAway();
    else recoverHostAfterAway();
    return;
  }
  if (document.visibilityState !== "hidden") return;
  if (!state || state.phase !== "play" || !state.started || state.paused || state.needCategory) return;
  state = pause(state);
  saveGame();
  render();
});
window.addEventListener("pagehide", () => {
  if (isOnline() && iAmHost()) hostGoAway();
  else saveGame();
});

boot();
