/**
 * Orientierungshinweis für Spiele.
 * Manifest ist "any"; jedes Spiel wählt portrait oder landscape
 * und kann während der Session umschalten (z. B. Zeitsprung).
 *
 * Spiele mit Phasen-Wechsel setzen die Orientierung zentral über
 * `preferredForPlayPhase` / `setPreferred`, nicht pro Bildschirmseite.
 *
 * iOS (Safari / Home-Bildschirm): screen.orientation.lock wird nicht
 * unterstützt – nie darauf verlassen. Nur matchMedia / Fenstergröße.
 * Der Hinweis ist rein informativ und verschwindet bei korrekter Lage.
 */

const HINTS = {
  portrait: "Bitte Handy hochkant halten",
  landscape: "Bitte Handy quer halten",
};

function isIos() {
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  /* iPadOS 13+ meldet sich oft als Mac */
  return navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1;
}

/** Orientierung nur messen – nie erzwingen. */
function isLandscapeNow() {
  if (window.matchMedia("(orientation: landscape)").matches) return true;
  if (window.matchMedia("(orientation: portrait)").matches) return false;
  /* Fallback, falls orientation-Media-Query zögert (ältere WebViews) */
  return window.innerWidth > window.innerHeight;
}

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
    overlay.setAttribute("role", "status");
    const text = document.createElement("p");
    text.setAttribute("data-orientation-text", "1");
    overlay.append(text);
    document.body.append(overlay);
  }
  const textNode = overlay.querySelector("[data-orientation-text]");
  const ios = isIos();

  /** Android/Desktop-PWA: Lock nur versuchen, nie auf iOS. */
  const tryLock = () => {
    if (ios) return;
    try {
      const lock = screen.orientation?.lock?.(mode);
      if (lock && typeof lock.catch === "function") lock.catch(() => {});
    } catch {
      /* nicht überall verfügbar */
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
    const landscape = isLandscapeNow();
    const wrong = mode === "portrait" ? landscape : !landscape;
    overlay.hidden = !wrong;
    document.documentElement.classList.toggle("orientation-wrong", wrong);
    if (!wrong) tryLock();
  };

  /* Nach orientationchange können Maße auf iOS einen Tick hinterherhinken. */
  let applyTimer = 0;
  const onChange = () => {
    apply();
    window.clearTimeout(applyTimer);
    applyTimer = window.setTimeout(apply, 50);
    requestAnimationFrame(apply);
  };

  const mqlOrient = window.matchMedia("(orientation: landscape)");
  const mqlPointer = window.matchMedia("(pointer: coarse)");
  if (typeof mqlOrient.addEventListener === "function") mqlOrient.addEventListener("change", onChange);
  else if (typeof mqlOrient.addListener === "function") mqlOrient.addListener(onChange);
  if (typeof mqlPointer.addEventListener === "function") mqlPointer.addEventListener("change", onChange);
  else if (typeof mqlPointer.addListener === "function") mqlPointer.addListener(onChange);
  window.addEventListener("orientationchange", onChange);
  window.addEventListener("resize", onChange);
  window.visualViewport?.addEventListener("resize", onChange);
  apply();

  return {
    setPreferred(next) {
      mode = next === "landscape" ? "landscape" : "portrait";
      apply();
    },
    destroy() {
      window.clearTimeout(applyTimer);
      if (typeof mqlOrient.removeEventListener === "function") mqlOrient.removeEventListener("change", onChange);
      else if (typeof mqlOrient.removeListener === "function") mqlOrient.removeListener(onChange);
      if (typeof mqlPointer.removeEventListener === "function") mqlPointer.removeEventListener("change", onChange);
      else if (typeof mqlPointer.removeListener === "function") mqlPointer.removeListener(onChange);
      window.removeEventListener("orientationchange", onChange);
      window.removeEventListener("resize", onChange);
      window.visualViewport?.removeEventListener("resize", onChange);
      overlay.remove();
      document.documentElement.classList.remove("orientation-wrong");
      delete document.documentElement.dataset.orientationPrefer;
      if (!ios) {
        try {
          screen.orientation?.unlock?.();
        } catch {
          /* egal */
        }
      }
    },
  };
}
