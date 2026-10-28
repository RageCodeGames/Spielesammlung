/**
 * Vollbild für Android (Statusleiste ausblenden).
 * iOS unterstützt requestFullscreen nicht – dort no-op.
 */

function isIos() {
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1;
}

function fullscreenElement() {
  return (
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.msFullscreenElement ||
    null
  );
}

/** @returns {Promise<boolean>} true wenn Vollbild aktiv oder schon aktiv war */
export async function requestPlayFullscreen() {
  if (isIos()) return false;
  if (fullscreenElement()) return true;
  const node = document.documentElement;
  const req = node.requestFullscreen || node.webkitRequestFullscreen || node.msRequestFullscreen;
  if (typeof req !== "function") return false;
  try {
    const result = req.call(node, { navigationUI: "hide" });
    if (result && typeof result.then === "function") await result;
    return Boolean(fullscreenElement());
  } catch {
    return false;
  }
}

/** Vollbild beenden – Fehler still. */
export async function exitPlayFullscreen() {
  if (isIos()) return;
  if (!fullscreenElement()) return;
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  if (typeof exit !== "function") return;
  try {
    const result = exit.call(document);
    if (result && typeof result.then === "function") await result;
  } catch {
    /* egal */
  }
}
