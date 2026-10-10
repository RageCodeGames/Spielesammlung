import { MIN_PLAYERS, MAX_PLAYERS, ROUND_COUNT, tableTotalsMatch } from "./rules.js";
import {
  ROLE_LABEL,
  TYPE_LABEL,
  applyAbort,
  applyClaim,
  applyReveal,
  auditHands,
  beginMatch,
  cardList,
  claimText,
  faceDownCards,
  logLine,
  migrateState,
  normalizeSecret,
  normalizeSecrets,
  packSecrets,
  randomClaim,
  randomTarget,
  shownCounts,
  shownText,
  winnerTitle,
} from "./logic.js";
import { playTone, unlock } from "../../shared/sound.js";
import { preserveScreenScroll } from "../../shared/scroll.js";
import { requestWakeLock } from "../../shared/wakelock.js";
import { initUpdates } from "../../shared/update.js";

const GAME_ID = "tempel";
const DEV_NAMES = ["Nia", "Rolo", "Mira", "Timo", "Suri", "Kale", "Pim", "Vela"];
const RULES_TEXT = [
  "Im Tempel liegen verdeckte Kammern: Gold, Feuerfallen und leere Räume. Jeder bekommt eine geheime Rolle – Abenteurer oder Wächterin – und kennt die Rollen der anderen nicht. Manchmal bleibt sogar eine Rollenkarte ungesehen beiseite.",
  "Die Abenteurer wollen alles Gold aufdecken. Die Wächterinnen wollen das verhindern: entweder indem alle Feuerfallen gefunden werden, oder indem nach der letzten Runde noch Gold versteckt ist.",
  "Zu Beginn jeder Runde bekommt jeder Kammerkarten. Du siehst nur die Anzahlen (Gold, Fallen, leer), nicht die Reihenfolge. Die Karten liegen verdeckt vor dir.",
  "Wer den Schlüssel hat, öffnet eine verdeckte Karte bei jemand anderem. Alle sehen das Ergebnis, danach hat die Person den Schlüssel. Pro Runde gibt es so viele Öffnungen wie Mitspielende. Offene Karten verlassen den Tempel, der Rest wird neu verteilt – jede Runde eine Karte weniger.",
  "Neben deinem Namen kannst du jederzeit eine Ansage setzen: Rolle (oder keine Angabe), Gold und Feuerfallen. Ansagen sind freiwillig und dürfen falsch sein. Mit jeder neuen Runde werden sie gelöscht. Der Verlauf hält fest, was angesagt und was tatsächlich aufgedeckt wurde.",
];

const app = document.getElementById("app");

let onlineApi = null;
let lobbyHandle = null;
let onlineRoom = null;
let state = null;
let secretMine = null;
let secretAll = null;
let entering = false;
let unsubRoom = null;
let unsubAction = null;
let unsubNet = null;
let unsubSecrets = null;
let unsubBadge = null;
let toastTimer = 0;
let botTimer = 0;
let botKey = "";
let hostQueue = Promise.resolve();
let lastRevealSeq = 0;
let peeking = false;
let leavingUi = false;
let leftHandled = new Set();
let lobbyTools = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function asset(name) {
  return `./assets/${name}.svg`;
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
  console.error(`[tempel] ${context}`, err);
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
  unsubBadge?.();
  unsubRoom = unsubAction = unsubNet = unsubSecrets = unsubBadge = null;
  clearBotTimer();
}

async function leaveOnline() {
  clearSubs();
  try {
    await onlineApi?.leaveRoom?.();
  } catch (err) {
    console.error("[tempel] Verlassen", err);
  }
  onlineRoom = null;
  state = null;
  secretMine = null;
  secretAll = null;
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
  renderBoot();
}

function notePeerLeft(player) {
  if (!player?.id || leftHandled.has(player.id)) return;
  leftHandled.add(player.id);
  toast(`${player.name} hat den Raum verlassen`);
  if (!iAmHost() || !state) return;
  handlePeerLeft(player).catch((err) => reportError("Mitspieler weg", err));
}

async function handlePeerLeft(player) {
  if (state.phase === "end") return;
  const next = applyAbort(state, secretAll || {}, player);
  if (next.error) return;
  await publish(next.state, next.secrets);
}

function showRules() {
  const back = el("div", "dialog-back");
  const dialog = el("div", "dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.append(el("h2", "", "Regeln"));
  for (const para of RULES_TEXT) dialog.append(el("p", "", para));
  const close = el("button", "btn primary", "Schließen");
  close.type = "button";
  close.addEventListener("click", () => back.remove());
  dialog.append(close);
  back.addEventListener("click", (event) => {
    if (event.target === back) back.remove();
  });
  back.append(dialog);
  document.body.append(back);
  close.focus();
}

function lobbyExtras(container, { room, isHost }) {
  const rules = el("button", "btn", "Regeln");
  rules.type = "button";
  rules.addEventListener("click", showRules);
  container.append(rules);
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
      title: "Tempelgold",
      lead: "Drei bis zehn Personen, jedes Handy für sich. Der Host startet die Runde.",
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      renderRoomExtra: lobbyExtras,
      async onBeforeStart(room) {
        if (!tableTotalsMatch()) throw new Error("Die Zahlentabelle ist ungültig.");
        const match = beginMatch(room.players);
        secretAll = match.secrets;
        secretMine = match.secrets[myId()] || null;
        await onlineApi.writeAllSecrets(packSecrets(match.secrets));
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
    lastRevealSeq = state?.revealSeq || 0;
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
      onlineRoom = next;
      if (next.state) adoptState(migrateState(next.state));
      else render();
    });
    unsubAction = onlineApi.onAction((action) => {
      handleAction(action).catch((err) => reportError("Aktion", err));
    });
    unsubSecrets = onlineApi.onSecrets((payload) => {
      secretMine = payload?.mine ? normalizeSecret(payload.mine) : null;
      if (payload?.all) secretAll = normalizeSecrets(payload.all);
      if (state && secretAll) auditHands(state, secretAll, "host-secrets");
      else if (state && secretMine) auditHands(state, { [myId()]: secretMine }, "meine-secrets");
      render();
      scheduleBots();
    });
    unsubNet = onlineApi.onConnectionChange(() => render());
    requestWakeLock();
    render();
    scheduleBots();
  } catch (err) {
    showCrash(err);
  }
}

function adoptState(next) {
  const seq = Number(next?.revealSeq) || 0;
  if (seq < lastRevealSeq) lastRevealSeq = 0;
  const prevSeq = lastRevealSeq;
  state = next;
  if (next?.lastReveal?.seq && next.lastReveal.seq > prevSeq) {
    playRevealSound(next.lastReveal.type);
  }
  lastRevealSeq = seq;
  render();
  scheduleBots();
}

function playRevealSound(type) {
  unlock().then(() => {
    if (type === "gold") playTone({ frequency: 784, duration: 0.22, type: "triangle" });
    else if (type === "falle") {
      playTone({ frequency: 196, duration: 0.28, type: "sawtooth" });
    } else playTone({ frequency: 330, duration: 0.16, type: "sine" });
  });
}

/** Alle Host-Änderungen nacheinander – nichts geht verloren, während gespeichert wird. */
function runHost(task) {
  const job = hostQueue.then(task).catch((err) => reportError("Spielstand", err));
  hostQueue = job;
  return job;
}

async function publish(nextState, nextSecrets) {
  if (!iAmHost()) return;
    if (nextSecrets) {
      secretAll = nextSecrets;
      await onlineApi.writeAllSecrets(packSecrets(nextSecrets));
    }
  state = nextState;
  await onlineApi.setState(nextState);
}

function handleAction(action) {
  if (!iAmHost()) return Promise.resolve();
  return runHost(async () => {
    if (!state) return;
    if (action.type === "claim") {
      const next = applyClaim(state, action.from, action.payload?.claim ?? null);
      if (!next.error) await publish(next.state, null);
      return;
    }
    if (action.type === "reveal") {
      if (!secretAll) return;
      const next = applyReveal(state, secretAll, action.from, action.payload?.ownerId, action.payload?.cardId);
      if (!next.error) await publish(next.state, next.secrets);
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
  }).finally(scheduleBots);
}

function botTurnKey() {
  return state ? `${state.phase}:${state.round}:${state.revealSeq}:${state.keyHolderId}` : "";
}

function clearBotTimer() {
  clearTimeout(botTimer);
  botTimer = 0;
  botKey = "";
}

function scheduleBots() {
  if (!iAmHost() || !state || state.phase !== "play") {
    clearBotTimer();
    return;
  }
  const holder = onlineRoom?.players?.find((player) => player.id === state.keyHolderId);
  if (!holder?.dummy) {
    clearBotTimer();
    return;
  }
  const key = botTurnKey();
  if (botTimer && botKey === key) return;
  clearTimeout(botTimer);
  botKey = key;
  const delay = 1000 + Math.floor(Math.random() * 1000);
  botTimer = setTimeout(() => {
    botTimer = 0;
    botKey = "";
    runHost(() => playDummy(holder.id, key)).finally(scheduleBots);
  }, delay);
}

async function playDummy(id, key) {
  if (!iAmHost() || !state || state.phase !== "play") return;
  if (botTurnKey() !== key || state.keyHolderId !== id || !secretAll) return;
  let working = state;
  for (const player of working.players) {
    const isDummy = onlineRoom?.players?.find((row) => row.id === player.id)?.dummy;
    if (!isDummy || player.claim) continue;
    const claimed = applyClaim(working, player.id, randomClaim(working.cardsPerHand));
    if (!claimed.error) working = claimed.state;
  }
  const target = randomTarget(working, id);
  if (!target) return;
  const next = applyReveal(working, secretAll, id, target.ownerId, target.cardId);
  if (next.error) {
    console.error("[tempel] Testspieler", next.error);
    return;
  }
  await publish(next.state, next.secrets);
}

async function sendClaim(claim) {
  if (!state || state.phase !== "play") return;
  if (iAmHost()) {
    await runHost(async () => {
      const next = applyClaim(state, myId(), claim);
      if (next.error) {
        toast(next.error);
        return;
      }
      await publish(next.state, null);
    });
    scheduleBots();
    return;
  }
  try {
    await onlineApi.sendAction({ type: "claim", payload: { claim } });
  } catch (err) {
    reportError("Ansage", err);
  }
}

async function sendReveal(ownerId, cardId) {
  if (!state || state.phase !== "play") return;
  if (state.keyHolderId !== myId()) return;
  if (iAmHost()) {
    await runHost(async () => {
      if (!secretAll || state.keyHolderId !== myId()) return;
      const next = applyReveal(state, secretAll, myId(), ownerId, cardId);
      if (next.error) {
        toast(next.error);
        return;
      }
      await publish(next.state, next.secrets);
    });
    scheduleBots();
    return;
  }
  try {
    await onlineApi.sendAction({ type: "reveal", payload: { ownerId, cardId } });
  } catch (err) {
    reportError("Aufdecken", err);
  }
}

async function startRematchNow() {
  if (!onlineRoom) return;
  clearBotTimer();
  const match = beginMatch(onlineRoom.players);
  lastRevealSeq = 0;
  await publish(match.state, match.secrets);
}

async function startRematch() {
  await runHost(startRematchNow);
  scheduleBots();
}

function showClaimDialog() {
  const me = state.players.find((player) => player.id === myId());
  const max = state.cardsPerHand;
  let role = me?.claim?.role ?? null;
  let gold = Math.min(me?.claim?.gold ?? 0, max);
  let falle = Math.min(me?.claim?.falle ?? 0, max - gold);
  const back = el("div", "dialog-back");
  const dialog = el("div", "dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.append(el("h2", "", "Ansage"));
  dialog.append(el("p", "", `Freiwillig, darf geflunkert sein. Du hast ${max} Karten.`));

  const roles = el("div", "role-pick");
  const roleButtons = [];
  for (const [id, label] of [["abenteurer", "Abenteurer"], ["waechterin", "Wächterin"], [null, "keine Angabe"]]) {
    const button = el("button", "btn", label);
    button.type = "button";
    button.addEventListener("click", () => {
      role = id;
      paint();
    });
    roleButtons.push([id, button]);
    roles.append(button);
  }
  dialog.append(roles);

  const goldRow = el("div", "step-row");
  const goldMinus = el("button", "btn", "−");
  const goldNum = el("strong");
  const goldPlus = el("button", "btn", "+");
  goldRow.append(el("span", "", "Gold"), goldMinus, goldNum, goldPlus);
  const trapRow = el("div", "step-row");
  const trapMinus = el("button", "btn", "−");
  const trapNum = el("strong");
  const trapPlus = el("button", "btn", "+");
  trapRow.append(el("span", "", "Feuerfallen"), trapMinus, trapNum, trapPlus);
  const emptyRow = el("div", "step-row is-auto");
  const emptyNum = el("strong");
  emptyRow.append(el("span", "", "Leer (automatisch)"), emptyNum);
  for (const button of [goldMinus, goldPlus, trapMinus, trapPlus]) button.type = "button";
  goldMinus.addEventListener("click", () => {
    gold = Math.max(0, gold - 1);
    paint();
  });
  goldPlus.addEventListener("click", () => {
    if (gold + falle < max) gold += 1;
    paint();
  });
  trapMinus.addEventListener("click", () => {
    falle = Math.max(0, falle - 1);
    paint();
  });
  trapPlus.addEventListener("click", () => {
    if (gold + falle < max) falle += 1;
    paint();
  });
  dialog.append(goldRow, trapRow, emptyRow);

  const preview = el("p", "claim-preview");
  dialog.append(preview);

  function paint() {
    for (const [id, button] of roleButtons) {
      button.classList.toggle("is-on", id === role);
      button.setAttribute("aria-pressed", id === role ? "true" : "false");
    }
    goldNum.textContent = String(gold);
    trapNum.textContent = String(falle);
    emptyNum.textContent = String(max - gold - falle);
    goldMinus.disabled = gold <= 0;
    trapMinus.disabled = falle <= 0;
    goldPlus.disabled = gold + falle >= max;
    trapPlus.disabled = gold + falle >= max;
    preview.textContent = claimText({ set: true, role, gold, falle }, max);
  }
  paint();

  const save = el("button", "btn primary", "Ansagen");
  save.type = "button";
  save.addEventListener("click", () => {
    back.remove();
    sendClaim({ role, gold, falle });
  });
  dialog.append(save);
  if (me?.claim) {
    const clear = el("button", "btn", "Ansage zurückziehen");
    clear.type = "button";
    clear.addEventListener("click", () => {
      back.remove();
      sendClaim(null);
    });
    dialog.append(clear);
  }
  const cancel = el("button", "btn", "Abbrechen");
  cancel.type = "button";
  cancel.addEventListener("click", () => back.remove());
  dialog.append(cancel);
  back.addEventListener("click", (event) => {
    if (event.target === back) back.remove();
  });
  back.append(dialog);
  document.body.append(back);
}

function bindPeek(button) {
  const open = (event) => {
    event.preventDefault();
    peeking = true;
    button.classList.add("is-open");
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      /* Desktop */
    }
  };
  const close = () => {
    peeking = false;
    button.classList.remove("is-open");
  };
  button.addEventListener("pointerdown", open);
  button.addEventListener("pointerup", close);
  button.addEventListener("pointercancel", close);
  button.addEventListener("pointerleave", close);
  button.addEventListener("contextmenu", (event) => event.preventDefault());
}

function chamberButton(card, options) {
  const button = el("button", "chamber");
  button.type = "button";
  const img = document.createElement("img");
  img.alt = card.shown ? TYPE_LABEL[card.type] || "Kammer" : "Verdeckte Kammer";
  img.src = asset(card.shown ? card.type : "rueckseite");
  button.append(img);
  if (options?.flip) button.classList.add("is-flip");
  if (options?.canPick && !card.shown) {
    button.classList.add("is-open");
    button.addEventListener("click", () => sendReveal(options.ownerId, card.id));
  } else {
    button.disabled = true;
  }
  return button;
}

function renderBoot() {
  const view = el("section", "screen setup");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  body.append(backLink());
  body.append(el("h1", "", "Tempelgold"));
  body.append(el("p", "lead", "Geheime Rollen, Bluff und verdeckte Kammern. Jedes Handy für sich."));
  const go = el("button", "btn primary", "Raum öffnen");
  go.type = "button";
  go.addEventListener("click", () => enterLobby());
  const rules = el("button", "btn", "Regeln");
  rules.type = "button";
  rules.addEventListener("click", showRules);
  dock.append(go, rules);
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

function renderPlay() {
  const me = myId();
  const mine = state.players.find((player) => player.id === me);
  const iHaveKey = state.keyHolderId === me;
  const view = el("section", "screen");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");

  const top = el("div", "lobby-top");
  top.append(el("p", "lobby-kicker", "Tempelgold"));
  const badge = el("div");
  if (unsubBadge) unsubBadge();
  unsubBadge = onlineApi.mountConnectionBadge(badge);
  const tools = el("div", "lobby-top-tools");
  tools.append(badge);
  lobbyTools?.appendRoomMenu(tools, { isHost: iAmHost(), onExit: askLeaveRoom });
  top.append(tools);
  body.append(top);

  const stats = el("div", "tempel-stats");
  const addStat = (label, value) => {
    const item = el("span", "");
    item.append(document.createTextNode(`${label} `), el("strong", "", value));
    stats.append(item);
  };
  addStat("Runde", `${state.round}/${ROUND_COUNT}`);
  addStat("Aufdeckungen", `${state.revealsDone}/${state.revealsNeed}`);
  addStat("Gold", `${state.goldFound}/${state.goldTotal}`);
  addStat("Feuerfallen", `${state.trapFound}/${state.trapTotal}`);
  body.append(stats);

  if (iHaveKey && state.phase === "play") {
    body.append(el("p", "tempel-banner", "Du hast den Schlüssel – wähle eine Karte"));
  } else if (state.phase === "play") {
    const holder = state.players.find((player) => player.id === state.keyHolderId);
    body.append(el("p", "tempel-banner wait", `${holder?.name || "Jemand"} hat den Schlüssel`));
  }

  const own = el("div", "own-panel");
  own.append(el("h2", "", "Dein Bereich"));
  const peek = el("button", "role-peek");
  peek.type = "button";
  peek.append(el("span", "hint", "Gedrückt halten zum Ansehen"));
  const face = el("div", "face");
  if (secretMine?.role) {
    const img = document.createElement("img");
    img.src = asset(secretMine.role);
    img.alt = ROLE_LABEL[secretMine.role];
    face.append(img, el("strong", "", ROLE_LABEL[secretMine.role]));
  } else {
    face.append(el("strong", "", "Noch keine Rolle"));
  }
  peek.append(face);
  bindPeek(peek);
  if (peeking) peek.classList.add("is-open");
  own.append(peek);
  if (state.leftoverRole) {
    own.append(el("p", "lead", "Eine Rollenkarte liegt ungesehen beiseite."));
  }

  const hiddenN = mine ? faceDownCards(mine).length : 0;
  const hiddenCounts = secretMine?.counts;
  own.append(
    el(
      "p",
      "own-hidden",
      hiddenCounts
        ? `Noch verdeckt: ${hiddenN} Karten (davon ${hiddenCounts.gold} Gold / ${hiddenCounts.falle} Fallen / ${hiddenCounts.leer} leer)`
        : `Noch verdeckt: ${hiddenN} Karten`
    )
  );
  const counts = el("div", "counts");
  for (const type of ["gold", "falle", "leer"]) {
    const box = el("div", "count");
    const img = document.createElement("img");
    img.src = asset(type);
    img.alt = TYPE_LABEL[type];
    box.append(img, el("strong", "", String(hiddenCounts ? hiddenCounts[type] : "–")), el("span", "", TYPE_LABEL[type]));
    counts.append(box);
  }
  own.append(counts);
  const shownMine = mine ? shownCounts(mine) : { gold: 0, falle: 0, leer: 0 };
  own.append(el("p", "own-shown", `In dieser Runde bei dir aufgedeckt: ${shownText(shownMine)}`));

  const claim = el("div", "claim-line");
  claim.append(el("span", "", mine?.claim ? claimText(mine.claim, state.cardsPerHand) : "Keine Ansage"));
  const edit = el("button", "btn", "Ansagen");
  edit.type = "button";
  edit.disabled = state.phase !== "play";
  edit.addEventListener("click", showClaimDialog);
  claim.append(edit);
  own.append(claim);
  body.append(own);

  body.append(el("h2", "lobby-list-title", "Im Tempel"));
  for (const player of state.players) {
    const roomPlayer = onlineRoom?.players?.find((row) => row.id === player.id);
    const card = el("div", player.id === me ? "player-card is-self" : "player-card");
    const head = el("div", "player-head");
    const dot = el("span", `lobby-dot${roomPlayer?.online !== false ? " is-on" : ""}`);
    head.append(dot);
    const name = el("span", "name", player.name);
    if (player.id === me) name.textContent += " (Du)";
    head.append(name);
    if (state.keyHolderId === player.id) {
      const key = el("span", "key-mark");
      key.title = "Schlüssel";
      head.append(key);
    }
    card.append(head);
    card.append(el("p", player.claim ? "claim" : "claim is-none", claimText(player.claim, state.cardsPerHand)));
    const shown = shownCounts(player);
    if (shown.gold || shown.falle || shown.leer) {
      card.append(el("p", "shown", `Aufgedeckt diese Runde: ${shownText(shown)}`));
    }
    const row = el("div", "chamber-row");
    const canPick = iHaveKey && player.id !== me && state.phase === "play";
    for (const chamber of faceDownCards(player)) {
      row.append(
        chamberButton(chamber, {
          ownerId: player.id,
          canPick,
        })
      );
    }
    for (const chamber of cardList(player).filter((item) => item.shown)) {
      const flip = state.lastReveal?.seq && state.lastReveal.cardId === chamber.id && state.lastReveal.seq === lastRevealSeq;
      row.append(
        chamberButton(chamber, {
          ownerId: player.id,
          canPick: false,
          flip: Boolean(flip),
        })
      );
    }
    card.append(row);
    body.append(card);
  }

  if (state.log?.length) {
    body.append(el("h2", "lobby-list-title", "Verlauf"));
    const log = el("ul", "log-list");
    for (const entry of [...state.log].reverse()) log.append(el("li", "", logLine(entry)));
    body.append(log);
  }
  appendRoundLog(body);

  const rules = el("button", "btn", "Regeln");
  rules.type = "button";
  rules.addEventListener("click", showRules);
  dock.append(rules);
  view.append(body, dock);
  app.replaceChildren(view);
}

function appendRoundLog(parent) {
  if (!state.roundLog?.length) return;
  parent.append(el("h2", "lobby-list-title", "Ansagen je Runde"));
  for (const round of [...state.roundLog].reverse()) {
    const block = el("div", "round-block");
    block.append(el("p", "round-title", `Runde ${round.round} · ${round.cardsPerHand} Karten`));
    const list = el("ul", "log-list");
    for (const entry of round.entries) {
      const item = el("li", "");
      item.append(el("strong", "", entry.name), document.createTextNode(`: ${claimText(entry.claim, round.cardsPerHand)}`));
      item.append(el("span", "shown", `aufgedeckt: ${shownText(entry.shown)}`));
      list.append(item);
    }
    block.append(list);
    parent.append(block);
  }
}

function renderEnd() {
  const view = el("section", "screen");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  const top = el("div", "lobby-top");
  top.append(el("p", "lobby-kicker", "Tempelgold"));
  const badge = el("div");
  if (unsubBadge) unsubBadge();
  unsubBadge = onlineApi.mountConnectionBadge(badge);
  const tools = el("div", "lobby-top-tools");
  tools.append(badge);
  lobbyTools?.appendRoomMenu(tools, { isHost: iAmHost(), onExit: askLeaveRoom });
  top.append(tools);
  body.append(top);
  body.append(el("h1", "", winnerTitle(state.winner, state.endReason)));
  body.append(
    el(
      "p",
      "lead",
      state.endReason === "left"
        ? `${state.leftName || "Jemand"} hat den Raum verlassen. Das Spiel kann nicht fortgesetzt werden.`
        : state.winner === "abenteurer"
          ? "Alles Gold ist gefunden."
          : state.trapFound >= state.trapTotal
            ? "Alle Feuerfallen sind aufgedeckt."
            : "Nach der letzten Runde blieb Gold verborgen."
    )
  );
  body.append(
    el("p", "note", `Gold ${state.goldFound}/${state.goldTotal} · Feuerfallen ${state.trapFound}/${state.trapTotal}`)
  );
  const list = el("div", "end-roles");
  for (const player of state.players) {
    const role = state.roles?.[player.id] || secretAll?.[player.id]?.role;
    const row = el("div", "end-role");
    if (role) {
      const img = document.createElement("img");
      img.src = asset(role);
      img.alt = ROLE_LABEL[role] || "";
      row.append(img);
    }
    row.append(el("strong", "", player.name));
    row.append(el("span", "", ROLE_LABEL[role] || "unbekannt"));
    list.append(row);
  }
  body.append(list);
  appendRoundLog(body);

  const again = el("button", "btn primary", "Nochmal");
  again.type = "button";
  again.addEventListener("click", async () => {
    again.disabled = true;
    try {
      if (iAmHost()) await startRematch();
      else await onlineApi.sendAction({ type: "rematch", payload: {} });
    } catch (err) {
      reportError("Nochmal", err);
      again.disabled = false;
    }
  });
  const hub = el("button", "btn", "Zum Hub");
  hub.type = "button";
  hub.addEventListener("click", () => {
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
      if (state.phase === "end") renderEnd();
      else renderPlay();
    } catch (err) {
      showCrash(err);
    }
  });
}

initUpdates();
if (!tableTotalsMatch()) console.error("[tempel] Zahlentabelle: Karten ungleich 5 × Spielerzahl");
enterLobby();
