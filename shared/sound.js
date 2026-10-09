import { get, set } from "./storage.js";

const STORAGE_KEY = "kajuete:sound";

/** AudioContext entsteht erst beim ersten Antippen, nicht beim Laden. */
let audioContext = null;
let enabled = get(STORAGE_KEY, true) !== false;

function ensureContext() {
  if (audioContext) return audioContext;
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;
  audioContext = new AudioCtor();
  return audioContext;
}

export function unlock() {
  const ctx = ensureContext();
  if (!ctx) return Promise.resolve(false);
  if (ctx.state === "suspended") {
    return ctx.resume().then(() => true).catch(() => false);
  }
  return Promise.resolve(true);
}

export function getAudioContext() {
  return ensureContext();
}

function onFirstTap() {
  unlock();
}

window.addEventListener("pointerdown", onFirstTap, { capture: true, once: true });

export function isSoundEnabled() {
  return enabled;
}

export function setSoundEnabled(on) {
  enabled = Boolean(on);
  set(STORAGE_KEY, enabled);
}

/**
 * Spielt einen einfachen erzeugten Ton.
 * options: frequency (Hz), duration (Sekunden), type ("sine", "square", "triangle", "sawtooth")
 */
export function playTone(options = {}) {
  if (!enabled) return;
  const ctx = audioContext;
  if (!ctx || ctx.state !== "running") return;

  const frequency = Number(options.frequency) > 0 ? Number(options.frequency) : 440;
  const duration = Number(options.duration) > 0 ? Number(options.duration) : 0.15;
  const type = options.type || "sine";
  const volume = Number(options.gain) > 0 ? Math.min(Number(options.gain), 0.4) : 0.18;

  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    const attack = 0.02;
    const end = now + Math.max(duration, attack + 0.04);

    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(end + 0.02);
    osc.addEventListener("ended", () => {
      osc.disconnect();
      gain.disconnect();
    });
  } catch {
    /* Ton auslassen, Spiel läuft weiter */
  }
}
