import {
  explainError,
  getDevices,
  getPlayback,
  getPreferredDeviceId,
  logDiagnose,
  pause,
  playViaPlaylist,
  seekPlayback,
  setPlaybackVolume,
  setPreferredDeviceId,
  setRepeatMode,
} from "../../shared/spotify.js";
import { isTransientSpotifyStatus } from "../../shared/spotify-retry.js";
import { isMuted } from "../../shared/mute-button.js";
import { CUE_MAX_AGE_MS } from "./rules.js";
import { cueArrivalDecision, positionMsWasIgnored, sleepDecision } from "./play-policy.js";

const SLEEP_HINT = "Dein Spotify schläft – öffne kurz Spotify und tippe auf Bereit";
const CUE_SLEEP_HINT = "Öffne kurz Spotify";

let lastCueId = "";
/** Cue, der beim Empfang angenommen wurde – den ganzen Zug abspielbar. */
let acceptedCueId = "";
let devices = [];
let deviceId = getPreferredDeviceId();
let clipTimer = 0;
/** idle | starting | playing | paused */
let playStatus = "idle";
let playWait = null;
/** Ungültig gemacht, sobald Pause oder ein neuer Cue kommt. */
let playGen = 0;
let keepAlive = false;
let savedVolume = 50;
let keepAliveSupportsVolume = false;

export function localDeviceId() {
  return deviceId || devices.find((row) => row.active)?.id || devices[0]?.id || "";
}

export function listDevices() {
  return devices;
}

export function localPlayStatus() {
  return playStatus;
}

function clearClipTimer() {
  window.clearTimeout(clipTimer);
  clipTimer = 0;
}

function armClipTimer(cue) {
  clearClipTimer();
  const clip = Number(cue?.clipSec) || 0;
  if (clip <= 0) return;
  clipTimer = window.setTimeout(() => {
    clipTimer = 0;
    endClipHold();
  }, clip * 1000);
}

function chosenDevice(id = localDeviceId()) {
  return devices.find((row) => row.id === id) || null;
}

async function rememberVolume(id) {
  try {
    const now = await getPlayback();
    if (Number.isFinite(now?.volumePercent) && now.volumePercent > 0) {
      savedVolume = Math.round(now.volumePercent);
    }
  } catch {
    /* Geräteliste als Fallback */
  }
  const device = chosenDevice(id);
  if (savedVolume <= 0 && Number.isFinite(device?.volumePercent) && device.volumePercent > 0) {
    savedVolume = Math.round(device.volumePercent);
  }
  if (savedVolume <= 0) savedVolume = 50;
}

/** Clip abgelaufen: stumm loopen, damit das Gerät wach bleibt. Ohne Lautstärke: Pause. */
async function endClipHold() {
  playGen += 1;
  if (playStatus === "starting" || playStatus === "playing") playStatus = "paused";
  const id = localDeviceId();
  if (!id) return;
  const device = chosenDevice(id);
  const supportsVolume = device?.supportsVolume === true;
  if (!supportsVolume) {
    logDiagnose("Clip Ende: Gerät ohne Lautstärke – Pause wie bisher");
    try {
      await pause(id);
    } catch (err) {
      if (!isDeviceMissingError(err)) console.error("[zeitsprung] Clip-Pause", err);
    }
    keepAlive = false;
    return;
  }
  logDiagnose("Clip Ende: Lautstärke 0 + Repeat track (Gerät bleibt aktiv, kein Pause)");
  try {
    await rememberVolume(id);
    await setPlaybackVolume(0, id);
    await setRepeatMode("track", id);
    keepAlive = true;
    keepAliveSupportsVolume = true;
  } catch (err) {
    logDiagnose(`Clip-Halten fehlgeschlagen (${explainError(err)}) – Pause`);
    keepAlive = false;
    try {
      await pause(id);
    } catch (pauseErr) {
      if (!isDeviceMissingError(pauseErr)) console.error("[zeitsprung] Clip-Pause", pauseErr);
    }
  }
}

async function restoreVolume(id) {
  if (!id || !keepAliveSupportsVolume) return;
  const volume = savedVolume > 0 ? savedVolume : 50;
  try {
    logDiagnose(`Lautstärke zurück auf ${volume}`);
    await setPlaybackVolume(volume, id);
  } catch (err) {
    logDiagnose(`Lautstärke zurücksetzen fehlgeschlagen: ${explainError(err)}`);
  }
}

/** Repeat aus, optional Lautstärke zurück. Vor dem nächsten Play oder beim echten Stop. */
async function liftKeepAlive(id, { restoreVol = false } = {}) {
  if (!id) {
    keepAlive = false;
    return;
  }
  try {
    await setRepeatMode("off", id);
  } catch (err) {
    logDiagnose(`Repeat aus: ${explainError(err)}`);
  }
  if (restoreVol) await restoreVolume(id);
  keepAlive = false;
}

/**
 * Cue beim Empfang annehmen. Zu alt nur hier (Beitritt in laufenden Raum).
 * Einmal angenommen bleibt er bis zum nächsten Zug/Auflösung abspielbar.
 */
export function acceptCueOnArrival(cue) {
  const decided = cueArrivalDecision(cue, Date.now(), acceptedCueId, CUE_MAX_AGE_MS);
  if (decided.already) {
    logDiagnose("Cue schon angenommen – weiter abspielbar");
    return decided;
  }
  if (!decided.ok) {
    if (decided.reason === "stale") {
      logDiagnose(
        `Befehl verpasst (${Math.round((decided.age || 0) / 1000)}s alt) – nur beim Empfang, nicht angenommen`
      );
    }
    return decided;
  }
  acceptedCueId = String(cue.cueId);
  logDiagnose(
    `Cue angenommen (${Math.round((decided.age || 0) / 1000)}s alt) – bleibt den ganzen Zug abspielbar`
  );
  return decided;
}

/** Sobald der Cue da ist: Geräte prüfen, Hinweis ohne Umdrehen. */
export async function checkDeviceOnCue({ onSleep, onError } = {}) {
  if (isMuted()) {
    logDiagnose("Vorab-Prüfung: stumm – keine Geräte");
    return { ok: false, reason: "muted" };
  }
  logDiagnose("Vorab-Prüfung zu Zugbeginn: Geräte laden");
  let id = localDeviceId();
  try {
    if (!id || !devices.some((row) => row.id === id)) {
      await refreshPlayDevices();
      id = localDeviceId();
    }
  } catch (err) {
    logDiagnose(`Vorab-Prüfung: Geräte laden fehlgeschlagen (${err?.status || err?.code || "Fehler"})`);
    onError?.(explainError(err));
    return { ok: false, reason: "error" };
  }
  if (id && devices.some((row) => row.id === id)) {
    logDiagnose(`Vorab-Prüfung: Gerät da (${chosenDevice(id)?.name || id}) – warte auf Umdrehen/Play`);
    return { ok: true };
  }
  logDiagnose("Vorab-Prüfung: Gerät fehlt – Hinweis ohne Umdrehen");
  const slept = await announceSleepIfGone(id, {
    onSleep: (msg) => onSleep?.(CUE_SLEEP_HINT || msg),
    onError,
  });
  return { ok: false, reason: slept ? "sleep" : "error" };
}

/**
 * Abspiel-Sperre für neuen Cue zurücksetzen.
 * Clip-Timer bleibt – Phasenwechsel (Einsortieren) darf ihn nicht löschen.
 */
export function resetPlayGate(cueId = "") {
  const id = String(cueId || "");
  if (id && id === lastCueId) return;
  lastCueId = id;
  if (!id) acceptedCueId = "";
  playGen += 1;
  playStatus = "idle";
  playWait = null;
}

export async function refreshPlayDevices() {
  logDiagnose(`Geräte laden (gewählt ${deviceId || "keins"})`);
  let list;
  try {
    list = await getDevices();
  } catch (err) {
    logDiagnose(
      `Geräte laden fehlgeschlagen (${err?.status || err?.code || "Fehler"}) – bisherige Liste behalten, keine Schlafen-Meldung`
    );
    throw err;
  }
  logDiagnose(`GET /me/player/devices → ${list.length} Gerät(e)`);
  if (!list.length) {
    logDiagnose("Geräteliste leer – bisheriges Gerät behalten");
    return devices;
  }
  devices = list;
  if (devices.length === 1) deviceId = devices[0].id;
  else if (deviceId && devices.some((row) => row.id === deviceId)) {
    /* behalten */
  } else {
    const preferred = getPreferredDeviceId();
    deviceId =
      (preferred && devices.some((row) => row.id === preferred) && preferred) ||
      devices.find((row) => row.active)?.id ||
      devices[0]?.id ||
      "";
    logDiagnose(`Gerät neu gewählt: ${deviceId || "keins"}`);
  }
  if (deviceId) setPreferredDeviceId(deviceId);
  return devices;
}

export function chooseDevice(id) {
  deviceId = id;
  if (id) setPreferredDeviceId(id);
}

export function spotifyStatusFromDevices(muted) {
  if (muted) return "muted";
  if (localDeviceId() && devices.some((row) => row.id === localDeviceId())) return "ready";
  return "sleep";
}

function isDeviceMissingError(err) {
  if (!err) return false;
  if (isTransientSpotifyStatus(err.status) || err.code === "spotify-temp" || err.code === "network") {
    return false;
  }
  return (
    err.code === "no-device" ||
    err.reason === "NO_ACTIVE_DEVICE" ||
    /no active device/i.test(String(err.message || ""))
  );
}

function isTransientError(err) {
  return Boolean(
    err &&
      (isTransientSpotifyStatus(err.status) || err.code === "spotify-temp" || err.code === "network")
  );
}

async function announceSleepIfGone(chosenId, { onSleep, onError }, err = null) {
  logDiagnose(
    `Schlaf-Prüfung: gewählt ${chosenId || "keins"}${
      err ? ` · Fehler ${err.status || err.code || err.message || ""}` : ""
    }`
  );
  if (isTransientError(err)) {
    const decided = sleepDecision({ chosenId, devices, serverError: true });
    logDiagnose(`Schlaf-Prüfung: ${decided.reason}`);
    onError?.(explainError(err));
    return false;
  }
  let list;
  try {
    list = await getDevices();
    logDiagnose(`Schlaf-Prüfung: GET /me/player/devices erneut → ${list.length} Gerät(e)`);
  } catch (loadErr) {
    const decided = sleepDecision({ chosenId, devices, loadFailed: true });
    logDiagnose(`Schlaf-Prüfung: ${decided.reason} (${loadErr?.status || loadErr?.code || "Fehler"})`);
    onError?.(explainError(err || loadErr));
    return false;
  }
  if (list.length) devices = list;
  const decided = sleepDecision({ chosenId, devices: list });
  logDiagnose(`Schlaf-Prüfung: ${decided.reason}`);
  if (decided.sleep) {
    onSleep?.(SLEEP_HINT);
    return true;
  }
  if (err) onError?.(explainError(err));
  return false;
}

async function deviceIsPlaying() {
  try {
    const now = await getPlayback();
    return Boolean(now?.isPlaying);
  } catch {
    return false;
  }
}

async function pauseAndRestore(id, label) {
  if (!id) {
    keepAlive = false;
    return;
  }
  try {
    await pause(id);
  } catch (err) {
    if (!isDeviceMissingError(err)) console.error(`[zeitsprung] ${label}`, err);
  }
  try {
    await setRepeatMode("off", id);
  } catch (err) {
    logDiagnose(`Repeat aus nach ${label}: ${explainError(err)}`);
  }
  await restoreVolume(id);
  keepAlive = false;
  keepAliveSupportsVolume = false;
}

export async function pauseLocal({ holdKeepAlive = false } = {}) {
  if (holdKeepAlive && keepAlive) {
    logDiagnose("Umdrehen nach Clip: stilles Repeat bleibt, Gerät bleibt aktiv");
    playGen += 1;
    playStatus = "paused";
    return;
  }
  clearClipTimer();
  playGen += 1;
  if (playStatus === "idle" && !keepAlive) return;
  const was = playStatus;
  playStatus = playStatus === "starting" ? "idle" : "paused";
  const id = localDeviceId();
  if (!id) {
    keepAlive = false;
    return;
  }
  if (!keepAlive && was !== "playing" && was !== "starting") return;
  if (!keepAlive) {
    const playing = await deviceIsPlaying();
    if (!playing) return;
  }
  logDiagnose("Pause – Repeat aus, Lautstärke zurück");
  await pauseAndRestore(id, "Pause");
}

/** Auflösung / Überspringen / neuer Zug / Raum verlassen: hart stoppen. */
export async function stopPlayback() {
  clearClipTimer();
  playGen += 1;
  playWait = null;
  const was = playStatus;
  playStatus = "idle";
  const id = localDeviceId();
  if (!id) {
    keepAlive = false;
    acceptedCueId = "";
    return;
  }
  if (!keepAlive && was === "idle") {
    try {
      const playing = await deviceIsPlaying();
      if (!playing) {
        acceptedCueId = "";
        return;
      }
    } catch {
      acceptedCueId = "";
      return;
    }
  }
  logDiagnose("Stop – Pause, Repeat aus, Lautstärke zurück");
  await pauseAndRestore(id, "Stop");
  acceptedCueId = "";
}

function playTarget(cue) {
  const position = Number.isFinite(Number(cue?.playlistIndex))
    ? Math.max(0, Math.floor(Number(cue.playlistIndex)))
    : undefined;
  return {
    trackUri: cue.trackUri,
    position,
    positionMs: Math.max(0, Math.floor(Number(cue.positionMs) || 0)),
    trackId: cue.trackId || "",
    title: cue.title || "",
    artist: cue.artist || "",
  };
}

async function seekOnlyIfIgnored(cue, playback, deviceId) {
  const startMs = Math.max(0, Math.floor(Number(cue?.positionMs) || 0));
  if (startMs <= 0) {
    logDiagnose("Startpunkt 0 – kein Seek");
    return;
  }
  if (!playback || playback.unreadable || !Number.isFinite(Number(playback.progressMs))) {
    logDiagnose("Stand nicht prüfbar – kein Seek (Play hatte bereits position_ms)");
    return;
  }
  const progress = Number(playback.progressMs) || 0;
  if (!positionMsWasIgnored(startMs, progress)) {
    logDiagnose(`position_ms ${startMs} übernommen (progress ${progress}ms) – kein Seek`);
    return;
  }
  logDiagnose(
    `Notlösung Seek: Spotify hat position_ms ${startMs} ignoriert (progress ${progress}ms)`
  );
  await seekPlayback(startMs, deviceId);
}

export async function playCue(cue, { onSleep, onError, onUnavailable } = {}) {
  if (!cue?.trackUri || !cue?.playlistUri) return { ok: false, reason: "bad-cue" };
  if (playStatus === "starting" || playStatus === "playing") {
    return { ok: false, reason: "busy" };
  }
  const accepted = acceptCueOnArrival(cue);
  if (!accepted.ok) {
    playStatus = "idle";
    lastCueId = cue.cueId || lastCueId;
    return { ok: false, reason: "stale" };
  }
  playStatus = "starting";
  const gen = (playGen += 1);
  if (isMuted()) {
    playStatus = "idle";
    logDiagnose("Stumm – Song nicht gestartet");
    return { ok: false, reason: "muted" };
  }
  lastCueId = cue.cueId || lastCueId;
  logDiagnose("Abspielen ausgelöst (angenommener Cue, kein Alters-Limit)");
  clearClipTimer();
  const stillMine = () => gen === playGen;
  const run = async () => {
    let id = localDeviceId();
    if (!id || !devices.some((row) => row.id === id)) {
      try {
        await refreshPlayDevices();
      } catch (err) {
        playStatus = "idle";
        const slept = await announceSleepIfGone(id, { onSleep, onError }, err);
        return { ok: false, reason: slept ? "sleep" : "error" };
      }
      id = localDeviceId();
    }
    if (!stillMine()) return { ok: false, reason: "aborted" };
    if (!id) {
      playStatus = "idle";
      const slept = await announceSleepIfGone("", { onSleep, onError });
      return { ok: false, reason: slept ? "sleep" : "error" };
    }
    const target = playTarget(cue);
    if (keepAlive) {
      logDiagnose("Vor dem Song: Repeat aus, Lautstärke bleibt 0 bis Play sitzt");
      await liftKeepAlive(id, { restoreVol: false });
      keepAliveSupportsVolume = true;
    }
    logDiagnose(`Play mit position_ms=${target.positionMs} (kein Seek als Standardweg)`);
    let result;
    try {
      result = await playViaPlaylist(cue.playlistUri, target, id);
    } catch (err) {
      if (isTransientError(err)) throw err;
      if (isDeviceMissingError(err)) {
        logDiagnose("Play: Gerät laut Fehler weg – Geräte neu laden, kein sofortiges Schlafen");
        try {
          await refreshPlayDevices();
        } catch (loadErr) {
          playStatus = "idle";
          const slept = await announceSleepIfGone(id, { onSleep, onError }, loadErr);
          return { ok: false, reason: slept ? "sleep" : "error" };
        }
        id = localDeviceId();
        if (!stillMine()) return { ok: false, reason: "aborted" };
        if (!id || !devices.some((row) => row.id === id)) {
          playStatus = "idle";
          const slept = await announceSleepIfGone(id, { onSleep, onError }, err);
          return { ok: false, reason: slept ? "sleep" : "error" };
        }
        logDiagnose("Gerät nach Reload da – Play einmal erneut");
        result = await playViaPlaylist(cue.playlistUri, target, id);
      } else {
        throw err;
      }
    }
    if (!stillMine()) return { ok: false, reason: "aborted" };
    try {
      await seekOnlyIfIgnored(cue, result?.state, id);
    } catch (err) {
      logDiagnose(`Seek-Notlösung fehlgeschlagen: ${explainError(err)}`);
    }
    if (!stillMine()) return { ok: false, reason: "aborted" };
    if (keepAliveSupportsVolume) await restoreVolume(id);
    keepAlive = false;
    if (!stillMine()) return { ok: false, reason: "aborted" };
    playStatus = "playing";
    armClipTimer(cue);
    return { ok: true };
  };
  playWait = run();
  try {
    return await playWait;
  } catch (err) {
    if (!stillMine()) return { ok: false, reason: "aborted" };
    playStatus = "idle";
    console.error("[zeitsprung] Abspielen", err);
    logDiagnose(explainError(err));
    const restoreId = localDeviceId();
    if (restoreId && keepAliveSupportsVolume) await restoreVolume(restoreId);
    if (err?.code === "track-unavailable") {
      logDiagnose("Schlaf-Prüfung: nicht zuständig (falscher/fehlender Song)");
      onUnavailable?.(cue, err);
      return { ok: false, reason: "unavailable", err };
    }
    if (isTransientError(err)) {
      logDiagnose("Schlaf-Prüfung: Serverfehler – keine Schlafen-Meldung");
      onError?.(explainError(err));
      return { ok: false, reason: "error", err };
    }
    if (isDeviceMissingError(err)) {
      const slept = await announceSleepIfGone(localDeviceId(), { onSleep, onError }, err);
      return { ok: false, reason: slept ? "sleep" : "error", err };
    }
    onError?.(explainError(err));
    return { ok: false, reason: "error", err };
  } finally {
    if (stillMine()) playWait = null;
  }
}
