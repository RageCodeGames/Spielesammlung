import { isMuted, mountMuteButton, setMuted } from "../../shared/mute-button.js";
import { mountOrientation, preferredForPlayPhase } from "../../shared/orientation.js";
import { get, set } from "../../shared/storage.js";
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
  countUniqueSongs,
  dealCue,
  effectiveMix,
  mixCatalogs,
  normalizeSecrets,
  normalizeSettings,
  packSecrets,
  pauseForHost,
  playerName,
  proposePlace,
  replaceUnavailableSong,
  resumeHost,
  skipSong,
  START_MODE_RANDOM,
  START_MODE_START,
  summarizeSettings,
  tapCard,
} from "./logic.js";
import { bindTimelineDrag } from "./drag.js";
import {
  bindCardPeek,
  faceDownCard,
  faceUpCard,
  hideCardPeek,
  revealFlipCard,
} from "./cards.js";
import { flipPlayEnabled, formatSensorLine, setFlipPlayEnabled, watchFaceDown } from "./flip.js";
import {
  acceptCueOnArrival,
  checkDeviceOnCue,
  chooseDevice,
  listDevices,
  localDeviceId,
  localPlayStatus,
  pauseLocal,
  playCue,
  refreshPlayDevices,
  resetPlayGate,
  spotifyStatusFromDevices,
  stopPlayback,
} from "./playback.js";
import {
  BUY_COST,
  CHALLENGE_COST,
  DEV_NAMES,
  GAME_ID,
  GOAL_OPTIONS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  SKIP_COST,
  TOKEN_START_DEFAULT,
  TOKEN_START_OPTIONS,
  VARIANT_PREFS_KEY,
} from "./rules.js";
import { listSonglists, loadSonglist, markSongUnplayable } from "./songlist-store.js";

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
let peekStop = null;
let revealFlipKey = "";
/** Cue-ID, für die der Umdreh-Hinweis schon weg kann (Song lief). */
let flipHintDoneCue = "";
let lastUnavailableCue = "";
let lastNotice = "";

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

function dismissToast() {
  clearTimeout(toastTimer);
  toastTimer = 0;
  document.querySelector(".toast")?.remove();
}

function toast(message) {
  dismissToast();
  const node = el("div", "toast", message);
  node.setAttribute("role", "status");
  node.addEventListener("click", dismissToast);
  document.body.append(node);
  toastTimer = setTimeout(() => node.remove(), 4000);
}

function clearPlayError() {
  sleepHint = "";
  dismissToast();
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
  try {
    await stopPlayback();
  } catch (err) {
    console.error("[zeitsprung] Stop beim Verlassen", err);
  }
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

function rememberVariantPrefs(settings) {
  const s = normalizeSettings(settings);
  set(VARIANT_PREFS_KEY, {
    mix: s.mix === true || s.playlistIds.length >= 2,
    playlistIds: s.playlistIds,
  });
}

function loadVariantPrefs() {
  const raw = get(VARIANT_PREFS_KEY, null);
  if (!raw || typeof raw !== "object") return null;
  const ids = Array.isArray(raw.playlistIds)
    ? raw.playlistIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  return {
    mix: raw.mix === true || ids.length >= 2,
    playlistIds: [...new Set(ids)],
  };
}

function applyVariantChange(current, patch, onChange) {
  const next = normalizeSettings({ ...current, ...patch });
  rememberVariantPrefs(next);
  onChange(next);
}

function renderSettings(container, { settings, onChange }) {
  const current = normalizeSettings(settings);
  container.append(el("h2", "group-label", "Songliste / Variante"));
  if (!catalogs.length) {
    container.append(el("p", "note is-bad", "Keine Variante gespeichert. Zuerst eine Songliste importieren."));
  }
  const mixOn = current.mix === true || current.playlistIds.length >= 2;
  const mixRow = el("label", "switch-row");
  const mixBox = document.createElement("input");
  mixBox.type = "checkbox";
  mixBox.checked = mixOn;
  mixBox.addEventListener("change", () => {
    if (mixBox.checked) {
      applyVariantChange(current, { mix: true, playlistIds: current.playlistIds }, onChange);
      return;
    }
    applyVariantChange(
      current,
      { mix: false, playlistIds: current.playlistIds.slice(0, 1) },
      onChange
    );
  });
  mixRow.append(mixBox, el("span", "", "Mix (Varianten einzeln anhaken)"));
  container.append(mixRow);

  if (mixOn) {
    container.append(el("p", "note", "Mindestens zwei Varianten wählen. Doppelte Songs nur einmal, Wiedergabe aus der Herkunfts-Playlist."));
    for (const cat of catalogs) {
      const row = el("label", "switch-row");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.name = `zs-mix-${cat.playlistId}`;
      box.checked = current.playlistIds.includes(cat.playlistId);
      box.addEventListener("change", () => {
        const ids = new Set(current.playlistIds);
        if (box.checked) ids.add(cat.playlistId);
        else ids.delete(cat.playlistId);
        applyVariantChange(current, { mix: true, playlistIds: [...ids] }, onChange);
      });
      row.append(box, el("span", "", `${cat.name} (${cat.songCount} Songs)`));
      container.append(row);
    }
    const n = current.playlistIds.length;
    const unique = countUniqueSongs(current.playlistIds, catalogs);
    if (n < 2) {
      container.append(el("p", "note is-bad", "Noch mindestens eine weitere Variante anhaken – sonst gilt eine normale Variante."));
    } else {
      container.append(el("p", "note", `Mix gesamt: ${unique} Songs (ohne Doppelte, ${n} Varianten)`));
    }
  } else {
    for (const cat of catalogs) {
      const row = el("label", "switch-row");
      const box = document.createElement("input");
      box.type = "radio";
      box.name = "zs-variant";
      box.checked = current.playlistIds[0] === cat.playlistId;
      box.addEventListener("change", () => {
        if (!box.checked) return;
        applyVariantChange(current, { mix: false, playlistIds: [cat.playlistId] }, onChange);
      });
      row.append(box, el("span", "", `${cat.name} (${cat.songCount} Songs)`));
      container.append(row);
    }
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

  container.append(el("h2", "group-label", "Startpunkt"));
  const starts = el("div", "btn-row");
  for (const [mode, label] of [
    [START_MODE_RANDOM, "Zufällig"],
    [START_MODE_START, "Anfang"],
  ]) {
    const on = current.startMode === mode;
    const button = el("button", on ? "btn primary" : "btn", label);
    button.type = "button";
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.addEventListener("click", () => onChange({ ...current, startMode: mode }));
    starts.append(button);
  }
  container.append(starts);

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
    const prefs = loadVariantPrefs();
    const known = new Set(catalogs.map((row) => row.playlistId));
    const prefIds = (prefs?.playlistIds || []).filter((id) => known.has(id));
    const initial = normalizeSettings({
      playlistIds: prefIds.length
        ? prefs.mix && prefIds.length >= 1
          ? prefIds
          : prefIds.slice(0, 1)
        : catalogs[0]
          ? [catalogs[0].playlistId]
          : [],
      mix: Boolean(prefs?.mix) && prefIds.length >= 1,
      goal: 10,
      clipSec: 30,
      startMode: START_MODE_RANDOM,
      startTokens: TOKEN_START_DEFAULT,
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
        const ids = effectiveMix(settings) ? settings.playlistIds : settings.playlistIds.slice(0, 1);
        if (!ids.length) throw new Error("Bitte mindestens eine Variante wählen.");
        if (settings.mix && ids.length < 2) {
          /* Mix-Intent mit nur einer Liste → normale Variante */
        }
        rememberVariantPrefs({ ...settings, playlistIds: ids, mix: ids.length >= 2 });
        const lists = [];
        for (const id of ids) {
          const list = await loadSonglist(id);
          if (list) lists.push(list);
        }
        const songs = mixCatalogs(lists);
        const need = catalogCountNeeded(room.players.length, settings.goal);
        if (songs.length < need) {
          throw new Error(`Zu wenige Songs in der Auswahl (${songs.length}, nötig ca. ${need}).`);
        }
        const match = beginMatch(room.players, { ...settings, playlistIds: ids, mix: ids.length >= 2 }, songs);
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

function shouldStopPlayback(prevPhase, prevActive, prevCue, next) {
  if (!next) return false;
  if (next.phase === "reveal" || next.phase === "end") return true;
  if (next.phase === "turn") {
    if (prevPhase && prevPhase !== "turn") return true;
    if (prevActive && prevActive !== next.activeId) return true;
    if (prevCue && !next.cue && !next.played) return true;
  }
  return false;
}

function ensureHostCue() {
  if (!iAmHost() || !state || state.waitingForHost) return;
  if (state.phase !== "turn" || state.played || state.cue) return;
  if (!secrets?.current) return;
  const dealt = dealCue(state, secrets);
  if (dealt.error && !dealt.state?.cue) {
    if (dealt.message) toast(dealt.message);
    return;
  }
  if (dealt.state) {
    publish(dealt.state, dealt.secrets).catch((err) => reportError("Cue", err));
  }
}

function adoptState(next) {
  const prevCue = state?.cue?.cueId;
  const prevPhase = state?.phase;
  const prevActive = state?.activeId;
  if (next?.phase !== prevPhase) {
    selectedGap = null;
    lastAimedGap = null;
  }
  if (next?.phase === "listen" && next.cue) pendingCue = next.cue;
  else if (next?.phase !== "listen") {
    pendingCue = null;
    /* Clip-Timer weiterlaufen lassen; nur Abspiel-Sperre öffnen */
    resetPlayGate("");
  }
  if (
    (next?.cue?.cueId && next.cue.cueId !== prevCue) ||
    next?.activeId !== prevActive ||
    (next?.phase !== "listen" && next?.phase !== "turn")
  ) {
    sleepHint = "";
  }
  state = next;
  syncOrientation();
  renderPlay();
  armTick();
  scheduleBots();
  if (next?.cue?.cueId && next.cue.cueId !== prevCue) handleIncomingCue(next.cue);
  else if (shouldStopPlayback(prevPhase, prevActive, prevCue, next)) {
    stopPlayback();
  }
  if (next?.notice && next.notice !== lastNotice) {
    lastNotice = next.notice;
    toast(next.notice);
  } else if (!next?.notice) {
    lastNotice = "";
  }
  ensureHostCue();
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
    else if (action.type === "song-unavailable") {
      await applyUnavailableSong(p);
      return;
    } else if (action.type === "buy") next = buyCard(state, secrets, from);
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
  lastUnavailableCue = "";
  lastNotice = "";
  pendingCue = null;
  selectedGap = null;
  clearPlayError();
  stopFlip();
  await stopPlayback();
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

function playlistIdFromCue(cue) {
  return String(cue?.playlistUri || "")
    .replace(/^spotify:playlist:/i, "")
    .trim();
}

async function applyUnavailableSong(payload = {}) {
  const cue = state?.cue;
  const cueId = payload.cueId || "";
  if (!cueId || lastUnavailableCue === cueId) return;
  if (cue?.cueId && cueId !== cue.cueId) return;
  const trackId = payload.trackId || cue?.trackId || secrets?.current?.id || "";
  const playlistId = payload.playlistId || playlistIdFromCue(cue) || secrets?.current?.playlistId || "";
  const next = replaceUnavailableSong(state, secrets);
  if (next.error && !next.state) return;
  lastUnavailableCue = cueId;
  if (next.state) await publish(next.state, next.secrets);
  if (playlistId && trackId) {
    try {
      await markSongUnplayable(playlistId, trackId);
    } catch (err) {
      console.error("[zeitsprung] nicht abspielbar", err);
    }
  }
}

function reportUnavailable(cue) {
  if (!cue?.cueId) return;
  send("song-unavailable", {
    cueId: cue.cueId,
    trackId: cue.trackId || "",
    playlistId: playlistIdFromCue(cue),
  });
}

function playCueHandlers() {
  return {
    onSleep: (msg) => {
      sleepHint = msg;
      renderPlay();
    },
    onError: (msg) => {
      sleepHint = msg;
      renderPlay();
    },
    onUnavailable: (cue) => {
      reportUnavailable(cue);
    },
  };
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

function markFlipHintDone(cue) {
  const id = cue?.cueId || "";
  if (!id || flipHintDoneCue === id) return;
  flipHintDoneCue = id;
}

function showFlipHint() {
  if (isMuted() || !flipPlayEnabled()) return false;
  if (state?.phase !== "listen") return false;
  const cue = listeningCue();
  if (!cue?.cueId) return false;
  if (flipHintDoneCue === cue.cueId) return false;
  const status = localPlayStatus();
  return status === "idle" || status === "paused";
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
  playCue(cue, playCueHandlers()).then((result) => {
    if (result?.ok) markFlipHintDone(cue);
    renderPlay();
  });
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
        pauseLocal({ holdKeepAlive: true }).then(() => renderPlay());
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
    sleepHint = "";
    const accepted = acceptCueOnArrival(cue);
    resetPlayGate(cue.cueId);
    if (flipHintDoneCue && flipHintDoneCue !== cue.cueId) flipHintDoneCue = "";
    if (!accepted.ok) {
      renderPlay();
      return;
    }
  }
  renderPlay();
  if (isMuted()) return;
  startFlipWatch();
  if (fresh) {
    await checkDeviceOnCue(playCueHandlers());
    renderPlay();
  }
  if (fresh && !flipPlayEnabled()) {
    logDiagnose("Cue empfangen – starte ohne Umdrehen");
    const result = await playCue(cue, playCueHandlers());
    if (result?.ok) markFlipHintDone(cue);
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
    if ((state.tokens[active.id] || 0) >= SKIP_COST && Math.random() < 0.12) {
      const next = skipSong(state, secrets, active.id);
      if (!next.error) await publish(next.state, next.secrets);
      return;
    }
    if ((state.tokens[active.id] || 0) >= BUY_COST && Math.random() < 0.08) {
      const next = buyCard(state, secrets, active.id);
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
    const foe = dummies.find((p) => p.id !== state.activeId && (state.tokens[p.id] || 0) >= CHALLENGE_COST);
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
    wrap.append(faceUpCard(card));
    addGap(i + 1);
  });
  box.append(wrap);
  void ownerId;
  return box;
}

function readCards(cards) {
  return Array.isArray(cards) ? cards : Object.values(cards || {});
}

function vinylButton() {
  return faceDownCard({ asButton: true });
}

function flipHintNode() {
  if (!showFlipHint()) return null;
  const hint = el("p", "zs-flip-hint");
  hint.setAttribute("role", "status");
  hint.append(el("span", "zs-flip-hint-icon", "↻"));
  hint.append(el("span", "", "Handy umdrehen zum Abspielen"));
  return hint;
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
  peekStop?.();
  peekStop = null;
  hideCardPeek();

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
  const hintText = sleepHint || "";
  if (hintText) {
    const hint = el("p", "spotify-sleep-hint", hintText);
    hint.setAttribute("role", "status");
    hint.addEventListener("click", () => {
      sleepHint = "";
      renderPlay();
    });
    center.append(hint);
  }

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
    const flipKey = `${r.title || ""}|${r.year || ""}|${r.result || ""}`;
    const animate = flipKey !== revealFlipKey;
    revealFlipKey = flipKey;
    center.append(
      revealFlipCard(
        { title: r.title, artist: r.artist, year: r.year },
        { animate }
      )
    );
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
    if (
      phase === "challenge" &&
      me !== state.activeId &&
      (state.tokens[me] || 0) >= CHALLENGE_COST &&
      !state.challengerId
    ) {
      const ch = el("button", "btn primary", "Herausfordern");
      ch.type = "button";
      ch.title = `Herausfordern (${CHALLENGE_COST} Token)`;
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
    const flipHint = flipHintNode();
    if (flipHint) center.append(flipHint);
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
      skip.disabled = (state.tokens[me] || 0) < SKIP_COST;
      skip.title = `Überspringen (${SKIP_COST} Token)`;
      skip.addEventListener("click", () => send("skip"));
      const buy = el("button", "btn zs-btn-mini", "Kaufen");
      buy.type = "button";
      buy.disabled = (state.tokens[me] || 0) < BUY_COST;
      buy.title = `Karte kaufen (${BUY_COST} Tokens)`;
      buy.addEventListener("click", () => send("buy"));
      row.append(skip, buy);
      actions.append(row);
    }
  }

  upper.append(side, center, actions);

  const lower = el("div", "zs-lower");
  if (phase !== "reveal") revealFlipKey = "";

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
  peekStop = bindCardPeek(lower);
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

function layoutMode() {
  try {
    return new URL(location.href).searchParams.get("layout") || "";
  } catch {
    return "";
  }
}

function isLayoutPreview() {
  const mode = layoutMode();
  return mode === "1" || mode === "reveal";
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
  const reveal = layoutMode() === "reveal";
  state = {
    phase: reveal ? "reveal" : "listen",
    players: [
      { id: "a", name: "Anna" },
      { id: "b", name: "Ben" },
      { id: "c", name: "Nia" },
    ],
    tokens: { a: 2, b: 1, c: 1 },
    activeId: "a",
    timelines: {
      a: [
        { id: "1", title: "Highway to Nowhere - 2015 Remaster", artist: "The Copper Wires", year: 1958 },
        { id: "2", title: "Night Drive (feat. Luna)", artist: "Amber & The Dials", year: 1967 },
        { id: "3", title: "River Song - Radio Edit", artist: "Oak Street Choir", year: 1979 },
        { id: "4", title: "Neon Parade - Remastered 2011", artist: "Violet Static", year: 1986 },
        { id: "5", title: "Paper Planes - Live at Harbour Hall", artist: "Green Lantern Trio", year: 1994 },
        { id: "6", title: "Glasshouse - Single Version", artist: "Blue Harbor", year: 2007 },
        { id: "9", title: "Midnight Atlas (feat. Nova)", artist: "Copper Satellite", year: 2014 },
        { id: "10", title: "Soft Alarm - Remastered 2022", artist: "Ivory Circuit", year: 2021 },
      ],
      b: [{ id: "7", title: "Night", artist: "Duo", year: 1984 }],
      c: [{ id: "8", title: "River", artist: "Trio", year: 1991 }],
    },
    cue: { cueId: "preview", trackUri: "spotify:track:x", playlistUri: "spotify:playlist:y" },
    played: true,
    reveal: reveal
      ? {
          title: "Highway to Nowhere - 2015 Remaster",
          artist: "The Copper Wires",
          year: 1958,
          result: "keep",
        }
      : null,
    winnerId: "a",
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
