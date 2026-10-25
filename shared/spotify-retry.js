/** Vorübergehende Spotify-HTTP-Fehler: nach 1 s und 2 s erneut versuchen. */

export function isTransientSpotifyStatus(status) {
  const n = Number(status);
  return n === 500 || n === 502 || n === 503 || n === 429;
}

/**
 * Wartezeit vor dem nächsten Versuch.
 * @param {number} status
 * @param {number} attempt 0 = erster Retry, 1 = zweiter
 * @param {string} [retryAfterHeader]
 */
export function spotifyRetryDelayMs(status, attempt, retryAfterHeader = "") {
  if (Number(status) === 429) {
    const raw = String(retryAfterHeader || "").trim();
    if (raw) {
      const sec = Number(raw);
      if (Number.isFinite(sec) && sec >= 0) return Math.min(10_000, Math.round(sec * 1000));
      const at = Date.parse(raw);
      if (Number.isFinite(at)) return Math.min(10_000, Math.max(0, at - Date.now()));
    }
  }
  return attempt === 0 ? 1000 : 2000;
}
