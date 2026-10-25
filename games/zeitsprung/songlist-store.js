/**
 * Gemeinsame Songlisten in Firebase: songlists/<playlistId>
 */

import { OnlineError, openDatabase } from "../../shared/online.js";

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
    };
  }
  return {
    playlistId: String(raw?.playlistId || fallbackId),
    title: raw?.title || "Playlist",
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

/** Liste schreiben (kompletter Stand). */
export async function saveSonglist(list) {
  const id = String(list?.playlistId || "").trim();
  if (!id) throw new OnlineError("songlist", "Playlist-ID fehlt.");
  try {
    const { db, ref, set, uid } = await openDatabase();
    const payload = jsonSafe({
      playlistId: id,
      title: list.title || "Playlist",
      updatedAt: Date.now(),
      updatedBy: uid || "",
      songs: list.songs && typeof list.songs === "object" ? list.songs : {},
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
    };
  }
  return {
    playlistId: catalog.id,
    title: catalog.title,
    updatedAt: Date.now(),
    updatedBy: "",
    songs,
  };
}
