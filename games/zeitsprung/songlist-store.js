/**
 * Gemeinsame Songlisten in Firebase: songlists/<playlistId>
 */

import { OnlineError, openDatabase } from "../../shared/online.js";
import { DEFAULT_VARIANT_NAME } from "./rules.js";

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

export function normalizeSonglist(raw, fallbackId = "") {
  const songsRaw = raw?.songs && typeof raw.songs === "object" ? raw.songs : {};
  const songs = {};
  for (const [key, row] of Object.entries(songsRaw)) {
    if (!row || typeof row !== "object") continue;
    const id = String(row.id || key);
    songs[id] = {
      id,
      uri: row.uri || `spotify:track:${id}`,
      title: row.title || "Ohne Titel",
      artist: row.artist || "",
      year: Number(row.year) || 0,
      yearOverride: row.yearOverride == null || row.yearOverride === "" ? null : Number(row.yearOverride) || 0,
      album: row.album || "",
      albumType: row.albumType || "",
      suspicious: row.suspicious === true,
      excluded: row.excluded === true,
      unplayable: row.unplayable === true,
      durationMs: Math.max(0, Math.floor(Number(row.durationMs) || 0)),
      playlistIndex: Number.isFinite(Number(row.playlistIndex))
        ? Math.max(0, Math.floor(Number(row.playlistIndex)))
        : null,
      playlistId: String(row.playlistId || raw?.playlistId || fallbackId || "").trim(),
    };
  }
  const name = String(raw?.name || "").trim() || DEFAULT_VARIANT_NAME;
  return {
    playlistId: String(raw?.playlistId || fallbackId),
    title: raw?.title || "Playlist",
    name,
    updatedAt: Number(raw?.updatedAt) || 0,
    updatedBy: raw?.updatedBy || "",
    songs,
  };
}

/** Gespeicherte Liste lesen oder null. */
export async function loadSonglist(playlistId) {
  const id = String(playlistId || "").trim();
  if (!id) return null;
  try {
    const { db, ref, get } = await openDatabase();
    const snap = await get(ref(db, `songlists/${id}`));
    if (!snap.exists()) return null;
    return normalizeSonglist(snap.val(), id);
  } catch (err) {
    console.error("[zeitsprung] Songliste laden", err);
    if (err instanceof OnlineError) throw err;
    throw new OnlineError("songlist", err?.message || "Songliste konnte nicht geladen werden.");
  }
}

/** Variante aus Firebase löschen. */
export async function deleteSonglist(playlistId) {
  const id = String(playlistId || "").trim();
  if (!id) throw new OnlineError("songlist", "Playlist-ID fehlt.");
  try {
    const { db, ref, remove } = await openDatabase();
    await remove(ref(db, `songlists/${id}`));
    return true;
  } catch (err) {
    console.error("[zeitsprung] Songliste löschen", err);
    if (err instanceof OnlineError) throw err;
    throw new OnlineError("songlist", err?.message || "Songliste konnte nicht gelöscht werden.");
  }
}

/** Liste schreiben (kompletter Stand). */
export async function saveSonglist(list) {
  const id = String(list?.playlistId || "").trim();
  if (!id) throw new OnlineError("songlist", "Playlist-ID fehlt.");
  try {
    const { db, ref, set, uid } = await openDatabase();
    const songsIn = list.songs && typeof list.songs === "object" ? list.songs : {};
    const songs = {};
    for (const [key, row] of Object.entries(songsIn)) {
      if (!row || typeof row !== "object") continue;
      songs[key] = { ...row, playlistId: String(row.playlistId || id).trim() };
    }
    const payload = jsonSafe({
      playlistId: id,
      title: list.title || "Playlist",
      name: String(list.name || "").trim() || DEFAULT_VARIANT_NAME,
      updatedAt: Date.now(),
      updatedBy: uid || "",
      songs,
    });
    await set(ref(db, `songlists/${id}`), payload);
    return normalizeSonglist(payload, id);
  } catch (err) {
    console.error("[zeitsprung] Songliste speichern", err);
    if (err instanceof OnlineError) throw err;
    throw new OnlineError("songlist", err?.message || "Songliste konnte nicht gespeichert werden.");
  }
}

/**
 * Spotify-Katalog mit gespeicherten Korrekturen mergen.
 * Neue Songs kommen dazu; yearOverride und excluded bleiben erhalten.
 */
export function mergeCatalogWithStored(catalog, stored) {
  const prev = stored?.songs || {};
  const songs = {};
  for (const track of catalog.tracks || []) {
    const old = prev[track.id];
    const yearOverride = old?.yearOverride == null ? null : old.yearOverride;
    songs[track.id] = {
      id: track.id,
      uri: track.uri,
      title: track.title,
      artist: track.artist,
      year: track.year,
      yearOverride,
      album: track.album,
      albumType: track.albumType,
      // Korrektur behalten: mit yearOverride nicht wieder als verdächtig markieren
      suspicious: yearOverride != null ? false : track.suspicious === true,
      excluded: old?.excluded === true,
      unplayable: old?.unplayable === true,
      durationMs: Math.max(0, Math.floor(Number(track.durationMs) || Number(old?.durationMs) || 0)),
      playlistIndex: Number.isFinite(Number(track.playlistIndex))
        ? Math.max(0, Math.floor(Number(track.playlistIndex)))
        : Number.isFinite(Number(old?.playlistIndex))
          ? Math.max(0, Math.floor(Number(old.playlistIndex)))
          : null,
      playlistId: catalog.id || stored?.playlistId || "",
    };
  }
  return {
    playlistId: catalog.id,
    title: catalog.title,
    name: stored?.name || DEFAULT_VARIANT_NAME,
    updatedAt: Date.now(),
    updatedBy: "",
    songs,
  };
}

/** Alle Varianten (Name + Anzahl spielbarer Songs). */
export async function listSonglists() {
  try {
    const { db, ref, get } = await openDatabase();
    const snap = await get(ref(db, "songlists"));
    if (!snap.exists()) return [];
    const raw = snap.val() && typeof snap.val() === "object" ? snap.val() : {};
    const out = [];
    for (const [id, row] of Object.entries(raw)) {
      const list = normalizeSonglist(row, id);
      if (!String(row?.name || "").trim()) {
        try {
          await saveSonglist(list);
        } catch (err) {
          console.error("[zeitsprung] Variantenname", err);
        }
      }
      const playableIds = Object.values(list.songs)
        .filter((song) => !song.excluded && !song.unplayable && (song.yearOverride || song.year))
        .map((song) => String(song.id));
      out.push({
        playlistId: list.playlistId,
        name: list.name || DEFAULT_VARIANT_NAME,
        title: list.title,
        songCount: playableIds.length,
        playableIds,
        updatedAt: list.updatedAt,
      });
    }
    out.sort((a, b) => String(a.name).localeCompare(String(b.name), "de"));
    return out;
  } catch (err) {
    console.error("[zeitsprung] Songlisten auflisten", err);
    if (err instanceof OnlineError) throw err;
    throw new OnlineError("songlist", err?.message || "Songlisten konnten nicht geladen werden.");
  }
}

/** Song in der Herkunfts-Liste als nicht abspielbar markieren und künftig auslassen. */
export async function markSongUnplayable(playlistId, trackId) {
  const listId = String(playlistId || "").trim();
  const id = String(trackId || "").trim();
  if (!listId || !id) return false;
  const list = await loadSonglist(listId);
  if (!list?.songs?.[id]) return false;
  if (list.songs[id].unplayable) return true;
  list.songs[id].unplayable = true;
  await saveSonglist(list);
  return true;
}
