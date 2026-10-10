import { MIN_PLAYERS, MAX_PLAYERS, ROUND_COUNT, tableTotalsMatch } from "./rules.js";
import {
  ROLE_LABEL,
  TYPE_LABEL,
  applyClaim,
  applyReveal,
  beginMatch,
  cardList,
  logLine,
  migrateState,
  normalizeSecret,
  normalizeSecrets,
  randomClaim,
  randomTarget,
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
  "Neben dem Namen kannst du eine Ansage setzen (Gold und Feuerfallen). Ansagen sind freiwillig und dürfen falsch sein.",
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
let lastRevealSeq = 0;
let busy = false;
let peeking = false;

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
  clearTimeout(botTimer);
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
        await onlineApi.writeAllSecrets(match.secrets);
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
      if (!next || next.status === "kicked") {
        const kicked = next?.status === "kicked";
        leaveOnline().then(() => {
          toast(kicked ? "Du wurdest entfernt." : "Der Raum wurde geschlossen.");
          renderBoot();
        });
        return;
      }
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
  const prevSeq = lastRevealSeq;
  state = next;
  if (next?.lastReveal?.seq && next.lastReveal.seq > prevSeq) {
    playRevealSound(next.lastReveal.type);
    lastRevealSeq = next.lastReveal.seq;
  } else if (next?.revealSeq) {
    lastRevealSeq = next.revealSeq;
  }
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

async function publish(nextState, nextSecrets) {
  if (!iAmHost()) return;
  busy = true;
  try {
    if (nextSecrets) {
      secretAll = nextSecrets;
      await onlineApi.writeAllSecrets(nextSecrets);
    }
    await onlineApi.setState(nextState);
    state = nextState;
  } catch (err) {
    reportError("Spielstand", err);
  } finally {
    busy = false;
  }
}

async function handleAction(action) {
  if (!iAmHost() || !state || busy) return;
  if (action.type === "claim") {
    const next = applyClaim(state, action.from, action.payload?.gold, action.payload?.falle);
    if (next.error) return;
    await publish(next.state, null);
    return;
  }
  if (action.type === "reveal") {
    if (!secretAll) return;
    const next = applyReveal(
      state,
      secretAll,
      action.from,
      action.payload?.ownerId,
      action.payload?.cardId
    );
    if (next.error) return;
    await publish(next.state, next.secrets);
    return;
  }
  if (action.type === "rematch") {
    if (state.phase !== "end") return;
    await startRematch();
  }
}

function scheduleBots() {
  if (botTimer) return;
  if (!iAmHost() || !state || state.phase !== "play" || busy) return;
  const holder = onlineRoom?.players?.find((player) => player.id === state.keyHolderId);
  if (!holder?.dummy) return;
  botTimer = setTimeout(() => {
    botTimer = 0;
    playDummy(holder.id).catch((err) => reportError("Testspieler", err));
  }, 900);
}

async function playDummy(id) {
  if (!iAmHost() || !state || state.phase !== "play" || busy) return;
  if (state.keyHolderId !== id) return;
  const player = state.players.find((row) => row.id === id);
  if (!player) return;
  if (!player.hasClaim) {
    const claim = randomClaim(player);
    const next = applyClaim(state, id, claim.gold, claim.falle);
    if (!next.error) await publish(next.state, null);
  }
  botTimer = setTimeout(() => {
    botTimer = 0;
    playDummyReveal(id).catch((err) => reportError("Testspieler", err));
  }, 700);
}

async function playDummyReveal(id) {
  if (!iAmHost() || !state || state.phase !== "play" || busy) return;
  if (state.keyHolderId !== id || !secretAll) return;
  const target = randomTarget(state, id);
  if (!target) return;
  const next = applyReveal(state, secretAll, id, target.ownerId, target.cardId);
  if (next.error) return;
  await publish(next.state, next.secrets);
}

async function sendClaim(gold, falle) {
  if (!state || state.phase !== "play") return;
  if (iAmHost()) {
    const next = applyClaim(state, myId(), gold, falle);
    if (next.error) {
      toast(next.error);
      return;
    }
    await publish(next.state, null);
    return;
  }
  try {
    await onlineApi.sendAction({ type: "claim", payload: { gold, falle } });
  } catch (err) {
    reportError("Ansage", err);
  }
}

async function sendReveal(ownerId, cardId) {
  if (!state || state.phase !== "play" || busy) return;
  if (state.keyHolderId !== myId()) return;
  if (iAmHost()) {
    if (!secretAll) return;
    const next = applyReveal(state, secretAll, myId(), ownerId, cardId);
    if (next.error) {
      toast(next.error);
      return;
    }
    await publish(next.state, next.secrets);
    return;
  }
  try {
    await onlineApi.sendAction({ type: "reveal", payload: { ownerId, cardId } });
  } catch (err) {
    reportError("Aufdecken", err);
  }
}

async function startRematch() {
  if (!onlineRoom) return;
  const match = beginMatch(onlineRoom.players);
  lastRevealSeq = 0;
  await publish(match.state, match.secrets);
}

function showClaimDialog() {
  const me = state.players.find((player) => player.id === myId());
  let gold = me?.hasClaim ? me.claimGold : 0;
  let falle = me?.hasClaim ? me.claimFalle : 0;
  const max = state.cardsPerHand;
  const back = el("div", "dialog-back");
  const dialog = el("div", "dialog");
  dialog.append(el("h2", "", "Ansage"));
  dialog.append(el("p", "", "Die Zahlen dürfen stimmen oder nicht. Alle sehen sie neben deinem Namen."));
  const goldRow = stepper("Gold", gold, max, (n) => {
    gold = n;
  });
  const trapRow = stepper("Feuerfallen", falle, max, (n) => {
    falle = n;
  });
  dialog.append(goldRow, trapRow);
  const save = el("button", "btn primary", "Ansage setzen");
  save.type = "button";
  save.addEventListener("click", () => {
    back.remove();
    sendClaim(gold, falle);
  });
  const cancel = el("button", "btn", "Abbrechen");
  cancel.type = "button";
  cancel.addEventListener("click", () => back.remove());
  dialog.append(save, cancel);
  back.append(dialog);
  document.body.append(back);
}

function stepper(label, start, max, onChange) {
  let value = start;
  const row = el("div", "step-row");
  row.append(el("span", "", label));
  const minus = el("button", "btn", "−");
  minus.type = "button";
  const num = el("strong", "", String(value));
  const plus = el("button", "btn", "+");
  plus.type = "button";
  const paint = () => {
    num.textContent = String(value);
    minus.disabled = value <= 0;
    plus.disabled = value >= max;
    onChange(value);
  };
  minus.addEventListener("click", () => {
    value = Math.max(0, value - 1);
    paint();
  });
  plus.addEventListener("click", () => {
    value = Math.min(max, value + 1);
    paint();
  });
  row.append(minus, num, plus);
  paint();
  return row;
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
  top.append(badge);
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

  const counts = el("div", "counts");
  for (const type of ["gold", "falle", "leer"]) {
    const box = el("div", "count");
    const img = document.createElement("img");
    img.src = asset(type);
    img.alt = TYPE_LABEL[type];
    box.append(img, el("strong", "", String(secretMine?.counts?.[type] ?? "–")), el("span", "", TYPE_LABEL[type]));
    counts.append(box);
  }
  own.append(counts);

  const claim = el("div", "claim-line");
  claim.append(
    el(
      "span",
      "",
      mine?.hasClaim ? `Ansage: ${mine.claimGold} Gold, ${mine.claimFalle} Feuerfallen` : "Keine Ansage"
    )
  );
  const edit = el("button", "btn", mine?.hasClaim ? "Ändern" : "Ansage");
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
    head.append(
      el(
        "span",
        "claim",
        player.hasClaim ? `${player.claimGold} Gold · ${player.claimFalle} Fallen` : "keine Ansage"
      )
    );
    card.append(head);
    const row = el("div", "chamber-row");
    const canPick = iHaveKey && player.id !== me && state.phase === "play";
    for (const chamber of cardList(player)) {
      const flip = state.lastReveal?.seq && state.lastReveal.cardId === chamber.id && state.lastReveal.seq === lastRevealSeq;
      row.append(
        chamberButton(chamber, {
          ownerId: player.id,
          canPick,
          flip: Boolean(flip && chamber.shown),
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

  const rules = el("button", "btn", "Regeln");
  rules.type = "button";
  rules.addEventListener("click", showRules);
  dock.append(rules);
  view.append(body, dock);
  app.replaceChildren(view);
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
  top.append(badge);
  body.append(top);
  body.append(el("h1", "", winnerTitle(state.winner)));
  body.append(
    el(
      "p",
      "lead",
      state.winner === "abenteurer"
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
