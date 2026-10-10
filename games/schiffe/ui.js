import {
  SHAPES,
  allPlaced,
  assessFleet,
  beginBattle,
  beginPlacement,
  botKnowledge,
  commitSunk,
  coord,
  COLS,
  dealRandom,
  decodeRules,
  defaultCounts,
  encodeRules,
  fireAtBot,
  fireIncoming,
  formatCode,
  freshState,
  incomingShotStats,
  isRunning,
  liftAt,
  logText,
  markEnemy,
  MAX_COUNT,
  MAX_SIZE,
  MIN_SIZE,
  mirror,
  ownShotStats,
  placeSelected,
  previewAt,
  readMark,
  readSave,
  resetShips,
  rotate,
  rulesFor,
  selectShip,
  shapeBox,
  shipAt,
  sunkText,
  undo,
} from "./logic.js";
import { benchmarkBots, chooseShot } from "./bot.js";
import {
  applyReady,
  beginOnlineMatch,
  beginOnlineRematch,
  fireOnlineShot,
  migrateOnlineState,
  normalizeOnlineSettings,
  opponentId,
  shotStatsFor,
  summarizeOnlineSettings,
  viewAsPlayer,
} from "./online-state.js";
import { playTone, unlock } from "../../shared/sound.js";
import { get, set } from "../../shared/storage.js";
import { preserveScreenScroll } from "../../shared/scroll.js";
import { requestWakeLock } from "../../shared/wakelock.js";
import { initUpdates } from "../../shared/update.js";

const STORAGE_KEY = "kajuete:schiffe";
const BOT_KEY = "kajuete:schiffe-bot";
const PRESET_KEY = "kajuete:schiffe-vorlagen";
const STATS_KEY = "kajuete:schiffe-bot-stats";
const ONLINE_DRAFT_KEY = "kajuete:schiffe-online-draft";
const ROOM_SESSION_KEY = "kajuete:online-room";

const DIFFICULTIES = [
  ["easy", "Leicht", "Tippt eher zufällig."],
  ["medium", "Mittel", "Sucht Treffer nach und hält die Linie."],
  ["hard", "Schwer", "Rechnet wahrscheinliche Schiffslagen aus."],
];

const MODES = [
  ["classic", "Klassisch", "10×10 · 5, 4, 3, 3, 2"],
  ["paper", "Papier", "10×10 · 5, 4, 4, 3, 3, 3, 2, 2, 2, 2"],
  ["mixed", "Gemischt", "10×10 · gerade 5, L-Form, gerade 3, Winkel, zwei gerade 2"],
  ["custom", "Custom", "Eigene Feldgröße und Flotte"],
];

let state = freshState();
let draft = rulesFor("classic", false);
let customWidth = 10;
let customHeight = 10;
let customCounts = defaultCounts();
let playMode = null;
let difficulty = "medium";
let extraShot = true;
let pendingMenu = null;
let boardTab = "enemy";
let tabMode = false;
let tabLock = false;
let bootNotice = null;
let toastTimer = 0;
let announceTimer = 0;
let softStatus = null;
let fitToken = 0;
let botTimer = 0;
let botSeq = 0;
let flashCell = null;
let hotseatSave = null;
let botSave = null;
let onlineApi = null;
let lobbyHandle = null;
let onlineRoom = null;
let onlineState = null;
let unsubRoom = null;
let unsubAction = null;
let unsubNet = null;
let unsubBadge = null;
let enteringOnline = false;
let lastShotSeqSeen = 0;
let onlineBusy = false;
let lastOnlineTurn = null;

const app = document.getElementById("app");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function save() {
  if (isOnline()) {
    if (state?.phase === "place") saveOnlineDraft();
    return;
  }
  if (state.phase !== "place" && state.phase !== "battle" && state.phase !== "end") return;
  if (state.versus === "bot") set(BOT_KEY, state);
  else set(STORAGE_KEY, state);
}

function isBot() {
  return state.versus === "bot" || playMode === "bot";
}

function isOnline() {
  return playMode === "online" || state?.versus === "online" || onlineState?.versus === "online";
}

function iAmHost() {
  return isOnline() && Boolean(onlineApi?.isHost?.());
}

function myOnlineId() {
  return onlineApi?.getPlayerId?.() || null;
}

function reportError(context, err) {
  console.error(`[schiffe] ${context}`, err);
  toast(err?.message || "Etwas ist schiefgelaufen.");
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
  clearOnlineSubs();
  lobbyHandle?.destroy();
  lobbyHandle = null;
  enteringOnline = false;
  try {
    await onlineApi?.leaveRoom?.();
  } catch (err) {
    console.error("[schiffe] Raum verlassen", err);
  }
  onlineRoom = null;
  onlineState = null;
  lastShotSeqSeen = 0;
  softStatus = null;
  flashCell = null;
  set(ONLINE_DRAFT_KEY, null);
}

function opponentOnline() {
  if (!onlineRoom || !isOnline()) return true;
  const me = myOnlineId();
  const other = onlineRoom.players?.find((player) => player.id !== me);
  if (!other) return false;
  return other.online !== false;
}

function saveOnlineDraft() {
  if (!isOnline() || !state || state.phase !== "place") return;
  set(ONLINE_DRAFT_KEY, {
    room: onlineApi?.getRoomCode?.() || null,
    ships: state.ships,
  });
}

function adoptOnlineState(raw, options = {}) {
  const migrated = migrateOnlineState(raw);
  if (!migrated) return;
  onlineState = migrated;
  const me = myOnlineId();
  const view = viewAsPlayer(migrated, me);
  if (migrated.phase === "place" && !migrated.ready?.[me]) {
    const draftShips = get(ONLINE_DRAFT_KEY, null);
    if (draftShips?.room === onlineApi?.getRoomCode?.() && Array.isArray(draftShips.ships)) {
      view.ships = draftShips.ships;
      view.selectedId = view.ships.find((ship) => !ship.cells)?.id ?? view.ships[0]?.id ?? null;
    }
  }
  state = view;
  playMode = "online";
  if (migrated.rules) {
    draft = normalizeOnlineSettings({ ...migrated.rules, extraShot: migrated.extraShot });
    rememberCustom(draft);
    extraShot = draft.extraShot !== false;
  }
  if (!options.silent) {
    maybeAnnounceOnlineShot();
    render();
  }
}

async function publishOnlineState(next) {
  if (!iAmHost()) return;
  onlineBusy = true;
  try {
    await onlineApi.setState(next);
    onlineState = next;
    adoptOnlineState(next);
  } catch (err) {
    reportError("Zustand schreiben", err);
  } finally {
    onlineBusy = false;
  }
}

function maybeAnnounceOnlineShot() {
  if (!onlineState?.lastShot || onlineState.phase === "place") return;
  const shot = onlineState.lastShot;
  if (!shot.seq || shot.seq <= lastShotSeqSeen) return;
  lastShotSeqSeen = shot.seq;
  const me = myOnlineId();
  const asShooter = shot.shooterId === me;
  if (tabMode || wantsTabs()) boardTab = asShooter ? "enemy" : "own";
  requestAnimationFrame(() => {
    announceSoft(asShooter ? "Du" : "Gegner", shot.c, shot.r, shot.result, asShooter ? "enemy" : "own", () => {
      if (onlineState?.phase === "battle" && (tabMode || wantsTabs())) {
        boardTab = onlineState.turnPlayerId === me ? "enemy" : "own";
      }
      render();
    });
  });
}

function loadStats() {
  const data = get(STATS_KEY, null);
  const blank = () => ({ wins: 0, losses: 0 });
  const next = { easy: blank(), medium: blank(), hard: blank() };
  if (!data || typeof data !== "object") return next;
  for (const key of ["easy", "medium", "hard"]) {
    next[key].wins = Number(data[key]?.wins) || 0;
    next[key].losses = Number(data[key]?.losses) || 0;
  }
  return next;
}

function recordStats() {
  if (state.versus !== "bot" || state.statsRecorded || (state.outcome !== "won" && state.outcome !== "lost")) return;
  const stats = loadStats();
  const row = stats[state.difficulty] || stats.medium;
  if (state.outcome === "won") row.wins += 1;
  else row.losses += 1;
  set(STATS_KEY, stats);
  state = { ...state, statsRecorded: true };
  save();
}

function clearBotTimer() {
  botSeq += 1;
  if (botTimer) {
    clearTimeout(botTimer);
    botTimer = 0;
  }
}

function toast(message) {
  document.querySelector(".toast")?.remove();
  const node = el("div", "toast", message);
  node.setAttribute("role", "status");
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 1600);
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

function playResult(result) {
  if (result === "water") playTone({ frequency: 196, duration: 0.2, type: "sine" });
  else if (result === "hit") playTone({ frequency: 523, duration: 0.16, type: "square" });
  else {
    playTone({ frequency: 659, duration: 0.18, type: "triangle" });
    setTimeout(() => playTone({ frequency: 880, duration: 0.28, type: "triangle" }), 150);
  }
}

function showAnnounce(kind, title, sub, onClose) {
  document.querySelector(".announce")?.remove();
  clearTimeout(announceTimer);
  const overlay = el("div", `announce ${kind}`);
  overlay.setAttribute("role", "status");
  overlay.append(el("strong", "", title));
  if (sub) overlay.append(el("span", "", sub));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(announceTimer);
    overlay.remove();
    if (onClose) onClose();
  };
  overlay.addEventListener("click", close);
  document.body.append(overlay);
  announceTimer = setTimeout(close, 2000);
}

function backLink() {
  const link = el("a", "back");
  link.href = "../../index.html";
  const arrow = el("span", "", "←");
  arrow.setAttribute("aria-hidden", "true");
  link.append(arrow, document.createTextNode(" Zurück"));
  return link;
}

function codeLine(code, options = {}) {
  const wrap = el("div", "game-code-block");
  const line = el("p", "game-code");
  line.append(document.createTextNode("Spielcode "), el("strong", "", formatCode(code)));
  wrap.append(line);
  if (options.hint) {
    wrap.append(
      el(
        "p",
        "code-hint",
        "Beide müssen dieselben Einstellungen haben. Lies deinen Code vor – dein Mitspieler tippt ihn unter „Code vom Mitspieler eingeben“ ein."
      )
    );
  }
  return wrap;
}

function shapeIcon(shapeId, rotation = 0, mirrored = false, sunk = false) {
  const box = shapeBox(shapeId, rotation, mirrored);
  const icon = el("span", sunk ? "shape sunk" : "shape");
  icon.setAttribute("aria-hidden", "true");
  icon.style.gridTemplateColumns = `repeat(${box.w}, 7px)`;
  icon.style.gridTemplateRows = `repeat(${box.h}, 7px)`;
  const on = new Set(box.cells.map(([x, y]) => `${x},${y}`));
  for (let y = 0; y < box.h; y += 1) {
    for (let x = 0; x < box.w; x += 1) icon.append(el("i", on.has(`${x},${y}`) ? "on" : ""));
  }
  return icon;
}

function markType(mark) {
  return mark?.result || mark?.kind || null;
}

function ownSunk(ship) {
  return Boolean(
    ship.cells?.length &&
      ship.cells.every((cell) => {
        const type = markType(readMark(state.incoming, cell.c, cell.r));
        return type === "hit" || type === "sunk";
      })
  );
}

function askNewGame() {
  if (isOnline()) {
    confirmDialog(iAmHost() ? "Raum schließen und neu beginnen?" : "Raum verlassen und neu beginnen?", () => {
      leaveOnline().then(() => {
        playMode = null;
        state = freshState();
        render();
      });
    });
    return;
  }
  if (state.phase === "place" || state.phase === "battle") {
    confirmDialog("Neues Spiel beginnen? Der laufende Spielstand wird gelöscht.", startFresh);
    return;
  }
  startFresh();
}

function startFresh() {
  clearBotTimer();
  pendingMenu = null;
  flashCell = null;
  softStatus = null;
  boardTab = "enemy";
  bootNotice = null;
  if (isOnline()) {
    leaveOnline().then(() => {
      playMode = null;
      state = freshState();
      render();
    });
    return;
  }
  if (showingResume) {
    if (isRunning(hotseatSave)) set(STORAGE_KEY, freshState());
    if (isRunning(botSave)) set(BOT_KEY, freshState());
  } else if (state.versus === "bot" || playMode === "bot") set(BOT_KEY, freshState());
  else set(STORAGE_KEY, freshState());
  playMode = null;
  difficulty = "medium";
  extraShot = true;
  draft = rulesFor("classic", false);
  customWidth = 10;
  customHeight = 10;
  customCounts = defaultCounts();
  state = freshState();
  render();
}

function startRematch() {
  clearBotTimer();
  pendingMenu = null;
  flashCell = null;
  softStatus = null;
  boardTab = "enemy";
  playMode = "bot";
  difficulty = state.difficulty || "medium";
  extraShot = state.extraShot !== false;
  draft = {
    mode: state.rules.mode,
    width: state.rules.width,
    height: state.rules.height,
    allowTouch: !!state.rules.allowTouch,
    counts: { ...state.rules.counts },
  };
  rememberCustom(draft);
  state = beginPlacement(draft, { versus: "bot", difficulty, extraShot });
  save();
  render();
}

function rememberCustom(rules) {
  if (rules.mode !== "custom") return;
  customWidth = rules.width;
  customHeight = rules.height;
  customCounts = { ...rules.counts };
}

function loadPresets() {
  const data = get(PRESET_KEY, []);
  return Array.isArray(data) ? data.filter((item) => item && typeof item.name === "string" && item.rules) : [];
}

function applyDraft(rules) {
  draft = {
    mode: rules.mode,
    width: rules.width,
    height: rules.height,
    allowTouch: !!rules.allowTouch,
    counts: { ...defaultCounts(), ...rules.counts },
  };
  rememberCustom(draft);
}

function fleetRow(label, ships, own) {
  const row = el("div", own ? "fleet-row own" : "fleet-row");
  row.append(el("span", "fleet-label", label));
  const list = el("span", "mini-ships");
  for (const ship of ships) list.append(shapeIcon(ship.shapeId, 0, false, ship.sunk));
  row.append(list);
  return row;
}

function setGridVars() {
  document.documentElement.style.setProperty("--cols", String(state.width));
  document.documentElement.style.setProperty("--rows", String(state.height));
}

function makeGrid(kind) {
  const grid = el("div", "grid");
  grid.append(el("div", "corner"));
  for (let c = 0; c < state.width; c += 1) grid.append(el("div", "coord", COLS[c]));
  for (let r = 0; r < state.height; r += 1) {
    grid.append(el("div", "coord", String(r + 1)));
    for (let c = 0; c < state.width; c += 1) {
      const button = el("button", "cell");
      button.type = "button";
      button.dataset.c = String(c);
      button.dataset.r = String(r);
      grid.append(button);
    }
  }
  paintGrid(grid, kind);
  return grid;
}

function cellButton(grid, c, r) {
  return grid.querySelector(`.cell[data-c="${c}"][data-r="${r}"]`);
}

function paintGrid(grid, kind) {
  for (let r = 0; r < state.height; r += 1) {
    for (let c = 0; c < state.width; c += 1) {
      const button = cellButton(grid, c, r);
      button.className = "cell";
      const label = [`${kind === "enemy" ? "Gegner" : kind === "place" ? "Feld" : "Eigenes Feld"} ${coord(c, r)}`];
      if (kind === "place") {
        const ship = shipAt(state.ships, c, r);
        if (ship) {
          button.classList.add("ship");
          label.push(ship.name);
        }
      } else if (kind === "own" || kind === "reveal") {
        const ship = shipAt(state.ships, c, r);
        const mark = readMark(state.incoming, c, r);
        const type = markType(mark);
        if (ship) button.classList.add("ship");
        if (type === "water") {
          button.classList.add("mark-water");
          if (mark.auto) button.classList.add("auto");
          label.push(mark.auto ? "Wasser, automatisch" : "Wasser");
        } else if (type === "sunk" || (ship && ownSunk(ship) && type === "hit")) {
          button.classList.add("mark-sunk");
          label.push("Versenkt");
        } else if (type === "hit") {
          button.classList.add("mark-hit");
          label.push("Treffer");
        } else if (ship) label.push(ship.name);
      } else if (kind === "reveal-bot") {
        const ship = shipAt(state.botShips || [], c, r);
        const mark = readMark(state.enemy, c, r);
        const type = markType(mark);
        if (ship) {
          button.classList.add("ship");
          label.push(ship.name);
        }
        if (type === "water") {
          button.classList.add("mark-water");
          if (mark.auto) button.classList.add("auto");
          label.push("Wasser");
        } else if (type === "hit") {
          button.classList.add("mark-hit");
          label.push("Treffer");
        } else if (type === "sunk") {
          button.classList.add("mark-sunk");
          label.push("Versenkt");
        }
      } else {
        const mark = readMark(state.enemy, c, r);
        const type = markType(mark);
        if (type === "water") {
          button.classList.add("mark-water");
          if (mark.auto) button.classList.add("auto");
          label.push(mark.auto ? "Wasser, automatisch" : "Wasser");
        } else if (type === "hit") {
          button.classList.add("mark-hit");
          label.push("Treffer");
        } else if (type === "sunk") {
          button.classList.add("mark-sunk");
          label.push("Versenkt");
        }
        if (pendingMenu && pendingMenu.c === c && pendingMenu.r === r) button.classList.add("is-picked");
      }
      if (flashCell && flashCell.c === c && flashCell.r === r && (kind === "own" || kind === flashCell.board)) {
        button.classList.add("is-flash");
      }
      button.setAttribute("aria-label", label.join(", "));
    }
  }
}

function paintPreview(grid, c, r) {
  for (const button of grid.querySelectorAll(".cell")) button.classList.remove("preview-ok", "preview-bad");
  const preview = previewAt(state, c, r);
  if (!preview) return null;
  const className = preview.ok ? "preview-ok" : "preview-bad";
  for (const cell of preview.cells) cellButton(grid, cell.c, cell.r)?.classList.add(className);
  return preview;
}

function wantsTabs() {
  const availW = Math.min(window.innerWidth, 672) - 8;
  const availH = window.innerHeight - 210;
  const cell = Math.min((availW - 16) / state.width, (availH / 2 - 16) / state.height);
  return cell < 24;
}

function fitBoards() {
  const battle = document.querySelector(".battle");
  if (!battle) return;
  const status = battle.querySelector(".status");
  const tabs = battle.querySelector(".board-tabs");
  let chrome = (status?.offsetHeight || 0) + (tabs?.offsetHeight || 0) + 8;
  battle.querySelectorAll(".board-title").forEach((title) => {
    chrome += title.offsetHeight;
  });
  const boards = tabMode ? 1 : 2;
  const availW = battle.clientWidth;
  const availH = battle.clientHeight - chrome;
  let cell = Math.floor(Math.min((availW - 4) / state.width, availH / boards / state.height));
  let label = Math.max(12, Math.round(cell * 0.62));
  const fits = (size, labelSize) => size * state.width + labelSize <= availW && size * state.height + labelSize <= availH / boards;
  while (cell > 8 && !fits(cell, label)) {
    cell -= 1;
    label = Math.max(12, Math.round(cell * 0.62));
  }
  document.documentElement.style.setProperty("--cell", `${Math.max(8, cell)}px`);
  document.documentElement.style.setProperty("--label", `${label}px`);
  setGridVars();
}

function fitPlace(view) {
  setGridVars();
  const width = view.clientWidth - 8;
  const cell = Math.max(16, Math.min(46, Math.floor((width - 22) / state.width)));
  document.documentElement.style.setProperty("--cell", `${cell}px`);
  document.documentElement.style.setProperty("--label", "22px");
}

function scheduleFit(note, button) {
  const token = ++fitToken;
  const rules = draft;
  note.textContent = "Prüfe, ob die Flotte passt …";
  note.className = "note";
  button.disabled = true;
  setTimeout(() => {
    if (token !== fitToken) return;
    const result = assessFleet(rules);
    if (token !== fitToken) return;
    button.disabled = !result.ok;
    note.textContent = result.message || result.warning || "Die Flotte passt.";
    note.classList.toggle("is-bad", !result.ok);
    note.classList.toggle("is-warn", Boolean(result.ok && result.warning));
  }, 30);
}

function askCode() {
  const back = el("div", "dialog-back");
  const dialog = el("div", "dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.append(el("p", "", "Code vom Mitspieler eingeben"));
  const input = document.createElement("input");
  input.className = "text-input";
  input.type = "text";
  input.maxLength = 32;
  input.autocapitalize = "characters";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.enterKeyHint = "done";
  input.setAttribute("aria-label", "Code vom Mitspieler");
  const error = el("p", "note is-bad");
  error.hidden = true;
  const ok = el("button", "btn primary", "Übernehmen");
  ok.type = "button";
  const no = el("button", "btn", "Abbrechen");
  no.type = "button";
  const submit = () => {
    const decoded = decodeRules(input.value);
    if (decoded.error) {
      error.hidden = false;
      error.textContent = decoded.error;
      return;
    }
    applyDraft(decoded.rules);
    back.remove();
    render();
  };
  ok.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
  no.addEventListener("click", () => back.remove());
  dialog.append(input, error, ok, no);
  back.append(dialog);
  document.body.append(back);
  input.focus();
}

function askWhichShip(choice) {
  const back = el("div", "dialog-back");
  const dialog = el("div", "dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.append(el("h2", "", "Welches Schiff wurde versenkt?"));
  const list = el("div", "stack");
  for (const option of choice.options) {
    const button = el("button", "choice pick");
    button.type = "button";
    button.append(shapeIcon(option.shapeId), el("span", "", `${option.name} · ${option.size}`));
    button.addEventListener("click", () => {
      const result = commitSunk(state, choice.c, choice.r, option.index);
      back.remove();
      if (result.error) {
        toast(result.error);
        return;
      }
      state = result.state;
      save();
      render();
    });
    list.append(button);
  }
  const cancel = el("button", "btn", "Abbrechen");
  cancel.type = "button";
  cancel.addEventListener("click", () => back.remove());
  dialog.append(list, cancel);
  back.append(dialog);
  document.body.append(back);
}

function appendOnlineSettingsControls(parent, current, apply) {
  const choices = el("div", "choices");
  for (const [id, title, detail] of MODES) {
    const button = el("button", current.mode === id ? "choice is-on" : "choice");
    button.type = "button";
    button.append(el("strong", "", title), el("small", "", detail));
    button.addEventListener("click", () => {
      if (id === "custom") {
        apply(
          normalizeOnlineSettings({
            ...rulesFor("custom", current.allowTouch, {
              width: customWidth,
              height: customHeight,
              counts: customCounts,
            }),
            extraShot: current.extraShot,
          })
        );
      } else {
        apply(normalizeOnlineSettings({ ...rulesFor(id, current.allowTouch), extraShot: current.extraShot }));
      }
    });
    choices.append(button);
  }
  parent.append(choices);

  const touch = el("button", current.allowTouch ? "switch-row is-on" : "switch-row");
  touch.type = "button";
  touch.setAttribute("role", "switch");
  touch.setAttribute("aria-checked", current.allowTouch ? "true" : "false");
  touch.append(
    el("strong", "", "Schiffe dürfen sich berühren"),
    el("small", "", current.allowTouch ? "An: Kante an Kante und diagonal ok." : "Aus: Abstand, auch diagonal.")
  );
  touch.addEventListener("click", () => apply({ ...current, allowTouch: !current.allowTouch }));
  parent.append(touch);

  const again = el("button", current.extraShot ? "switch-row is-on" : "switch-row");
  again.type = "button";
  again.setAttribute("role", "switch");
  again.setAttribute("aria-checked", current.extraShot ? "true" : "false");
  again.append(
    el("strong", "", "Bei Treffer nochmal schießen"),
    el("small", "", current.extraShot ? "An: Nach Treffer oder Versenkt bleibt man dran." : "Aus: Immer abwechselnd.")
  );
  again.addEventListener("click", () => apply({ ...current, extraShot: !current.extraShot }));
  parent.append(again);

  if (current.mode === "custom") {
    const sizes = el("div", "stack");
    sizes.append(
      sizeStepper(
        "Breite",
        current.width,
        (value) => {
          customWidth = value;
          apply(
            normalizeOnlineSettings({
              ...rulesFor("custom", current.allowTouch, {
                width: customWidth,
                height: customHeight,
                counts: customCounts,
              }),
              extraShot: current.extraShot,
            })
          );
        },
        (value) => `${value} · A–${COLS[value - 1]}`
      )
    );
    sizes.append(
      sizeStepper(
        "Höhe",
        current.height,
        (value) => {
          customHeight = value;
          apply(
            normalizeOnlineSettings({
              ...rulesFor("custom", current.allowTouch, {
                width: customWidth,
                height: customHeight,
                counts: customCounts,
              }),
              extraShot: current.extraShot,
            })
          );
        },
        (value) => `${value} · 1–${value}`
      )
    );
    parent.append(sizes);
    parent.append(el("h2", "group-label", "Gerade"));
    for (const shape of SHAPES.filter((item) => item.form === "gerade")) {
      const count = current.counts[shape.id] || 0;
      const row = el("div", "counter");
      const minus = el("button", "btn", "−");
      minus.type = "button";
      minus.disabled = count <= 0;
      const plus = el("button", "btn", "+");
      plus.type = "button";
      plus.disabled = count >= MAX_COUNT;
      const change = (nextCount) => {
        customCounts = { ...customCounts, [shape.id]: nextCount };
        apply(
          normalizeOnlineSettings({
            ...rulesFor("custom", current.allowTouch, {
              width: customWidth,
              height: customHeight,
              counts: customCounts,
            }),
            extraShot: current.extraShot,
          })
        );
      };
      minus.addEventListener("click", () => change(count - 1));
      plus.addEventListener("click", () => change(count + 1));
      row.append(shapeIcon(shape.id), el("span", "counter-name", shape.name), minus, el("span", "counter-value", String(count)), plus);
      parent.append(row);
    }
    parent.append(el("h2", "group-label", "Gewinkelt"));
    for (const shape of SHAPES.filter((item) => item.form !== "gerade")) {
      const count = current.counts[shape.id] || 0;
      const row = el("div", "counter");
      const minus = el("button", "btn", "−");
      minus.type = "button";
      minus.disabled = count <= 0;
      const plus = el("button", "btn", "+");
      plus.type = "button";
      plus.disabled = count >= MAX_COUNT;
      const change = (nextCount) => {
        customCounts = { ...customCounts, [shape.id]: nextCount };
        apply(
          normalizeOnlineSettings({
            ...rulesFor("custom", current.allowTouch, {
              width: customWidth,
              height: customHeight,
              counts: customCounts,
            }),
            extraShot: current.extraShot,
          })
        );
      };
      minus.addEventListener("click", () => change(count - 1));
      plus.addEventListener("click", () => change(count + 1));
      row.append(shapeIcon(shape.id), el("span", "counter-name", shape.name), minus, el("span", "counter-value", String(count)), plus);
      parent.append(row);
    }
    for (const preset of loadPresets()) {
      const row = el("div", "preset");
      const load = el("button", "btn", preset.name);
      load.type = "button";
      load.addEventListener("click", () => {
        applyDraft(preset.rules);
        apply(normalizeOnlineSettings({ ...draft, extraShot: current.extraShot }));
      });
      row.append(load);
      parent.append(row);
    }
  } else {
    const preview = el("div", "mini-ships");
    for (const shape of SHAPES) {
      for (let i = 0; i < (current.counts[shape.id] || 0); i += 1) preview.append(shapeIcon(shape.id));
    }
    parent.append(preview);
  }
  const check = assessFleet(current);
  if (!check.ok) parent.append(el("p", "note is-bad", check.message || "Flotte passt nicht."));
  else if (check.warning) parent.append(el("p", "note", check.warning));
}

async function handleOnlineAction(action) {
  if (!iAmHost() || !onlineState) return;
  const type = action?.type;
  const from = action?.from;
  if (type === "ready") {
    const result = applyReady(onlineState, from, action.payload?.ships);
    if (result.error) {
      toast(result.error);
      return;
    }
    await publishOnlineState(result.state);
    return;
  }
  if (type === "shot") {
    const c = Number(action.payload?.c);
    const r = Number(action.payload?.r);
    const fired = fireOnlineShot(onlineState, from, c, r);
    if (fired.result === "ignore" || fired.result === "already") return;
    await publishOnlineState(fired.state);
    return;
  }
  if (type === "rematch") {
    if (onlineState.phase !== "end") return;
    const players = (onlineRoom?.players || []).map((player, index) => ({
      id: player.id,
      name: player.name,
      seat: index,
    }));
    const next = beginOnlineRematch(onlineState, players);
    lastShotSeqSeen = 0;
    softStatus = null;
    flashCell = null;
    set(ONLINE_DRAFT_KEY, null);
    await publishOnlineState(next);
  }
}

async function enterOnline() {
  if (enteringOnline && lobbyHandle) return;
  enteringOnline = true;
  playMode = "online";
  try {
    const [lobbyMod, api] = await Promise.all([
      import("../../shared/lobby.js"),
      import("../../shared/online.js"),
    ]);
    onlineApi = api;
    lobbyHandle?.destroy();
    const initial = normalizeOnlineSettings({
      ...draft,
      extraShot,
    });
    lobbyHandle = lobbyMod.mountLobby(app, {
      gameId: "schiffe",
      title: "Schiffe versenken",
      lead: "Genau zwei Spieler. Zuerst den Raum, dann die Regeln.",
      minPlayers: 2,
      maxPlayers: 2,
      settingsPanel: {
        initial,
        summarize: summarizeOnlineSettings,
        render(container, { settings: current, onChange }) {
          const paint = (settings) => {
            const top = container.parentElement?.closest(".screen-body")?.scrollTop ?? 0;
            container.innerHTML = "";
            appendOnlineSettingsControls(container, normalizeOnlineSettings(settings), (next) => {
              draft = next;
              extraShot = next.extraShot !== false;
              rememberCustom(next);
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
        const settings = normalizeOnlineSettings(room.settings || draft);
        const check = assessFleet(settings);
        if (!check.ok) throw new Error(check.message || "Flotte passt nicht aufs Feld.");
        const players = room.players.slice(0, 2);
        const next = beginOnlineMatch(players, settings);
        await onlineApi.setState(next);
        onlineState = next;
      },
      onStart(room) {
        beginOnlinePlay(room);
      },
      onLeave() {
        lobbyHandle = null;
        enteringOnline = false;
        playMode = null;
        state = freshState();
        render();
      },
    });
  } catch (err) {
    enteringOnline = false;
    playMode = null;
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
    onlineRoom = room;
    const incoming = room?.state ? migrateOnlineState(room.state) : onlineState;
    if (incoming) {
      lastShotSeqSeen = incoming.lastShot?.seq || 0;
      adoptOnlineState(incoming, { silent: true });
    }
    clearOnlineSubs();
    unsubRoom = onlineApi.onRoomChange((next) => {
      if (!next || next.status === "kicked") {
        const kicked = next?.status === "kicked";
        leaveOnline().then(() => {
          playMode = null;
          state = freshState();
          toast(kicked ? "Du wurdest entfernt." : "Der Raum wurde geschlossen.");
          render();
        });
        return;
      }
      onlineRoom = next;
      if (next.state) adoptOnlineState(next.state);
      else render();
    });
    unsubAction = onlineApi.onAction((action) => {
      handleOnlineAction(action).catch((err) => reportError("Aktion", err));
    });
    unsubNet = onlineApi.onConnectionChange(() => render());
    render();
  } catch (err) {
    reportError("Online-Spiel", err);
    leaveOnline().then(() => {
      playMode = null;
      state = freshState();
      render();
    });
  }
}

function renderVersus() {
  document.body.classList.remove("is-battle");
  const view = el("section", "screen setup");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  body.append(backLink());
  body.append(el("h1", "", "Schiffe versenken"));
  body.append(el("p", "lead", "Zu zweit am Tisch, online auf zwei Handys oder allein gegen den Bot."));
  if (bootNotice) body.append(el("p", "note is-warn", bootNotice));
  const hotseat = el("button", "choice", "");
  hotseat.type = "button";
  hotseat.append(
    el("strong", "", "Zu zweit am Tisch (Zurufen)"),
    el("small", "", "Zwei Handys, Schüsse werden zugerufen.")
  );
  hotseat.addEventListener("click", () => {
    playMode = "hotseat";
    render();
  });
  const bot = el("button", "choice", "");
  bot.type = "button";
  bot.append(el("strong", "", "Gegen Bot"), el("small", "", "Allein gegen den Computer."));
  bot.addEventListener("click", () => {
    playMode = "bot";
    render();
  });
  const online = el("button", "choice", "");
  online.type = "button";
  online.append(
    el("strong", "", "Online (zwei Handys)"),
    el("small", "", "Raum erstellen oder beitreten. Host prüft die Schüsse.")
  );
  online.addEventListener("click", () => {
    playMode = "online";
    enterOnline();
  });
  body.append(hotseat, bot, online);
  view.append(body, dock);
  app.replaceChildren(view);
}

function renderSettings() {
  document.body.classList.remove("is-battle");
  const view = el("section", "screen setup");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");

  body.append(backLink());
  body.append(el("h1", "", isBot() ? "Gegen Bot" : "Schiffe versenken"));
  body.append(el("p", "lead", isBot()
    ? "Gleiche Flotte wie zu zweit. Der Bot verteilt seine Schiffe versteckt."
    : "Jeder spielt auf dem eigenen Handy. Die Schüsse ruft ihr euch zu."));
  if (bootNotice) body.append(el("p", "note is-warn", bootNotice));

  if (isBot()) {
    body.append(el("h2", "group-label", "Schwierigkeit"));
    const diffs = el("div", "choices");
    for (const [id, title, detail] of DIFFICULTIES) {
      const button = el("button", difficulty === id ? "choice is-on" : "choice");
      button.type = "button";
      button.setAttribute("aria-pressed", difficulty === id ? "true" : "false");
      button.append(el("strong", "", title), el("small", "", detail));
      button.addEventListener("click", () => {
        difficulty = id;
        render();
      });
      diffs.append(button);
    }
    body.append(diffs);
    const again = el("button", extraShot ? "switch-row is-on" : "switch-row");
    again.type = "button";
    again.setAttribute("role", "switch");
    again.setAttribute("aria-checked", extraShot ? "true" : "false");
    again.append(
      el("strong", "", "Bei Treffer nochmal schießen"),
      el("small", "", extraShot ? "An: Nach Treffer oder Versenkt bleibt man dran." : "Aus: Immer abwechselnd.")
    );
    again.addEventListener("click", () => {
      extraShot = !extraShot;
      render();
    });
    body.append(again);
    const stats = loadStats();
    const statLine = el("p", "lead");
    statLine.textContent = DIFFICULTIES.map(([id, title]) => {
      const row = stats[id];
      return `${title} ${row.wins}–${row.losses}`;
    }).join(" · ");
    body.append(statLine);
  }

  const choices = el("div", "choices");
  for (const [id, title, detail] of MODES) {
    const button = el("button", draft.mode === id ? "choice is-on" : "choice");
    button.type = "button";
    button.setAttribute("aria-pressed", draft.mode === id ? "true" : "false");
    button.append(el("strong", "", title), el("small", "", detail));
    button.addEventListener("click", () => {
      if (id === "custom") draft = rulesFor("custom", draft.allowTouch, { width: customWidth, height: customHeight, counts: customCounts });
      else draft = rulesFor(id, draft.allowTouch);
      render();
    });
    choices.append(button);
  }

  const touch = el("button", draft.allowTouch ? "switch-row is-on" : "switch-row");
  touch.type = "button";
  touch.setAttribute("role", "switch");
  touch.setAttribute("aria-checked", draft.allowTouch ? "true" : "false");
  touch.append(
    el("strong", "", "Schiffe dürfen sich berühren"),
    el("small", "", draft.allowTouch
      ? "An: Schiffe dürfen Kante an Kante und diagonal liegen."
      : "Aus: Schiffe brauchen Abstand, auch diagonal.")
  );
  touch.addEventListener("click", () => {
    draft = { ...draft, allowTouch: !draft.allowTouch, counts: { ...draft.counts } };
    render();
  });

  body.append(choices, touch);
  if (!isBot() && !isOnline()) {
    body.append(codeLine(encodeRules(draft), { hint: true }));
    const codeButton = el("button", "btn", "Code vom Mitspieler eingeben");
    codeButton.type = "button";
    codeButton.addEventListener("click", askCode);
    body.append(codeButton);
  }

  if (draft.mode !== "custom") {
    const preview = el("div", "mini-ships");
    for (const shape of SHAPES) {
      for (let i = 0; i < (draft.counts[shape.id] || 0); i += 1) preview.append(shapeIcon(shape.id));
    }
    body.append(preview);
  } else {
    const sizes = el("div", "stack");
    sizes.append(sizeStepper("Breite", draft.width, (value) => {
      customWidth = value;
      draft = rulesFor("custom", draft.allowTouch, { width: customWidth, height: customHeight, counts: customCounts });
      render();
    }, (value) => `${value} · A–${COLS[value - 1]}`));
    sizes.append(sizeStepper("Höhe", draft.height, (value) => {
      customHeight = value;
      draft = rulesFor("custom", draft.allowTouch, { width: customWidth, height: customHeight, counts: customCounts });
      render();
    }, (value) => `${value} · 1–${value}`));
    body.append(sizes);

    body.append(el("h2", "group-label", "Gerade"));
    for (const shape of SHAPES.filter((item) => item.form === "gerade")) body.append(counter(shape));
    body.append(el("h2", "group-label", "Gewinkelt"));
    for (const shape of SHAPES.filter((item) => item.form !== "gerade")) body.append(counter(shape));

    const presetBox = el("div", "stack");
    presetBox.append(el("h2", "group-label", "Eigene Einstellungen"));
    const name = document.createElement("input");
    name.className = "text-input";
    name.type = "text";
    name.maxLength = 24;
    name.placeholder = "Name";
    name.setAttribute("aria-label", "Name der Vorlage");
    const savePreset = el("button", "btn", "Speichern");
    savePreset.type = "button";
    savePreset.addEventListener("click", () => {
      const title = name.value.trim();
      if (!title) {
        toast("Bitte einen Namen eingeben.");
        return;
      }
      const next = loadPresets().filter((item) => item.name !== title);
      next.unshift({ name: title, rules: draft });
      set(PRESET_KEY, next.slice(0, 20));
      toast("Gespeichert.");
      render();
    });
    presetBox.append(name, savePreset);
    for (const preset of loadPresets()) {
      const row = el("div", "preset");
      const load = el("button", "btn", preset.name);
      load.type = "button";
      load.addEventListener("click", () => {
        applyDraft(preset.rules);
        render();
      });
      const remove = el("button", "btn", "Löschen");
      remove.type = "button";
      remove.addEventListener("click", () => {
        set(PRESET_KEY, loadPresets().filter((item) => item.name !== preset.name));
        render();
      });
      row.append(load, remove);
      presetBox.append(row);
    }
    body.append(presetBox);
  }

  const note = el("p", "note", "Prüfe, ob die Flotte passt …");
  const next = el("button", "btn primary", "Weiter");
  next.type = "button";
  next.disabled = true;
  next.addEventListener("click", () => {
    if (next.disabled) return;
    boardTab = "enemy";
    state = beginPlacement(draft, isBot() ? { versus: "bot", difficulty, extraShot } : null);
    save();
    render();
  });
  dock.append(note, next);
  view.append(body, dock);
  app.replaceChildren(view);
  scheduleFit(note, next);
}

function sizeStepper(label, value, onChange, text) {
  const row = el("div", "stepper");
  const minus = el("button", "btn", "−");
  minus.type = "button";
  minus.disabled = value <= MIN_SIZE;
  minus.setAttribute("aria-label", `${label} verkleinern`);
  minus.addEventListener("click", () => onChange(value - 1));
  const plus = el("button", "btn", "+");
  plus.type = "button";
  plus.disabled = value >= MAX_SIZE;
  plus.setAttribute("aria-label", `${label} vergrößern`);
  plus.addEventListener("click", () => onChange(value + 1));
  row.append(minus, el("span", "", `${label} ${text(value)}`), plus);
  return row;
}

function counter(shape) {
  const count = draft.counts[shape.id] || 0;
  const row = el("div", "counter");
  const minus = el("button", "btn", "−");
  minus.type = "button";
  minus.disabled = count <= 0;
  minus.setAttribute("aria-label", `${shape.name} weniger`);
  const plus = el("button", "btn", "+");
  plus.type = "button";
  plus.disabled = count >= MAX_COUNT;
  plus.setAttribute("aria-label", `${shape.name} mehr`);
  const change = (next) => {
    customCounts = { ...customCounts, [shape.id]: next };
    draft = rulesFor("custom", draft.allowTouch, { width: customWidth, height: customHeight, counts: customCounts });
    render();
  };
  minus.addEventListener("click", () => change(count - 1));
  plus.addEventListener("click", () => change(count + 1));
  row.append(shapeIcon(shape.id), el("span", "counter-name", shape.name), minus, el("span", "counter-value", String(count)), plus);
  return row;
}

function renderPlace() {
  document.body.classList.remove("is-battle");
  const view = el("section", "place");
  const bar = el("div", "battle-bar");
  bar.append(backLink());
  const fresh = el("button", "btn", "Neues Spiel");
  fresh.type = "button";
  fresh.addEventListener("click", askNewGame);
  bar.append(el("span", "spacer"), fresh);
  view.append(bar);
  view.append(el("h1", "", "Schiffe legen"));
  if (isOnline()) {
    const me = myOnlineId();
    const other = opponentId(onlineState || state, me);
    const iReady = Boolean(onlineState?.ready?.[me]);
    const theyReady = Boolean(other && onlineState?.ready?.[other]);
    view.append(
      el(
        "p",
        "lead",
        theyReady ? "Gegner ist bereit." : "Gegner legt noch."
      )
    );
    if (iReady) view.append(el("p", "note", "Du bist bereit – warte auf den Gegner …"));
  } else if (!isBot()) view.append(codeLine(state.code, { hint: true }));
  else view.append(el("p", "lead", `Bot · ${DIFFICULTIES.find((item) => item[0] === state.difficulty)?.[1] || "Mittel"}`));

  const grid = makeGrid("place");
  view.append(grid);

  let pointer = null;
  const placeLocked = isOnline() && Boolean(onlineState?.ready?.[myOnlineId()]);
  grid.addEventListener("pointerdown", (event) => {
    if (placeLocked) return;
    const button = event.target.closest(".cell");
    if (!button || event.button !== 0) return;
    const c = Number(button.dataset.c);
    const r = Number(button.dataset.r);
    grid.setPointerCapture(event.pointerId);
    const lift = Boolean(shipAt(state.ships, c, r));
    pointer = { id: event.pointerId, c, r, lift };
    if (!lift) paintPreview(grid, c, r);
  });
  grid.addEventListener("pointerup", (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const action = pointer;
    pointer = null;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const button = hit && hit.closest ? hit.closest(".cell") : null;
    const same = button && Number(button.dataset.c) === action.c && Number(button.dataset.r) === action.r;
    for (const cell of grid.querySelectorAll(".cell")) cell.classList.remove("preview-ok", "preview-bad");
    if (!same) return;
    if (action.lift) {
      state = liftAt(state, action.c, action.r);
      save();
      render();
      return;
    }
    if (state.selectedId == null) {
      toast("Zuerst ein Schiff wählen");
      return;
    }
    const next = placeSelected(state, action.c, action.r);
    if (next === state) {
      const preview = previewAt(state, action.c, action.r);
      const reason = !preview || preview.issue === "rand"
        ? "Ragt über den Rand"
        : preview.issue === "ueber"
          ? "Liegt auf einem Schiff"
          : "Berührt ein anderes Schiff";
      toast(reason);
      if (preview) {
        for (const cell of preview.cells) cellButton(grid, cell.c, cell.r)?.classList.add("preview-bad");
        setTimeout(() => {
          for (const cell of grid.querySelectorAll(".preview-bad")) cell.classList.remove("preview-bad");
        }, 450);
      }
      return;
    }
    state = next;
    save();
    render();
  });

  const tools = el("div", "btn-row place-tools");
  const turn = el("button", "btn", "Drehen");
  turn.type = "button";
  turn.addEventListener("click", () => {
    state = rotate(state);
    save();
    render();
  });
  const flip = el("button", "btn", state.mirror ? "Spiegeln · an" : "Spiegeln");
  flip.type = "button";
  flip.setAttribute("aria-pressed", state.mirror ? "true" : "false");
  flip.addEventListener("click", () => {
    state = mirror(state);
    save();
    render();
  });
  const random = el("button", "btn", "Zufällig verteilen");
  random.type = "button";
  random.addEventListener("click", () => {
    const dealt = dealRandom(state);
    if (!dealt) {
      toast("Kein Platz gefunden, bitte noch einmal");
      return;
    }
    state = dealt;
    save();
    render();
  });
  const reset = el("button", "btn", "Alles zurücksetzen");
  reset.type = "button";
  reset.addEventListener("click", () => {
    state = resetShips(state);
    save();
    render();
  });
  tools.append(turn, flip, random, reset);

  const dock = el("div", "dock");
  const open = state.ships.filter((ship) => !ship.cells);
  if (open.length === 0) dock.append(el("p", "lead", "Alle Schiffe stehen."));
  for (const ship of open) {
    const selected = ship.id === state.selectedId;
    const chip = el("button", selected ? "ship-chip is-on" : "ship-chip");
    chip.type = "button";
    chip.setAttribute("aria-pressed", selected ? "true" : "false");
    chip.append(
      shapeIcon(ship.shapeId, selected ? state.rotation : 0, selected ? state.mirror : false),
      el("span", "", `${ship.name} · ${ship.size}`)
    );
    chip.addEventListener("click", () => {
      state = selectShip(state, ship.id);
      save();
      render();
    });
    dock.append(chip);
  }

  const meReady = isOnline() && Boolean(onlineState?.ready?.[myOnlineId()]);
  if (isOnline() && meReady) {
    tools.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
    dock.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
  }

  const done = el("button", "btn primary", isOnline() ? (meReady ? "Bereit …" : "Bereit") : "Fertig");
  done.type = "button";
  done.disabled = !allPlaced(state.ships) || meReady || onlineBusy;
  done.addEventListener("click", async () => {
    if (!allPlaced(state.ships) || meReady) return;
    if (isOnline()) {
      saveOnlineDraft();
      done.disabled = true;
      done.textContent = "Bereit …";
      try {
        if (iAmHost()) {
          const result = applyReady(onlineState, myOnlineId(), state.ships);
          if (result.error) {
            toast(result.error);
            done.disabled = false;
            done.textContent = "Bereit";
            return;
          }
          await publishOnlineState(result.state);
        } else {
          await onlineApi.sendAction({ type: "ready", payload: { ships: state.ships } });
          toast("Bereit gemeldet.");
        }
      } catch (err) {
        reportError("Bereit", err);
        done.disabled = false;
        done.textContent = "Bereit";
      }
      return;
    }
    const next = beginBattle(state);
    if (!next) {
      toast("Der Bot findet keinen Platz. Bitte andere Einstellungen.");
      return;
    }
    state = next;
    boardTab = "enemy";
    save();
    render();
  });

  view.append(tools, dock, done);
  app.replaceChildren(view);
  fitPlace(view);
}

function resultWord(result) {
  return result === "water" ? "Wasser" : result === "hit" ? "Treffer" : "Versenkt";
}

function announceResult(result, ship, onClose) {
  const title = result === "water" ? "WASSER" : result === "hit" ? "TREFFER!" : "VERSENKT!";
  const sub = result === "sunk" && ship ? sunkText(ship) : "";
  showAnnounce(result, title, sub, onClose);
  unlock().then(() => playResult(result));
}

/** Online/Bot: kurze Zellen-Animation, Ton und kleine Statuszeile – keine große Overlay-Anzeige. */
function announceSoft(who, c, r, result, board, onClose) {
  document.querySelector(".announce")?.remove();
  clearTimeout(announceTimer);
  flashCell = { c, r, board };
  softStatus = { text: `${who}: ${coord(c, r)} ${resultWord(result)}`, kind: result };
  unlock().then(() => playResult(result));
  render();
  announceTimer = setTimeout(() => {
    flashCell = null;
    if (onClose) onClose();
    else render();
  }, 750);
}

function scheduleBotShot() {
  if (state.versus !== "bot" || state.phase !== "battle" || state.turn !== "bot") return;
  if (botTimer) return;
  const seq = botSeq;
  botTimer = setTimeout(() => {
    botTimer = 0;
    if (seq !== botSeq) return;
    if (state.versus !== "bot" || state.phase !== "battle" || state.turn !== "bot") return;
    const view = botKnowledge(state);
    const shot = chooseShot(view, state.difficulty);
    if (!shot) {
      toast("Der Bot findet kein freies Feld.");
      return;
    }
    if (tabMode) boardTab = "own";
    render();
    botTimer = setTimeout(() => {
      botTimer = 0;
      if (seq !== botSeq) return;
      const fired = fireIncoming(state, shot.c, shot.r);
      if (fired.result === "already" || fired.result === "ignore") {
        flashCell = null;
        render();
        return;
      }
      state = fired.state;
      save();
      const ended = state.phase === "end";
      if (ended) recordStats();
      if (tabMode) boardTab = "own";
      announceSoft("Bot", shot.c, shot.r, fired.result, "own", () => {
        if (ended) return;
        if (state.turn === "bot") scheduleBotShot();
        else if (tabMode) {
          boardTab = "enemy";
          render();
        }
      });
    }, 320);
  }, 800);
}

function renderBattle() {
  document.body.classList.add("is-battle");
  tabMode = tabLock || wantsTabs();
  if (isOnline() && state.phase === "battle" && tabMode && !flashCell) {
    if (lastOnlineTurn !== state.turn) {
      lastOnlineTurn = state.turn;
      boardTab = state.turn === "player" ? "enemy" : "own";
    }
  }
  const bar = el("div", "battle-bar");
  bar.append(backLink());
  const fresh = el("button", "btn", "Neues Spiel");
  fresh.type = "button";
  fresh.addEventListener("click", askNewGame);
  if (isBot() || isOnline()) {
    bar.append(el("span", "spacer"), fresh);
  } else {
    const undoButton = el("button", "btn", "Rückgängig");
    undoButton.type = "button";
    undoButton.disabled = state.history.length === 0;
    undoButton.addEventListener("click", () => {
      state = undo(state);
      pendingMenu = null;
      save();
      render();
    });
    bar.append(el("span", "spacer"), undoButton, fresh);
  }

  const battle = el("div", "battle");
  if (tabMode) {
    const tabs = el("div", "board-tabs");
    for (const [id, label] of [["enemy", "Gegner"], ["own", "Ich"]]) {
      const button = el("button", boardTab === id ? "is-on" : "", label);
      button.type = "button";
      button.setAttribute("aria-pressed", boardTab === id ? "true" : "false");
      button.addEventListener("click", () => {
        boardTab = id;
        pendingMenu = null;
        render();
      });
      tabs.append(button);
    }
    battle.append(tabs);
  }

  const status = el("div", "status");
  status.append(
    fleetRow("Gegner", state.enemyFleet.map((slot) => ({ shapeId: slot.shapeId, sunk: slot.sunk })), false),
    fleetRow("Ich", state.ships.map((ship) => ({ shapeId: ship.shapeId, sunk: ownSunk(ship) })), true)
  );

  if (isOnline() && !opponentOnline()) {
    battle.append(el("p", "bot-banner wait-banner", "Gegner nicht verbunden – warte …"));
  } else if (isOnline() && state.phase === "battle") {
    battle.append(
      el("p", state.turn === "player" ? "bot-banner your-turn" : "bot-banner", state.turn === "player" ? "Du bist dran" : "Gegner ist dran")
    );
  } else if (isBot() && state.turn === "bot" && state.phase === "battle") {
    battle.append(el("p", "bot-banner", "Bot ist dran"));
  }

  if ((isBot() || isOnline()) && softStatus) {
    battle.append(el("p", `shot-line ${softStatus.kind || ""}`, softStatus.text));
  }

  const enemyBlock = el("div", "board-block");
  enemyBlock.append(el("p", "board-title", isBot() ? "Feld des Bots" : "Gegnerisches Feld"));
  const enemyGrid = makeGrid("enemy");
  const onlineLocked =
    isOnline() &&
    (state.turn !== "player" || state.phase !== "battle" || !opponentOnline() || onlineBusy);
  if ((isBot() && state.turn !== "player") || onlineLocked) enemyGrid.classList.add("is-locked");
  enemyGrid.addEventListener("click", async (event) => {
    const button = event.target.closest(".cell");
    if (!button) return;
    const c = Number(button.dataset.c);
    const r = Number(button.dataset.r);
    if (isOnline()) {
      if (onlineLocked) return;
      if (readMark(state.enemy, c, r)) {
        toast("Schon beschossen");
        return;
      }
      try {
        if (iAmHost()) {
          const fired = fireOnlineShot(onlineState, myOnlineId(), c, r);
          if (fired.result === "already") {
            toast("Schon beschossen");
            return;
          }
          if (fired.result === "ignore") return;
          await publishOnlineState(fired.state);
        } else {
          await onlineApi.sendAction({ type: "shot", payload: { c, r } });
        }
      } catch (err) {
        reportError("Schuss", err);
      }
      return;
    }
    if (isBot()) {
      if (state.turn !== "player" || state.phase !== "battle") return;
      const fired = fireAtBot(state, c, r);
      if (fired.result === "already") {
        toast("Schon beschossen");
        return;
      }
      if (fired.result === "ignore") return;
      state = fired.state;
      pendingMenu = null;
      save();
      const ended = state.phase === "end";
      if (ended) recordStats();
      if (tabMode) boardTab = "enemy";
      announceSoft("Du", c, r, fired.result, "enemy", () => {
        if (ended) return;
        if (state.turn === "bot") {
          if (tabMode) boardTab = "own";
          render();
          scheduleBotShot();
        }
      });
      return;
    }
    pendingMenu = { c, r };
    render();
  });
  enemyBlock.append(enemyGrid);

  const ownBlock = el("div", "board-block");
  ownBlock.append(el("p", "board-title", "Mein Feld"));
  const ownGrid = makeGrid("own");
  if (!isBot() && !isOnline()) {
    ownGrid.addEventListener("click", async (event) => {
      const button = event.target.closest(".cell");
      if (!button) return;
      const c = Number(button.dataset.c);
      const r = Number(button.dataset.r);
      const fired = fireIncoming(state, c, r);
      if (fired.result === "already") {
        toast("Schon beschossen");
        return;
      }
      if (fired.result === "ignore") return;
      state = fired.state;
      pendingMenu = null;
      save();
      const ended = state.phase === "end";
      if (!ended && tabMode) boardTab = "own";
      render();
      announceResult(fired.result, fired.ship, () => {
        if (!ended && tabMode && state.phase === "battle") {
          boardTab = "enemy";
          render();
        }
      });
    });
  }
  ownBlock.append(ownGrid);

  if (tabMode) battle.append(status, boardTab === "own" ? ownBlock : enemyBlock);
  else battle.append(enemyBlock, status, ownBlock);

  if (isBot() || isOnline()) app.replaceChildren(bar, battle);
  else app.replaceChildren(bar, codeLine(state.code), battle);

  if (!isBot() && !isOnline() && pendingMenu && (!tabMode || boardTab === "enemy")) {
    const menu = el("div", "mark-menu");
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", "Schuss eintragen");
    menu.append(el("p", "", coord(pendingMenu.c, pendingMenu.r)));
    for (const [kind, label] of [["water", "Wasser"], ["hit", "Treffer"], ["sunk", "Versenkt"], ["cancel", "Abbrechen"]]) {
      const button = el("button", "", label);
      button.type = "button";
      button.addEventListener("click", () => {
        if (kind === "cancel") {
          pendingMenu = null;
          render();
          return;
        }
        const marked = markEnemy(state, pendingMenu.c, pendingMenu.r, kind);
        if (marked.error) {
          toast(marked.error);
          return;
        }
        pendingMenu = null;
        if (marked.choice) {
          render();
          askWhichShip(marked.choice);
          return;
        }
        state = marked.state;
        save();
        render();
      });
      menu.append(button);
    }
    app.append(menu);
  }

  requestAnimationFrame(() => {
    if (!document.body.classList.contains("is-battle")) return;
    fitBoards();
    const cell = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--cell"));
    if (!tabMode && cell < 24) {
      tabLock = true;
      boardTab = "enemy";
      render();
      return;
    }
    requestAnimationFrame(fitBoards);
    if (
      isBot() &&
      state.turn === "bot" &&
      state.phase === "battle" &&
      !document.querySelector(".announce") &&
      !flashCell
    ) {
      scheduleBotShot();
    }
  });
}

function sizeEndGrid(grid, view) {
  const cell = Math.max(12, Math.min(28, Math.floor((view.clientWidth - 48) / state.width)));
  grid.style.setProperty("--cell", `${cell}px`);
  grid.style.setProperty("--label", "18px");
  grid.style.setProperty("--cols", String(state.width));
  grid.style.setProperty("--rows", String(state.height));
}

function renderEnd() {
  document.body.classList.remove("is-battle");
  const view = el("section", "end-screen");
  view.append(backLink());
  if (!isBot() && !isOnline()) view.append(codeLine(state.code));
  view.append(el("h1", "", state.outcome === "won" ? "Gewonnen" : "Verloren"));
  const mine = ownShotStats(state);
  if (isOnline() && onlineState) {
    const me = myOnlineId();
    const other = opponentId(onlineState, me);
    const myStats = shotStatsFor(onlineState, me);
    const theirStats = shotStatsFor(onlineState, other);
    const myName = onlineState.playerNames?.[me] || "Du";
    const theirName = onlineState.playerNames?.[other] || "Gegner";
    view.append(el("p", "lead", `${myName}: ${myStats.shots} Schüsse · Trefferquote ${myStats.rate} %`));
    view.append(el("p", "lead", `${theirName}: ${theirStats.shots} Schüsse · Trefferquote ${theirStats.rate} %`));
    view.append(el("h2", "", "Flotte des Gegners"));
    const enemyGrid = makeGrid("reveal-bot");
    enemyGrid.classList.add("end-grid");
    for (const button of enemyGrid.querySelectorAll(".cell")) button.disabled = true;
    view.append(enemyGrid);
    view.append(el("h2", "", "Mein Feld"));
    const grid = makeGrid("reveal");
    grid.classList.add("end-grid");
    for (const button of grid.querySelectorAll(".cell")) button.disabled = true;
    view.append(grid);
    const rematch = el("button", "btn primary", "Revanche");
    rematch.type = "button";
    rematch.disabled = onlineBusy;
    rematch.addEventListener("click", async () => {
      rematch.disabled = true;
      try {
        if (iAmHost()) {
          const players = (onlineRoom?.players || []).map((player, index) => ({
            id: player.id,
            name: player.name,
            seat: index,
          }));
          const next = beginOnlineRematch(onlineState, players);
          lastShotSeqSeen = 0;
          softStatus = null;
          flashCell = null;
          set(ONLINE_DRAFT_KEY, null);
          await publishOnlineState(next);
        } else {
          await onlineApi.sendAction({ type: "rematch", payload: {} });
          toast("Revanche angefragt …");
        }
      } catch (err) {
        reportError("Revanche", err);
        rematch.disabled = false;
      }
    });
    const hub = el("a", "btn", "Zum Hub");
    hub.href = "../../index.html";
    const row = el("div", "btn-row");
    row.append(rematch, hub);
    view.append(row);
    app.replaceChildren(view);
    sizeEndGrid(enemyGrid, view);
    sizeEndGrid(grid, view);
    return;
  }
  if (isBot()) {
    const bot = incomingShotStats(state);
    view.append(el("p", "lead", `Du: ${mine.shots} Schüsse · Trefferquote ${mine.rate} %`));
    view.append(el("p", "lead", `Bot: ${bot.shots} Schüsse · Trefferquote ${bot.rate} %`));
    view.append(el("h2", "", "Flotte des Bots"));
    const botGrid = makeGrid("reveal-bot");
    botGrid.classList.add("end-grid");
    for (const button of botGrid.querySelectorAll(".cell")) button.disabled = true;
    view.append(botGrid);
    view.append(el("h2", "", "Mein Feld"));
    const grid = makeGrid("reveal");
    grid.classList.add("end-grid");
    for (const button of grid.querySelectorAll(".cell")) button.disabled = true;
    view.append(grid);
    const rematch = el("button", "btn primary", "Revanche");
    rematch.type = "button";
    rematch.addEventListener("click", startRematch);
    const fresh = el("button", "btn", "Neues Spiel");
    fresh.type = "button";
    fresh.addEventListener("click", startFresh);
    const hub = el("a", "btn", "Zum Hub");
    hub.href = "../../index.html";
    const row = el("div", "btn-row");
    row.append(rematch, fresh, hub);
    view.append(row);
    app.replaceChildren(view);
    sizeEndGrid(botGrid, view);
    sizeEndGrid(grid, view);
    return;
  }
  view.append(el("p", "lead", `${mine.shots} eigene Schüsse · Trefferquote ${mine.rate} %`));
  view.append(el("h2", "", "Mein Feld"));
  const grid = makeGrid("reveal");
  grid.classList.add("end-grid");
  for (const button of grid.querySelectorAll(".cell")) button.disabled = true;
  view.append(grid);
  view.append(el("h2", "", "Schüsse des Gegners"));
  const list = el("ol", "log");
  if (state.shotLog.length === 0) list.append(el("li", "", "Keine Schüsse"));
  for (const entry of state.shotLog) list.append(el("li", "", logText(entry)));
  view.append(list);
  const fresh = el("button", "btn primary", "Neues Spiel");
  fresh.type = "button";
  fresh.addEventListener("click", startFresh);
  const hub = el("a", "btn", "Zum Hub");
  hub.href = "../../index.html";
  const row = el("div", "btn-row");
  row.append(fresh, hub);
  view.append(row);
  app.replaceChildren(view);
  sizeEndGrid(grid, view);
}

let showingResume = false;

function draw() {
  preserveScreenScroll(app, () => {
    if (playMode === "online" && (enteringOnline || lobbyHandle)) return;
    document.body.dataset.phase = showingResume ? "resume" : state.phase;
    if (showingResume) {
      renderResumeScreen();
      return;
    }
    if (state.phase === "setup" && !playMode) renderVersus();
    else if (state.phase === "setup") renderSettings();
    else if (state.phase === "place") renderPlace();
    else if (state.phase === "battle") renderBattle();
    else renderEnd();
  });
}

function render() {
  showingResume = false;
  draw();
}

function resumeFrom(which) {
  const loaded = which === "bot" ? botSave : hotseatSave;
  state = loaded;
  playMode = which;
  difficulty = state.difficulty || "medium";
  extraShot = state.extraShot !== false;
  if (state.rules) {
    draft = {
      mode: state.rules.mode,
      width: state.rules.width,
      height: state.rules.height,
      allowTouch: !!state.rules.allowTouch,
      counts: { ...state.rules.counts },
    };
    rememberCustom(draft);
  }
  showingResume = false;
  draw();
}

function renderResumeScreen() {
  document.body.classList.remove("is-battle");
  const view = el("section", "screen setup");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  body.append(backLink());
  body.append(el("h1", "", "Schiffe versenken"));
  body.append(el("p", "lead", "Es gibt ein angefangenes Spiel auf diesem Handy."));
  if (isRunning(hotseatSave)) {
    const resume = el("button", "btn primary", "Zuruf-Spiel fortsetzen");
    resume.type = "button";
    resume.addEventListener("click", () => resumeFrom("hotseat"));
    dock.append(resume);
  }
  if (isRunning(botSave)) {
    const resume = el("button", isRunning(hotseatSave) ? "btn" : "btn primary", "Bot-Spiel fortsetzen");
    resume.type = "button";
    resume.addEventListener("click", () => resumeFrom("bot"));
    dock.append(resume);
  }
  const fresh = el("button", "btn", "Neues Spiel");
  fresh.type = "button";
  fresh.addEventListener("click", startFresh);
  dock.append(fresh);
  view.append(body, dock);
  app.replaceChildren(view);
}

function boot() {
  document.title = "Schiffe versenken – Kajütenspiele";
  requestWakeLock();
  initUpdates();
  const session = get(ROOM_SESSION_KEY, null);
  if (wantsOnline() || (session && session.gameId === "schiffe")) {
    playMode = "online";
    enterOnline();
    return;
  }
  const hotseat = readSave(get(STORAGE_KEY, null));
  const bot = readSave(get(BOT_KEY, null));
  bootNotice = hotseat.notice || bot.notice;
  if (hotseat.notice) set(STORAGE_KEY, freshState());
  if (bot.notice) set(BOT_KEY, freshState());
  hotseatSave = hotseat.notice ? null : hotseat.state;
  botSave = bot.notice ? null : bot.state;
  if (isRunning(hotseatSave) || isRunning(botSave)) {
    showingResume = true;
    state = isRunning(hotseatSave) ? hotseatSave : botSave;
  } else {
    state = freshState();
  }
  draw();
}

window.kajueteSchiffeBotTest = (games = 200) => {
  console.log(`Simuliere ${games} Partien je Schwierigkeit …`);
  const result = benchmarkBots(games);
  console.table(result);
  return result;
};

window.addEventListener("resize", () => {
  if (state.phase === "battle" && !showingResume) {
    tabLock = false;
    const next = wantsTabs();
    if (next !== tabMode) {
      tabMode = next;
      if (!next) boardTab = "enemy";
      render();
      return;
    }
    fitBoards();
    return;
  }
  if (state.phase === "place" && !showingResume) {
    const view = document.querySelector(".place");
    if (view) fitPlace(view);
  }
});
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => {
    if (state.phase === "battle" && !showingResume) fitBoards();
  });
}
window.addEventListener("pagehide", save);

boot();
