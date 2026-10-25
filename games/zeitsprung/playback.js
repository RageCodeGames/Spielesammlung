import {
  explainError,
  getDevices,
  getPreferredDeviceId,
  logDiagnose,
  pause,
  playViaPlaylist,
  setPreferredDeviceId,
} from "../../shared/spotify.js";
import { isMuted } from "../../shared/mute-button.js";
import { CUE_MAX_AGE_MS } from "./rules.js";

const SLEEP_HINT = "Dein Spotify schläft – öffne kurz Spotify und tippe auf Bereit";

let lastCueId = "";
let devices = [];
let deviceId = getPreferredDeviceId();
let clipTimer = 0;

export function localDeviceId() {
  return deviceId || devices.find((row) => row.active)?.id || devices[0]?.id || "";
}

export function listDevices() {
  return devices;
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

export async function pauseLocal() {
  window.clearTimeout(clipTimer);
  clipTimer = 0;
  const id = localDeviceId();
  if (!id) return;
  try {
    await pause(id);
  } catch (err) {
    if (!isDeviceMissingError(err)) console.error("[zeitsprung] Pause", err);
  }
}

export async function playCue(cue, { onSleep, onError } = {}) {
  if (!cue?.trackUri || !cue?.playlistUri) return { ok: false, reason: "bad-cue" };
  if (cue.cueId && cue.cueId === lastCueId) return { ok: false, reason: "dup" };
  const age = Date.now() - (Number(cue.sentAt) || 0);
  if (age > CUE_MAX_AGE_MS) {
    logDiagnose(`Befehl verpasst (${Math.round(age / 1000)}s alt)`);
    lastCueId = cue.cueId || "";
    return { ok: false, reason: "stale" };
  }
  lastCueId = cue.cueId || "";
  if (isMuted()) {
    logDiagnose("Stumm – Song nicht gestartet");
    return { ok: false, reason: "muted" };
  }
  window.clearTimeout(clipTimer);
  const run = async () => {
    let id = localDeviceId();
    if (!id || !devices.some((row) => row.id === id)) {
      await refreshPlayDevices();
      id = localDeviceId();
    }
    if (!id) {
      onSleep?.(SLEEP_HINT);
      return { ok: false, reason: "sleep" };
    }
    try {
      await playViaPlaylist(cue.playlistUri, { trackUri: cue.trackUri }, id);
    } catch (err) {
      if (isDeviceMissingError(err)) {
        await refreshPlayDevices();
        id = localDeviceId();
        if (!id) {
          onSleep?.(SLEEP_HINT);
          return { ok: false, reason: "sleep" };
        }
        await playViaPlaylist(cue.playlistUri, { trackUri: cue.trackUri }, id);
      } else {
        throw err;
      }
    }
    const clip = Number(cue.clipSec) || 0;
    if (clip > 0) {
      clipTimer = window.setTimeout(() => {
        pauseLocal();
      }, clip * 1000);
    }
    return { ok: true };
  };
  try {
    return await run();
  } catch (err) {
    console.error("[zeitsprung] Abspielen", err);
    logDiagnose(explainError(err));
    if (isDeviceMissingError(err)) onSleep?.(SLEEP_HINT);
    else onError?.(explainError(err));
    return { ok: false, reason: "error", err };
  }
}
