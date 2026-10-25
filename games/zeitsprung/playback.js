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
import { isMuted } from "../../shared/mute-button.js";
import { CUE_MAX_AGE_MS } from "./rules.js";
import { computeStartMs, START_MODE_RANDOM } from "./logic.js";

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
  devices = await getDevices();
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
  return (
    err?.code === "no-device" ||
    err?.reason === "NO_ACTIVE_DEVICE" ||
    /no active device|schläft/i.test(String(err?.message || ""))
  );
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

async function jumpToCueStart(cue, playback, deviceId) {
  const known = Math.max(0, Math.floor(Number(cue?.positionMs) || 0));
  let startMs = known;
  if (startMs <= 0 && (cue?.startMode || START_MODE_RANDOM) === START_MODE_RANDOM) {
    const duration = Number(playback?.durationMs) || 0;
    startMs = computeStartMs(duration, cue?.clipSec, START_MODE_RANDOM, cue?.startRatio);
    if (startMs > 0) {
      logDiagnose(`Länge nachträglich ${duration}ms – springe auf ${startMs}ms`);
    }
  }
  if (startMs <= 0) return;
  const progress = Number(playback?.progressMs) || 0;
  if (Math.abs(progress - startMs) <= 2500) {
    logDiagnose(`Startpunkt ${startMs}ms bereits nahe (${progress}ms) – kein Seek`);
    return;
  }
  logDiagnose(`Seek auf ${startMs}ms (Stand ${progress}ms)`);
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
      await refreshPlayDevices();
      id = localDeviceId();
    }
    if (!stillMine()) return { ok: false, reason: "aborted" };
    if (!id) {
      playStatus = "idle";
      onSleep?.(SLEEP_HINT);
      return { ok: false, reason: "sleep" };
    }
    const target = playTarget(cue);
    let result;
    try {
      result = await playViaPlaylist(cue.playlistUri, target, id);
    } catch (err) {
      if (isDeviceMissingError(err)) {
        await refreshPlayDevices();
        id = localDeviceId();
        if (!stillMine()) return { ok: false, reason: "aborted" };
        if (!id) {
          playStatus = "idle";
          onSleep?.(SLEEP_HINT);
          return { ok: false, reason: "sleep" };
        }
        result = await playViaPlaylist(cue.playlistUri, target, id);
      } else {
        throw err;
      }
    }
    if (!stillMine()) return { ok: false, reason: "aborted" };
    try {
      await jumpToCueStart(cue, result?.state, id);
    } catch (err) {
      logDiagnose(`Seek fehlgeschlagen: ${explainError(err)}`);
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
    if (isDeviceMissingError(err)) onSleep?.(SLEEP_HINT);
    else if (err?.code === "track-unavailable") onUnavailable?.(cue, err);
    else onError?.(explainError(err));
    return { ok: false, reason: err?.code === "track-unavailable" ? "unavailable" : "error", err };
  } finally {
    if (stillMine()) playWait = null;
  }
}
