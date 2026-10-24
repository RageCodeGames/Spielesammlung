/**
 * Stumm-Schalter für Spotify (und spätere Spiele).
 * Zustand bleibt in localStorage erhalten.
 */

import { get, set } from "./storage.js";

const MUTE_KEY = "kajuete:spotify-muted";

export function isMuted() {
  return get(MUTE_KEY, false) === true;
}

export function setMuted(value) {
  return setMutedState(value);
}

function setMutedState(value) {
  const next = Boolean(value);
  set(MUTE_KEY, next);
  return next;
}

function speakerSvg(muted) {
  if (muted) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22"><path fill="currentColor" d="M4 9v6h3l4 4V5L7 9H4zm11.5 3c0-1.8-1-3.3-2.5-4.1v2.2l2.4 2.4c.1-.2.1-.5.1-.5zm2.5 0c0 .9-.2 1.8-.5 2.6l1.5 1.5c.7-1.2 1-2.6 1-4.1 0-3.4-2.2-6.2-5.2-7.2v2.1c2 .9 3.2 2.9 3.2 5.1zM5.3 3.7 4 5l4.2 4.2L4 14.4V16h2.6L12 21.4v-6.2L18.3 21l1.3-1.3L5.3 3.7zM12 5.5l-.8.8L12 7.1V5.5z"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22"><path fill="currentColor" d="M4 9v6h3l4 4V5L7 9H4zm9-3.1v2.1c2 .9 3.2 2.9 3.2 5.1s-1.2 4.2-3.2 5.1v2.1c3-.9 5.2-3.8 5.2-7.2S16 6.8 13 5.9zm0 4.1v4c.8-.5 1.3-1.4 1.3-2.4S13.8 10.5 13 10z"/></svg>`;
}

/**
 * Kleiner Stumm-Knopf (Lautsprecher).
 * @param {HTMLElement} parent
 * @param {{ onChange?: (muted: boolean) => void, onMute?: () => void | Promise<void> }} options
 *   onMute: wenn gerade stummgeschaltet wird (z. B. laufenden Song pausieren)
 * @returns {{ button: HTMLButtonElement, isMuted: () => boolean, setMuted: (v: boolean) => void, destroy: () => void }}
 */
export function mountMuteButton(parent, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn mute-btn";

  function paint() {
    const muted = isMuted();
    button.classList.toggle("is-muted", muted);
    button.setAttribute("aria-pressed", muted ? "true" : "false");
    button.setAttribute("aria-label", muted ? "Ton an" : "Stumm schalten");
    button.title = muted ? "Ton an" : "Stumm";
    button.innerHTML = speakerSvg(muted);
  }

  const onClick = async () => {
    const next = !isMuted();
    setMutedState(next);
    paint();
    if (next) {
      try {
        await options.onMute?.();
      } catch (err) {
        console.error("[mute]", err);
      }
    }
    options.onChange?.(next);
  };

  button.addEventListener("click", onClick);
  paint();
  parent.append(button);

  return {
    button,
    isMuted,
    setMuted(value) {
      setMutedState(value);
      paint();
    },
    destroy() {
      button.removeEventListener("click", onClick);
      button.remove();
    },
  };
}
