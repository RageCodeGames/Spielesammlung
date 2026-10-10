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

const CARD_TYPES = new Set(["gold", "falle", "leer"]);

export function emptyCounts() {
  return { gold: 0, falle: 0, leer: 0 };
}

export function countsFromHand(hand) {
  const counts = emptyCounts();
  for (const card of hand || []) {
    if (CARD_TYPES.has(card.type)) counts[card.type] += 1;
  }
  return counts;
}

export function countsFromPile(pile) {
  return countsFromHand(handFromRaw({ pile, hand: pile }));
}

function cardType(value) {
  return CARD_TYPES.has(value) ? value : null;
}

function cardsFromList(list) {
  const hand = [];
  const items = Array.isArray(list)
    ? list
    : list && typeof list === "object"
      ? Object.values(list)
      : [];
  for (const card of items) {
    const type = cardType(typeof card === "string" ? card : card?.type);
    const id = card?.id != null ? String(card.id) : "";
    if (id && type) hand.push({ id, type });
  }
  return hand;
}

/** Verdeckte Karten als dichte Liste – Firebase-sicher, ohne Lücken. */
export function handFromRaw(raw) {
  if (!raw || typeof raw !== "object") return [];
  if (raw.hand != null) return cardsFromList(raw.hand);
  const pile = raw.pile;
  if (pile == null) return [];
  if (Array.isArray(pile)) return cardsFromList(pile);
  if (typeof pile === "object") {
    const asList = cardsFromList(pile);
    if (asList.length) return asList;
    const hand = [];
    for (const [id, type] of Object.entries(pile)) {
      const kind = cardType(type);
      if (kind) hand.push({ id: String(id), type: kind });
    }
    return hand;
  }
  return [];
}

function pileFromHand(hand) {
  const pile = {};
  for (const card of hand) pile[card.id] = card.type;
  return pile;
}

export function syncSecret(secret) {
  const role = secret?.role === "waechterin" || secret?.role === "abenteurer" ? secret.role : null;
  const hand = Array.isArray(secret?.hand)
    ? secret.hand.filter((card) => card?.id && CARD_TYPES.has(card.type)).map((card) => ({ id: String(card.id), type: card.type }))
    : handFromRaw(secret);
  const counts = countsFromHand(hand);
  return {
    role,
    hand,
    pile: pileFromHand(hand),
    counts,
    hidden: hand.length,
  };
}

export function normalizeSecret(raw) {
  return syncSecret(raw);
}

/** Vor dem Schreiben: Zählfelder immer gesetzt, leere Hand weglassen. */
export function packSecrets(secrets) {
  const out = {};
  for (const [id, raw] of Object.entries(secrets || {})) {
    const secret = syncSecret(raw);
    const packed = {
      role: secret.role,
      hidden: secret.hidden,
      gold: secret.counts.gold,
      falle: secret.counts.falle,
      leer: secret.counts.leer,
    };
    if (secret.hand.length) {
      packed.hand = secret.hand.map((card) => ({ id: card.id, type: card.type }));
      packed.pile = secret.pile;
    }
    out[id] = packed;
  }
  return out;
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
      endReason: null,
      leftName: null,
      keyHolderId: null,
      revealSeq: 0,
      lastReveal: null,
    },
  });
  next.players = readArray(next.players).map((player) => ({
    id: player.id,
    name: player.name || "Spieler",
    claim: normalizeClaim(player.claim),
    cards: normalizeCards(player.cards),
  }));
  next.roundLog = readArray(next.roundLog)
    .filter((row) => row && Number(row.round))
    .map((row) => ({
      round: Number(row.round),
      cardsPerHand: Number(row.cardsPerHand) || 0,
      entries: readArray(row.entries).map((entry) => ({
        name: entry?.name || "Spieler",
        claim: normalizeClaim(entry?.claim),
        shown: normalizeShown(entry?.shown),
      })),
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

export function normalizeClaim(raw) {
  if (!raw || typeof raw !== "object" || raw.set !== true) return null;
  const role = raw.role === "abenteurer" || raw.role === "waechterin" ? raw.role : null;
  return {
    set: true,
    role,
    gold: Math.max(0, Math.floor(Number(raw.gold) || 0)),
    falle: Math.max(0, Math.floor(Number(raw.falle) || 0)),
  };
}

function normalizeShown(raw) {
  return {
    gold: Math.max(0, Number(raw?.gold) || 0),
    falle: Math.max(0, Number(raw?.falle) || 0),
    leer: Math.max(0, Number(raw?.leer) || 0),
  };
}

/** Was in dieser Runde bei einem Spieler schon aufgedeckt wurde. */
export function shownCounts(player) {
  const counts = { gold: 0, falle: 0, leer: 0 };
  for (const card of Object.values(player?.cards || {})) {
    if (card?.shown && counts[card.type] != null) counts[card.type] += 1;
  }
  return counts;
}

export function claimText(claim, cardsPerHand) {
  if (!claim) return "keine Ansage";
  const parts = [];
  if (claim.role) parts.push(ROLE_LABEL[claim.role]);
  const empty = Math.max(0, cardsPerHand - claim.gold - claim.falle);
  parts.push(`${claim.gold} Gold`, `${claim.falle} ${claim.falle === 1 ? "Falle" : "Fallen"}`, `${empty} leer`);
  return parts.join(" · ");
}

export function shownText(shown) {
  const parts = [];
  if (shown.gold) parts.push(`${shown.gold} Gold`);
  if (shown.falle) parts.push(`${shown.falle} ${shown.falle === 1 ? "Falle" : "Fallen"}`);
  if (shown.leer) parts.push(`${shown.leer} leer`);
  return parts.length ? parts.join(" · ") : "nichts";
}

function snapshotRound(state) {
  const entry = {
    round: state.round,
    cardsPerHand: state.cardsPerHand,
    entries: state.players.map((player) => ({
      name: player.name,
      claim: player.claim || null,
      shown: shownCounts(player),
    })),
  };
  state.roundLog = [...(state.roundLog || []).filter((row) => row.round !== state.round), entry];
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
    out[id] = syncSecret(secret);
  }
  return out;
}

function typeOfSecretCard(secret, cardId) {
  const synced = syncSecret(secret);
  return synced.pile[cardId] || synced.hand.find((card) => card.id === cardId)?.type || null;
}

function removeSecretCard(secret, cardId) {
  const next = syncSecret(secret);
  next.hand = next.hand.filter((card) => card.id !== cardId);
  return syncSecret(next);
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
    const hidden = [];
    const cards = {};
    const typesForPlayer = types.slice(offset, offset + cardsEach);
    offset += cardsEach;
    for (const type of typesForPlayer) {
      const id = `c${seq}`;
      seq += 1;
      hidden.push({ id, type });
      cards[id] = { shown: false };
    }
    secrets[player.id] = syncSecret({
      role: player.role,
      hand: hidden,
    });
    publicPlayers.push({
      id: player.id,
      name: player.name,
      claim: null,
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
  const match = {
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
      roundLog: [],
      players: dealt.publicPlayers,
      roles: null,
    },
    secrets: dealt.secrets,
  };
  auditHands(match.state, match.secrets, "austeilen");
  return match;
}

/** input: { role, gold, falle } oder null zum Löschen */
export function applyClaim(state, playerId, input) {
  if (state.phase !== "play") return { state, error: "Ansage gerade nicht möglich." };
  const next = clone(state);
  const player = next.players.find((row) => row.id === playerId);
  if (!player) return { state, error: "Unbekannter Spieler." };
  if (!input) {
    player.claim = null;
    return { state: next, error: null };
  }
  const max = next.cardsPerHand;
  const gold = clampInt(input.gold, 0, max);
  const falle = clampInt(input.falle, 0, max);
  if (gold + falle > max) {
    return { state, error: `Gold und Fallen zusammen höchstens ${max}.` };
  }
  const role = input.role === "abenteurer" || input.role === "waechterin" ? input.role : null;
  player.claim = { set: true, role, gold, falle };
  return { state: next, error: null };
}

function finishRound(state, secrets, rng) {
  snapshotRound(state);
  if (state.round >= ROUND_COUNT) {
    state.phase = "end";
    state.winner = "waechterinnen";
    publishRoles(state, secrets);
    return { state, secrets, error: null };
  }
  const remaining = [];
  for (const player of state.players) {
    const hand = syncSecret(secrets[player.id]).hand;
    for (const card of hand) remaining.push(card.type);
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
  auditHands(state, dealt.secrets, `runde ${state.round}`);
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
  const type = typeOfSecretCard(nextSecrets[ownerId], cardId);
  if (!type) return { state, secrets, error: "Karte nicht gefunden." };

  card.shown = true;
  card.type = type;
  nextSecrets[ownerId] = removeSecretCard(nextSecrets[ownerId], cardId);
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
    snapshotRound(next);
    next.phase = "end";
    next.winner = "abenteurer";
    publishRoles(next, nextSecrets);
    return { state: next, secrets: nextSecrets, error: null };
  }
  if (next.trapFound >= next.trapTotal) {
    snapshotRound(next);
    next.phase = "end";
    next.winner = "waechterinnen";
    publishRoles(next, nextSecrets);
    return { state: next, secrets: nextSecrets, error: null };
  }
  if (next.revealsDone >= next.revealsNeed) {
    return finishRound(next, nextSecrets, rng);
  }
  auditHands(next, nextSecrets, "aufdecken");
  return { state: next, secrets: nextSecrets, error: null };
}

export function applyAbort(state, secrets, leaver) {
  const next = clone(state);
  const nextSecrets = cloneSecrets(secrets);
  snapshotRound(next);
  next.phase = "end";
  next.winner = null;
  next.endReason = "left";
  next.leftName = leaver?.name || "Jemand";
  publishRoles(next, nextSecrets);
  return { state: next, secrets: nextSecrets, error: null };
}

export function auditHands(state, secrets, where = "") {
  if (!state?.players) return true;
  let ok = true;
  const tag = `[tempel] Summen${where ? ` (${where})` : ""}`;
  for (const player of state.players) {
    if (!secrets || !Object.prototype.hasOwnProperty.call(secrets, player.id)) continue;
    const hiddenCards = faceDownCards(player);
    const shown = shownCounts(player);
    const shownSum = shown.gold + shown.falle + shown.leer;
    const secret = syncSecret(secrets[player.id]);
    const countSum = secret.counts.gold + secret.counts.falle + secret.counts.leer;
    if (state.phase === "play" && hiddenCards.length + shownSum !== state.cardsPerHand) {
      console.warn(tag, player.name, "Rundenkarten", {
        verdeckt: hiddenCards.length,
        aufgedeckt: shownSum,
        runde: state.cardsPerHand,
      });
      ok = false;
    }
    if (secret.hand.length !== hiddenCards.length || countSum !== hiddenCards.length || secret.hidden !== hiddenCards.length) {
      console.warn(tag, player.name, "verdeckt ≠ geheim", {
        ruecken: hiddenCards.length,
        hand: secret.hand.length,
        counts: secret.counts,
        hidden: secret.hidden,
      });
      ok = false;
    }
    const publicIds = new Set(hiddenCards.map((card) => card.id));
    const secretIds = new Set(secret.hand.map((card) => card.id));
    for (const id of publicIds) {
      if (!secretIds.has(id)) {
        console.warn(tag, player.name, "öffentliche Karte fehlt geheim", id);
        ok = false;
      }
    }
    for (const id of secretIds) {
      if (!publicIds.has(id)) {
        console.warn(tag, player.name, "geheime Karte nicht verdeckt", id);
        ok = false;
      }
    }
  }
  return ok;
}

export function randomClaim(cardsPerHand, rng = Math.random) {
  const gold = Math.floor(rng() * (cardsPerHand + 1));
  const falle = Math.floor(rng() * (cardsPerHand - gold + 1));
  const roll = rng();
  const role = roll < 0.45 ? "abenteurer" : roll < 0.7 ? "waechterin" : null;
  return { role, gold, falle };
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

export function winnerTitle(winner, reason) {
  if (reason === "left" || !winner) return "Runde abgebrochen";
  return winner === "abenteurer" ? "Die Abenteurer gewinnen" : "Die Wächterinnen gewinnen";
}

export function logLine(entry) {
  return `${entry.fromName} deckt bei ${entry.ownerName} auf: ${TYPE_LABEL[entry.type] || entry.type}`;
}

export { TABLE, ROUND_COUNT, cardsPerHand, tableFor };
