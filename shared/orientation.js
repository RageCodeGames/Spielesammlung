/**
 * Orientierungshinweis für Spiele.
 * Manifest ist "any"; jedes Spiel wählt portrait oder landscape.
 */

const HINTS = {
  portrait: "Bitte Handy hochkant halten",
  landscape: "Bitte Handy quer halten",
};

/**
 * @param {"portrait" | "landscape"} preferred
 * @returns {{ destroy: () => void }}
 */
export function mountOrientation(preferred = "portrait") {
  const mode = preferred === "landscape" ? "landscape" : "portrait";
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
  const text = overlay.querySelector("[data-orientation-text]");
  if (text) text.textContent = HINTS[mode];

  document.documentElement.dataset.orientationPrefer = mode;

  const apply = () => {
    const landscape = window.matchMedia("(orientation: landscape)").matches;
    const wrong = mode === "portrait" ? landscape : !landscape;
    overlay.hidden = !wrong;
    document.documentElement.classList.toggle("orientation-wrong", wrong);
  };

  try {
    const lock = screen.orientation?.lock?.(mode);
    if (lock && typeof lock.catch === "function") lock.catch(() => {});
  } catch {
    /* nur in installierter PWA / Fullscreen */
  }

  const mql = window.matchMedia("(orientation: landscape)");
  const onChange = () => apply();
  if (typeof mql.addEventListener === "function") mql.addEventListener("change", onChange);
  else if (typeof mql.addListener === "function") mql.addListener(onChange);
  window.addEventListener("orientationchange", onChange);
  apply();

  return {
    destroy() {
      if (typeof mql.removeEventListener === "function") mql.removeEventListener("change", onChange);
      else if (typeof mql.removeListener === "function") mql.removeListener(onChange);
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
