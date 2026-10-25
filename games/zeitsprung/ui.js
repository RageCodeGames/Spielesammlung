import { isMuted, mountMuteButton, setMuted } from "../../shared/mute-button.js";
import { mountOrientation, preferredForPlayPhase } from "../../shared/orientation.js";
import { requestWakeLock, releaseWakeLock } from "../../shared/wakelock.js";
import { initUpdates } from "../../shared/update.js";
import {
  completeLoginIfRedirected,
  explainError,
  getStoredSession,
  isConfigured,
  login,
  logout,
} from "../../shared/spotify.js";
import { showImport } from "./import-ui.js";
import {
  awardTitle,
  beginMatch,
  buyCard,
  catalogCountNeeded,
  challengePlace,
  claimChallenge,
  dropPlayer,
  expireChallenge,
  finishReveal,
  gapOk,
  migrateState,
  mixCatalogs,
  normalizeSecrets,
  normalizeSettings,
  packSecrets,
  pauseForHost,
  playerName,
  proposePlace,
  resumeHost,
  skipSong,
  summarizeSettings,
  tapCard,
} from "./logic.js";
import { flipPlayEnabled, setFlipPlayEnabled, watchFaceDown } from "./flip.js";
import {
  chooseDevice,
  listDevices,
  localDeviceId,
  pauseLocal,
  playCue,
  refreshPlayDevices,
  spotifyStatusFromDevices,
} from "./playback.js";
import { DEV_NAMES, GAME_ID, GOAL_OPTIONS, MAX_PLAYERS, MIN_PLAYERS, TOKEN_START_OPTIONS } from "./rules.js";
import { listSonglists, loadSonglist } from "./songlist-store.js";

const app = document.getElementById("app");
const orientation = mountOrientation("portrait");
const VIEW_KEY = "kajuete:zs-view";

/** Orientierung nur aus der Spielphase – nicht pro Bildschirm. */
function syncOrientation() {
  orientation.setPreferred(preferredForPlayPhase(state?.phase));
}

let session = getStoredSession();
let bootError = "";
let catalogs = [];
let onlineApi = null;
let lobbyHandle = null;
let lobbyTools = null;
let onlineRoom = null;
let state = null;
let secrets = { deck: [], current: null, used: {} };
let entering = false;
let leavingUi = false;
let leftHandled = new Set();
let unsubRoom = null;
let unsubAction = null;
let unsubNet = null;
let unsubSecrets = null;
let unsubBadge = null;
let hostQueue = Promise.resolve();
let tickTimer = 0;
let botTimer = 0;
let toastTimer = 0;
let muteControl = null;
let flipWatch = null;
let pendingCue = null;
let selectedGap = null;
let sleepHint = "";
let lastHandledCue = "";

initUpdates();

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

function rememberView(view) {
  try {
    sessionStorage.setItem(VIEW_KEY, view);
  } catch {
    /* privat */
  }
}

function savedView() {
  try {
    return sessionStorage.getItem(VIEW_KEY) || "";
  } catch {
    return "";
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
  console.error(`[zeitsprung] ${context}`, err);
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

function sameSpotifyAccounts(players) {
  const counts = new Map();
  for (const player of players || []) {
    if (player.dummy || player.spotifyStatus === "muted") continue;
    const key = player.spotifyUserId || "";
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.values()].some((n) => n > 1);
}

function clearSubs() {
  unsubRoom?.();
  unsubAction?.();
  unsubNet?.();
  unsubSecrets?.();
  unsubBadge?.();
  unsubRoom = unsubAction = unsubNet = unsubSecrets = unsubBadge = null;
  clearInterval(tickTimer);
  tickTimer = 0;
  clearTimeout(botTimer);
  botTimer = 0;
  stopFlip();
  muteControl?.destroy();
  muteControl = null;
}

async function leaveOnline() {
  clearSubs();
  releaseWakeLock();
  try {
    await onlineApi?.leaveRoom?.();
  } catch (err) {
    console.error("[zeitsprung] Verlassen", err);
  }
  onlineRoom = null;
  state = null;
  leavingUi = false;
  leftHandled = new Set();
  pendingCue = null;
  syncOrientation();
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
    await publish(next.state, next.secrets);
  }).catch((err) => reportError("Mitspieler weg", err));
}

function runHost(task) {
  const job = hostQueue.then(task).catch((err) => reportError("Spielstand", err));
  hostQueue = job;
  return job;
}

async function publish(nextState, nextSecrets) {
  if (!iAmHost()) return;
  if (nextSecrets) {
    secrets = nextSecrets;
    await onlineApi.writeAllSecrets(packSecrets(nextSecrets));
  }
  state = nextState;
  await onlineApi.setState(nextState);
}

async function publishStatus() {
  if (!onlineApi?.getRoomCode?.() && !onlineRoom) return;
  const muted = isMuted();
  const status = spotifyStatusFromDevices(muted);
  try {
    await onlineApi.updateSelfPlayer({
      spotifyName: muted ? "" : session?.displayName || "",
      spotifyUserId: muted ? "" : session?.userId || "",
      spotifyStatus: status,
    });
  } catch (err) {
    console.error("[zeitsprung] Status", err);
  }
}

function renderBoot() {
  rememberView("boot");
  state = null;
  syncOrientation();
  releaseWakeLock();
  const view = el("section", "screen setup");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  body.append(backLink());
  body.append(el("h1", "", "Zeitsprung"));
  body.append(
    el("p", "lead", "Songs auf der Zeitleiste einsortieren. Wer zuerst genug Karten hat, gewinnt.")
  );
  if (bootError) body.append(el("p", "note is-bad", bootError));
  if (isDev()) body.append(el("p", "note", "Testmodus: Testspieler sind stumm und spielen mit."));
  const play = el("button", "btn primary", "Raum öffnen");
  play.type = "button";
  play.addEventListener("click", () => enterLobby());
  const lists = el("button", "btn", "Songliste vorbereiten");
  lists.type = "button";
  lists.addEventListener("click", () => openImport());
  dock.append(play, lists);
  view.append(body, dock);
  app.replaceChildren(view);
}

function openImport() {
  rememberView("import");
  state = null;
  syncOrientation();
  showImport(app, {
    session,
    bootError,
    onBack() {
      rememberView("boot");
      renderBoot();
    },
  });
}

function lobbyExtras(container, { room, isHost }) {
  container.innerHTML = "";
  if (sameSpotifyAccounts(room.players)) {
    container.append(
      el("p", "note is-bad", "Ein Spotify-Konto kann nur auf einem Gerät gleichzeitig abspielen")
    );
  }
  const meBox = el("div", "zs-lobby-me");
  meBox.append(el("h2", "group-label", "Dein Spotify"));
  const muteRow = el("label", "switch-row");
  const mute = document.createElement("input");
  mute.type = "checkbox";
  mute.checked = isMuted();
  mute.addEventListener("change", async () => {
    setMuted(mute.checked);
    if (mute.checked) await pauseLocal();
    await refreshPlayDevices().catch(() => {});
    await publishStatus();
  });
  muteRow.append(mute, el("span", "", "Stumm (ohne Spotify-Anmeldung)"));
  meBox.append(muteRow);

  if (!isMuted()) {
    if (!session) {
      const loginBtn = el("button", "btn", "Mit Spotify anmelden");
      loginBtn.type = "button";
      loginBtn.addEventListener("click", async () => {
        rememberView("lobby");
        try {
          await login();
        } catch (err) {
          reportError("Anmeldung", err);
        }
      });
      meBox.append(loginBtn);
    } else {
      meBox.append(el("p", "", `Konto: ${session.displayName}`));
      const out = el("button", "btn", "Abmelden");
      out.type = "button";
      out.addEventListener("click", async () => {
        logout();
        session = null;
        await publishStatus();
      });
      meBox.append(out);
      const box = el("div", "stack");
      const rows = listDevices();
      if (!rows.length) meBox.append(el("p", "note is-bad", "Dein Spotify schläft – öffne kurz Spotify"));
      for (const device of rows) {
        const row = el("label", "switch-row");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "zs-device";
        radio.value = device.id;
        radio.checked = device.id === localDeviceId();
        radio.addEventListener("change", async () => {
          if (!radio.checked) return;
          chooseDevice(device.id);
          await publishStatus();
        });
        row.append(radio, el("span", "", `${device.name}${device.active ? " (aktiv)" : ""}`));
        box.append(row);
      }
      meBox.append(box);
      const refresh = el("button", "btn", "Geräte aktualisieren");
      refresh.type = "button";
      refresh.addEventListener("click", async () => {
        try {
          await refreshPlayDevices();
          await publishStatus();
        } catch (err) {
          reportError("Geräte", err);
        }
      });
      meBox.append(refresh);
    }
  }
  container.append(meBox);

  if (isHost && isDev()) {
    const add = el("button", "btn", "Testspieler hinzufügen");
    add.type = "button";
    add.disabled = room.players.length >= MAX_PLAYERS;
    add.addEventListener("click", async () => {
      add.disabled = true;
      try {
        const used = new Set(room.players.map((p) => p.name));
        const name = DEV_NAMES.find((n) => !used.has(n)) || `Test ${room.players.length}`;
        await onlineApi.addDummyPlayer(name);
      } catch (err) {
        reportError("Testspieler", err);
      }
    });
    container.append(add);
  }
  publishStatus();
}

function renderSettings(container, { settings, onChange }) {
  const current = normalizeSettings(settings);
  container.append(el("h2", "group-label", "Songliste / Variante"));
  if (!catalogs.length) {
    container.append(el("p", "note is-bad", "Keine Variante gespeichert. Zuerst eine Songliste importieren."));
  }
  const mixRow = el("label", "switch-row");
  const mixBox = document.createElement("input");
  mixBox.type = "checkbox";
  mixBox.checked = current.mix || current.playlistIds.length > 1;
  mixBox.addEventListener("change", () => {
    const ids = mixBox.checked ? current.playlistIds : current.playlistIds.slice(0, 1);
    onChange({ ...current, playlistIds: ids, mix: mixBox.checked });
  });
  mixRow.append(mixBox, el("span", "", "Mix (mehrere Varianten)"));
  container.append(mixRow);
  const mixOn = mixBox.checked;
  for (const cat of catalogs) {
    const row = el("label", "switch-row");
    const box = document.createElement("input");
    box.type = mixOn ? "checkbox" : "radio";
    box.name = mixOn ? `zs-var-${cat.playlistId}` : "zs-variant";
    box.checked = current.playlistIds.includes(cat.playlistId);
    box.addEventListener("change", () => {
      if (!mixOn) {
        onChange({ ...current, playlistIds: [cat.playlistId], mix: false });
        return;
      }
      const ids = new Set(current.playlistIds);
      if (box.checked) ids.add(cat.playlistId);
      else ids.delete(cat.playlistId);
      const next = [...ids];
      onChange({ ...current, playlistIds: next, mix: true });
    });
    row.append(box, el("span", "", `${cat.name} (${cat.songCount} Songs)`));
    container.append(row);
  }
  if (mixOn) {
    container.append(el("p", "note", "Songs werden zusammengemischt, ohne doppelte Titel. Jeder Song kommt aus seiner Playlist."));
  }

  container.append(el("h2", "group-label", "Ziel"));
  const goals = el("div", "btn-row");
  for (const n of GOAL_OPTIONS) {
    const button = el("button", current.goal === n ? "btn primary" : "btn", `${n} Karten`);
    button.type = "button";
    button.addEventListener("click", () => onChange({ ...current, goal: n }));
    goals.append(button);
  }
  container.append(goals);

  container.append(el("h2", "group-label", "Abspieldauer"));
  const clips = el("div", "btn-row");
  for (const [sec, label] of [
    [30, "30 Sekunden"],
    [0, "Ganzer Song"],
  ]) {
    const button = el("button", current.clipSec === sec ? "btn primary" : "btn", label);
    button.type = "button";
    button.addEventListener("click", () => onChange({ ...current, clipSec: sec }));
    clips.append(button);
  }
  container.append(clips);

  container.append(el("h2", "group-label", "Start-Tokens"));
  const toks = el("div", "btn-row");
  for (const n of TOKEN_START_OPTIONS) {
    const button = el("button", current.startTokens === n ? "btn primary" : "btn", String(n));
    button.type = "button";
    button.addEventListener("click", () => onChange({ ...current, startTokens: n }));
    toks.append(button);
  }
  container.append(toks);

  const ch = el("label", "switch-row");
  const chBox = document.createElement("input");
  chBox.type = "checkbox";
  chBox.checked = current.challengeOn;
  chBox.addEventListener("change", () => onChange({ ...current, challengeOn: chBox.checked }));
  ch.append(chBox, el("span", "", "Herausfordern"));
  container.append(ch);
}

async function enterLobby() {
  if (entering && lobbyHandle) return;
  entering = true;
  rememberView("lobby");
  state = null;
  syncOrientation();
  try {
    const [lobbyMod, api] = await Promise.all([
      import("../../shared/lobby.js"),
      import("../../shared/online.js"),
    ]);
    lobbyTools = lobbyMod;
    onlineApi = api;
    catalogs = await listSonglists().catch((err) => {
      reportError("Songlisten", err);
      return [];
    });
    await refreshPlayDevices().catch(() => {});
    lobbyHandle?.destroy();
    const initial = normalizeSettings({
      playlistIds: catalogs[0] ? [catalogs[0].playlistId] : [],
      mix: false,
      goal: 10,
      clipSec: 30,
      startTokens: 1,
      challengeOn: true,
    });
    lobbyHandle = lobbyMod.mountLobby(app, {
      gameId: GAME_ID,
      title: "Zeitsprung",
      lead: "Zwei bis zehn Personen. Songs auf der Zeitleiste einsortieren.",
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      renderRoomExtra: lobbyExtras,
      settingsPanel: {
        initial,
        summarize: (raw) => summarizeSettings(raw, catalogs),
        render: renderSettings,
      },
      async onBeforeStart(room) {
        const settings = normalizeSettings(room.settings);
        if (!settings.playlistIds.length) throw new Error("Bitte mindestens eine Variante wählen.");
        const lists = [];
        for (const id of settings.playlistIds) {
          const list = await loadSonglist(id);
          if (list) lists.push(list);
        }
        const songs = mixCatalogs(lists);
        const need = catalogCountNeeded(room.players.length, settings.goal);
        if (songs.length < need) {
          throw new Error(`Zu wenige Songs in der Auswahl (${songs.length}, nötig ca. ${need}).`);
        }
        const match = beginMatch(room.players, settings, songs);
        secrets = match.secrets;
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
        state = null;
        syncOrientation();
        renderBoot();
      },
    });
  } catch (err) {
    entering = false;
    state = null;
    syncOrientation();
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
    syncOrientation();
    requestWakeLock();
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
      const hostGone = next.players?.some((p) => p.isHost && p.online === false);
      onlineRoom = next;
      if (!iAmHost() && state && hostGone && !state.waitingForHost) state = pauseForHost(state);
      if (!iAmHost() && state?.waitingForHost && next.players?.some((p) => p.isHost && p.online !== false)) {
        state = resumeHost(state);
      }
      if (next.state) adoptState(migrateState(next.state));
      else renderPlay();
    });
    unsubAction = onlineApi.onAction((action) => {
      handleAction(action).catch((err) => reportError("Aktion", err));
    });
    unsubSecrets = onlineApi.onSecrets((payload) => {
      if (payload?.all) secrets = normalizeSecrets(payload.all);
    });
    unsubNet = onlineApi.onConnectionChange((ok) => {
      if (iAmHost() && ok && state?.waitingForHost) {
        runHost(() => publish(resumeHost(state), null));
      } else if (iAmHost() && !ok && state && !state.waitingForHost) {
        runHost(() => publish(pauseForHost(state), null));
      }
    });
    renderPlay();
    armTick();
    scheduleBots();
    handleIncomingCue(state?.cue);
  } catch (err) {
    showCrash(err);
  }
}

function adoptState(next) {
  const prevCue = state?.cue?.cueId;
  const prevPhase = state?.phase;
  if (next?.phase !== prevPhase) selectedGap = null;
  state = next;
  syncOrientation();
  renderPlay();
  armTick();
  scheduleBots();
  if (next?.cue?.cueId && next.cue.cueId !== prevCue) handleIncomingCue(next.cue);
  else if (!next?.cue || next.phase !== "listen") {
    pauseLocal();
    if (next?.phase !== "listen") pendingCue = null;
  }
}

function handleAction(action) {
  if (!iAmHost()) return Promise.resolve();
  return runHost(async () => {
    if (!state) return;
    const from = action.from;
    const p = action.payload || {};
    let next = null;
    if (action.type === "play-card") next = tapCard(state, secrets, from);
    else if (action.type === "place") next = proposePlace(state, secrets, from, p.gap);
    else if (action.type === "skip") next = skipSong(state, secrets, from);
    else if (action.type === "buy") next = buyCard(state, secrets, from);
    else if (action.type === "challenge") next = claimChallenge(state, from);
    else if (action.type === "challenge-place") next = challengePlace(state, secrets, from, p.gap);
    else if (action.type === "award") next = awardTitle(state, from, onlineRoom?.hostId);
    else if (action.type === "next") next = finishReveal(state, secrets);
    else if (action.type === "leave") {
      const who = state.players.find((row) => row.id === from);
      notePeerLeft({ id: from, name: p.name || who?.name || "Jemand" });
      return;
    } else if (action.type === "rematch" && state.phase === "end") {
      await rematchNow();
      return;
    }
    if (next?.error) return;
    if (next?.state) await publish(next.state, next.secrets);
  });
}

async function rematchNow() {
  if (!onlineRoom) return;
  lastHandledCue = "";
  pendingCue = null;
  selectedGap = null;
  sleepHint = "";
  stopFlip();
  const settings = normalizeSettings(onlineRoom.settings || state);
  const lists = [];
  for (const id of settings.playlistIds) {
    const list = await loadSonglist(id);
    if (list) lists.push(list);
  }
  const match = beginMatch(onlineRoom.players, settings, mixCatalogs(lists));
  await publish(match.state, match.secrets);
}

function armTick() {
  clearInterval(tickTimer);
  tickTimer = 0;
  if (!iAmHost() || !state || state.phase === "end") return;
  tickTimer = window.setInterval(() => {
    runHost(hostTick);
    patchTimers();
  }, 250);
}

async function hostTick() {
  if (!iAmHost() || !state || state.waitingForHost) return;
  if (state.phase === "challenge") {
    const next = expireChallenge(state, secrets, Date.now());
    if (!next.error) await publish(next.state, next.secrets);
  }
}

function patchTimers() {
  const node = app.querySelector("[data-challenge-timer]");
  if (!node || state?.phase !== "challenge") return;
  const left = Math.max(0, Math.ceil((state.challengeUntil - Date.now()) / 1000));
  node.textContent = `${left}s`;
}

function send(type, payload) {
  if (!onlineApi) return;
  if (iAmHost()) {
    handleAction({ type, from: myId(), payload }).catch((err) => reportError("Aktion", err));
    return;
  }
  onlineApi.sendAction({ type, payload }).catch((err) => reportError("Senden", err));
}

function stopFlip() {
  flipWatch?.stop?.();
  flipWatch = null;
}

async function handleIncomingCue(cue) {
  if (!cue?.cueId || cue.cueId === lastHandledCue) return;
  lastHandledCue = cue.cueId;
  pendingCue = cue;
  if (isMuted()) return;
  if (!flipPlayEnabled()) {
    await playCue(cue, { onSleep: (msg) => { sleepHint = msg; renderPlay(); } });
    return;
  }
  stopFlip();
  const watch = await watchFaceDown({
    onDown: () => playCue(cue, { onSleep: (msg) => { sleepHint = msg; renderPlay(); } }),
    onUp: () => pauseLocal(),
  });
  flipWatch = watch;
  if (!watch.supported) {
    /* Knopf in der UI */
    renderPlay();
  }
}

function scheduleBots() {
  if (!isDev() || !iAmHost() || !state || state.waitingForHost) return;
  clearTimeout(botTimer);
  const delay = 600 + Math.floor(Math.random() * 900);
  botTimer = window.setTimeout(() => runHost(runBots), delay);
}

async function runBots() {
  if (!state || !isDev()) return;
  const dummies = state.players.filter((p) => p.dummy);
  if (!dummies.length) return;
  const active = state.players.find((p) => p.id === state.activeId);
  if (active?.dummy && (state.phase === "turn" || state.phase === "listen")) {
    if (state.phase === "turn" && (state.tokens[active.id] || 0) >= 1 && Math.random() < 0.12) {
      const next = skipSong(state, secrets, active.id);
      if (!next.error) await publish(next.state, next.secrets);
      return;
    }
    if (state.phase === "turn" && (state.tokens[active.id] || 0) >= 3 && Math.random() < 0.08) {
      const next = buyCard(state, secrets, active.id);
      if (!next.error) await publish(next.state, next.secrets);
      return;
    }
    if (state.phase === "turn") {
      const next = tapCard(state, secrets, active.id);
      if (!next.error) await publish(next.state, next.secrets);
      return;
    }
    if (state.phase === "listen") {
      const n = (state.timelines[active.id] || []).length;
      const gap = Math.floor(Math.random() * (n + 1));
      const next = proposePlace(state, secrets, active.id, gap);
      if (!next.error) await publish(next.state, next.secrets);
      return;
    }
  }
  if (state.phase === "challenge") {
    const foe = dummies.find((p) => p.id !== state.activeId && (state.tokens[p.id] || 0) > 0);
    if (foe && Math.random() < 0.35) {
      const next = claimChallenge(state, foe.id);
      if (!next.error) await publish(next.state, null);
      return;
    }
  }
  if (state.phase === "challenge-place") {
    const ch = state.players.find((p) => p.id === state.challengerId);
    if (ch?.dummy) {
      const n = (state.timelines[state.activeId] || []).length;
      let gap = Math.floor(Math.random() * (n + 1));
      if (gap === state.proposedGap) gap = (gap + 1) % (n + 1);
      const next = challengePlace(state, secrets, ch.id, gap);
      if (!next.error) await publish(next.state, next.secrets);
      return;
    }
  }
  if (state.phase === "reveal") {
    const who = state.players.find((p) => p.id === state.activeId);
    if (!who?.dummy) return;
    const next = finishReveal(state, secrets);
    if (!next.error) await publish(next.state, next.secrets);
    return;
  }
  scheduleBots();
}

function showCrash(err) {
  reportError("Online-Spiel", err);
  state = null;
  syncOrientation();
  const view = el("section", "screen setup");
  const body = el("div", "screen-body");
  body.append(backLink());
  body.append(el("h1", "", "Verbindungsfehler"));
  body.append(el("p", "note is-bad", err?.message || "Das Spiel konnte nicht gestartet werden."));
  view.append(body);
  app.replaceChildren(view);
}

function tokenStrip() {
  const row = el("div", "zs-tokens");
  for (const player of state.players) {
    const item = el("span", player.id === state.activeId ? "zs-token is-on" : "zs-token");
    item.textContent = `${player.name} · ${state.tokens[player.id] || 0}`;
    row.append(item);
  }
  return row;
}

function timelineRow(cards, { ownerId, interactive, highlightGap, foreign }) {
  const box = el("div", "zs-tl-box");
  const wrap = el("div", `zs-tl${foreign ? " is-foreign" : ""}`);
  wrap.setAttribute(foreign ? "data-foreign-tl" : "data-my-tl", "1");
  const list = readCards(cards);
  const picker = interactive && (state.phase === "listen" || state.phase === "challenge-place");
  const placeGap = (gap) => {
    selectedGap = gap;
    renderPlay();
  };
  const confirm = () => {
    if (selectedGap == null) return;
    if (state.phase === "challenge-place") send("challenge-place", { gap: selectedGap });
    else send("place", { gap: selectedGap });
    selectedGap = null;
  };
  const addGap = (g) => {
    const gap = el("button", `zs-gap${selectedGap === g ? " is-on" : ""}`, "▾");
    gap.type = "button";
    gap.title = "Hier einsortieren";
    if (!picker) {
      gap.disabled = true;
      gap.classList.add("is-idle");
    } else {
      gap.addEventListener("click", () => placeGap(g));
    }
    if (highlightGap === g) gap.classList.add("is-pick");
    wrap.append(gap);
  };
  addGap(0);
  list.forEach((card, i) => {
    wrap.append(cardNode(card));
    addGap(i + 1);
  });
  box.append(wrap);
  if (picker) {
    const go = el("button", "btn primary zs-lock", "Festlegen");
    go.type = "button";
    go.disabled = selectedGap == null;
    if (state.phase === "challenge-place" && selectedGap === state.proposedGap) go.disabled = true;
    go.addEventListener("click", confirm);
    box.append(go);
  }
  void ownerId;
  return box;
}

function readCards(cards) {
  return Array.isArray(cards) ? cards : Object.values(cards || {});
}

function cardNode(card) {
  const node = el("article", "zs-card");
  node.append(el("strong", "zs-card-year", String(card.year || "")));
  node.append(el("span", "zs-card-title", card.title || ""));
  node.append(el("span", "zs-card-artist", card.artist || ""));
  return node;
}

function vinylButton() {
  const btn = el("button", "zs-vinyl");
  btn.type = "button";
  btn.setAttribute("aria-label", "Songkarte umdrehen");
  btn.append(el("span", "zs-vinyl-q", "?"));
  const mine = myId() === state.activeId;
  if (mine && state.phase === "turn" && !state.played) {
    btn.addEventListener("click", () => send("play-card"));
  } else {
    btn.disabled = true;
  }
  return btn;
}

function playFallbackButton() {
  if (isMuted() || !pendingCue) return null;
  if (!flipPlayEnabled()) return null;
  if (flipWatch?.supported) return null;
  if (state.phase !== "listen") return null;
  const playBtn = el("button", "btn primary", "Abspielen");
  playBtn.type = "button";
  playBtn.addEventListener("click", () => {
    playCue(pendingCue, {
      onSleep: (msg) => {
        sleepHint = msg;
        renderPlay();
      },
    });
  });
  return playBtn;
}

function renderPlay() {
  if (!state) return;
  if (state.waitingForHost) {
    app.replaceChildren(el("p", "lead", "Warte auf den Host …"));
    return;
  }
  const me = myId();
  const mine = state.timelines?.[me] || [];
  const active = playerName(state, state.activeId);
  const scroll = app.querySelector("[data-my-tl]")?.scrollLeft || 0;

  muteControl?.destroy();
  const view = el("section", "screen zs-play");
  const topbar = el("div", "zs-bar");
  if (lobbyTools) lobbyTools.appendRoomMenu(topbar, { isHost: iAmHost(), onExit: askLeaveRoom });
  const tools = el("div", "zs-bar-tools");
  muteControl = mountMuteButton(tools, {
    onMute: pauseLocal,
    onChange() {
      if (isMuted()) pauseLocal();
      publishStatus();
    },
  });
  topbar.append(tools);
  view.append(topbar);

  const board = el("div", "zs-board");
  const upper = el("div", "zs-upper");
  upper.append(tokenStrip());
  if (sleepHint) upper.append(el("p", "spotify-sleep-hint", sleepHint));

  if (state.phase === "end") {
    const win = playerName(state, state.winnerId);
    upper.append(el("h1", "zs-win", `${win} gewinnt`));
    if (iAmHost()) {
      const again = el("button", "btn primary", "Nochmal");
      again.type = "button";
      again.addEventListener("click", () => send("rematch"));
      upper.append(again);
    }
    for (const player of state.players) {
      upper.append(el("h2", "lobby-list-title", player.name));
      upper.append(timelineRow(state.timelines[player.id], { ownerId: player.id, interactive: false, foreign: true }));
    }
  } else if (state.phase === "reveal") {
    const r = state.reveal || {};
    upper.append(el("p", "zs-reveal-title", r.title || ""));
    upper.append(el("p", "zs-reveal-meta", `${r.artist || ""} · ${r.year || ""}`));
    const how =
      r.result === "keep"
        ? `${active} behält die Karte.`
        : r.result === "steal"
          ? `${playerName(state, r.holderId)} übernimmt die Karte.`
          : "Die Karte wird abgelegt.";
    upper.append(el("p", "lead", how));
    if (iAmHost()) {
      const row = el("div", "btn-row");
      const award = el("button", "btn", "Titel & Interpret richtig");
      award.type = "button";
      award.disabled = state.awarded;
      award.addEventListener("click", () => send("award"));
      const next = el("button", "btn primary", "Weiter");
      next.type = "button";
      next.addEventListener("click", () => send("next"));
      row.append(award, next);
      upper.append(row);
    }
  } else if (state.phase === "challenge" || state.phase === "challenge-place") {
    upper.append(el("p", "lead", `${active} hat gelegt`));
    if (state.phase === "challenge") {
      const t = el("strong", "", "");
      t.setAttribute("data-challenge-timer", "1");
      const left = Math.max(0, Math.ceil((state.challengeUntil - Date.now()) / 1000));
      t.textContent = `${left}s`;
      upper.append(t);
      if (me !== state.activeId && (state.tokens[me] || 0) > 0 && !state.challengerId) {
        const ch = el("button", "btn primary", "Herausfordern");
        ch.type = "button";
        ch.addEventListener("click", () => send("challenge"));
        upper.append(ch);
      } else if (me !== state.activeId) {
        upper.append(el("p", "note", "Warten …"));
      }
    } else {
      upper.append(el("p", "note", `${playerName(state, state.challengerId)} legt eine andere Lücke fest.`));
    }
    const chPlace = me === state.challengerId && state.phase === "challenge-place";
    upper.append(
      timelineRow(state.timelines[state.activeId], {
        ownerId: state.activeId,
        interactive: chPlace,
        foreign: true,
        highlightGap: state.proposedGap,
      })
    );
  } else if (me === state.activeId) {
    upper.append(el("p", "lead", "Du bist dran"));
    upper.append(vinylButton());
    const fallback = playFallbackButton();
    if (fallback) upper.append(fallback);
    const spend = el("div", "btn-row");
    const skip = el("button", "btn", "Überspringen (1 Token)");
    skip.type = "button";
    skip.disabled = (state.tokens[me] || 0) < 1;
    skip.addEventListener("click", () => send("skip"));
    const buy = el("button", "btn", "Karte kaufen (3 Tokens)");
    buy.type = "button";
    buy.disabled = (state.tokens[me] || 0) < 3;
    buy.addEventListener("click", () => send("buy"));
    spend.append(skip, buy);
    upper.append(spend);
  } else {
    upper.append(el("p", "lead", `${active} ist dran`));
    upper.append(vinylButton());
    const fallback = playFallbackButton();
    if (fallback) upper.append(fallback);
    upper.append(timelineRow(state.timelines[state.activeId], { ownerId: state.activeId, interactive: false, foreign: true }));
  }

  if (state.phase !== "end") {
    const flipRow = el("label", "switch-row zs-flip");
    const flip = document.createElement("input");
    flip.type = "checkbox";
    flip.checked = flipPlayEnabled();
    flip.addEventListener("change", () => {
      setFlipPlayEnabled(flip.checked);
      if (!flip.checked && pendingCue && state.phase === "listen" && !isMuted()) {
        playCue(pendingCue, {
          onSleep: (msg) => {
            sleepHint = msg;
            renderPlay();
          },
        });
      }
    });
    flipRow.append(flip, el("span", "", "Umdrehen zum Abspielen"));
    upper.append(flipRow);
  }

  const lower = el("div", "zs-lower");
  lower.append(el("p", "zs-mine-label", "Deine Zeitleiste"));
  const canPlace = me === state.activeId && state.phase === "listen";
  lower.append(
    timelineRow(mine, {
      ownerId: me,
      interactive: canPlace,
      foreign: false,
    })
  );

  board.append(upper, lower);
  view.append(board);
  app.replaceChildren(view);
  const tl = app.querySelector("[data-my-tl]");
  if (tl) tl.scrollLeft = scroll;
  patchTimers();
}

completeLoginIfRedirected()
  .then((ok) => {
    if (ok) session = getStoredSession();
  })
  .catch((err) => {
    bootError = explainError(err);
    console.error("[zeitsprung] Redirect", err);
  })
  .finally(() => {
    session = getStoredSession();
    if (savedView() === "import") openImport();
    else if (savedView() === "lobby") enterLobby();
    else renderBoot();
  });
