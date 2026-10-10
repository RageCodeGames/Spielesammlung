import {
  COLORS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROUND_OPTIONS,
  TIME_OPTIONS,
  WIDTHS,
  WORDS,
  advanceTurn,
  applyGuess,
  applyHint,
  applyPick,
  autoPick,
  beginMatch,
  defaultSettings,
  dropPlayer,
  finishTurn,
  guessList,
  hostWord,
  migrateState,
  normalizeSecrets,
  normalizeSettings,
  packSecrets,
  pauseForHost,
  ranking,
  resumeHost,
  skipPainter,
  summarizeSettings,
} from "./logic.js";
import { preserveScreenScroll } from "../../shared/scroll.js";
import { requestWakeLock } from "../../shared/wakelock.js";
import { initUpdates } from "../../shared/update.js";

const GAME_ID = "malen";
const DEV_NAMES = ["Nia", "Rolo", "Mira", "Timo", "Suri", "Kale", "Pim", "Vela"];

const app = document.getElementById("app");

let onlineApi = null;
let lobbyHandle = null;
let lobbyTools = null;
let onlineRoom = null;
let state = null;
let secrets = { used: {}, word: null, choices: [], players: {} };
let secretMine = null;
let entering = false;
let leavingUi = false;
let leftHandled = new Set();
let unsubRoom = null;
let unsubAction = null;
let unsubNet = null;
let unsubSecrets = null;
let unsubDraw = null;
let unsubBadge = null;
let hostQueue = Promise.resolve();
let tickTimer = 0;
let botTimer = 0;
let botKey = "";
let toastTimer = 0;
let lastAlmost = 0;
let strokes = {};
let tool = { color: COLORS[0], width: WIDTHS[1], erase: false };
let liveStroke = null;
let sentPts = 0;
let strokeSeq = 0;
let strokeStack = [];
let flushTimer = 0;
let canvasNode = null;
let canvasCtx = null;
let drawing = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function isDev() {
  try {
    return new URL(location.href).searchParams.get("dev") === "1";
  } catch {
    return false;
  }
}

function iAmHost() {
  return Boolean(onlineApi?.isHost?.());
}

function myId() {
  return onlineApi?.getPlayerId?.() || onlineRoom?.you?.id || null;
}

function toast(message) {
  document.querySelector(".toast")?.remove();
  const node = el("div", "toast", message);
  node.setAttribute("role", "status");
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 1800);
}

function reportError(context, err) {
  console.error(`[malen] ${context}`, err);
  toast(err?.message || "Etwas ist schiefgelaufen.");
}

function backLink() {
  const link = el("a", "back");
  link.href = "../../index.html";
  const arrow = el("span", "", "←");
  arrow.setAttribute("aria-hidden", "true");
  link.append(arrow, document.createTextNode(" Zurück"));
  return link;
}

function clearSubs() {
  unsubRoom?.();
  unsubAction?.();
  unsubNet?.();
  unsubSecrets?.();
  unsubDraw?.();
  unsubBadge?.();
  unsubRoom = unsubAction = unsubNet = unsubSecrets = unsubDraw = unsubBadge = null;
  clearInterval(tickTimer);
  tickTimer = 0;
  clearTimeout(botTimer);
  botTimer = 0;
  stopFlush();
}

async function leaveOnline() {
  clearSubs();
  try {
    await onlineApi?.leaveRoom?.();
  } catch (err) {
    console.error("[malen] Verlassen", err);
  }
  onlineRoom = null;
  state = null;
  secretMine = null;
  leavingUi = false;
  leftHandled = new Set();
  strokes = {};
  canvasNode = null;
  canvasCtx = null;
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
  renderBoot();
}

function notePeerLeft(player) {
  if (!player?.id || leftHandled.has(player.id)) return;
  leftHandled.add(player.id);
  toast(`${player.name} hat den Raum verlassen`);
  if (!iAmHost() || !state) return;
  runHost(async () => {
    if (!state || state.phase === "end") return;
    const next = dropPlayer(state, secrets, player.id);
    await publish(next.state, next.secrets, next.state.phase !== "draw");
  }).catch((err) => reportError("Mitspieler weg", err));
}

function runHost(task) {
  const job = hostQueue.then(task).catch((err) => reportError("Spielstand", err));
  hostQueue = job;
  return job;
}

async function publish(nextState, nextSecrets, wipeDraw = false) {
  if (!iAmHost()) return;
  if (nextSecrets) {
    secrets = nextSecrets;
    await onlineApi.writeAllSecrets(packSecrets(nextSecrets));
  }
  if (wipeDraw) {
    try {
      await onlineApi.clearDraw();
    } catch (err) {
      console.error("[malen] Zeichnung löschen", err);
    }
  }
  state = nextState;
  await onlineApi.setState(nextState);
}

function lobbyExtras(container, { room, isHost }) {
  if (!isHost || !isDev()) return;
  const add = el("button", "btn", "Testspieler hinzufügen");
  add.type = "button";
  add.disabled = room.players.length >= MAX_PLAYERS;
  add.addEventListener("click", async () => {
    if (room.players.length >= MAX_PLAYERS) return;
    add.disabled = true;
    try {
      const used = new Set(room.players.map((player) => player.name));
      const name = DEV_NAMES.find((item) => !used.has(item)) || `Test ${room.players.length}`;
      await onlineApi.addDummyPlayer(name);
    } catch (err) {
      reportError("Testspieler", err);
      add.disabled = false;
    }
  });
  container.append(add);
}

function renderSettings(container, { settings, onChange }) {
  const current = normalizeSettings(settings);
  container.append(el("h2", "group-label", "Runden"));
  const rounds = el("div", "btn-row");
  for (const count of ROUND_OPTIONS) {
    const button = el("button", current.rounds === count ? "btn primary" : "btn", `${count} Runden`);
    button.type = "button";
    button.addEventListener("click", () => onChange({ ...current, rounds: count }));
    rounds.append(button);
  }
  container.append(rounds);
  container.append(el("h2", "group-label", "Zeit pro Bild"));
  const times = el("div", "btn-row");
  for (const sec of TIME_OPTIONS) {
    const button = el("button", current.drawSec === sec ? "btn primary" : "btn", `${sec} Sekunden`);
    button.type = "button";
    button.addEventListener("click", () => onChange({ ...current, drawSec: sec }));
    times.append(button);
  }
  container.append(times);
}

async function enterLobby() {
  if (entering && lobbyHandle) return;
  entering = true;
  try {
    const [lobbyMod, api] = await Promise.all([
      import("../../shared/lobby.js"),
      import("../../shared/online.js"),
    ]);
    lobbyTools = lobbyMod;
    onlineApi = api;
    lobbyHandle?.destroy();
    lobbyHandle = lobbyMod.mountLobby(app, {
      gameId: GAME_ID,
      title: "Malen & Raten",
      lead: "Drei bis acht Personen. Einer malt, die anderen raten.",
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      renderRoomExtra: lobbyExtras,
      settingsPanel: {
        initial: defaultSettings(),
        summarize: summarizeSettings,
        render: renderSettings,
      },
      async onBeforeStart(room) {
        const match = beginMatch(room.players, room.settings);
        secrets = match.secrets;
        await onlineApi.writeAllSecrets(packSecrets(match.secrets));
        await onlineApi.clearDraw().catch(() => {});
        await onlineApi.setState(match.state);
        state = match.state;
      },
      onStart(room) {
        beginPlay(room);
      },
      onLeave() {
        lobbyHandle = null;
        entering = false;
        renderBoot();
      },
    });
  } catch (err) {
    entering = false;
    reportError("Lobby", err);
    renderBoot();
  }
}

function beginPlay(room) {
  try {
    lobbyHandle?.destroy();
    lobbyHandle = null;
    entering = false;
    onlineRoom = room;
    if (room?.state) state = migrateState(room.state);
    clearSubs();
    unsubRoom = onlineApi.onRoomChange((next) => {
      if (leavingUi) return;
      if (onlineApi.isRoomGone(next)) {
        leavingUi = true;
        const msg = onlineApi.roomExitMessage(next);
        leaveOnline().then(() => {
          toast(msg);
          renderBoot();
        });
        return;
      }
      for (const player of onlineApi.playersWhoLeft(onlineRoom, next)) notePeerLeft(player);
      const hostGone = next.players?.some((player) => player.isHost && player.online === false);
      onlineRoom = next;
      if (!iAmHost() && state && hostGone && !state.waitingForHost) {
        state = pauseForHost(state);
      }
      if (!iAmHost() && state?.waitingForHost && next.players?.some((player) => player.isHost && player.online !== false)) {
        state = resumeHost(state);
      }
      if (next.state) adoptState(migrateState(next.state));
      else render();
    });
    unsubAction = onlineApi.onAction((action) => {
      handleAction(action).catch((err) => reportError("Aktion", err));
    });
    unsubSecrets = onlineApi.onSecrets((payload) => {
      secretMine = payload?.mine || null;
      if (payload?.all) secrets = normalizeSecrets(payload.all);
      if (secretMine?.almost && secretMine.almost !== lastAlmost) {
        lastAlmost = secretMine.almost;
        toast("Fast!");
      }
      if (state?.phase === "pick" && (secretMine?.choices?.length || secrets.choices?.length) && !app.querySelector(".malen-picks .btn")) {
        render();
      } else if (state?.phase === "draw") patchPlay();
      else render();
      scheduleBots();
    });
    unsubDraw = onlineApi.onDraw((data) => {
      strokes = data || {};
      redrawCanvas();
    });
    unsubNet = onlineApi.onConnectionChange((ok) => {
      if (iAmHost() && ok && state?.waitingForHost) {
        runHost(() => publish(resumeHost(state), null)).finally(armTick);
      } else if (iAmHost() && !ok && state && !state.waitingForHost) {
        runHost(() => publish(pauseForHost(state), null));
      } else render();
    });
    requestWakeLock();
    render();
    armTick();
    scheduleBots();
  } catch (err) {
    showCrash(err);
  }
}

function adoptState(next) {
  const same =
    state &&
    next &&
    state.phase === next.phase &&
    state.turnIndex === next.turnIndex &&
    state.painterId === next.painterId;
  state = next;
  if (same && (next.phase === "draw" || next.phase === "pick" || next.phase === "reveal")) patchPlay();
  else render();
  armTick();
  scheduleBots();
}

function handleAction(action) {
  if (!iAmHost()) return Promise.resolve();
  return runHost(async () => {
    if (!state) return;
    if (action.type === "pick") {
      const next = applyPick(state, secrets, action.from, action.payload?.word);
      if (!next.error) await publish(next.state, next.secrets, true);
      return;
    }
    if (action.type === "guess") {
      const next = applyGuess(state, secrets, action.from, action.payload?.text);
      if (next.almost) {
        await onlineApi.writePlayerSecret(action.from, { almost: Date.now() });
        return;
      }
      if (!next.error) await publish(next.state, next.secrets, next.clearDraw);
      return;
    }
    if (action.type === "clearDraw" && action.from === state.painterId) {
      await onlineApi.clearDraw();
      return;
    }
    if (action.type === "leave") {
      const who = state.players.find((player) => player.id === action.from);
      notePeerLeft({ id: action.from, name: action.payload?.name || who?.name || "Jemand" });
      return;
    }
    if (action.type === "rematch" && state.phase === "end") {
      await startRematchNow();
    }
  });
}

async function startRematchNow() {
  if (!onlineRoom) return;
  const match = beginMatch(onlineRoom.players, {
    rounds: state?.rounds,
    drawSec: Math.round((state?.drawMs || 80000) / 1000),
    ...(onlineRoom.settings || {}),
  });
  await publish(match.state, match.secrets, true);
}

function painterOffline() {
  const painter = onlineRoom?.players?.find((player) => player.id === state?.painterId);
  return Boolean(painter && painter.online === false && !painter.dummy);
}

function hostOffline() {
  const host = onlineRoom?.players?.find((player) => player.isHost);
  return Boolean(host && host.online === false);
}

function armTick() {
  clearInterval(tickTimer);
  tickTimer = 0;
  if (!iAmHost() || !state || state.phase === "end") return;
  tickTimer = window.setInterval(() => {
    runHost(hostTick);
    patchTimer();
  }, 250);
}

async function hostTick() {
  if (!iAmHost() || !state || state.waitingForHost) return;
  const now = Date.now();
  if (hostOffline()) {
    await publish(pauseForHost(state, now), null);
    return;
  }
  if (painterOffline() && (state.phase === "pick" || state.phase === "draw")) {
    const next = skipPainter(state, secrets, now);
    await publish(next.state, next.secrets, true);
    toast("Maler nicht da – Runde übersprungen");
    return;
  }
  if (state.phase === "pick" && now >= state.deadline) {
    const next = autoPick(state, secrets, now);
    await publish(next.state, next.secrets, true);
    return;
  }
  if (state.phase === "draw") {
    const hinted = applyHint(state, secrets, now);
    if (hinted.state !== state) {
      await publish(hinted.state, null);
      return;
    }
    if (now >= state.deadline) {
      const next = finishTurn(state, secrets, now);
      await publish(next.state, next.secrets, true);
    }
  }
  if (state.phase === "reveal" && now >= state.deadline) {
    const next = advanceTurn(state, secrets, now);
    await publish(next.state, next.secrets, true);
  }
}

function scheduleBots() {
  if (!iAmHost() || !state || state.phase === "end") {
    clearTimeout(botTimer);
    botTimer = 0;
    return;
  }
  const dummies = (onlineRoom?.players || []).filter((player) => player.dummy);
  if (!dummies.length) {
    clearTimeout(botTimer);
    botTimer = 0;
    return;
  }
  const key = `${state.phase}:${state.turnIndex}:${state.guessSeq}:${Object.keys(state.guessed || {}).length}`;
  if (botTimer && botKey === key) return;
  clearTimeout(botTimer);
  botKey = key;
  const delay = state.phase === "pick" ? 900 : 1400 + Math.floor(Math.random() * 1600);
  botTimer = setTimeout(() => {
    botTimer = 0;
    runHost(() => playDummies(key)).finally(scheduleBots);
  }, delay);
}

async function playDummies(key) {
  if (!iAmHost() || !state) return;
  if (`${state.phase}:${state.turnIndex}:${state.guessSeq}:${Object.keys(state.guessed || {}).length}` !== key) return;
  const dummies = (onlineRoom?.players || []).filter((player) => player.dummy);
  if (state.phase === "pick" && dummies.some((player) => player.id === state.painterId)) {
    const next = autoPick(state, secrets);
    await publish(next.state, next.secrets, true);
    return;
  }
  if (state.phase !== "draw") return;
  const guessers = dummies.filter((player) => player.id !== state.painterId && !state.guessed[player.id]);
  const who = guessers[Math.floor(Math.random() * guessers.length)];
  if (!who) return;
  const correct = secrets.word && Math.random() < 0.28;
  const text = correct ? secrets.word : WORDS[Math.floor(Math.random() * WORDS.length)];
  const next = applyGuess(state, secrets, who.id, text);
  if (next.almost || next.error) return;
  await publish(next.state, next.secrets, next.clearDraw);
}

function remainingSec() {
  if (!state?.deadline) return 0;
  return Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
}

function patchTimer() {
  const node = app.querySelector("[data-timer]");
  if (node) node.textContent = `${remainingSec()}s`;
}

function patchPlay() {
  if (!app.querySelector("[data-malen]")) {
    render();
    return;
  }
  patchTimer();
  const mask = app.querySelector("[data-mask]");
  if (mask) mask.textContent = state.mask || "";
  const letters = app.querySelector("[data-letters]");
  if (letters) letters.textContent = state.letterCount ? `${state.letterCount} Buchstaben` : "";
  const banner = app.querySelector("[data-banner]");
  if (banner) {
    if (state.lastSolved) {
      banner.hidden = false;
      banner.textContent = `${state.lastSolved} hat es erraten!`;
    } else banner.hidden = true;
  }
  const list = app.querySelector("[data-guesses]");
  if (list) {
    list.replaceChildren();
    for (const row of guessList(state).slice(-12)) {
      const item = el("li", "");
      item.append(el("strong", "", row.name), document.createTextNode(row.text));
      list.append(item);
    }
  }
  const form = app.querySelector("[data-guess-form]");
  if (form) {
    const locked = Boolean(state.guessed?.[myId()]) || state.phase !== "draw";
    form.querySelector("input")?.toggleAttribute("disabled", locked);
    form.querySelector("button")?.toggleAttribute("disabled", locked);
  }
}

function stopFlush() {
  clearInterval(flushTimer);
  flushTimer = 0;
}

function toNorm(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  return {
    x: Math.max(0, Math.min(1, Number(x.toFixed(4)))),
    y: Math.max(0, Math.min(1, Number(y.toFixed(4)))),
  };
}

function flushStroke() {
  if (!liveStroke || !onlineApi) return;
  if (sentPts >= liveStroke.pts.length) return;
  const patch = {
    color: liveStroke.color,
    width: liveStroke.width,
    erase: liveStroke.erase ? true : false,
  };
  for (let i = sentPts; i < liveStroke.pts.length; i += 1) {
    patch[`pts/${i}`] = liveStroke.pts[i];
  }
  sentPts = liveStroke.pts.length;
  onlineApi.writeDrawStroke(liveStroke.id, patch).catch((err) => console.error("[malen] Strich", err));
}

function bindCanvas(canvas) {
  canvasNode = canvas;
  canvasCtx = canvas.getContext("2d");
  const start = (event) => {
    if (state?.phase !== "draw" || state.painterId !== myId()) return;
    event.preventDefault();
    drawing = true;
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* Desktop */
    }
    strokeSeq += 1;
    liveStroke = {
      id: `s${strokeSeq}`,
      color: tool.erase ? "#f7f1e6" : tool.color,
      width: tool.width,
      erase: tool.erase,
      pts: [toNorm(event, canvas)],
    };
    sentPts = 0;
    strokeStack.push(liveStroke.id);
    strokes = { ...strokes, [liveStroke.id]: { from: myId(), color: liveStroke.color, width: liveStroke.width, erase: liveStroke.erase, pts: { 0: liveStroke.pts[0] } } };
    redrawCanvas();
    stopFlush();
    flushTimer = window.setInterval(flushStroke, 100);
  };
  const move = (event) => {
    if (!drawing || !liveStroke) return;
    event.preventDefault();
    const pt = toNorm(event, canvas);
    const last = liveStroke.pts[liveStroke.pts.length - 1];
    if (Math.abs(pt.x - last.x) + Math.abs(pt.y - last.y) < 0.004) return;
    liveStroke.pts.push(pt);
    const stroke = strokes[liveStroke.id] || { pts: {} };
    stroke.pts = { ...stroke.pts, [liveStroke.pts.length - 1]: pt };
    strokes[liveStroke.id] = stroke;
    redrawCanvas();
  };
  const end = (event) => {
    if (!drawing) return;
    event.preventDefault();
    drawing = false;
    flushStroke();
    stopFlush();
    liveStroke = null;
  };
  canvas.addEventListener("pointerdown", start);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("touchmove", (event) => event.preventDefault(), { passive: false });
  redrawCanvas();
}

function redrawCanvas() {
  const canvas = canvasNode;
  const ctx = canvasCtx;
  if (!canvas || !ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  ctx.fillStyle = "#f7f1e6";
  ctx.fillRect(0, 0, width, height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const ids = Object.keys(strokes).sort();
  for (const id of ids) {
    const stroke = strokes[id];
    if (!stroke || typeof stroke !== "object") continue;
    const pts = stroke.pts && typeof stroke.pts === "object" ? stroke.pts : {};
    const points = Object.keys(pts)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => pts[key])
      .filter((pt) => pt && Number.isFinite(pt.x) && Number.isFinite(pt.y));
    if (!points.length) continue;
    ctx.save();
    ctx.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
    ctx.strokeStyle = stroke.erase ? "rgba(0,0,0,1)" : stroke.color || "#1a1a1a";
    ctx.lineWidth = Math.max(2, (Number(stroke.width) || 0.018) * width);
    ctx.beginPath();
    ctx.moveTo(points[0].x * width, points[0].y * height);
    for (const pt of points.slice(1)) ctx.lineTo(pt.x * width, pt.y * height);
    if (points.length === 1) ctx.lineTo(points[0].x * width + 0.01, points[0].y * height);
    ctx.stroke();
    ctx.restore();
  }
}

function sizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  redrawCanvas();
}

async function sendPick(word) {
  if (iAmHost()) {
    await runHost(async () => {
      const next = applyPick(state, secrets, myId(), word);
      if (next.error) return toast(next.error);
      await publish(next.state, next.secrets, true);
    });
    return;
  }
  try {
    await onlineApi.sendAction({ type: "pick", payload: { word } });
  } catch (err) {
    reportError("Wahl", err);
  }
}

async function sendGuess(text) {
  if (iAmHost()) {
    await runHost(async () => {
      const next = applyGuess(state, secrets, myId(), text);
      if (next.almost) {
        toast("Fast!");
        return;
      }
      if (next.error) return toast(next.error);
      await publish(next.state, next.secrets, next.clearDraw);
    });
    return;
  }
  try {
    await onlineApi.sendAction({ type: "guess", payload: { text } });
  } catch (err) {
    reportError("Tipp", err);
  }
}

async function undoStroke() {
  const id = strokeStack.pop();
  if (!id) return;
  try {
    await onlineApi.removeDrawStroke(id);
  } catch (err) {
    reportError("Rückgängig", err);
  }
}

async function clearCanvas() {
  strokeStack = [];
  if (iAmHost()) {
    try {
      await onlineApi.clearDraw();
    } catch (err) {
      reportError("Löschen", err);
    }
    return;
  }
  try {
    await onlineApi.sendAction({ type: "clearDraw", payload: {} });
  } catch (err) {
    reportError("Löschen", err);
  }
}

function topBar(title) {
  const top = el("div", "lobby-top");
  top.append(el("p", "lobby-kicker", title));
  const tools = el("div", "lobby-top-tools");
  const badge = el("div");
  if (unsubBadge) unsubBadge();
  unsubBadge = onlineApi.mountConnectionBadge(badge);
  tools.append(badge);
  lobbyTools?.appendRoomMenu(tools, { isHost: iAmHost(), onExit: askLeaveRoom });
  top.append(tools);
  return top;
}

function renderBoot() {
  const view = el("section", "screen setup");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  body.append(backLink());
  body.append(el("h1", "", "Malen & Raten"));
  body.append(el("p", "lead", "Einer malt, die anderen tippen. Jedes Handy für sich."));
  const go = el("button", "btn primary", "Raum öffnen");
  go.type = "button";
  go.addEventListener("click", () => enterLobby());
  dock.append(go);
  view.append(body, dock);
  app.replaceChildren(view);
}

function showCrash(err) {
  reportError("Online-Spiel", err);
  const view = el("section", "screen setup");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  body.append(backLink());
  body.append(el("h1", "", "Verbindungsfehler"));
  body.append(el("p", "note is-bad", err?.message || "Das Spiel konnte nicht gestartet werden."));
  const back = el("button", "btn primary", "Zur Lobby");
  back.type = "button";
  back.addEventListener("click", () => {
    leaveOnline().then(() => enterLobby());
  });
  dock.append(back);
  view.append(body, dock);
  app.replaceChildren(view);
}

function renderWaitHost() {
  const view = el("section", "screen");
  const body = el("div", "screen-body");
  body.append(topBar("Malen & Raten"));
  body.append(el("h1", "", "Warte auf Host"));
  body.append(el("p", "lead", "Die Verbindung zum Host ist weg. Das Spiel pausiert."));
  view.append(body);
  app.replaceChildren(view);
}

function renderPick() {
  const me = myId();
  const iPaint = state.painterId === me;
  const view = el("section", "screen");
  const body = el("div", "screen-body");
  body.dataset.malen = "pick";
  body.append(topBar("Malen & Raten"));
  const hud = el("div", "malen-hud");
  hud.append(el("span", "", `Runde ${state.round}/${state.rounds}`));
  const timer = el("strong", "malen-timer", `${remainingSec()}s`);
  timer.setAttribute("data-timer", "1");
  hud.append(timer);
  body.append(hud);
  if (iPaint) {
    body.append(el("p", "lead", "Wähle einen Begriff"));
    const picks = el("div", "malen-picks");
    const choices = secretMine?.choices || secrets.players?.[me]?.choices || secrets.choices || [];
    for (const word of choices) {
      const button = el("button", "btn primary", word);
      button.type = "button";
      button.addEventListener("click", () => sendPick(word));
      picks.append(button);
    }
    if (!choices.length) body.append(el("p", "note", "Begriffe kommen gleich …"));
    body.append(picks);
  } else {
    body.append(el("p", "malen-banner wait", `${state.painterName} wählt …`));
  }
  view.append(body);
  app.replaceChildren(view);
}

function renderDraw() {
  const me = myId();
  const iPaint = state.painterId === me;
  const view = el("section", "screen");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  body.dataset.malen = "draw";
  body.append(topBar("Malen & Raten"));
  const hud = el("div", "malen-hud");
  hud.append(el("span", "", `${state.painterName} malt`));
  const timer = el("strong", "malen-timer", `${remainingSec()}s`);
  timer.setAttribute("data-timer", "1");
  hud.append(timer);
  body.append(hud);
  const word = hostWord(secrets, state.painterId, me, iAmHost()) || (iPaint ? secretMine?.word : null);
  if (iPaint) {
    body.append(el("p", "malen-banner", word ? `Zeichne: ${word}` : "Zeichne den Begriff"));
  } else {
    const mask = el("p", "malen-mask", state.mask || "");
    mask.setAttribute("data-mask", "1");
    const letters = el("small", "", state.letterCount ? `${state.letterCount} Buchstaben` : "");
    letters.setAttribute("data-letters", "1");
    body.append(mask, letters);
    if (iAmHost() && word) body.append(el("p", "note", `Begriff (Host): ${word}`));
  }
  const banner = el("p", "malen-banner");
  banner.setAttribute("data-banner", "1");
  if (state.lastSolved) banner.textContent = `${state.lastSolved} hat es erraten!`;
  else banner.hidden = true;
  body.append(banner);

  const stage = el("div", "malen-stage");
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", "Zeichnung");
  stage.append(canvas);
  body.append(stage);

  if (iPaint) {
    const tools = el("div", "malen-tools");
    const colors = el("div", "malen-colors");
    for (const color of COLORS) {
      const swatch = el("button", "malen-swatch");
      swatch.type = "button";
      swatch.style.background = color;
      swatch.setAttribute("aria-label", "Farbe");
      if (tool.color === color && !tool.erase) swatch.classList.add("is-on");
      swatch.addEventListener("click", () => {
        tool = { ...tool, color, erase: false };
        for (const node of colors.querySelectorAll(".malen-swatch")) node.classList.remove("is-on");
        swatch.classList.add("is-on");
        erase.classList.remove("primary");
      });
      colors.append(swatch);
    }
    const widths = el("div", "malen-widths");
    for (const width of WIDTHS) {
      const button = el("button", "malen-width");
      button.type = "button";
      if (tool.width === width) button.classList.add("is-on");
      const dot = el("i", "");
      dot.style.width = `${8 + width * 400}px`;
      dot.style.height = `${8 + width * 400}px`;
      button.append(dot);
      button.addEventListener("click", () => {
        tool = { ...tool, width };
        for (const node of widths.querySelectorAll(".malen-width")) node.classList.remove("is-on");
        button.classList.add("is-on");
      });
      widths.append(button);
    }
    const acts = el("div", "malen-acts");
    const erase = el("button", tool.erase ? "btn primary" : "btn", "Radierer");
    erase.type = "button";
    erase.addEventListener("click", () => {
      tool = { ...tool, erase: !tool.erase };
      erase.className = tool.erase ? "btn primary" : "btn";
      if (tool.erase) {
        for (const node of colors.querySelectorAll(".malen-swatch")) node.classList.remove("is-on");
      }
    });
    const undo = el("button", "btn", "Rückgängig");
    undo.type = "button";
    undo.addEventListener("click", undoStroke);
    const wipe = el("button", "btn", "Alles löschen");
    wipe.type = "button";
    wipe.addEventListener("click", clearCanvas);
    acts.append(erase, undo, wipe);
    tools.append(colors, widths, acts);
    body.append(tools);
  } else {
    const list = el("ul", "malen-guesses");
    list.setAttribute("data-guesses", "1");
    for (const row of guessList(state).slice(-12)) {
      const item = el("li", "");
      item.append(el("strong", "", row.name), document.createTextNode(row.text));
      list.append(item);
    }
    body.append(list);
    const form = el("form", "malen-form");
    form.setAttribute("data-guess-form", "1");
    const input = el("input", "text-input");
    input.type = "text";
    input.maxLength = 40;
    input.placeholder = "Tipp …";
    input.autocomplete = "off";
    const locked = Boolean(state.guessed?.[me]);
    input.disabled = locked;
    const send = el("button", "btn primary", locked ? "Erraten" : "Tippen");
    send.type = "submit";
    send.disabled = locked;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input.value;
      input.value = "";
      sendGuess(text);
    });
    form.append(input, send);
    dock.append(form);
  }
  view.append(body, dock);
  app.replaceChildren(view);
  bindCanvas(canvas);
  sizeCanvas(canvas);
  requestAnimationFrame(() => sizeCanvas(canvas));
}

function renderReveal() {
  const view = el("section", "screen");
  const body = el("div", "screen-body");
  body.dataset.malen = "reveal";
  body.append(topBar("Malen & Raten"));
  const hud = el("div", "malen-hud");
  const timer = el("strong", "malen-timer", `${remainingSec()}s`);
  timer.setAttribute("data-timer", "1");
  hud.append(el("span", "", "Auflösung"), timer);
  body.append(hud);
  body.append(el("h1", "", state.word || "—"));
  body.append(el("p", "lead", `${state.painterName} hat gemalt.`));
  const list = el("div", "malen-scores");
  for (const player of state.players) {
    const got = state.roundScores?.[player.id] || 0;
    const row = el("div", got ? "malen-score is-up" : "malen-score");
    row.append(el("span", "", player.name), el("strong", "", got ? `+${got}` : "0"));
    list.append(row);
  }
  body.append(list);
  view.append(body);
  app.replaceChildren(view);
}

function renderEnd() {
  const view = el("section", "screen");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  body.append(topBar("Malen & Raten"));
  body.append(el("h1", "", "Rangliste"));
  let place = 1;
  for (const row of ranking(state)) {
    const item = el("div", "malen-rank");
    item.append(el("span", "", `${place}.`), el("strong", "", row.name), el("em", "", `${row.score} Punkte`));
    body.append(item);
    place += 1;
  }
  const again = el("button", "btn primary", "Nochmal");
  again.type = "button";
  again.addEventListener("click", async () => {
    again.disabled = true;
    try {
      if (iAmHost()) await runHost(startRematchNow);
      else await onlineApi.sendAction({ type: "rematch", payload: {} });
    } catch (err) {
      reportError("Nochmal", err);
      again.disabled = false;
    }
  });
  const hub = el("a", "btn", "Zum Hub");
  hub.href = "../../index.html";
  hub.addEventListener("click", (event) => {
    event.preventDefault();
    leaveOnline().then(() => {
      location.href = "../../index.html";
    });
  });
  dock.append(again, hub);
  view.append(body, dock);
  app.replaceChildren(view);
}

function render() {
  if (!state || !onlineRoom) {
    if (lobbyHandle) return;
    renderBoot();
    return;
  }
  preserveScreenScroll(app, () => {
    try {
      if (!iAmHost() && (state.waitingForHost || hostOffline())) {
        renderWaitHost();
        return;
      }
      if (state.phase === "end") renderEnd();
      else if (state.phase === "reveal") renderReveal();
      else if (state.phase === "draw") renderDraw();
      else renderPick();
    } catch (err) {
      showCrash(err);
    }
  });
}

initUpdates();
enterLobby();
