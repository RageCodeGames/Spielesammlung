import { get, set } from "../../shared/storage.js";
import { FLIP_KEY } from "./rules.js";

const FACE_DOWN_HOLD_MS = 180;
const NO_DATA_MS = 2000;
const BETA_DOWN = 140;
const Z_FACE_DOWN = 6;

export function flipPlayEnabled() {
  const stored = get(FLIP_KEY, null);
  if (stored === null || stored === undefined) return true;
  return stored === true;
}

export function setFlipPlayEnabled(value) {
  set(FLIP_KEY, Boolean(value));
}

function formatNum(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "–";
  return n.toFixed(digits);
}

export function formatSensorLine(reading) {
  const live = reading?.live === true;
  const status = live ? "aktiv" : "keine Daten";
  const beta = formatNum(reading?.beta, 0);
  const gamma = formatNum(reading?.gamma, 0);
  const z = formatNum(reading?.z, 1);
  return { status, values: `β ${beta}° · γ ${gamma}° · z ${z}` };
}

/**
 * Display nach unten: |beta| groß (flach auf dem Display) oder z > 6
 * (Beschleunigung aus dem Bildschirm heraus, Schwerkraft Richtung Boden).
 */
export function isFaceDown(beta, z) {
  const byBeta = Number.isFinite(beta) && Math.abs(beta) > BETA_DOWN;
  const byZ = Number.isFinite(z) && z > Z_FACE_DOWN;
  return byBeta || byZ;
}

export function faceDownReason(beta, z) {
  const parts = [];
  if (Number.isFinite(beta) && Math.abs(beta) > BETA_DOWN) parts.push(`|β|=${Math.abs(beta).toFixed(0)}> ${BETA_DOWN}`);
  if (Number.isFinite(z) && z > Z_FACE_DOWN) parts.push(`z=${z.toFixed(1)}>${Z_FACE_DOWN}`);
  return parts.join(" · ") || "kein Schwellenwert";
}

async function requestSensorPermission() {
  const Orientation = window.DeviceOrientationEvent;
  const Motion = window.DeviceMotionEvent;
  if (typeof Orientation?.requestPermission === "function") {
    try {
      const perm = await Orientation.requestPermission();
      if (perm !== "granted") return false;
    } catch {
      return false;
    }
  }
  if (typeof Motion?.requestPermission === "function") {
    try {
      await Motion.requestPermission();
    } catch {
      /* Orientierung reicht */
    }
  }
  return true;
}

/**
 * Lagesensor: deviceorientation + devicemotion.
 * Haltezeit startet einmal – nicht bei jedem Event neu.
 */
export async function watchFaceDown({ onDown, onUp, onReading, onNoData, onFaceDown } = {}) {
  const hasOrient = typeof window.DeviceOrientationEvent === "function" || "ondeviceorientation" in window;
  const hasMotion = typeof window.DeviceMotionEvent === "function" || "ondevicemotion" in window;
  if (!hasOrient && !hasMotion) {
    onNoData?.();
    return { supported: false, stop() {} };
  }

  const allowed = await requestSensorPermission();
  if (!allowed) {
    onNoData?.();
    return { supported: false, stop() {} };
  }

  let down = false;
  let pending = null;
  let holdTimer = 0;
  let noDataTimer = 0;
  let beta;
  let gamma;
  let z;
  let live = false;
  let noDataSent = false;

  const emit = () => {
    onReading?.({ live, beta, gamma, z, down });
  };

  const consider = () => {
    const next = isFaceDown(beta, z);
    if (next === down) {
      pending = null;
      if (holdTimer) {
        window.clearTimeout(holdTimer);
        holdTimer = 0;
      }
      return;
    }
    if (pending === next) return;
    pending = next;
    if (holdTimer) window.clearTimeout(holdTimer);
    holdTimer = window.setTimeout(() => {
      holdTimer = 0;
      pending = null;
      if (isFaceDown(beta, z) === down) return;
      down = isFaceDown(beta, z);
      if (down) {
        onFaceDown?.({ beta, z, reason: faceDownReason(beta, z) });
        onDown?.();
      } else {
        onUp?.();
      }
    }, FACE_DOWN_HOLD_MS);
  };

  const markLive = () => {
    if (!live) live = true;
    if (noDataTimer) {
      window.clearTimeout(noDataTimer);
      noDataTimer = 0;
    }
    emit();
    consider();
  };

  const onOrient = (event) => {
    const nextBeta = Number(event.beta);
    const nextGamma = Number(event.gamma);
    if (!Number.isFinite(nextBeta) && !Number.isFinite(nextGamma)) return;
    beta = nextBeta;
    gamma = nextGamma;
    markLive();
  };

  const onMotion = (event) => {
    const nextZ = Number(event.accelerationIncludingGravity?.z);
    if (!Number.isFinite(nextZ)) return;
    z = nextZ;
    markLive();
  };

  window.addEventListener("deviceorientation", onOrient, true);
  window.addEventListener("deviceorientationabsolute", onOrient, true);
  window.addEventListener("devicemotion", onMotion, true);

  noDataTimer = window.setTimeout(() => {
    noDataTimer = 0;
    if (live || noDataSent) return;
    noDataSent = true;
    onNoData?.();
    emit();
  }, NO_DATA_MS);

  emit();

  return {
    supported: true,
    stop() {
      window.removeEventListener("deviceorientation", onOrient, true);
      window.removeEventListener("deviceorientationabsolute", onOrient, true);
      window.removeEventListener("devicemotion", onMotion, true);
      window.clearTimeout(holdTimer);
      window.clearTimeout(noDataTimer);
      holdTimer = 0;
      noDataTimer = 0;
    },
  };
}
