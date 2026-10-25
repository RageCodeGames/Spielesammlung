import { isMuted, mountMuteButton, setMuted } from "../../shared/mute-button.js";
import { mountOrientation, preferredForPlayPhase } from "../../shared/orientation.js";
import { requestWakeLock, releaseWakeLock } from "../../shared/wakelock.js";
import { initUpdates } from "../../shared/update.js";
import {
  completeLoginIfRedirected,
  explainError,
  formatDiagnoseLine,
  getDiagnoseLog,
  getStoredSession,
  isConfigured,
  logDiagnose,
  login,
  logout,
} from "../../shared/spotify.js";
import { showImport } from "./import-ui.js";
import {
  aimChallenge,
  awardTitle,
  beginMatch,
  buyCard,
  catalogCountNeeded,
  challengePlace,
  claimChallenge,
  dropPlayer,
  expireChallenge,
  finishReveal,
  firstValidGap,
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
import { bindTimelineDrag } from "./drag.js";
import { flipPlayEnabled, formatSensorLine, setFlipPlayEnabled, watchFaceDown } from "./flip.js";
import {
  chooseDevice,
  listDevices,
  localDeviceId,
  localPlayStatus,
  pauseLocal,
  playCue,
  refreshPlayDevices,
  resetPlayGate,
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
let flipStarting = false;
let pendingCue = null;
let selectedGap = null;
let sleepHint = "";
let sensorReading = { live: false, beta: null, gamma: null, z: null };
let sensorNoData = false;
let lastHandledCue = "";
let lastAimedGap = null;
let dragStop = null;

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
  logDiagnose(`${context}: ${err?.message || err}`);
  toast(err?.message || "Etwas ist schiefgelaufen.");
}

let pressBound = false;
function bindPressFeedback() {
  if (pressBound) return;
  pressBound = true;
  const down = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const btn = event.target.closest?.("button, .choice, a.back");
    if (!btn || btn.disabled) return;
    document.querySelectorAll(".is-pressed").forEach((node) => node.classList.remove("is-pressed"));
    btn.classList.add("is-pressed");
  };
  const up = () => {
    document.querySelectorAll(".is-pressed").forEach((node) => node.classList.remove("is-pressed"));
  };
  document.addEventListener("pointerdown", down, true);
  document.addEventListener("pointerup", up, true);
  document.addEventListener("pointercancel", up, true);
}
bindPressFeedback();

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

function lobbyExtras(container, { room, isHost, refresh }) {
  function paint() {
    try {
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
        paint();
        if (isMuted()) await pauseLocal();
        await refreshPlayDevices().catch((err) => reportError("Geräte", err));
        await publishStatus();
        paint();
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
            paint();
          });
          meBox.append(out);
          const rows = listDevices();
          const chosen = rows.find((row) => row.id === localDeviceId()) || rows.find((row) => row.active);
          if (chosen) meBox.append(el("p", "note", `Spielt auf: ${chosen.name}`));
          else meBox.append(el("p", "note is-bad", "Dein Spotify schläft – öffne kurz Spotify"));
          const box = el("div", "stack");
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
              paint();
              await publishStatus();
            });
            row.append(radio, el("span", "", `${device.name}${device.active ? " (aktiv)" : ""}`));
            box.append(row);
          }
          if (rows.length) meBox.append(box);
          const refreshBtn = el("button", "btn", "Geräte aktualisieren");
          refreshBtn.type = "button";
          refreshBtn.addEventListener("click", async () => {
            refreshBtn.disabled = true;
            refreshBtn.textContent = "Aktualisiere …";
            try {
              await refreshPlayDevices();
              await publishStatus();
              paint();
            } catch (err) {
              reportError("Geräte", err);
              refreshBtn.disabled = false;
              refreshBtn.textContent = "Geräte aktualisieren";
            }
          });
          meBox.append(refreshBtn);
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
            refresh?.();
          } catch (err) {
            reportError("Testspieler", err);
            add.disabled = false;
          }
        });
        container.append(add);
      }
    } catch (err) {
      reportError("Spotify-Bereich", err);
    }
  }
  paint();
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
    const on = current.goal === n;
    const button = el("button", on ? "btn primary" : "btn", `${n} Karten`);
    button.type = "button";
    button.setAttribute("aria-pressed", on ? "true" : "false");
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
    const on = current.clipSec === sec;
    const button = el("button", on ? "btn primary" : "btn", label);
    button.type = "button";
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.addEventListener("click", () => onChange({ ...current, clipSec: sec }));
    clips.append(button);
  }
  container.append(clips);

  container.append(el("h2", "group-label", "Start-Tokens"));
  const toks = el("div", "btn-row");
  for (const n of TOKEN_START_OPTIONS) {
    const on = current.startTokens === n;
    const button = el("button", on ? "btn primary" : "btn", String(n));
    button.type = "button";
    button.setAttribute("aria-pressed", on ? "true" : "false");
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
      onRenderError(area, err) {
        logDiagnose(`Zeichnen (${area}): ${err?.message || err}`);
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
    if (state?.phase === "listen" && state.cue) pendingCue = state.cue;
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
    startFlipWatch();
    handleIncomingCue(state?.cue);
  } catch (err) {
    showCrash(err);
  }
}

function adoptState(next) {
  const prevCue = state?.cue?.cueId;
  const prevPhase = state?.phase;
  if (next?.phase !== prevPhase) {
    selectedGap = null;
    lastAimedGap = null;
  }
  if (next?.phase === "listen" && next.cue) pendingCue = next.cue;
  else if (next?.phase !== "listen") {
    pendingCue = null;
    resetPlayGate("");
  }
  state = next;
  syncOrientation();
  renderPlay();
  armTick();
  scheduleBots();
  if (next?.cue?.cueId && next.cue.cueId !== prevCue) handleIncomingCue(next.cue);
  else if (!next?.cue || next.phase !== "listen") {
    pauseLocal();
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
    else if (action.type === "challenge-aim") next = aimChallenge(state, from, p.gap);
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
    if (next?.error) {
      if (next.message) toast(next.message);
      return;
    }
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
  startFlipWatch();
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
  if (state.phase === "challenge" || state.phase === "challenge-place") {
    const next = expireChallenge(state, secrets, Date.now());
    if (!next.error) await publish(next.state, next.secrets);
  }
}

function patchTimers() {
  const node = app.querySelector("[data-challenge-timer]");
  if (!node || (state?.phase !== "challenge" && state?.phase !== "challenge-place")) return;
  const left = Math.max(0, Math.ceil((state.challengeUntil - Date.now()) / 1000));
  node.textContent = `${left}s`;
}

function send(type, payload) {
  if (!onlineApi) return;
  const body = payload && typeof payload === "object" ? payload : {};
  if (iAmHost()) {
    handleAction({ type, from: myId(), payload: body }).catch((err) => reportError("Aktion", err));
    return;
  }
  onlineApi.sendAction({ type, payload: body }).catch((err) => reportError("Senden", err));
}

function stopFlip() {
  flipWatch?.stop?.();
  flipWatch = null;
  flipStarting = false;
}

function patchSensorHud() {
  const line = formatSensorLine(sensorReading);
  const status = app.querySelector("[data-sensor-status]");
  const values = app.querySelector("[data-sensor-values]");
  if (status) status.textContent = `Sensor: ${line.status}`;
  if (values) values.textContent = line.values;
}

function listeningCue() {
  if (state?.phase !== "listen") return null;
  return state?.cue || pendingCue || null;
}

function playPendingCue() {
  const cue = listeningCue() || pendingCue;
  if (!cue) {
    logDiagnose("Abspielen nicht: kein Cue lokal");
    return;
  }
  if (isMuted()) {
    logDiagnose("Abspielen nicht: Gerät ist stumm");
    return;
  }
  const status = localPlayStatus();
  if (status === "starting" || status === "playing") return;
  playCue(cue, {
    onSleep: (msg) => {
      sleepHint = msg;
      renderPlay();
    },
    onError: (msg) => {
      sleepHint = msg;
      renderPlay();
    },
  }).then(() => renderPlay());
}

function togglePlayback() {
  const status = localPlayStatus();
  if (status === "starting" || status === "playing") {
    pauseLocal().then(() => renderPlay());
    return;
  }
  playPendingCue();
}

async function startFlipWatch() {
  if (flipWatch || flipStarting) return;
  flipStarting = true;
  sensorNoData = false;
  sensorReading = { live: false, beta: null, gamma: null, z: null };
  try {
    const watch = await watchFaceDown({
      onFaceDown: ({ reason }) => {
        logDiagnose(`Display nach unten erkannt (${reason})`);
      },
      onDown: () => {
        if (!flipPlayEnabled()) {
          logDiagnose("Abspielen nicht: Umdrehen ist aus");
          return;
        }
        if (state?.phase !== "listen") {
          logDiagnose(`Abspielen nicht: Phase ist ${state?.phase || "keine"}`);
          return;
        }
        if (isMuted()) {
          logDiagnose("Abspielen nicht: Gerät ist stumm");
          return;
        }
        if (!listeningCue() && !pendingCue) {
          logDiagnose("Abspielen nicht: Cue liegt noch nicht vor");
          return;
        }
        playPendingCue();
      },
      onUp: () => {
        if (!flipPlayEnabled() || state?.phase !== "listen") return;
        pauseLocal().then(() => renderPlay());
      },
      onReading: (reading) => {
        sensorReading = reading;
        if (reading?.live) sensorNoData = false;
        patchSensorHud();
      },
      onNoData: () => {
        sensorNoData = true;
        logDiagnose("Keine Sensordaten – Abspielen-Knopf nutzen");
      },
    });
    flipWatch = watch;
    if (!watch.supported) {
      sensorNoData = true;
      renderPlay();
    }
  } catch (err) {
    console.error("[zeitsprung] Sensor", err);
    sensorNoData = true;
    renderPlay();
  } finally {
    flipStarting = false;
  }
}

async function handleIncomingCue(cue) {
  if (!cue?.cueId) return;
  pendingCue = cue;
  const fresh = cue.cueId !== lastHandledCue;
  if (fresh) {
    lastHandledCue = cue.cueId;
    resetPlayGate(cue.cueId);
  }
  renderPlay();
  if (isMuted()) return;
  startFlipWatch();
  if (fresh && !flipPlayEnabled()) {
    logDiagnose("Cue empfangen – starte ohne Umdrehen");
    await playCue(cue, {
      onSleep: (msg) => {
        sleepHint = msg;
        renderPlay();
      },
    });
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
    if (foe && Math.random() < 0.7) {
      const next = claimChallenge(state, foe.id);
      if (!next.error) await publish(next.state, null);
      return;
    }
  }
  if (state.phase === "challenge-place") {
    const ch = state.players.find((p) => p.id === state.challengerId);
    if (ch?.dummy) {
      const year = secrets.current?.year;
      const n = (state.timelines[state.activeId] || []).length;
      let gap = year != null ? firstValidGap(state.timelines[state.activeId], year) : Math.floor(Math.random() * (n + 1));
      if (gap === state.proposedGap) gap = (gap + 1) % (n + 1);
      const aimed = aimChallenge(state, ch.id, gap);
      if (!aimed.error) await publish(aimed.state, null);
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
    const extra = player.id === state.challengerId ? " !" : "";
    item.textContent = `${player.name} · ${state.tokens[player.id] || 0}${extra}`;
    row.append(item);
  }
  return row;
}

function pickGap(gap) {
  if (gap == null) return;
  if (state.phase === "challenge-place" && gap === state.proposedGap) return;
  selectedGap = gap;
  if (state.phase === "challenge-place" && myId() === state.challengerId && gap !== lastAimedGap) {
    lastAimedGap = gap;
    send("challenge-aim", { gap });
  }
  renderPlay();
}

function confirmPlace() {
  if (selectedGap == null) return;
  if (state.phase === "challenge-place") send("challenge-place", { gap: selectedGap });
  else send("place", { gap: selectedGap });
  selectedGap = null;
}

function timelineRow(cards, { ownerId, interactive, highlightGap, aimGap, lockedGap, mine }) {
  const box = el("div", "zs-tl-box");
  const wrap = el("div", `zs-tl${mine ? "" : " is-foreign"}`);
  wrap.setAttribute(mine ? "data-my-tl" : "data-work-tl", "1");
  const list = readCards(cards);
  const picker = interactive;
  const addGap = (g) => {
    const locked = lockedGap === g;
    const gap = el("button", "zs-gap", locked ? "●" : "▾");
    gap.type = "button";
    gap.setAttribute("data-gap", String(g));
    gap.title = locked ? "Gewählte Lücke" : "Hier einsortieren";
    if (!picker || locked) {
      gap.disabled = true;
      gap.classList.add(locked ? "is-lock" : "is-idle");
    } else {
      gap.addEventListener("click", () => pickGap(g));
    }
    if (selectedGap === g) gap.classList.add("is-on");
    if (highlightGap === g) gap.classList.add("is-pick");
    if (aimGap === g) gap.classList.add("is-aim");
    wrap.append(gap);
  };
  addGap(0);
  list.forEach((card, i) => {
    wrap.append(cardNode(card));
    addGap(i + 1);
  });
  box.append(wrap);
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
  btn.setAttribute("aria-label", "Songkarte");
  btn.setAttribute("data-drag-label", "?");
  btn.append(el("span", "zs-vinyl-q", "?"));
  const mine = myId() === state.activeId;
  if (mine && state.phase === "turn" && !state.played) {
    btn.addEventListener("click", () => send("play-card"));
  }
  return btn;
}

function challengeMarker() {
  const btn = el("button", "zs-marker");
  btn.type = "button";
  btn.setAttribute("aria-label", "Herausforderungs-Marke");
  btn.setAttribute("data-drag-label", "▾");
  btn.textContent = "▾";
  return btn;
}

function playFallbackButton() {
  if (isMuted()) return null;
  if (state.phase !== "listen") return null;
  if (!listeningCue()) return null;
  const status = localPlayStatus();
  const label = status === "playing" || status === "starting" ? "Pause" : status === "paused" ? "Weiter" : "Abspielen";
  const playBtn = el("button", "btn primary", label);
  playBtn.type = "button";
  playBtn.addEventListener("click", () => togglePlayback());
  return playBtn;
}

function showDiagnose() {
  document.querySelector(".zs-diag-back")?.remove();
  const back = el("div", "zs-diag-back");
  const dialog = el("div", "zs-diag");
  dialog.setAttribute("role", "dialog");
  const line = formatSensorLine(sensorReading);
  dialog.append(el("h2", "", "Diagnose"));
  dialog.append(el("p", "", `Sensor: ${line.status}`));
  dialog.append(el("p", "zs-sensor-values", line.values));
  if (sensorNoData) {
    dialog.append(el("p", "note", "Dein Browser liefert keine Sensordaten – nutze den Abspielen-Knopf"));
  }
  const flipRow = el("label", "switch-row");
  const flip = document.createElement("input");
  flip.type = "checkbox";
  flip.checked = flipPlayEnabled();
  flip.addEventListener("change", () => {
    setFlipPlayEnabled(flip.checked);
    if (!flip.checked && listeningCue() && !isMuted()) playPendingCue();
  });
  flipRow.append(flip, el("span", "", "Umdrehen zum Abspielen"));
  dialog.append(flipRow);
  const log = el("pre", "zs-diag-log");
  const rows = getDiagnoseLog();
  log.textContent = rows.length ? rows.slice(0, 24).map(formatDiagnoseLine).join("\n") : "Noch keine Einträge.";
  dialog.append(log);
  const close = el("button", "btn primary", "Schließen");
  close.type = "button";
  close.addEventListener("click", () => back.remove());
  dialog.append(close);
  back.addEventListener("click", (event) => {
    if (event.target === back) back.remove();
  });
  back.append(dialog);
  document.body.append(back);
}

function renderPlay() {
  if (!state) return;
  try {
    renderPlayView();
  } catch (err) {
    console.error("[zeitsprung] Zeichnen", err);
    logDiagnose(`Zeichnen fehlgeschlagen: ${err?.message || err}`);
  }
}

function renderPlayView() {
  if (state.waitingForHost) {
    app.replaceChildren(el("p", "lead", "Warte auf den Host …"));
    return;
  }
  const me = myId();
  const mine = state.timelines?.[me] || [];
  const active = playerName(state, state.activeId);
  const scrollMine = app.querySelector("[data-my-tl]")?.scrollLeft || 0;
  const scrollWork = app.querySelector("[data-work-tl]")?.scrollLeft || 0;
  dragStop?.();
  dragStop = null;

  muteControl?.destroy();
  const view = el("section", "screen zs-play");
  const topbar = el("div", "zs-bar");
  if (lobbyTools) {
    lobbyTools.appendRoomMenu(topbar, {
      isHost: iAmHost(),
      onExit: askLeaveRoom,
      extra: [{ label: "Diagnose", onClick: showDiagnose }],
    });
  }
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
  const side = el("div", "zs-side");
  side.append(tokenStrip());
  const center = el("div", "zs-center");
  const actions = el("div", "zs-actions");
  if (sleepHint) center.append(el("p", "spotify-sleep-hint", sleepHint));

  const phase = state.phase;
  const inChallenge = phase === "challenge" || phase === "challenge-place";
  let vinyl = null;
  let marker = null;

  if (phase === "end") {
    center.append(el("h1", "zs-win", `${playerName(state, state.winnerId)} gewinnt`));
    if (iAmHost()) {
      const again = el("button", "btn primary", "Nochmal");
      again.type = "button";
      again.addEventListener("click", () => send("rematch"));
      actions.append(again);
    }
  } else if (phase === "reveal") {
    const r = state.reveal || {};
    center.append(el("p", "zs-reveal-title", r.title || ""));
    center.append(el("p", "zs-reveal-meta", `${r.artist || ""} · ${r.year || ""}`));
    const how =
      r.result === "keep"
        ? `${active} behält die Karte.`
        : r.result === "steal"
          ? `${playerName(state, r.holderId)} übernimmt die Karte.`
          : "Die Karte wird abgelegt.";
    center.append(el("p", "lead", how));
    if (iAmHost()) {
      const award = el("button", "btn", "Titel & Interpret richtig");
      award.type = "button";
      award.disabled = state.awarded;
      award.addEventListener("click", () => send("award"));
      const next = el("button", "btn primary", "Weiter");
      next.type = "button";
      next.addEventListener("click", () => send("next"));
      actions.append(award, next);
    }
  } else if (inChallenge) {
    center.append(el("p", "lead", `${active} hat gelegt`));
    const t = el("strong", "", "");
    t.setAttribute("data-challenge-timer", "1");
    const left = Math.max(0, Math.ceil((state.challengeUntil - Date.now()) / 1000));
    t.textContent = `${left}s`;
    center.append(t);
    if (phase === "challenge-place") {
      center.append(el("p", "note", `${playerName(state, state.challengerId)} fordert heraus`));
      if (state.challengeGap != null) {
        center.append(el("p", "note", `Lücke ${Number(state.challengeGap) + 1}`));
      }
    }
    if (phase === "challenge" && me !== state.activeId && (state.tokens[me] || 0) > 0 && !state.challengerId) {
      const ch = el("button", "btn primary", "Herausfordern");
      ch.type = "button";
      ch.addEventListener("click", () => send("challenge"));
      actions.append(ch);
    }
    if (phase === "challenge-place" && me === state.challengerId) {
      marker = challengeMarker();
      center.append(marker);
      const go = el("button", "btn primary zs-lock", "Festlegen");
      go.type = "button";
      go.disabled = selectedGap == null || selectedGap === state.proposedGap;
      go.addEventListener("click", confirmPlace);
      actions.append(go);
    }
  } else {
    center.append(el("p", "lead", me === state.activeId ? "Du bist dran" : `${active} ist dran`));
    vinyl = vinylButton();
    center.append(vinyl);
    if (phase === "listen") {
      const playBtn = playFallbackButton();
      if (playBtn) actions.append(playBtn);
    }
    if (me === state.activeId && phase === "listen" && selectedGap != null) {
      const go = el("button", "btn primary zs-lock", "Festlegen");
      go.type = "button";
      go.addEventListener("click", confirmPlace);
      actions.append(go);
    }
    if (me === state.activeId && (phase === "turn" || phase === "listen")) {
      const row = el("div", "zs-actions-row");
      const skip = el("button", "btn zs-btn-mini", "Überspringen");
      skip.type = "button";
      skip.disabled = (state.tokens[me] || 0) < 1;
      skip.title = "Überspringen (1 Token)";
      skip.addEventListener("click", () => send("skip"));
      const buy = el("button", "btn zs-btn-mini", "Kaufen");
      buy.type = "button";
      buy.disabled = (state.tokens[me] || 0) < 3;
      buy.title = "Karte kaufen (3 Tokens)";
      buy.addEventListener("click", () => send("buy"));
      row.append(skip, buy);
      actions.append(row);
    }
  }

  upper.append(side, center, actions);

  const lower = el("div", "zs-lower");
  if (phase === "end") {
    const strip = el("div", "zs-end-strip");
    for (const player of state.players) {
      const block = el("div", "zs-end-one");
      block.append(el("p", "zs-mine-label", player.name));
      block.append(
        timelineRow(state.timelines[player.id], {
          ownerId: player.id,
          interactive: false,
          mine: player.id === me,
        })
      );
      strip.append(block);
    }
    lower.append(strip);
  } else if (inChallenge) {
    const chPlace = me === state.challengerId && phase === "challenge-place";
    lower.append(el("p", "zs-mine-label", `Zeitleiste von ${active}`));
    lower.append(
      timelineRow(state.timelines[state.activeId], {
        ownerId: state.activeId,
        interactive: chPlace,
        highlightGap: state.proposedGap,
        aimGap: state.challengeGap,
        lockedGap: state.proposedGap,
        mine: false,
      })
    );
  } else {
    lower.append(el("p", "zs-mine-label", "Deine Zeitleiste"));
    lower.append(
      timelineRow(mine, {
        ownerId: me,
        interactive: me === state.activeId && phase === "listen",
        mine: true,
      })
    );
  }

  board.append(upper, lower);
  view.append(board);
  app.replaceChildren(view);
  const myTl = app.querySelector("[data-my-tl]");
  if (myTl) myTl.scrollLeft = scrollMine;
  const workTl = app.querySelector("[data-work-tl]");
  if (workTl) workTl.scrollLeft = scrollWork;
  patchTimers();

  const dragTl = app.querySelector("[data-my-tl], [data-work-tl]");
  const canDragListen = vinyl && me === state.activeId && phase === "listen";
  const canDragChallenge = marker && me === state.challengerId && phase === "challenge-place";
  if (dragTl && (canDragListen || canDragChallenge)) {
    dragStop = bindTimelineDrag({
      source: canDragChallenge ? marker : vinyl,
      timeline: dragTl,
      lockedGap: canDragChallenge ? state.proposedGap : null,
      onDrop: pickGap,
    });
  }
}

function isLayoutPreview() {
  try {
    return new URL(location.href).searchParams.get("layout") === "1";
  } catch {
    return false;
  }
}

function renderLayoutPreview() {
  orientation.setPreferred("landscape");
  lobbyTools = {
    appendRoomMenu(parent) {
      const btn = el("button", "btn room-menu-btn", "⋯");
      btn.type = "button";
      parent.append(btn);
    },
  };
  onlineApi = { isHost: () => true, getPlayerId: () => "a" };
  state = {
    phase: "listen",
    players: [
      { id: "a", name: "Anna" },
      { id: "b", name: "Ben" },
      { id: "c", name: "Nia" },
    ],
    tokens: { a: 2, b: 1, c: 1 },
    activeId: "a",
    timelines: {
      a: [{ id: "1", title: "Highway", artist: "Band", year: 1979 }],
      b: [{ id: "2", title: "Night", artist: "Duo", year: 1984 }],
      c: [{ id: "3", title: "River", artist: "Trio", year: 1991 }],
    },
    cue: { cueId: "preview", trackUri: "spotify:track:x", playlistUri: "spotify:playlist:y" },
    played: true,
  };
  selectedGap = 1;
  renderPlay();
}

if (isLayoutPreview()) {
  renderLayoutPreview();
} else {
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
}
