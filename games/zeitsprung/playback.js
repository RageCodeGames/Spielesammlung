import {
  explainError,
  getDevices,
  getPlayback,
  getPreferredDeviceId,
  logDiagnose,
  pause,
  playViaPlaylist,
  seekPlayback,
  setPreferredDeviceId,
} from "../../shared/spotify.js";
import { isTransientSpotifyStatus } from "../../shared/spotify-retry.js";
import { isMuted } from "../../shared/mute-button.js";
import { CUE_MAX_AGE_MS } from "./rules.js";
import { positionMsWasIgnored, sleepDecision } from "./play-policy.js";

const SLEEP_HINT = "Dein Spotify schläft – öffne kurz Spotify und tippe auf Bereit";

let lastCueId = "";
let devices = [];
let deviceId = getPreferredDeviceId();
let clipTimer = 0;
/** idle | starting | playing | paused */
let playStatus = "idle";
let playWait = null;
/** Ungültig gemacht, sobald Pause oder ein neuer Cue kommt. */
let playGen = 0;

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
    endClipPause();
  }, clip * 1000);
}

/** Clip abgelaufen: pausieren, Status egal (Phasenwechsel darf den Timer nicht killen). */
async function endClipPause() {
  playGen += 1;
  if (playStatus === "starting" || playStatus === "playing") playStatus = "paused";
  const id = localDeviceId();
  if (!id) return;
  try {
    await pause(id);
  } catch (err) {
    if (!isDeviceMissingError(err)) console.error("[zeitsprung] Clip-Pause", err);
  }
}

/**
 * Abspiel-Sperre für neuen Cue zurücksetzen.
 * Clip-Timer bleibt – Phasenwechsel (Einsortieren) darf ihn nicht löschen.
 */
export function resetPlayGate(cueId = "") {
  const id = String(cueId || "");
  if (id && id === lastCueId) return;
  lastCueId = id;
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

export async function pauseLocal() {
  clearClipTimer();
  playGen += 1;
  if (playStatus === "idle") return;
  const was = playStatus;
  playStatus = playStatus === "starting" ? "idle" : "paused";
  const id = localDeviceId();
  if (!id) return;
  if (was !== "playing" && was !== "starting") return;
  const playing = await deviceIsPlaying();
  if (!playing) return;
  try {
    await pause(id);
  } catch (err) {
    if (!isDeviceMissingError(err)) console.error("[zeitsprung] Pause", err);
  }
}

/** Auflösung / Überspringen / neuer Zug: Wiedergabe hart stoppen. */
export async function stopPlayback() {
  clearClipTimer();
  playGen += 1;
  playWait = null;
  const was = playStatus;
  playStatus = "idle";
  const id = localDeviceId();
  if (!id) return;
  if (was === "idle") {
    try {
      const playing = await deviceIsPlaying();
      if (!playing) return;
    } catch {
      return;
    }
  }
  try {
    await pause(id);
  } catch (err) {
    if (!isDeviceMissingError(err)) console.error("[zeitsprung] Stop", err);
  }
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
  playStatus = "starting";
  const gen = (playGen += 1);
  const age = Date.now() - (Number(cue.sentAt) || 0);
  if (age > CUE_MAX_AGE_MS) {
    playStatus = "idle";
    logDiagnose(`Befehl verpasst (${Math.round(age / 1000)}s alt)`);
    lastCueId = cue.cueId || lastCueId;
    return { ok: false, reason: "stale" };
  }
  if (isMuted()) {
    playStatus = "idle";
    logDiagnose("Stumm – Song nicht gestartet");
    return { ok: false, reason: "muted" };
  }
  lastCueId = cue.cueId || lastCueId;
  logDiagnose("Abspielen ausgelöst");
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
