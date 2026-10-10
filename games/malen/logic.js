import { normalizeRemote, readArray } from "../../shared/online.js";
import { WORDS } from "./words.js";

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 8;
export const ROUND_OPTIONS = [2, 3, 4];
export const TIME_OPTIONS = [60, 80, 100];
export const PICK_MS = 10000;
export const REVEAL_MS = 5000;
export const PAINTER_PER_SOLVE = 50;
export const COLORS = ["#1a1a1a", "#e8e6e1", "#c44536", "#e3a44a", "#3d8b5c", "#3a6ea5", "#7a4bb8", "#8b5a2b"];
export const WIDTHS = [0.008, 0.018, 0.036];

export function defaultSettings() {
  return { rounds: 3, drawSec: 80 };
}

export function normalizeSettings(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== "object") return base;
  return {
    rounds: ROUND_OPTIONS.includes(raw.rounds) ? raw.rounds : base.rounds,
    drawSec: TIME_OPTIONS.includes(raw.drawSec) ? raw.drawSec : base.drawSec,
  };
}

export function summarizeSettings(raw) {
  const s = normalizeSettings(raw);
  return `${s.rounds} ${s.rounds === 1 ? "Runde" : "Runden"} · ${s.drawSec} Sekunden`;
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

export function fold(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[\s-]/g, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function letterCount(word) {
  return [...String(word || "")].filter((ch) => /[a-zäöüß]/i.test(ch)).length;
}

export function buildMask(word, revealed) {
  const marks = revealed && typeof revealed === "object" ? revealed : {};
  const parts = [];
  for (let i = 0; i < word.length; i += 1) {
    const ch = word[i];
    if (ch === " ") parts.push(" ");
    else if (ch === "-") parts.push("-");
    else parts.push(marks[i] ? ch.toUpperCase() : "_");
  }
  return parts.join(" ");
}

export function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const grid = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) grid[i][0] = i;
  for (let j = 0; j < cols; j += 1) grid[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      grid[i][j] = Math.min(grid[i - 1][j] + 1, grid[i][j - 1] + 1, grid[i - 1][j - 1] + cost);
    }
  }
  return grid[a.length][b.length];
}

export function guesserPoints(elapsed, drawMs) {
  const t = Math.max(0, Math.min(1, 1 - elapsed / Math.max(1, drawMs)));
  return Math.max(5, Math.round(100 * t));
}

export function pickChoices(used, rng = Math.random) {
  const blocked = used && typeof used === "object" ? used : {};
  const pool = WORDS.filter((word) => !blocked[fold(word)]);
  const source = pool.length >= 3 ? pool : WORDS;
  return shuffle(source, rng).slice(0, 3);
}

function mapUsed(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    if (value) out[fold(key)] = 1;
  }
  return out;
}

function mapScores(raw, players) {
  const out = {};
  for (const player of players) out[player.id] = Math.max(0, Math.floor(Number(raw?.[player.id]) || 0));
  return out;
}

function mapGuessed(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, row] of Object.entries(raw)) {
    if (!row || typeof row !== "object") continue;
    out[id] = {
      name: row.name || "Spieler",
      points: Math.max(0, Math.floor(Number(row.points) || 0)),
      at: Number(row.at) || 0,
    };
  }
  return out;
}

function mapGuesses(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, row] of Object.entries(raw)) {
    if (!row || typeof row !== "object") continue;
    out[id] = {
      name: row.name || "Spieler",
      text: String(row.text || "").slice(0, 40),
      at: Number(row.at) || 0,
    };
  }
  return out;
}

function mapRevealed(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    if (value) out[String(key)] = 1;
  }
  return out;
}

export function migrateState(data) {
  if (!data || typeof data !== "object") return data;
  const next = normalizeRemote(data, {
    arrays: ["players", "order"],
    defaults: {
      version: 1,
      phase: "pick",
      waitingForHost: false,
      pauseLeft: null,
      rounds: 3,
      drawMs: 80000,
      round: 1,
      turnIndex: 0,
      painterId: null,
      painterName: "",
      startedAt: 0,
      deadline: 0,
      letterCount: 0,
      mask: "",
      hintsDone: 0,
      word: null,
      guessSeq: 0,
      lastSolved: null,
    },
  });
  next.players = readArray(next.players).map((player) => ({
    id: player.id,
    name: player.name || "Spieler",
  }));
  next.order = readArray(next.order).filter(Boolean);
  if (!next.order.length) next.order = next.players.map((player) => player.id);
  next.scores = mapScores(next.scores, next.players);
  next.roundScores = mapScores(next.roundScores, next.players);
  next.guessed = mapGuessed(next.guessed);
  next.guesses = mapGuesses(next.guesses);
  next.revealed = mapRevealed(next.revealed);
  next.waitingForHost = !!next.waitingForHost;
  if (next.phase !== "reveal" && next.phase !== "end") next.word = null;
  return next;
}

export function normalizeSecrets(raw) {
  const all = raw && typeof raw === "object" ? raw : {};
  const used = mapUsed(all._game?.used);
  const gameWord = typeof all._game?.word === "string" ? all._game.word : null;
  const choices = readArray(all._game?.choices).filter((word) => typeof word === "string");
  const players = {};
  for (const [id, secret] of Object.entries(all)) {
    if (id.startsWith("_") || !secret || typeof secret !== "object") continue;
    players[id] = {
      choices: readArray(secret.choices).filter((word) => typeof word === "string"),
      word: typeof secret.word === "string" ? secret.word : null,
      almost: Number(secret.almost) || 0,
    };
  }
  return { used, word: gameWord, choices, players };
}

export function packSecrets(secrets) {
  const packed = { _game: {} };
  if (secrets.used && Object.keys(secrets.used).length) packed._game.used = secrets.used;
  if (secrets.word) packed._game.word = secrets.word;
  if (secrets.choices?.length) packed._game.choices = secrets.choices;
  if (!Object.keys(packed._game).length) delete packed._game;
  for (const [id, secret] of Object.entries(secrets.players || {})) {
    const row = {};
    if (secret.choices?.length) row.choices = secret.choices;
    if (secret.word) row.word = secret.word;
    if (secret.almost) row.almost = secret.almost;
    if (Object.keys(row).length) packed[id] = row;
  }
  return packed;
}

function emptyScores(players) {
  const scores = {};
  for (const player of players) scores[player.id] = 0;
  return scores;
}

export function beginMatch(playersInput, settingsInput, rng = Math.random) {
  const settings = normalizeSettings(settingsInput);
  const players = (playersInput || []).map((player, index) => ({
    id: player.id,
    name: String(player.name || `Spieler ${index + 1}`).trim() || `Spieler ${index + 1}`,
  }));
  const order = players.map((player) => player.id);
  const state = {
    version: 1,
    phase: "pick",
    waitingForHost: false,
    pauseLeft: null,
    rounds: settings.rounds,
    drawMs: settings.drawSec * 1000,
    round: 1,
    turnIndex: 0,
    painterId: order[0],
    painterName: players[0]?.name || "Spieler",
    startedAt: 0,
    deadline: 0,
    letterCount: 0,
    mask: "",
    hintsDone: 0,
    revealed: {},
    word: null,
    guessed: {},
    guesses: {},
    guessSeq: 0,
    lastSolved: null,
    scores: emptyScores(players),
    roundScores: emptyScores(players),
    players,
    order,
  };
  const secrets = { used: {}, word: null, choices: [], players: {} };
  return beginPick(state, secrets, Date.now(), rng);
}

function painterOf(state, turnIndex = state.turnIndex) {
  const order = state.order || [];
  if (!order.length) return null;
  const id = order[turnIndex % order.length];
  return state.players.find((player) => player.id === id) || null;
}

export function beginPick(state, secrets, now = Date.now(), rng = Math.random) {
  const next = clone(state);
  const nextSecrets = clone(secrets);
  const total = next.order.length * next.rounds;
  if (next.turnIndex >= total || next.players.length < MIN_PLAYERS) {
    next.phase = "end";
    next.deadline = 0;
    next.word = null;
    return { state: next, secrets: nextSecrets, error: null };
  }
  const painter = painterOf(next);
  if (!painter) {
    next.turnIndex += 1;
    return beginPick(next, nextSecrets, now, rng);
  }
  const choices = pickChoices(nextSecrets.used, rng);
  next.phase = "pick";
  next.waitingForHost = false;
  next.pauseLeft = null;
  next.painterId = painter.id;
  next.painterName = painter.name;
  next.round = Math.floor(next.turnIndex / next.order.length) + 1;
  next.startedAt = now;
  next.deadline = now + PICK_MS;
  next.letterCount = 0;
  next.mask = "";
  next.hintsDone = 0;
  next.revealed = {};
  next.word = null;
  next.guessed = {};
  next.guesses = {};
  next.lastSolved = null;
  next.roundScores = emptyScores(next.players);
  nextSecrets.word = null;
  nextSecrets.choices = choices;
  nextSecrets.players = {
    [painter.id]: { choices, word: null, almost: 0 },
  };
  return { state: next, secrets: nextSecrets, error: null };
}

export function applyPick(state, secrets, playerId, word, now = Date.now()) {
  if (state.phase !== "pick") return { state, secrets, error: "Gerade wird nicht gewählt." };
  if (playerId !== state.painterId) return { state, secrets, error: "Nur der Maler wählt." };
  const choices = secrets.choices || secrets.players?.[playerId]?.choices || [];
  const picked = choices.find((item) => fold(item) === fold(word)) || (word && choices.length ? choices[0] : null);
  if (!picked) return { state, secrets, error: "Dieser Begriff steht nicht zur Wahl." };
  return startDraw(state, secrets, picked, now);
}

export function autoPick(state, secrets, now = Date.now(), rng = Math.random) {
  const choices = secrets.choices || [];
  const word = choices[Math.floor(rng() * Math.max(1, choices.length))] || pickChoices(secrets.used, rng)[0];
  return startDraw(state, secrets, word, now);
}

function startDraw(state, secrets, word, now) {
  const next = clone(state);
  const nextSecrets = clone(secrets);
  next.phase = "draw";
  next.startedAt = now;
  next.deadline = now + next.drawMs;
  next.word = null;
  next.letterCount = letterCount(word);
  next.mask = buildMask(word, {});
  next.hintsDone = 0;
  next.revealed = {};
  next.guessed = {};
  next.guesses = {};
  next.lastSolved = null;
  nextSecrets.word = word;
  nextSecrets.choices = [];
  nextSecrets.used = { ...(nextSecrets.used || {}), [fold(word)]: 1 };
  nextSecrets.players = {
    [next.painterId]: { choices: [], word, almost: 0 },
  };
  return { state: next, secrets: nextSecrets, error: null };
}

export function applyHint(state, secrets, now = Date.now(), rng = Math.random) {
  if (state.phase !== "draw" || !secrets.word) return { state, secrets, error: null };
  const elapsed = now - state.startedAt;
  let want = 0;
  if (elapsed >= state.drawMs * 0.75) want = 2;
  else if (elapsed >= state.drawMs * 0.5) want = 1;
  if (state.hintsDone >= want) return { state, secrets, error: null };
  const next = clone(state);
  const word = secrets.word;
  const options = [];
  for (let i = 0; i < word.length; i += 1) {
    if (/[a-zäöüß]/i.test(word[i]) && !next.revealed[i]) options.push(i);
  }
  if (!options.length) {
    if (state.hintsDone >= want) return { state, secrets, error: null };
    next.hintsDone = want;
    return { state: next, secrets, error: null };
  }
  const index = options[Math.floor(rng() * options.length)];
  next.revealed = { ...next.revealed, [index]: 1 };
  next.mask = buildMask(word, next.revealed);
  next.hintsDone = state.hintsDone + 1;
  return { state: next, secrets, error: null };
}

export function applyGuess(state, secrets, playerId, text, now = Date.now()) {
  if (state.phase !== "draw") return { state, secrets, error: "Gerade wird nicht geraten.", almost: false };
  if (playerId === state.painterId) return { state, secrets, error: "Der Maler rät nicht.", almost: false };
  if (state.guessed[playerId]) return { state, secrets, error: "Du hast es schon.", almost: false };
  const player = state.players.find((row) => row.id === playerId);
  if (!player) return { state, secrets, error: "Unbekannter Spieler.", almost: false };
  const guess = String(text || "").trim().slice(0, 40);
  if (!guess) return { state, secrets, error: "Bitte etwas eingeben.", almost: false };
  const word = secrets.word;
  if (!word) return { state, secrets, error: "Noch kein Begriff.", almost: false };
  const dist = editDistance(fold(guess), fold(word));
  if (dist === 0) {
    const next = clone(state);
    const points = guesserPoints(now - next.startedAt, next.drawMs);
    next.guessed = {
      ...next.guessed,
      [playerId]: { name: player.name, points, at: now },
    };
    next.lastSolved = player.name;
    const guessers = next.players.filter((row) => row.id !== next.painterId);
    if (guessers.every((row) => next.guessed[row.id])) {
      return finishTurn(next, secrets, now);
    }
    return { state: next, secrets, error: null, almost: false, solved: true };
  }
  if (dist === 1) {
    return { state, secrets, error: null, almost: true };
  }
  const next = clone(state);
  next.guessSeq += 1;
  next.guesses = {
    ...next.guesses,
    [`g${next.guessSeq}`]: { name: player.name, text: guess, at: now },
  };
  const keys = Object.keys(next.guesses);
  if (keys.length > 24) {
    const drop = keys.slice(0, keys.length - 24);
    for (const key of drop) delete next.guesses[key];
  }
  return { state: next, secrets, error: null, almost: false };
}

export function finishTurn(state, secrets, now = Date.now()) {
  const next = clone(state);
  const nextSecrets = clone(secrets);
  const roundScores = emptyScores(next.players);
  let solved = 0;
  for (const [id, row] of Object.entries(next.guessed || {})) {
    roundScores[id] = row.points || 0;
    next.scores[id] = (next.scores[id] || 0) + (row.points || 0);
    solved += 1;
  }
  const painterPts = solved * PAINTER_PER_SOLVE;
  if (next.painterId) {
    roundScores[next.painterId] = painterPts;
    next.scores[next.painterId] = (next.scores[next.painterId] || 0) + painterPts;
  }
  next.roundScores = roundScores;
  next.phase = "reveal";
  next.word = nextSecrets.word || next.word;
  next.mask = next.word ? buildMask(next.word, Object.fromEntries([...String(next.word)].map((_, i) => [i, 1]))) : next.mask;
  next.startedAt = now;
  next.deadline = now + REVEAL_MS;
  next.lastSolved = null;
  nextSecrets.choices = [];
  nextSecrets.players = {};
  return { state: next, secrets: nextSecrets, error: null, clearDraw: true };
}

export function advanceTurn(state, secrets, now = Date.now(), rng = Math.random) {
  const next = clone(state);
  next.turnIndex += 1;
  next.word = null;
  return beginPick(next, secrets, now, rng);
}

export function skipPainter(state, secrets, now = Date.now(), rng = Math.random) {
  const next = clone(state);
  next.turnIndex += 1;
  next.word = null;
  next.lastSolved = null;
  return beginPick(next, secrets, now, rng);
}

export function dropPlayer(state, secrets, playerId, now = Date.now(), rng = Math.random) {
  const next = clone(state);
  const nextSecrets = clone(secrets);
  next.players = next.players.filter((player) => player.id !== playerId);
  next.order = next.order.filter((id) => id !== playerId);
  delete next.scores[playerId];
  delete next.roundScores[playerId];
  delete next.guessed[playerId];
  if (next.players.length < MIN_PLAYERS) {
    next.phase = "end";
    next.deadline = 0;
    next.word = nextSecrets.word || next.word;
    return { state: next, secrets: nextSecrets, error: null };
  }
  if (next.phase === "end") return { state: next, secrets: nextSecrets, error: null };
  if (playerId === next.painterId && next.phase !== "reveal") {
    return skipPainter(next, nextSecrets, now, rng);
  }
  if (next.phase === "draw") {
    const guessers = next.players.filter((row) => row.id !== next.painterId);
    if (guessers.length && guessers.every((row) => next.guessed[row.id])) {
      return finishTurn(next, nextSecrets, now);
    }
  }
  return { state: next, secrets: nextSecrets, error: null };
}

export function pauseForHost(state, now = Date.now()) {
  if (state.waitingForHost || state.phase === "end") return state;
  const next = clone(state);
  next.waitingForHost = true;
  next.pauseLeft = Math.max(0, (next.deadline || now) - now);
  next.deadline = null;
  return next;
}

export function resumeHost(state, now = Date.now()) {
  if (!state.waitingForHost) return state;
  const next = clone(state);
  next.waitingForHost = false;
  const left = Number(next.pauseLeft) || 0;
  next.deadline = now + left;
  next.startedAt = next.phase === "draw" ? now - (next.drawMs - left) : now - ((next.phase === "pick" ? PICK_MS : REVEAL_MS) - left);
  next.pauseLeft = null;
  return next;
}

export function ranking(state) {
  return [...(state.players || [])]
    .map((player) => ({
      id: player.id,
      name: player.name,
      score: state.scores?.[player.id] || 0,
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "de"));
}

export function guessList(state) {
  return Object.entries(state.guesses || {})
    .map(([id, row]) => ({ id, ...row }))
    .sort((a, b) => a.at - b.at);
}

export function hostWord(secrets, painterId, myId, isHost) {
  if (isHost) return secrets?.word || secrets?.players?.[painterId]?.word || null;
  if (myId && secrets?.players?.[myId]?.word) return secrets.players[myId].word;
  return null;
}

export { WORDS };
