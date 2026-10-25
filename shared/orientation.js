/**
 * Orientierungshinweis für Spiele.
 * Manifest ist "any"; jedes Spiel wählt portrait oder landscape
 * und kann während der Session umschalten (z. B. Zeitsprung).
 *
 * Spiele mit Phasen-Wechsel setzen die Orientierung zentral über
 * `preferredForPlayPhase` / `setPreferred`, nicht pro Bildschirmseite.
 */

const HINTS = {
  portrait: "Bitte Handy hochkant halten",
  landscape: "Bitte Handy quer halten",
};

/**
 * Querformat nur während einer laufenden Spielphase (nicht Lobby, nicht Ende).
 * @param {string|null|undefined} phase
 * @returns {"portrait" | "landscape"}
 */
export function preferredForPlayPhase(phase) {
  if (!phase || phase === "end") return "portrait";
  return "landscape";
}

/**
 * @param {"portrait" | "landscape"} preferred
 * @returns {{ setPreferred: (mode: "portrait" | "landscape") => void, destroy: () => void }}
 */
export function mountOrientation(preferred = "portrait") {
  let mode = preferred === "landscape" ? "landscape" : "portrait";
  let overlay = document.querySelector("[data-orientation-lock]");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "orientation-lock";
    overlay.setAttribute("data-orientation-lock", "1");
    overlay.setAttribute("hidden", "");
    const text = document.createElement("p");
    text.setAttribute("data-orientation-text", "1");
    overlay.append(text);
    document.body.append(overlay);
  }
  const textNode = overlay.querySelector("[data-orientation-text]");

  const applyLock = () => {
    try {
      const lock = screen.orientation?.lock?.(mode);
      if (lock && typeof lock.catch === "function") lock.catch(() => {});
    } catch {
      /* nur in installierter PWA / Fullscreen */
    }
  };

  /** Hinweis nur auf Touch; Maus/PC nie blockieren. */
  const isTouchUi = () => window.matchMedia("(pointer: coarse)").matches;

  const apply = () => {
    if (textNode) textNode.textContent = HINTS[mode];
    document.documentElement.dataset.orientationPrefer = mode;
    if (!isTouchUi()) {
      overlay.hidden = true;
      document.documentElement.classList.remove("orientation-wrong");
      return;
    }
    const landscape = window.matchMedia("(orientation: landscape)").matches;
    const wrong = mode === "portrait" ? landscape : !landscape;
    overlay.hidden = !wrong;
    document.documentElement.classList.toggle("orientation-wrong", wrong);
    applyLock();
  };

  const mqlOrient = window.matchMedia("(orientation: landscape)");
  const mqlPointer = window.matchMedia("(pointer: coarse)");
  const onChange = () => apply();
  if (typeof mqlOrient.addEventListener === "function") mqlOrient.addEventListener("change", onChange);
  else if (typeof mqlOrient.addListener === "function") mqlOrient.addListener(onChange);
  if (typeof mqlPointer.addEventListener === "function") mqlPointer.addEventListener("change", onChange);
  else if (typeof mqlPointer.addListener === "function") mqlPointer.addListener(onChange);
  window.addEventListener("orientationchange", onChange);
  apply();

  return {
    setPreferred(next) {
      mode = next === "landscape" ? "landscape" : "portrait";
      apply();
    },
    destroy() {
      if (typeof mqlOrient.removeEventListener === "function") mqlOrient.removeEventListener("change", onChange);
      else if (typeof mqlOrient.removeListener === "function") mqlOrient.removeListener(onChange);
      if (typeof mqlPointer.removeEventListener === "function") mqlPointer.removeEventListener("change", onChange);
      else if (typeof mqlPointer.removeListener === "function") mqlPointer.removeListener(onChange);
      window.removeEventListener("orientationchange", onChange);
      overlay.remove();
      document.documentElement.classList.remove("orientation-wrong");
      delete document.documentElement.dataset.orientationPrefer;
      try {
        screen.orientation?.unlock?.();
      } catch {
        /* egal */
      }
    },
  };
}
