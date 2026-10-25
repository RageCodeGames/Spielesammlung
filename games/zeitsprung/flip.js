import { get, set } from "../../shared/storage.js";
import { FLIP_KEY } from "./rules.js";

export function flipPlayEnabled() {
  const stored = get(FLIP_KEY, null);
  if (stored === null || stored === undefined) return true;
  return stored === true;
}

export function setFlipPlayEnabled(value) {
  set(FLIP_KEY, Boolean(value));
}

function faceDown(event) {
  const beta = Number(event.beta);
  if (!Number.isFinite(beta)) return false;
  return Math.abs(beta) > 150;
}

/**
 * Lagesensor: face-down → onDown, face-up → onUp.
 * @returns {Promise<{ supported: boolean, stop: () => void }>}
 */
export async function watchFaceDown({ onDown, onUp }) {
  const Orientation = window.DeviceOrientationEvent;
  if (!Orientation) return { supported: false, stop() {} };

  if (typeof Orientation.requestPermission === "function") {
    try {
      const perm = await Orientation.requestPermission();
      if (perm !== "granted") return { supported: false, stop() {} };
    } catch {
      return { supported: false, stop() {} };
    }
  }

  let down = false;
  const onOrient = (event) => {
    const next = faceDown(event);
    if (next === down) return;
    down = next;
    if (down) onDown?.();
    else onUp?.();
  };
  window.addEventListener("deviceorientation", onOrient, true);
  return {
    supported: true,
    stop() {
      window.removeEventListener("deviceorientation", onOrient, true);
    },
  };
}
