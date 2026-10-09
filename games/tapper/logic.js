export const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
export const DEFAULT_OFF = ["C", "Q", "X", "Y"];

export const TIMERS = {
  easy: { id: "easy", label: "Leicht", min: 8, max: 18 },
  normal: { id: "normal", label: "Normal", min: 6, max: 15 },
  hard: { id: "hard", label: "Schwer", min: 4, max: 10 },
};

export const ROUND_OPTIONS = [5, 10, 15];
export const BOMB_OPTIONS = [3, 5];
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const FREE_LABEL = "Freie Kategorie";

export function defaultLetters() {
  const letters = {};
  for (const letter of ABC) letters[letter] = !DEFAULT_OFF.includes(letter);
  return letters;
}

export function defaultSettings() {
  return {
    timer: "normal",
    scoring: "bombs",
    endMode: "rounds",
    rounds: 10,
    bombLimit: 5,
    letters: defaultLetters(),
    tick: true,
    categoryMode: "list",
  };
}

export function normalizeSettings(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== "object") return base;
  const timer = TIMERS[raw.timer] ? raw.timer : "normal";
  const scoring = raw.scoring === "survive" ? "survive" : "bombs";
  const endMode = scoring === "survive" ? "rounds" : raw.endMode === "bombs" ? "bombs" : "rounds";
  const rounds = ROUND_OPTIONS.includes(raw.rounds) ? raw.rounds : 10;
  const bombLimit = BOMB_OPTIONS.includes(raw.bombLimit) ? raw.bombLimit : 5;
  const categoryMode = raw.categoryMode === "free" ? "free" : "list";
  const letters = defaultLetters();
  if (raw.letters && typeof raw.letters === "object") {
    for (const letter of ABC) {
      if (typeof raw.letters[letter] === "boolean") letters[letter] = raw.letters[letter];
    }
  }
  return { timer, scoring, endMode, rounds, bombLimit, letters, tick: raw.tick !== false, categoryMode };
}

export function isFreeMode(settings) {
  return settings?.categoryMode === "free";
}

export function displayCategory(state) {
  const text = String(state?.category || "").trim();
  if (isFreeMode(state?.settings)) return text || FREE_LABEL;
  return text || FREE_LABEL;
}

export function normalizeFreeCategory(text) {
  const name = String(text || "").trim();
  return name || FREE_LABEL;
}

export function enabledLetters(settings) {
  return ABC.filter((letter) => settings.letters[letter]);
}

export function letterCountOk(settings) {
  return enabledLetters(settings).length >= 1;
}

export function makePlayers(names) {
  const clean = names.map((name) => String(name || "").trim()).filter(Boolean).slice(0, MAX_PLAYERS);
  while (clean.length < MIN_PLAYERS) clean.push("");
  return clean.map((name, index) => ({ id: index, name: name || `Spieler ${index + 1}`, score: 0 }));
}

export function movePlayer(names, index, dir) {
  const next = names.slice();
  const other = index + dir;
  if (other < 0 || other >= next.length) return next;
  [next[index], next[other]] = [next[other], next[index]];
  return next;
}

export function freshState(players, settings, categories, rng = Math.random) {
  const list = makePlayers(players.map((item) => (typeof item === "string" ? item : item.name)));
  const rules = normalizeSettings(settings);
  const free = isFreeMode(rules);
  const pool = uniqueCategories(categories);
  const category = free ? FREE_LABEL : drawCategory(pool, [], rng);
  return {
    version: 1,
    phase: "play",
    players: list,
    current: 0,
    round: 1,
    settings: rules,
    category,
    usedCategories: free || !category ? [] : [category],
    locked: [],
    started: false,
    paused: false,
    deadline: null,
    burst: null,
    needCategory: false,
  };
}

export function migrateState(data) {
  if (!data || typeof data !== "object") return data;
  const settings = normalizeSettings(data.settings);
  return {
    ...data,
    settings,
    needCategory: !!data.needCategory,
    category: data.category == null ? (isFreeMode(settings) ? FREE_LABEL : data.category) : data.category,
  };
}

export function isRunning(data) {
  const state = migrateState(data);
  if (!state || state.version !== 1) return false;
  if (!["play", "boom", "end"].includes(state.phase)) return false;
  if (!Array.isArray(state.players) || state.players.length < MIN_PLAYERS || state.players.length > MAX_PLAYERS) return false;
  if (!state.settings || !state.players.every((player) => player && typeof player.name === "string")) return false;
  return true;
}

export function readSave(data) {
  try {
    if (isRunning(data)) {
      const migrated = migrateState(data);
      const state =
        migrated.phase === "play" && migrated.started && !migrated.paused && !migrated.needCategory
          ? pause(migrated)
          : migrated;
      return { state, notice: null };
    }
    if (data && typeof data === "object" && (data.version || data.phase || data.players)) {
      return { state: null, notice: "Der gespeicherte Spielstand passt nicht mehr zur neuen Version und wurde verworfen." };
    }
  } catch {
    return { state: null, notice: "Der gespeicherte Spielstand passt nicht mehr zur neuen Version und wurde verworfen." };
  }
  return { state: null, notice: null };
}

export function uniqueCategories(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const name = String(item || "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

export function drawCategory(pool, used, rng = Math.random) {
  const taken = new Set(used);
  let open = pool.filter((item) => !taken.has(item));
  if (!open.length) open = pool.slice();
  if (!open.length) return "Tiere";
  return open[Math.floor(rng() * open.length)];
}

export function otherCategory(state, pool, rng = Math.random) {
  if (state.started || state.phase !== "play" || isFreeMode(state.settings)) return state;
  const avoid = pool.filter((item) => item !== state.category);
  const category = drawCategory(avoid.length ? avoid : pool, state.usedCategories, rng);
  const used = state.usedCategories.includes(category) ? state.usedCategories : [...state.usedCategories, category];
  return { ...state, category, usedCategories: used };
}

export function setFreeCategory(state, text) {
  if (state.phase !== "play" || !isFreeMode(state.settings)) return state;
  if (state.started && !state.needCategory) return state;
  return { ...state, category: normalizeFreeCategory(text) };
}

export function continueFreeCategory(state, text, now = Date.now(), rng = Math.random) {
  if (state.phase !== "play" || !isFreeMode(state.settings) || !state.needCategory) return state;
  return startTurn(
    {
      ...state,
      category: normalizeFreeCategory(text),
      locked: [],
      needCategory: false,
      paused: false,
    },
    now,
    rng
  );
}

export function randomTurnMs(timerId, rng = Math.random) {
  const timer = TIMERS[timerId] || TIMERS.normal;
  const seconds = timer.min + rng() * (timer.max - timer.min);
  return Math.round(seconds * 1000);
}

export function startTurn(state, now = Date.now(), rng = Math.random) {
  if (state.phase !== "play" || state.needCategory) return state;
  const ms = randomTurnMs(state.settings.timer, rng);
  return { ...state, started: true, paused: false, needCategory: false, deadline: now + ms };
}

export function pause(state) {
  if (state.phase !== "play" || !state.started || state.paused || state.needCategory) return state;
  return { ...state, paused: true, deadline: null };
}

export function resumeTurn(state, now = Date.now(), rng = Math.random) {
  if (state.phase !== "play" || !state.paused || state.needCategory) return state;
  return startTurn({ ...state, paused: false }, now, rng);
}

export function tapLetter(state, letter, pool, now = Date.now(), rng = Math.random) {
  if (state.phase !== "play" || !state.started || state.paused || state.needCategory) return { state, effect: "ignore" };
  const key = String(letter || "").toUpperCase();
  if (!state.settings.letters[key] || state.locked.includes(key)) return { state, effect: "ignore" };
  let locked = [...state.locked, key];
  let category = state.category;
  let usedCategories = state.usedCategories;
  const active = enabledLetters(state.settings);
  const current = (state.current + 1) % state.players.length;
  if (active.every((item) => locked.includes(item))) {
    if (isFreeMode(state.settings)) {
      return {
        state: {
          ...state,
          locked,
          current,
          needCategory: true,
          paused: false,
          deadline: null,
        },
        effect: "need-category",
        letter: key,
      };
    }
    locked = [];
    category = drawCategory(pool, usedCategories, rng);
    if (!usedCategories.includes(category)) usedCategories = [...usedCategories, category];
  }
  const next = startTurn({ ...state, locked, category, usedCategories, current }, now, rng);
  return { state: next, effect: "tap", letter: key };
}

export function rejectTerm(state, now = Date.now()) {
  if (state.phase !== "play" || !state.started || state.paused || state.needCategory) return { state, effect: "ignore" };
  return explode(state, now);
}

export function checkDeadline(state, now = Date.now()) {
  if (state.phase !== "play" || !state.started || state.paused || state.needCategory || state.deadline == null) {
    return { state, effect: "ignore" };
  }
  if (now < state.deadline) return { state, effect: "ignore" };
  return explode(state, now);
}

export function explode(state) {
  if (state.phase !== "play") return { state, effect: "ignore" };
  const players = state.players.map((player) => ({ ...player }));
  const current = state.current;
  if (state.settings.scoring === "survive") {
    for (const player of players) {
      if (player.id !== players[current].id) player.score += 1;
    }
  } else {
    players[current].score += 1;
  }
  const next = {
    ...state,
    players,
    phase: "boom",
    started: false,
    paused: false,
    needCategory: false,
    deadline: null,
    burst: players[current].name,
  };
  return { state: next, effect: "boom", player: players[current] };
}

export function isGameOver(state) {
  if (state.settings.scoring === "bombs" && state.settings.endMode === "bombs") {
    return state.players.some((player) => player.score >= state.settings.bombLimit);
  }
  return state.round >= state.settings.rounds;
}

export function afterBoom(state, pool, rng = Math.random) {
  if (state.phase !== "boom") return state;
  if (isGameOver(state)) return { ...state, phase: "end", burst: null };
  if (isFreeMode(state.settings)) {
    return {
      ...state,
      phase: "play",
      round: state.round + 1,
      category: FREE_LABEL,
      locked: [],
      started: false,
      paused: false,
      deadline: null,
      burst: null,
      needCategory: false,
    };
  }
  const category = drawCategory(pool, state.usedCategories, rng);
  const usedCategories = state.usedCategories.includes(category) ? state.usedCategories : [...state.usedCategories, category];
  return {
    ...state,
    phase: "play",
    round: state.round + 1,
    category,
    usedCategories,
    locked: [],
    started: false,
    paused: false,
    deadline: null,
    burst: null,
    needCategory: false,
  };
}

export function replay(state, pool, rng = Math.random) {
  return freshState(state.players, state.settings, pool, rng);
}

export function ranking(state) {
  const scoring = state.settings.scoring;
  const rows = state.players.map((player, seat) => ({ ...player, seat }));
  rows.sort((a, b) => (scoring === "survive" ? b.score - a.score : a.score - b.score) || a.seat - b.seat);
  const best = rows[0]?.score;
  return rows.map((row) => ({
    ...row,
    winner: scoring === "survive" ? row.score === best && best > 0 : row.score === best,
  }));
}

export function scoreLabel(settings) {
  return settings.scoring === "survive" ? "Punkte" : "Bombenpunkte";
}
