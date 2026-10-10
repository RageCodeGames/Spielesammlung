import { normalizeRemote, readArray } from "../../shared/online.js";
import { ROUND_COUNT, TABLE, cardsPerHand, tableFor } from "./rules.js";

export const TYPE_LABEL = {
  gold: "Gold",
  falle: "Feuerfalle",
  leer: "leere Kammer",
};

export const ROLE_LABEL = {
  abenteurer: "Abenteurer",
  waechterin: "Wächterin",
};

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function shuffle(list, rng = Math.random) {
  const next = [...list];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

export function countsFromPile(pile) {
  const counts = { gold: 0, falle: 0, leer: 0 };
  for (const type of Object.values(pile || {})) {
    if (counts[type] != null) counts[type] += 1;
  }
  return counts;
}

export function normalizeSecret(raw) {
  const pile = {};
  const src = raw?.pile && typeof raw.pile === "object" ? raw.pile : {};
  for (const [id, type] of Object.entries(src)) {
    if (type === "gold" || type === "falle" || type === "leer") pile[id] = type;
  }
  const role = raw?.role === "waechterin" || raw?.role === "abenteurer" ? raw.role : null;
  return { role, pile, counts: countsFromPile(pile) };
}

export function normalizeSecrets(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, secret] of Object.entries(raw)) {
    if (id.startsWith("_")) continue;
    out[id] = normalizeSecret(secret);
  }
  return out;
}

function normalizeCards(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  const entries = Array.isArray(raw) ? raw.map((card, i) => [card?.id || `c${i}`, card]) : Object.entries(raw);
  for (const [id, card] of entries) {
    if (!card || typeof card !== "object") continue;
    const shown = !!card.shown;
    const next = { shown };
    if (shown && (card.type === "gold" || card.type === "falle" || card.type === "leer")) {
      next.type = card.type;
    }
    out[id] = next;
  }
  return out;
}

export function migrateState(data) {
  if (!data || typeof data !== "object") return data;
  const next = normalizeRemote(data, {
    arrays: ["log", "players"],
    defaults: {
      version: 1,
      phase: "play",
      round: 1,
      cardsPerHand: 5,
      revealsDone: 0,
      revealsNeed: 0,
      goldFound: 0,
      goldTotal: 0,
      trapFound: 0,
      trapTotal: 0,
      leftoverRole: false,
      winner: null,
      keyHolderId: null,
      revealSeq: 0,
      lastReveal: null,
    },
  });
  next.players = readArray(next.players).map((player) => ({
    id: player.id,
    name: player.name || "Spieler",
    hasClaim: !!player.hasClaim,
    claimGold: player.hasClaim ? Number(player.claimGold) || 0 : 0,
    claimFalle: player.hasClaim ? Number(player.claimFalle) || 0 : 0,
    cards: normalizeCards(player.cards),
  }));
  next.log = readArray(next.log)
    .filter((row) => row && row.type)
    .map((row) => ({
      seq: Number(row.seq) || 0,
      fromName: row.fromName || "Spieler",
      ownerName: row.ownerName || "Spieler",
      type: row.type,
    }));
  next.roles =
    next.phase === "end" && next.roles && typeof next.roles === "object" ? { ...next.roles } : null;
  if (next.lastReveal && typeof next.lastReveal === "object") {
    next.lastReveal = { ...next.lastReveal };
  } else next.lastReveal = null;
  return next;
}

export function cardList(player) {
  return Object.entries(player?.cards || {}).map(([id, card]) => ({ id, ...card }));
}

export function faceDownCards(player) {
  return cardList(player).filter((card) => !card.shown);
}

function clampInt(value, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function cloneSecrets(secrets) {
  const out = {};
  for (const [id, secret] of Object.entries(secrets || {})) {
    out[id] = {
      role: secret.role,
      pile: { ...(secret.pile || {}) },
      counts: { ...(secret.counts || { gold: 0, falle: 0, leer: 0 }) },
    };
  }
  return out;
}

function publishRoles(state, secrets) {
  const roles = {};
  for (const player of state.players) {
    roles[player.id] = secrets[player.id]?.role || null;
  }
  state.roles = roles;
}

function dealPiles(players, types, cardsEach, seqStart) {
  const secrets = {};
  const publicPlayers = [];
  let seq = seqStart;
  let offset = 0;
  for (const player of players) {
    const pile = {};
    const cards = {};
    const hand = types.slice(offset, offset + cardsEach);
    offset += cardsEach;
    for (const type of hand) {
      const id = `c${seq}`;
      seq += 1;
      pile[id] = type;
      cards[id] = { shown: false };
    }
    secrets[player.id] = {
      role: player.role,
      pile,
      counts: countsFromPile(pile),
    };
    publicPlayers.push({
      id: player.id,
      name: player.name,
      hasClaim: false,
      claimGold: 0,
      claimFalle: 0,
      cards,
    });
  }
  return { secrets, publicPlayers, seq };
}

export function beginMatch(playersInput, rng = Math.random) {
  const players = (playersInput || []).map((player, index) => ({
    id: player.id,
    name: String(player.name || `Spieler ${index + 1}`).trim() || `Spieler ${index + 1}`,
  }));
  const n = players.length;
  const table = tableFor(n);
  const roles = shuffle(
    [
      ...Array(table.adventurers).fill("abenteurer"),
      ...Array(table.guardians).fill("waechterin"),
    ],
    rng
  );
  const leftoverRole = roles.length > n;
  const assigned = roles.slice(0, n);
  const deck = shuffle(
    [
      ...Array(table.gold).fill("gold"),
      ...Array(table.traps).fill("falle"),
      ...Array(table.empty).fill("leer"),
    ],
    rng
  );
  const seated = players.map((player, i) => ({ ...player, role: assigned[i] }));
  const dealt = dealPiles(seated, deck, 5, 1);
  const keyHolderId = seated[Math.floor(rng() * n)].id;
  return {
    state: {
      version: 1,
      phase: "play",
      round: 1,
      cardsPerHand: 5,
      revealsDone: 0,
      revealsNeed: n,
      goldFound: 0,
      goldTotal: table.gold,
      trapFound: 0,
      trapTotal: table.traps,
      leftoverRole,
      winner: null,
      keyHolderId,
      revealSeq: 0,
      lastReveal: null,
      log: [],
      players: dealt.publicPlayers,
      roles: null,
    },
    secrets: dealt.secrets,
  };
}

export function applyClaim(state, playerId, gold, falle) {
  if (state.phase !== "play") return { state, error: "Ansage gerade nicht möglich." };
  const next = clone(state);
  const player = next.players.find((row) => row.id === playerId);
  if (!player) return { state, error: "Unbekannter Spieler." };
  const max = next.cardsPerHand;
  player.hasClaim = true;
  player.claimGold = clampInt(gold, 0, max);
  player.claimFalle = clampInt(falle, 0, max);
  return { state: next, error: null };
}

function finishRound(state, secrets, rng) {
  if (state.round >= ROUND_COUNT) {
    state.phase = "end";
    state.winner = "waechterinnen";
    publishRoles(state, secrets);
    return { state, secrets, error: null };
  }
  const remaining = [];
  for (const player of state.players) {
    for (const [id, card] of Object.entries(player.cards || {})) {
      if (card.shown) continue;
      const type = secrets[player.id]?.pile?.[id];
      if (type) remaining.push(type);
    }
  }
  const nextRound = state.round + 1;
  const each = cardsPerHand(nextRound);
  const need = each * state.players.length;
  if (remaining.length !== need) {
    return { state, secrets, error: "Kartenanzahl passt nicht zur nächsten Runde." };
  }
  const shuffled = shuffle(remaining, rng);
  const seated = state.players.map((player) => ({
    id: player.id,
    name: player.name,
    role: secrets[player.id]?.role || null,
  }));
  const maxSeq = Math.max(
    0,
    ...state.players.flatMap((player) => Object.keys(player.cards || {}).map((id) => Number(String(id).slice(1)) || 0))
  );
  const dealt = dealPiles(seated, shuffled, each, maxSeq + 1);
  state.round = nextRound;
  state.cardsPerHand = each;
  state.revealsDone = 0;
  state.players = dealt.publicPlayers;
  return { state, secrets: dealt.secrets, error: null };
}

export function applyReveal(state, secrets, actorId, ownerId, cardId, rng = Math.random) {
  if (state.phase !== "play") return { state, secrets, error: "Das Spiel ist vorbei." };
  if (state.keyHolderId !== actorId) return { state, secrets, error: "Du hast den Schlüssel nicht." };
  if (!actorId || actorId === ownerId) {
    return { state, secrets, error: "Nimm eine Karte von jemand anderem." };
  }
  const next = clone(state);
  const nextSecrets = cloneSecrets(secrets);
  const owner = next.players.find((row) => row.id === ownerId);
  const actor = next.players.find((row) => row.id === actorId);
  if (!owner || !actor) return { state, secrets, error: "Unbekannter Spieler." };
  const card = owner.cards?.[cardId];
  if (!card) return { state, secrets, error: "Diese Karte gibt es nicht." };
  if (card.shown) return { state, secrets, error: "Die Karte ist schon offen." };
  const type = nextSecrets[ownerId]?.pile?.[cardId];
  if (!type) return { state, secrets, error: "Karte nicht gefunden." };

  card.shown = true;
  card.type = type;
  delete nextSecrets[ownerId].pile[cardId];
  nextSecrets[ownerId].counts = countsFromPile(nextSecrets[ownerId].pile);
  next.revealsDone += 1;
  next.revealSeq += 1;
  next.keyHolderId = ownerId;
  next.lastReveal = {
    seq: next.revealSeq,
    fromId: actorId,
    ownerId,
    cardId,
    type,
  };
  next.log = [
    ...(next.log || []),
    {
      seq: next.revealSeq,
      fromName: actor.name,
      ownerName: owner.name,
      type,
    },
  ].slice(-16);

  if (type === "gold") next.goldFound += 1;
  if (type === "falle") next.trapFound += 1;

  if (next.goldFound >= next.goldTotal) {
    next.phase = "end";
    next.winner = "abenteurer";
    publishRoles(next, nextSecrets);
    return { state: next, secrets: nextSecrets, error: null };
  }
  if (next.trapFound >= next.trapTotal) {
    next.phase = "end";
    next.winner = "waechterinnen";
    publishRoles(next, nextSecrets);
    return { state: next, secrets: nextSecrets, error: null };
  }
  if (next.revealsDone >= next.revealsNeed) {
    return finishRound(next, nextSecrets, rng);
  }
  return { state: next, secrets: nextSecrets, error: null };
}

export function randomClaim(player, rng = Math.random) {
  const n = faceDownCards(player).length;
  return {
    gold: Math.floor(rng() * (n + 1)),
    falle: Math.floor(rng() * (n + 1)),
  };
}

export function randomTarget(state, actorId, rng = Math.random) {
  const options = [];
  for (const player of state.players || []) {
    if (player.id === actorId) continue;
    for (const card of faceDownCards(player)) {
      options.push({ ownerId: player.id, cardId: card.id });
    }
  }
  if (!options.length) return null;
  return options[Math.floor(rng() * options.length)];
}

export function winnerTitle(winner) {
  return winner === "abenteurer" ? "Die Abenteurer gewinnen" : "Die Wächterinnen gewinnen";
}

export function logLine(entry) {
  return `${entry.fromName} deckt bei ${entry.ownerName} auf: ${TYPE_LABEL[entry.type] || entry.type}`;
}

export { TABLE, ROUND_COUNT, cardsPerHand, tableFor };
