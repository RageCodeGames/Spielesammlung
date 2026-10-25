/** Entscheidungen rund um Startpunkt, Seek, Cue-Alter und „Spotify schläft“. */

/** 20-s-Limit nur beim Empfang. Schon angenommene Cues bleiben gültig. */
export function cueArrivalDecision(cue, now = Date.now(), acceptedId = "", maxAgeMs = 20_000) {
  const id = String(cue?.cueId || "");
  if (!id) return { ok: false, reason: "bad-cue" };
  if (id === acceptedId) return { ok: true, already: true };
  const age = now - (Number(cue.sentAt) || 0);
  if (age > maxAgeMs) return { ok: false, reason: "stale", age };
  return { ok: true, age };
}

export const FALLBACK_START_MIN_MS = 30_000;
export const FALLBACK_START_MAX_MS = 70_000;

/** Spotify hat position_ms ignoriert, wenn der Stand noch am Anfang klebt. */
export function positionMsWasIgnored(positionMs, progressMs) {
  const want = Math.max(0, Math.floor(Number(positionMs) || 0));
  const progress = Math.max(0, Math.floor(Number(progressMs) || 0));
  if (want < 8_000) return false;
  return progress < 8_000 && want - progress > 15_000;
}

/**
 * Schlafen-Meldung nur, wenn das gewählte Gerät nach einem erfolgreichen
 * GET /me/player/devices nachweislich fehlt. Nie bei Serverfehlern.
 */
export function sleepDecision({ chosenId, devices, loadFailed = false, serverError = false } = {}) {
  if (serverError) {
    return { sleep: false, reason: "Serverfehler – keine Schlafen-Meldung" };
  }
  if (loadFailed) {
    return { sleep: false, reason: "Geräteliste nicht lesbar – keine Schlafen-Meldung" };
  }
  if (!Array.isArray(devices)) {
    return { sleep: false, reason: "Keine Geräteliste – keine Schlafen-Meldung" };
  }
  const id = String(chosenId || "");
  if (id && devices.some((row) => row && row.id === id)) {
    return { sleep: false, reason: "Gerät steht in GET /me/player/devices" };
  }
  if (id) {
    return {
      sleep: true,
      reason: `Gerät ${id} fehlt in GET /me/player/devices (${devices.length} Geräte)`,
    };
  }
  if (!devices.length) {
    return { sleep: true, reason: "Kein Gerät gewählt und Liste leer nach erfolgreichem Laden" };
  }
  return { sleep: false, reason: "Geräte vorhanden, keins gewählt – keine Schlafen-Meldung" };
}
