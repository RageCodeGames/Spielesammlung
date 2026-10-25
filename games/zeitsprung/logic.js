import { normalizeRemote, readArray } from "../../shared/online.js";
import { effectiveYear } from "./suspicious.js";
import {
  BUY_COST,
  CHALLENGE_COST,
  CHALLENGE_MS,
  CHALLENGE_PLACE_MS,
  DEFAULT_VARIANT_NAME,
  GOAL_OPTIONS,
  SKIP_COST,
  TOKEN_MAX,
  TOKEN_START_DEFAULT,
  TOKEN_START_OPTIONS,
} from "./rules.js";

export function defaultSettings() {
  return {
    playlistIds: [],
    mix: false,
    goal: 10,
    clipSec: 30,
    startTokens: TOKEN_START_DEFAULT,
    challengeOn: true,
  };
}

export function normalizeSettings(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== "object") return base;
  const ids = Array.isArray(raw.playlistIds)
    ? raw.playlistIds.map((id) => String(id || "").trim()).filter(Boolean)
    : raw.playlistId
      ? [String(raw.playlistId)]
      : [];
  const unique = [...new Set(ids)];
  /* Mix-Flag bleibt in der Lobby, solange der Host den Modus an hat;
     fürs Spiel gilt: Mix nur bei ≥ 2 Listen (siehe effectiveMix). */
  return {
    playlistIds: unique,
    mix: unique.length >= 2 ? true : raw.mix === true,
    goal: GOAL_OPTIONS.includes(raw.goal) ? raw.goal : base.goal,
    clipSec: raw.clipSec === 0 ? 0 : 30,
    startTokens: TOKEN_START_OPTIONS.includes(Number(raw.startTokens))
      ? Number(raw.startTokens)
      : base.startTokens,
    challengeOn: raw.challengeOn !== false,
  };
}

/** Wirklicher Mix erst ab zwei Varianten – eine Auswahl = normale Variante. */
export function effectiveMix(settings) {
  const s = normalizeSettings(settings);
  return s.playlistIds.length >= 2;
}

/** Eindeutige spielbare Tracks über die gewählten Varianten (nach Track-ID). */
export function countUniqueSongs(playlistIds, catalogs = []) {
  const ids = Array.isArray(playlistIds) ? playlistIds : [];
  const seen = new Set();
  let fallback = 0;
  for (const id of ids) {
    const cat = catalogs.find((row) => row.playlistId === id);
    if (!cat) continue;
    const trackIds = Array.isArray(cat.playableIds) ? cat.playableIds : null;
    if (trackIds) {
      for (const tid of trackIds) {
        if (tid) seen.add(String(tid));
      }
    } else {
      fallback += Number(cat.songCount) || 0;
    }
  }
  return seen.size || fallback;
}

export function summarizeSettings(raw, catalogs = []) {
  const s = normalizeSettings(raw);
  const names = s.playlistIds
    .map((id) => catalogs.find((row) => row.playlistId === id)?.name)
    .filter(Boolean);
  const songN = countUniqueSongs(s.playlistIds, catalogs);
  const songBit = songN ? ` · ${songN} Songs` : "";
  let label;
  if (s.playlistIds.length >= 2) {
    label = names.length
      ? `Mix: ${names.join(" + ")}`
      : `Mix: ${s.playlistIds.length} Varianten`;
  } else if (names.length) {
    label = names[0];
  } else if (s.playlistIds.length) {
    label = "1 Variante";
  } else {
    label = "Keine Songliste";
  }
  const clip = s.clipSec ? `${s.clipSec}s` : "ganzer Song";
  return `${label}${songBit} · ${s.goal} Karten · ${clip} · ${s.startTokens} Token${s.challengeOn ? " · Herausfordern" : ""}`;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function shuffle(list, rng = Math.random) {
  const next = [...list];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [next[j], next[i]] = [next[i], next[j]];
  }
  return next;
}

function packSong(song, fallbackPlaylistId = "", fallbackVariant = "") {
  if (!song || typeof song !== "object") return null;
  const id = String(song.id || "").trim();
  if (!id) return null;
  const playlistId = String(song.playlistId || fallbackPlaylistId || "").trim();
  return {
    id,
    uri: String(song.uri || "").trim() || `spotify:track:${id}`,
    title: String(song.title || "Ohne Titel"),
    artist: String(song.artist || ""),
    year: Number(song.year) || 0,
    playlistId,
    variantName: String(song.variantName || fallbackVariant || DEFAULT_VARIANT_NAME),
  };
}

export function playableFromList(list) {
  const playlistId = String(list?.playlistId || "").trim();
  const variantName = list?.name || DEFAULT_VARIANT_NAME;
  const out = [];
  for (const song of Object.values(list?.songs || {})) {
    if (!song?.id || song.excluded) continue;
    const year = effectiveYear(song);
    if (!year) continue;
    const packed = packSong({ ...song, year, playlistId: song.playlistId || playlistId }, playlistId, variantName);
    if (packed?.playlistId) out.push(packed);
  }
  return out;
}

/** Mehrere Varianten: gleiche Track-ID nur einmal (erste Liste gewinnt). */
export function mixCatalogs(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists || []) {
    for (const song of playableFromList(list)) {
      if (seen.has(song.id)) continue;
      seen.add(song.id);
      out.push(song);
    }
  }
  return out;
}

export function publicCard(song) {
  if (!song) return null;
  return { id: song.id, title: song.title, artist: song.artist, year: song.year };
}

export function gapOk(timeline, year, gap) {
  const cards = readArray(timeline);
  const g = Math.max(0, Math.min(cards.length, Math.floor(Number(gap) || 0)));
  const left = g === 0 ? null : cards[g - 1];
  const right = g >= cards.length ? null : cards[g];
  const leftOk = !left || Number(left.year) <= Number(year);
  const rightOk = !right || Number(right.year) >= Number(year);
  return leftOk && rightOk;
}

export function firstValidGap(timeline, year) {
  const cards = readArray(timeline);
  for (let g = 0; g <= cards.length; g += 1) {
    if (gapOk(cards, year, g)) return g;
  }
  return cards.length;
}

export function insertAt(timeline, gap, card) {
  const cards = readArray(timeline);
  const g = Math.max(0, Math.min(cards.length, Math.floor(Number(gap) || 0)));
  const next = cards.slice();
  next.splice(g, 0, card);
  return next;
}

function mapPlayers(raw) {
  return readArray(raw).map((player) => ({
    id: player.id,
    name: player.name || "Spieler",
    dummy: player.dummy === true,
  }));
}

function mapTokens(raw, players, fallback = 0) {
  const out = {};
  for (const player of players) {
    const n = Math.floor(Number(raw?.[player.id]));
    out[player.id] = Number.isFinite(n) ? Math.max(0, Math.min(TOKEN_MAX, n)) : fallback;
  }
  return out;
}

function mapTimelines(raw, players) {
  const out = {};
  for (const player of players) {
    out[player.id] = readArray(raw?.[player.id]).map((card) => ({
      id: card.id,
      title: card.title || "",
      artist: card.artist || "",
      year: Number(card.year) || 0,
    }));
  }
  return out;
}

export function migrateState(data) {
  if (!data || typeof data !== "object") return data;
  const next = normalizeRemote(data, {
    arrays: ["players", "order", "playlistIds", "variantNames"],
    defaults: {
      version: 1,
      phase: "turn",
      waitingForHost: false,
      goal: 10,
      clipSec: 30,
      startTokens: TOKEN_START_DEFAULT,
      challengeOn: true,
      mix: false,
      turnIndex: 0,
      activeId: "",
      played: false,
      cue: null,
      proposedGap: null,
      challengerId: null,
      challengeGap: null,
      challengeUntil: 0,
      awarded: false,
      reveal: null,
      winnerId: null,
      discardCount: 0,
    },
  });
  next.players = mapPlayers(next.players);
  next.order = readArray(next.order).filter((id) => next.players.some((p) => p.id === id));
  if (!next.order.length) next.order = next.players.map((p) => p.id);
  next.playlistIds = readArray(next.playlistIds).map(String);
  next.variantNames = readArray(next.variantNames).map(String);
  next.tokens = mapTokens(next.tokens, next.players, 0);
  next.timelines = mapTimelines(next.timelines, next.players);
  next.goal = GOAL_OPTIONS.includes(next.goal) ? next.goal : 10;
  next.clipSec = next.clipSec === 0 ? 0 : 30;
  if (!next.activeId) next.activeId = next.order[next.turnIndex % next.order.length] || "";
  return next;
}

export function normalizeSecrets(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const game = data._game && typeof data._game === "object" ? data._game : data;
  return {
    deck: readArray(game.deck).map((song) => packSong(song)).filter(Boolean),
    current: packSong(game.current),
    used: game.used && typeof game.used === "object" ? game.used : {},
  };
}

export function packSecrets(secrets) {
  const s = normalizeSecrets(secrets);
  return {
    _game: {
      deck: s.deck,
      current: s.current || null,
      used: s.used,
    },
  };
}

function drawSong(secrets) {
  const s = normalizeSecrets(secrets);
  if (!s.deck.length) return { song: null, secrets: s };
  const song = s.deck[0];
  s.deck = s.deck.slice(1);
  s.used = { ...s.used, [song.id]: 1 };
  s.current = song;
  return { song, secrets: s };
}

function nextIndex(order, fromId) {
  const i = order.indexOf(fromId);
  if (i < 0) return 0;
  return (i + 1) % order.length;
}

function setActive(state, playerId) {
  const order = readArray(state.order);
  const idx = Math.max(0, order.indexOf(playerId));
  state.activeId = playerId;
  state.turnIndex = idx < 0 ? 0 : idx;
  state.played = false;
  state.cue = null;
  state.proposedGap = null;
  state.challengerId = null;
  state.challengeGap = null;
  state.challengeUntil = 0;
  state.awarded = false;
  state.reveal = null;
  state.phase = "turn";
}

/**
 * Cue für den aktuellen Song setzen und Hörphase starten (ohne Karten-Antippen).
 * @returns {{ state, secrets } | { error, message? }}
 */
export function dealCue(state, secrets) {
  const s = migrateState(state);
  const sec = normalizeSecrets(secrets);
  if (s.phase === "end") return { state: s, secrets: sec };
  if (!sec.current) return { error: "no-card" };
  if (s.phase === "listen" && s.cue && s.played) return { state: s, secrets: sec };
  const fallback = readArray(s.playlistIds).length === 1 ? s.playlistIds[0] : "";
  const cue = makeCue(sec.current, s.clipSec, fallback);
  if (!cue) {
    return {
      error: "no-uri",
      message: "Dieser Song hat keine gültige Playlist- oder Song-ID. Überspringe oder kaufe die Karte.",
      state: s,
      secrets: sec,
    };
  }
  s.played = true;
  s.cue = cue;
  s.phase = "listen";
  return { state: s, secrets: sec };
}

function startPlayerTurn(state, secrets, playerId) {
  setActive(state, playerId);
  const dealt = dealCue(state, secrets);
  if (dealt.error && !dealt.state) return dealt;
  return { state: dealt.state || state, secrets: dealt.secrets || secrets, error: dealt.error, message: dealt.message };
}

function checkWin(state, playerId) {
  const n = readArray(state.timelines?.[playerId]).length;
  if (n >= state.goal) {
    state.phase = "end";
    state.winnerId = playerId;
    state.played = false;
    state.cue = null;
    return true;
  }
  return false;
}

export function catalogCountNeeded(playerCount, goal) {
  return Math.max(playerCount * 2, playerCount + goal + 4);
}

export function beginMatch(roomPlayers, settings, songs, rng = Math.random) {
  const s = normalizeSettings(settings);
  const players = (roomPlayers || []).map((p) => ({
    id: p.id,
    name: p.name || "Spieler",
    dummy: p.dummy === true,
  }));
  if (players.length < 2) throw new Error("Mindestens 2 Spieler.");
  const pool = shuffle(songs || [], rng);
  const need = catalogCountNeeded(players.length, s.goal);
  if (pool.length < need) {
    throw new Error(`Zu wenige Songs (${pool.length}, nötig ca. ${need}). Weitere Varianten laden oder Mix nutzen.`);
  }
  const used = {};
  const timelines = {};
  const tokens = {};
  for (const player of players) {
    const start = pool.shift();
    used[start.id] = 1;
    timelines[player.id] = [publicCard(start)];
    tokens[player.id] = s.startTokens;
  }
  const current = pool.shift();
  used[current.id] = 1;
  const order = players.map((p) => p.id);
  const state = migrateState({
    version: 1,
    phase: "turn",
    goal: s.goal,
    clipSec: s.clipSec,
    startTokens: s.startTokens,
    challengeOn: s.challengeOn,
    mix: effectiveMix(s),
    playlistIds: effectiveMix(s) ? s.playlistIds : s.playlistIds.slice(0, 1),
    variantNames: [...new Set(songs.map((song) => song.variantName).filter(Boolean))],
    players,
    order,
    turnIndex: 0,
    activeId: order[0],
    tokens,
    timelines,
    played: false,
    discardCount: 0,
  });
  const secrets = {
    deck: pool,
    current,
    used,
  };
  const dealt = dealCue(state, secrets);
  return { state: dealt.state || state, secrets: dealt.secrets || secrets };
}

export function makeCue(song, clipSec, fallbackPlaylistId = "") {
  const packed = packSong(song, fallbackPlaylistId);
  const playlistId = packed?.playlistId || String(fallbackPlaylistId || "").trim();
  const trackUri = packed?.uri || "";
  if (!playlistId || !trackUri) return null;
  const sentAt = Date.now();
  return {
    cueId: `${sentAt}-${Math.random().toString(36).slice(2, 8)}`,
    playlistUri: `spotify:playlist:${playlistId}`,
    trackUri,
    sentAt,
    clipSec: Number(clipSec) || 0,
  };
}

/** Früher: Karte antippen. Cue kommt jetzt automatisch – Funktion bleibt für Alt-Clients. */
export function tapCard(state, secrets, fromId) {
  const s = migrateState(state);
  const sec = normalizeSecrets(secrets);
  if (fromId !== s.activeId) return { error: "not-active" };
  if (s.phase === "listen" && s.cue) return { state: s, secrets: sec };
  if (s.phase !== "turn" || s.played) return { error: "not-now" };
  return dealCue(s, sec);
}

export function skipSong(state, secrets, fromId) {
  const s = migrateState(state);
  const sec = normalizeSecrets(secrets);
  if (s.phase !== "turn" && s.phase !== "listen") return { error: "not-now" };
  if (fromId !== s.activeId) return { error: "not-active" };
  if ((s.tokens[fromId] || 0) < SKIP_COST) return { error: "no-token" };
  s.tokens[fromId] -= SKIP_COST;
  s.discardCount = (s.discardCount || 0) + 1;
  const drawn = drawSong(sec);
  if (!drawn.song) {
    s.phase = "end";
    s.winnerId = s.winnerId || longestPlayer(s);
    return { state: s, secrets: drawn.secrets };
  }
  return startPlayerTurn(s, drawn.secrets, fromId);
}

export function buyCard(state, secrets, fromId) {
  const s = migrateState(state);
  const sec = normalizeSecrets(secrets);
  if (s.phase !== "turn" && s.phase !== "listen") return { error: "not-now" };
  if (fromId !== s.activeId) return { error: "not-active" };
  if ((s.tokens[fromId] || 0) < BUY_COST) return { error: "no-token" };
  if (!sec.current) return { error: "no-card" };
  s.tokens[fromId] -= BUY_COST;
  const card = publicCard(sec.current);
  const gap = firstValidGap(s.timelines[fromId], card.year);
  s.timelines[fromId] = insertAt(s.timelines[fromId], gap, card);
  if (checkWin(s, fromId)) return { state: s, secrets: { ...sec, current: null } };
  return advanceTurn(s, sec);
}

export function proposePlace(state, secrets, fromId, gap) {
  const s = migrateState(state);
  const sec = normalizeSecrets(secrets);
  if (s.phase !== "listen" && s.phase !== "turn") return { error: "not-now" };
  if (fromId !== s.activeId) return { error: "not-active" };
  if (!s.played) return { error: "play-first" };
  if (!sec.current) return { error: "no-card" };
  const cards = readArray(s.timelines[fromId]);
  const g = Math.max(0, Math.min(cards.length, Math.floor(Number(gap) || 0)));
  s.proposedGap = g;
  s.challengerId = null;
  s.challengeGap = null;
  if (s.challengeOn) {
    s.phase = "challenge";
    s.challengeUntil = Date.now() + CHALLENGE_MS;
    s.cue = null;
  } else {
    return resolvePlacement(s, sec);
  }
  return { state: s, secrets: sec };
}

export function claimChallenge(state, fromId, at = Date.now()) {
  const s = migrateState(state);
  if (s.phase !== "challenge") return { error: "not-now" };
  if (fromId === s.activeId) return { error: "self" };
  if (s.challengerId) return { error: "taken" };
  if ((s.tokens[fromId] || 0) < CHALLENGE_COST) return { error: "no-token" };
  if (s.challengeUntil && at > s.challengeUntil) return { error: "late" };
  s.tokens[fromId] -= CHALLENGE_COST;
  s.challengerId = fromId;
  s.phase = "challenge-place";
  s.challengeGap = null;
  s.challengeUntil = Date.now() + CHALLENGE_PLACE_MS;
  return { state: s };
}

export function aimChallenge(state, fromId, gap) {
  const s = migrateState(state);
  if (s.phase !== "challenge-place") return { error: "not-now" };
  if (fromId !== s.challengerId) return { error: "not-challenger" };
  const cards = readArray(s.timelines[s.activeId]);
  const g = Math.max(0, Math.min(cards.length, Math.floor(Number(gap) || 0)));
  if (g === s.proposedGap) return { error: "same-gap" };
  s.challengeGap = g;
  return { state: s };
}

export function challengePlace(state, secrets, fromId, gap) {
  const s = migrateState(state);
  const sec = normalizeSecrets(secrets);
  if (s.phase !== "challenge-place") return { error: "not-now" };
  if (fromId !== s.challengerId) return { error: "not-challenger" };
  const cards = readArray(s.timelines[s.activeId]);
  const g = Math.max(0, Math.min(cards.length, Math.floor(Number(gap) || 0)));
  if (g === s.proposedGap) return { error: "same-gap" };
  s.challengeGap = g;
  return resolvePlacement(s, sec);
}

export function expireChallenge(state, secrets, now = Date.now()) {
  const s = migrateState(state);
  if (s.phase !== "challenge" && s.phase !== "challenge-place") return { error: "not-now" };
  if (s.challengeUntil && now < s.challengeUntil) return { error: "wait" };
  return resolvePlacement(s, normalizeSecrets(secrets));
}

function resolvePlacement(state, secrets) {
  const s = state;
  const sec = secrets;
  const song = sec.current;
  if (!song) return { error: "no-card" };
  const year = song.year;
  const activeOk = gapOk(s.timelines[s.activeId], year, s.proposedGap);
  const challengerOk =
    s.challengerId != null && s.challengeGap != null
      ? gapOk(s.timelines[s.activeId], year, s.challengeGap)
      : false;
  const card = publicCard(song);
  let result = "discard";
  let holder = null;
  if (activeOk) {
    s.timelines[s.activeId] = insertAt(s.timelines[s.activeId], s.proposedGap, card);
    result = "keep";
    holder = s.activeId;
  } else if (challengerOk && s.challengerId) {
    const stealGap = firstValidGap(s.timelines[s.challengerId], year);
    s.timelines[s.challengerId] = insertAt(s.timelines[s.challengerId], stealGap, card);
    result = "steal";
    holder = s.challengerId;
  } else {
    s.discardCount = (s.discardCount || 0) + 1;
  }
  s.phase = "reveal";
  s.played = false;
  s.cue = null;
  s.awarded = false;
  s.reveal = {
    title: song.title,
    artist: song.artist,
    year: song.year,
    result,
    holderId: holder,
    activeOk,
    challengerOk,
  };
  sec.current = null;
  if (holder && checkWin(s, holder)) return { state: s, secrets: sec };
  return { state: s, secrets: sec };
}

export function awardTitle(state, fromId, hostId) {
  const s = migrateState(state);
  if (s.phase !== "reveal") return { error: "not-now" };
  if (fromId !== hostId) return { error: "not-host" };
  if (s.awarded) return { error: "done" };
  const id = s.activeId;
  s.tokens[id] = Math.min(TOKEN_MAX, (s.tokens[id] || 0) + 1);
  s.awarded = true;
  return { state: s };
}

export function finishReveal(state, secrets) {
  const s = migrateState(state);
  if (s.phase !== "reveal") return { error: "not-now" };
  if (s.phase === "end") return { state: s, secrets: normalizeSecrets(secrets) };
  return advanceTurn(s, normalizeSecrets(secrets));
}

function longestPlayer(state) {
  let best = state.players[0]?.id || "";
  let n = -1;
  for (const player of state.players) {
    const len = readArray(state.timelines[player.id]).length;
    if (len > n) {
      n = len;
      best = player.id;
    }
  }
  return best;
}

function advanceTurn(state, secrets) {
  const drawn = drawSong(secrets);
  if (!drawn.song) {
    state.phase = "end";
    state.winnerId = state.winnerId || longestPlayer(state);
    state.cue = null;
    return { state, secrets: drawn.secrets };
  }
  const nid = state.order[nextIndex(state.order, state.activeId)];
  return startPlayerTurn(state, drawn.secrets, nid);
}

export function dropPlayer(state, secrets, playerId) {
  const s = migrateState(state);
  const sec = normalizeSecrets(secrets);
  s.players = s.players.filter((p) => p.id !== playerId);
  s.order = s.order.filter((id) => id !== playerId);
  delete s.tokens[playerId];
  delete s.timelines[playerId];
  if (s.players.length < 2) {
    s.phase = "end";
    s.winnerId = s.players[0]?.id || s.winnerId;
    return { state: s, secrets: sec };
  }
  if (s.activeId === playerId || s.challengerId === playerId) {
    if (s.phase === "end") return { state: s, secrets: sec };
    return advanceTurn(s, sec);
  }
  return { state: s, secrets: sec };
}

export function pauseForHost(state) {
  const s = migrateState(state);
  s.waitingForHost = true;
  return s;
}

export function resumeHost(state) {
  const s = migrateState(state);
  s.waitingForHost = false;
  return s;
}

export function playerName(state, id) {
  return state?.players?.find((p) => p.id === id)?.name || "Spieler";
}
