// Regeln für Schiffe versenken. Neue Formen kommen als Eintrag in SHAPES dazu.

export const COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O"];
export const MIN_SIZE = 6;
export const MAX_SIZE = 15;
export const MAX_COUNT = 5;

export const SHAPES = [
  { id: "g1", name: "Gerade 1", form: "gerade", cells: [[0, 0]] },
  { id: "g2", name: "U-Boot", form: "gerade", cells: [[0, 0], [1, 0]] },
  { id: "g3", name: "Zerstörer", form: "gerade", cells: [[0, 0], [1, 0], [2, 0]] },
  { id: "g4", name: "Kreuzer", form: "gerade", cells: [[0, 0], [1, 0], [2, 0], [3, 0]] },
  { id: "g5", name: "Schlachtschiff", form: "gerade", cells: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]] },
  { id: "g6", name: "Gerade 6", form: "gerade", cells: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]] },
  { id: "w3", name: "Winkel", form: "Winkel", cells: [[0, 0], [1, 0], [1, 1]] },
  { id: "l4", name: "L-Form", form: "L-Form", cells: [[0, 0], [1, 0], [2, 0], [2, 1]] },
  { id: "z4", name: "Z-Form", form: "Z-Form", cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  { id: "t4", name: "T-Form", form: "T-Form", cells: [[0, 0], [1, 0], [2, 0], [1, 1]] },
];

const SHAPE_BY_ID = Object.fromEntries(SHAPES.map((shape) => [shape.id, shape]));
const MODES = ["classic", "paper", "mixed", "custom"];
const PRESET_COUNTS = {
  classic: { g5: 1, g4: 1, g3: 2, g2: 1 },
  paper: { g5: 1, g4: 2, g3: 3, g2: 4 },
  mixed: { g5: 1, l4: 1, g3: 1, w3: 1, g2: 2 },
};

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_BASE = ALPHABET.length;

const NEIGHBORS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
const CROSS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const SIGNATURE = Object.fromEntries(SHAPES.map((shape) => [shape.id, canonical(shape.cells)]));

export function shapeById(id) {
  return SHAPE_BY_ID[id];
}

export function defaultCounts() {
  const counts = {};
  for (const shape of SHAPES) counts[shape.id] = 0;
  return counts;
}

export function rulesFor(mode, allowTouch = false, custom = null) {
  if (mode === "custom") {
    const counts = defaultCounts();
    for (const shape of SHAPES) {
      counts[shape.id] = clamp(custom?.counts?.[shape.id] || 0, 0, MAX_COUNT);
    }
    return {
      mode: "custom",
      width: clamp(custom?.width ?? 10, MIN_SIZE, MAX_SIZE),
      height: clamp(custom?.height ?? 10, MIN_SIZE, MAX_SIZE),
      allowTouch: !!allowTouch,
      counts,
    };
  }
  const counts = defaultCounts();
  for (const [id, count] of Object.entries(PRESET_COUNTS[mode] || PRESET_COUNTS.classic)) {
    counts[id] = count;
  }
  return { mode: PRESET_COUNTS[mode] ? mode : "classic", width: 10, height: 10, allowTouch: !!allowTouch, counts };
}

export function formatCode(code) {
  return String(code).replace(/(.{4})(?=.)/g, "$1 ");
}

export function encodeRules(rules) {
  const bits = [];
  pushBits(bits, Math.max(0, MODES.indexOf(rules.mode)), 2);
  pushBits(bits, rules.allowTouch ? 1 : 0, 1);
  if (rules.mode === "custom") {
    pushBits(bits, clamp(rules.width, MIN_SIZE, MAX_SIZE) - MIN_SIZE, 4);
    pushBits(bits, clamp(rules.height, MIN_SIZE, MAX_SIZE) - MIN_SIZE, 4);
    for (const shape of SHAPES) pushBits(bits, clamp(rules.counts?.[shape.id] || 0, 0, MAX_COUNT), 3);
  }
  while (bits.length % 5 !== 0) bits.push(0);
  const checksum = bits.reduce((sum, bit) => sum + bit, 0) % CODE_BASE;
  return bitsToCode(bits) + ALPHABET[checksum];
}

export function decodeRules(text) {
  const code = String(text || "").toUpperCase().replace(/[\s-]/g, "");
  if (!code) return { error: "Bitte einen Spielcode eingeben." };
  if (!new RegExp(`^[${ALPHABET}]+$`).test(code)) {
    return { error: "Der Code enthält ungültige Zeichen. Erlaubt sind Buchstaben und Ziffern, ohne 0, O, 1 und I." };
  }
  if (code.length < 2) return { error: "Dieser Code ist ungültig." };

  const bits = [];
  for (const char of code.slice(0, -1)) pushBits(bits, ALPHABET.indexOf(char), 5);
  const checksum = bits.reduce((sum, bit) => sum + bit, 0) % CODE_BASE;
  if (ALPHABET[checksum] !== code.at(-1)) return { error: "Dieser Code ist ungültig." };

  const cursor = { i: 0 };
  if (bits.length < 3) return { error: "Dieser Code ist ungültig." };
  const modeIndex = readBits(bits, cursor, 2);
  const allowTouch = readBits(bits, cursor, 1) === 1;
  const mode = MODES[modeIndex];
  if (!mode) return { error: "Dieser Code ist ungültig." };
  if (mode !== "custom") return { rules: rulesFor(mode, allowTouch) };

  if (cursor.i + 8 + SHAPES.length * 3 > bits.length) return { error: "Dieser Code ist ungültig." };
  const width = readBits(bits, cursor, 4) + MIN_SIZE;
  const height = readBits(bits, cursor, 4) + MIN_SIZE;
  if (width > MAX_SIZE || height > MAX_SIZE) return { error: "Dieser Code ist ungültig." };
  const counts = defaultCounts();
  for (const shape of SHAPES) {
    const count = readBits(bits, cursor, 3);
    if (count > MAX_COUNT) return { error: "Dieser Code ist ungültig." };
    counts[shape.id] = count;
  }
  return { rules: { mode: "custom", width, height, allowTouch, counts } };
}

export function fleetCells(rules) {
  return SHAPES.reduce((sum, shape) => sum + (rules.counts[shape.id] || 0) * shape.cells.length, 0);
}

export function assessFleet(rules) {
  const ships = expandFleet(rules);
  const area = rules.width * rules.height;
  const cells = ships.reduce((sum, ship) => sum + ship.size, 0);
  if (!ships.length) return { ok: false, warning: null, message: "Mindestens ein Schiff wählen." };
  if (cells > area) return { ok: false, warning: null, message: "Flotte passt nicht aufs Feld" };
  if (ships.some((ship) => !shapeFits(ship.shapeId, rules.width, rules.height))) {
    return { ok: false, warning: null, message: "Flotte passt nicht aufs Feld" };
  }
  const warning = cells / area > 0.4 ? "Wird sehr leicht" : null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const copies = ships.map((ship) => ({ ...ship, cells: null }));
    if (randomPlacement(copies, rules.allowTouch, rules.width, rules.height, Math.random, { budget: 8000, spotLimit: 40 })) {
      return { ok: true, warning, message: null };
    }
  }
  return { ok: false, warning: null, message: "Flotte passt nicht aufs Feld" };
}

export function coord(c, r) {
  return `${COLS[c] || "?"}${r + 1}`;
}

export function emptyGrid(width, height) {
  return Array.from({ length: height }, () => Array(width).fill(null));
}

export function expandFleet(rules) {
  const ships = [];
  for (const shape of SHAPES) {
    for (let i = 0; i < (rules.counts[shape.id] || 0); i += 1) {
      ships.push({
        id: ships.length,
        shapeId: shape.id,
        name: shape.name,
        form: shape.form,
        size: shape.cells.length,
        rotation: 0,
        mirror: false,
        cells: null,
      });
    }
  }
  return ships;
}

export function freshState() {
  const rules = rulesFor("classic", false);
  return {
    version: 2,
    phase: "setup",
    rules,
    code: encodeRules(rules),
    width: rules.width,
    height: rules.height,
    allowTouch: false,
    ships: [],
    selectedId: null,
    rotation: 0,
    mirror: false,
    enemy: emptyGrid(rules.width, rules.height),
    incoming: emptyGrid(rules.width, rules.height),
    enemyFleet: [],
    nextGroup: 1,
    shotLog: [],
    history: [],
    outcome: null,
  };
}

export function isRunning(data) {
  if (!data || data.version !== 2) return false;
  if (!["place", "battle", "end"].includes(data.phase)) return false;
  if (!validGrid(data.enemy, data.width, data.height) || !validGrid(data.incoming, data.width, data.height)) return false;
  if (!Array.isArray(data.ships) || !data.ships.every((ship) => ship && SHAPE_BY_ID[ship.shapeId])) return false;
  if (!Array.isArray(data.enemyFleet) || !data.rules) return false;
  if (data.versus === "bot") {
    if (!["easy", "medium", "hard"].includes(data.difficulty)) return false;
    if (data.phase !== "place" && !Array.isArray(data.botShips)) return false;
    return true;
  }
  if (!data.code) return false;
  return true;
}

export function readSave(data) {
  try {
    if (isRunning(data)) return { state: data, notice: null };
    if (data && data.version === 2 && data.phase === "setup") return { state: freshState(), notice: null };
    if (data && typeof data === "object" && (data.version || data.phase || data.ships)) {
      return { state: freshState(), notice: "Der gespeicherte Spielstand passt nicht mehr zur neuen Version und wurde verworfen." };
    }
  } catch {
    return { state: freshState(), notice: "Der gespeicherte Spielstand passt nicht mehr zur neuen Version und wurde verworfen." };
  }
  return { state: freshState(), notice: null };
}

export function shapeBox(shapeId, rotation = 0, mirror = false) {
  const cells = normalize(transform(SHAPE_BY_ID[shapeId].cells, rotation, mirror));
  return {
    w: Math.max(...cells.map((cell) => cell[0])) + 1,
    h: Math.max(...cells.map((cell) => cell[1])) + 1,
    cells,
  };
}

export function footprint(c, r, shapeId, rotation, mirror) {
  const cells = [];
  let out = false;
  for (const [x, y] of orientedCells(shapeId, rotation, mirror)) {
    const col = c + x;
    const row = r + y;
    if (col < 0 || row < 0) out = true;
    else cells.push({ c: col, r: row });
  }
  return { cells, out };
}

export function placementIssue(ships, shipId, cells, allowTouch, width, height) {
  if (cells.some((cell) => cell.c >= width || cell.r >= height)) return "rand";
  const own = new Set(cells.map(keyOf));
  for (const cell of cells) {
    if (ships.some((ship) => ship.id !== shipId && ship.cells?.some((part) => part.c === cell.c && part.r === cell.r))) {
      return "ueber";
    }
  }
  if (!allowTouch) {
    for (const cell of cells) {
      for (const [dc, dr] of NEIGHBORS) {
        const col = cell.c + dc;
        const row = cell.r + dr;
        if (own.has(`${col},${row}`)) continue;
        if (ships.some((ship) => ship.id !== shipId && ship.cells?.some((part) => part.c === col && part.r === row))) {
          return "beruehrt";
        }
      }
    }
  }
  return null;
}

export function previewAt(state, c, r) {
  const ship = state.ships.find((item) => item.id === state.selectedId);
  if (!ship || ship.cells) return null;
  const spot = footprint(c, r, ship.shapeId, state.rotation, state.mirror);
  const visible = spot.cells.filter((cell) => cell.c >= 0 && cell.r >= 0 && cell.c < state.width && cell.r < state.height);
  if (spot.out || visible.length !== spot.cells.length) return { cells: visible, ok: false, issue: "rand" };
  const issue = placementIssue(state.ships, ship.id, spot.cells, state.allowTouch, state.width, state.height);
  return { cells: spot.cells, ok: !issue, issue };
}

export function shipAt(ships, c, r) {
  return ships.find((ship) => ship.cells?.some((cell) => cell.c === c && cell.r === r)) || null;
}

export function allPlaced(ships) {
  return ships.length > 0 && ships.every((ship) => ship.cells?.length === ship.size);
}

export function sunkText(ship) {
  return `(${ship.name}, ${ship.size})`;
}

export function beginPlacement(rules, extras = null) {
  const fixed = {
    mode: rules.mode,
    width: rules.width,
    height: rules.height,
    allowTouch: !!rules.allowTouch,
    counts: { ...rules.counts },
  };
  const ships = expandFleet(fixed);
  return {
    version: 2,
    phase: "place",
    rules: fixed,
    code: encodeRules(fixed),
    width: fixed.width,
    height: fixed.height,
    allowTouch: fixed.allowTouch,
    ships,
    selectedId: ships[0]?.id ?? null,
    rotation: 0,
    mirror: false,
    enemy: emptyGrid(rules.width, rules.height),
    incoming: emptyGrid(rules.width, rules.height),
    enemyFleet: ships.map((ship) => ({
      shapeId: ship.shapeId,
      name: ship.name,
      form: ship.form,
      size: ship.size,
      sunk: false,
      group: null,
    })),
    nextGroup: 1,
    shotLog: [],
    history: [],
    outcome: null,
    versus: extras?.versus === "bot" ? "bot" : "hotseat",
    difficulty: extras?.versus === "bot" ? extras.difficulty || "medium" : null,
    extraShot: extras?.versus === "bot" ? extras.extraShot !== false : false,
    turn: "player",
    botShips: [],
  };
}

export function rotate(state) {
  if (state.phase !== "place") return state;
  return { ...state, rotation: (state.rotation + 90) % 360 };
}

export function mirror(state) {
  if (state.phase !== "place") return state;
  return { ...state, mirror: !state.mirror };
}

export function selectShip(state, id) {
  const ship = state.ships.find((item) => item.id === id);
  if (!ship || ship.cells) return state;
  return { ...state, selectedId: id };
}

export function placeSelected(state, c, r) {
  const ship = state.ships.find((item) => item.id === state.selectedId);
  if (!ship || ship.cells) return state;
  const spot = footprint(c, r, ship.shapeId, state.rotation, state.mirror);
  if (spot.out || placementIssue(state.ships, ship.id, spot.cells, state.allowTouch, state.width, state.height)) return state;
  const ships = state.ships.map((item) => (
    item.id === ship.id ? { ...item, cells: spot.cells, rotation: state.rotation, mirror: state.mirror } : item
  ));
  const next = ships.find((item) => !item.cells);
  return { ...state, ships, selectedId: next ? next.id : null };
}

export function liftAt(state, c, r) {
  const ship = shipAt(state.ships, c, r);
  if (!ship) return state;
  return {
    ...state,
    selectedId: ship.id,
    rotation: ship.rotation || 0,
    mirror: !!ship.mirror,
    ships: state.ships.map((item) => (item.id === ship.id ? { ...item, cells: null } : item)),
  };
}

export function resetShips(state) {
  return {
    ...state,
    rotation: 0,
    mirror: false,
    selectedId: state.ships[0]?.id ?? null,
    ships: state.ships.map((ship) => ({ ...ship, cells: null, rotation: 0, mirror: false })),
  };
}

export function dealRandom(state) {
  const ships = state.ships.map((ship) => ({ ...ship, cells: null, rotation: 0, mirror: false }));
  for (let attempt = 0; attempt < 12; attempt += 1) {
    for (const ship of ships) ship.cells = null;
    if (randomPlacement(ships, state.allowTouch, state.width, state.height, Math.random, { budget: 20000, spotLimit: 60 })) {
      return { ...state, ships, selectedId: null, rotation: 0, mirror: false };
    }
  }
  return null;
}

export function randomFleet(rules, rng = Math.random) {
  const ships = expandFleet(rules);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    for (const ship of ships) ship.cells = null;
    if (randomPlacement(ships, rules.allowTouch, rules.width, rules.height, rng, { budget: 20000, spotLimit: 60 })) {
      return ships;
    }
  }
  return null;
}

export function beginBattle(state) {
  if (!allPlaced(state.ships)) return state;
  if (state.versus === "bot") {
    const botShips = randomFleet(state.rules);
    if (!botShips) return null;
    return { ...state, phase: "battle", selectedId: null, botShips, turn: "player", history: [] };
  }
  return { ...state, phase: "battle", selectedId: null };
}

export function markEnemy(state, c, r, kind) {
  if (state.phase !== "battle" || kind === "cancel") return { state, error: null, choice: null };
  if (kind === "sunk") return startSunk(state, c, r);
  const next = snapshot(state);
  const existing = next.enemy[r][c];
  if (existing?.group != null) clearGroup(next, existing.group);
  next.enemy[r][c] = { kind, auto: false, group: null };
  return { state: next, error: null, choice: null };
}

export function commitSunk(state, c, r, slotIndex) {
  if (state.phase !== "battle") return { state, error: "Das geht gerade nicht." };
  const next = snapshot(state);
  const existing = next.enemy[r][c];
  if (existing?.group != null) clearGroup(next, existing.group);
  const report = inspectSunk(next, c, r);
  const option = report.options.find((item) => item.index === slotIndex);
  if (!option) return { state, error: "Dieses Schiff passt nicht mehr." };
  applySunk(next, option.cells, option.index);
  return { state: next, error: null };
}

export function fireIncoming(state, c, r) {
  if (state.phase !== "battle") return { state, result: "ignore" };
  if (state.incoming[r][c]) return { state, result: "already" };
  const next = state.versus === "bot" ? fork(state) : snapshot(state);
  const ship = shipAt(next.ships, c, r);
  let result = "water";
  if (ship) {
    next.incoming[r][c] = { result: "hit" };
    result = ship.cells.every((cell) => next.incoming[cell.r][cell.c]) ? "sunk" : "hit";
    if (result === "sunk") {
      for (const cell of ship.cells) next.incoming[cell.r][cell.c] = { result: "sunk" };
      if (next.versus === "bot" && !next.allowTouch) {
        for (const cell of around(ship.cells, next.width, next.height)) {
          if (!next.incoming[cell.r][cell.c]) next.incoming[cell.r][cell.c] = { result: "water", auto: true };
        }
      }
    }
  } else {
    next.incoming[r][c] = { result: "water" };
  }
  next.shotLog.push({
    c,
    r,
    result,
    name: result === "sunk" ? ship.name : null,
    size: result === "sunk" ? ship.size : null,
    shapeId: result === "sunk" ? ship.shapeId : null,
  });
  if (next.ships.every((item) => item.cells.every((cell) => next.incoming[cell.r][cell.c]))) {
    next.phase = "end";
    next.outcome = "lost";
  } else if (next.versus === "bot") {
    next.turn = next.extraShot && result !== "water" ? "bot" : "player";
  }
  return { state: next, result, ship: result === "sunk" ? ship : null };
}

export function fireAtBot(state, c, r) {
  if (state.versus !== "bot" || state.phase !== "battle") return { state, result: "ignore" };
  if (state.enemy[r][c]) return { state, result: "already" };
  if (state.turn && state.turn !== "player") return { state, result: "ignore" };
  const next = fork(state);
  const ship = shipAt(next.botShips, c, r);
  let result = "water";
  if (ship) {
    next.enemy[r][c] = { kind: "hit", auto: false, group: null };
    result = ship.cells.every((cell) => next.enemy[cell.r][cell.c]) ? "sunk" : "hit";
    if (result === "sunk") {
      const group = next.nextGroup;
      next.nextGroup += 1;
      for (const cell of ship.cells) next.enemy[cell.r][cell.c] = { kind: "sunk", auto: false, group };
      const slot = next.enemyFleet.find((item) => !item.sunk && item.shapeId === ship.shapeId);
      if (slot) {
        slot.sunk = true;
        slot.group = group;
      }
      if (!next.allowTouch) {
        for (const cell of around(ship.cells, next.width, next.height)) {
          if (!next.enemy[cell.r][cell.c]) next.enemy[cell.r][cell.c] = { kind: "water", auto: true, group };
        }
      }
    }
  } else {
    next.enemy[r][c] = { kind: "water", auto: false, group: null };
  }
  if (next.enemyFleet.every((slot) => slot.sunk)) {
    next.phase = "end";
    next.outcome = "won";
  } else {
    next.turn = next.extraShot && result !== "water" ? "player" : "bot";
  }
  return { state: next, result, ship: result === "sunk" ? ship : null };
}

export function botKnowledge(state) {
  const remaining = [];
  for (const ship of state.ships) {
    const sunk = Boolean(ship.cells?.length && ship.cells.every((cell) => state.incoming[cell.r][cell.c]?.result === "sunk"));
    if (!sunk) remaining.push({ shapeId: ship.shapeId, size: ship.size });
  }
  const grid = [];
  for (let r = 0; r < state.height; r += 1) {
    const row = [];
    for (let c = 0; c < state.width; c += 1) {
      const mark = state.incoming[r][c];
      row.push(mark ? mark.result : null);
    }
    grid.push(row);
  }
  return {
    width: state.width,
    height: state.height,
    allowTouch: !!state.allowTouch,
    grid,
    remaining,
  };
}

export function incomingShotStats(state) {
  const shots = [];
  for (let r = 0; r < state.height; r += 1) {
    for (let c = 0; c < state.width; c += 1) {
      const mark = state.incoming[r][c];
      if (mark && !mark.auto) shots.push(mark);
    }
  }
  const hits = shots.filter((mark) => mark.result === "hit" || mark.result === "sunk").length;
  return { shots: shots.length, hits, rate: shots.length ? Math.round((hits / shots.length) * 100) : 0 };
}

export { variants as shapeVariants };

export function undo(state) {
  if (state.phase !== "battle" || !state.history.length) return state;
  return state.history.at(-1);
}

export function ownShotStats(state) {
  const shots = [];
  for (let r = 0; r < state.height; r += 1) {
    for (let c = 0; c < state.width; c += 1) {
      const mark = state.enemy[r][c];
      if (mark && !mark.auto) shots.push(mark);
    }
  }
  const hits = shots.filter((mark) => mark.kind === "hit" || mark.kind === "sunk").length;
  return { shots: shots.length, hits, rate: shots.length ? Math.round((hits / shots.length) * 100) : 0 };
}

export function logText(entry) {
  const word = { water: "Wasser", hit: "Treffer", sunk: "Versenkt" }[entry.result];
  const detail = entry.result === "sunk" && entry.name ? ` (${entry.name}, ${entry.size})` : "";
  return `${coord(entry.c, entry.r)} ${word}${detail}`;
}

function startSunk(state, c, r) {
  const probe = snapshot(state);
  probe.history = state.history;
  const existing = probe.enemy[r][c];
  if (existing?.group != null) clearGroup(probe, existing.group);
  const report = inspectSunk(probe, c, r);
  if (!report.options.length) {
    return { state, error: "Die Treffer passen zu keinem offenen Schiff.", choice: null };
  }
  if (report.unique) {
    const next = snapshot(state);
    const cell = next.enemy[r][c];
    if (cell?.group != null) clearGroup(next, cell.group);
    const again = inspectSunk(next, c, r);
    applySunk(next, again.options[0].cells, again.options[0].index);
    return { state: next, error: null, choice: null };
  }
  return {
    state,
    error: null,
    choice: { c, r, options: report.options.map(({ index, shapeId, name, form, size }) => ({ index, shapeId, name, form, size })) },
  };
}

function inspectSunk(state, c, r) {
  const component = connectedHits(state.enemy, c, r, state.width, state.height);
  const signature = canonical(component.map((cell) => [cell.c, cell.r]));
  const open = state.enemyFleet
    .map((slot, index) => ({ slot, index }))
    .filter((item) => !item.slot.sunk);
  const exactIds = [...new Set(open.filter((item) => SIGNATURE[item.slot.shapeId] === signature).map((item) => item.slot.shapeId))];

  let shapeIds = exactIds;
  let cellsFor = () => component;
  if (!exactIds.length && state.allowTouch) {
    shapeIds = [];
    const embedded = new Map();
    for (const item of open) {
      if (embedded.has(item.slot.shapeId)) continue;
      const cells = firstEmbedding(component, { c, r }, item.slot.shapeId);
      if (cells) {
        embedded.set(item.slot.shapeId, cells);
        shapeIds.push(item.slot.shapeId);
      }
    }
    cellsFor = (shapeId) => embedded.get(shapeId);
  }

  const options = [];
  for (const shapeId of shapeIds) {
    const item = open.find((entry) => entry.slot.shapeId === shapeId);
    if (!item) continue;
    options.push({
      index: item.index,
      shapeId,
      name: item.slot.name,
      form: item.slot.form,
      size: item.slot.size,
      cells: cellsFor(shapeId),
    });
  }
  return { options, unique: !state.allowTouch && exactIds.length === 1 };
}

function applySunk(state, cells, slotIndex) {
  const group = state.nextGroup;
  state.nextGroup += 1;
  for (const cell of cells) state.enemy[cell.r][cell.c] = { kind: "sunk", auto: false, group };
  state.enemyFleet[slotIndex].sunk = true;
  state.enemyFleet[slotIndex].group = group;
  if (!state.allowTouch) {
    for (const cell of around(cells, state.width, state.height)) {
      if (!state.enemy[cell.r][cell.c]) state.enemy[cell.r][cell.c] = { kind: "water", auto: true, group };
    }
  }
  if (state.enemyFleet.every((slot) => slot.sunk)) {
    state.phase = "end";
    state.outcome = "won";
  }
}

function connectedHits(grid, c, r, width, height) {
  const cells = [{ c, r }];
  const seen = new Set([`${c},${r}`]);
  const queue = [{ c, r }];
  while (queue.length) {
    const current = queue.pop();
    for (const [dc, dr] of CROSS) {
      const col = current.c + dc;
      const row = current.r + dr;
      const id = `${col},${row}`;
      if (col < 0 || row < 0 || col >= width || row >= height || seen.has(id)) continue;
      if (grid[row][col]?.kind !== "hit") continue;
      seen.add(id);
      const cell = { c: col, r: row };
      cells.push(cell);
      queue.push(cell);
    }
  }
  return cells;
}

function firstEmbedding(component, origin, shapeId) {
  const room = new Set(component.map(keyOf));
  let best = null;
  let bestKey = "";
  for (const mirror of [false, true]) {
    for (const rotation of [0, 90, 180, 270]) {
      const shape = orientedCells(shapeId, rotation, mirror);
      for (const [sx, sy] of shape) {
        const abs = shape.map(([x, y]) => ({ c: origin.c - sx + x, r: origin.r - sy + y }));
        if (!abs.every((cell) => room.has(keyOf(cell)))) continue;
        const id = abs.map(keyOf).sort().join(";");
        if (!best || id < bestKey) {
          best = abs;
          bestKey = id;
        }
      }
    }
  }
  return best;
}

function clearGroup(state, group) {
  for (let r = 0; r < state.height; r += 1) {
    for (let c = 0; c < state.width; c += 1) {
      if (state.enemy[r][c]?.group === group) state.enemy[r][c] = null;
    }
  }
  for (const slot of state.enemyFleet) {
    if (slot.group === group) {
      slot.sunk = false;
      slot.group = null;
    }
  }
}

function around(cells, width, height) {
  const blocked = new Set(cells.map(keyOf));
  const extra = [];
  for (const cell of cells) {
    for (const [dc, dr] of NEIGHBORS) {
      const col = cell.c + dc;
      const row = cell.r + dr;
      const id = `${col},${row}`;
      if (col < 0 || row < 0 || col >= width || row >= height || blocked.has(id)) continue;
      blocked.add(id);
      extra.push({ c: col, r: row });
    }
  }
  return extra;
}

function copyShips(ships) {
  return (ships || []).map((ship) => ({ ...ship, cells: ship.cells ? ship.cells.map((cell) => ({ ...cell })) : null }));
}

function fork(state) {
  return {
    ...state,
    ships: copyShips(state.ships),
    botShips: copyShips(state.botShips),
    enemy: state.enemy.map((row) => row.map((cell) => (cell ? { ...cell } : null))),
    incoming: state.incoming.map((row) => row.map((cell) => (cell ? { ...cell } : null))),
    enemyFleet: state.enemyFleet.map((slot) => ({ ...slot })),
    shotLog: state.shotLog.map((entry) => ({ ...entry })),
    history: state.history || [],
  };
}

function snapshot(state) {
  const next = fork(state);
  next.history = [...state.history, state].slice(-40);
  return next;
}

function randomPlacement(ships, allowTouch, width, height, rng, options = {}) {
  const budget = { left: options.budget ?? 20000 };
  const order = ships.map((ship, index) => index).sort((a, b) => ships[b].size - ships[a].size || a - b);
  const occupied = new Set();

  function place(step) {
    if (step >= order.length) return true;
    if (budget.left <= 0) return false;
    const ship = ships[order[step]];
    const spots = sample(openSpots(ship, occupied, allowTouch, width, height), options.spotLimit ?? 80, rng);
    for (let i = spots.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    for (const spot of spots) {
      budget.left -= 1;
      if (budget.left < 0) return false;
      const cells = spot.cells.map(([x, y]) => ({ c: spot.c + x, r: spot.r + y }));
      for (const cell of cells) occupied.add(keyOf(cell));
      ship.cells = cells;
      ship.rotation = spot.rotation;
      ship.mirror = spot.mirror;
      if (place(step + 1)) return true;
      ship.cells = null;
      for (const cell of cells) occupied.delete(keyOf(cell));
    }
    return false;
  }

  return place(0);
}

function openSpots(ship, occupied, allowTouch, width, height) {
  const spots = [];
  for (const variant of variants(ship.shapeId)) {
    const xs = variant.cells.map((cell) => cell[0]);
    const ys = variant.cells.map((cell) => cell[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    for (let r = -minY; r <= height - maxY - 1; r += 1) {
      for (let c = -minX; c <= width - maxX - 1; c += 1) {
        const cells = variant.cells.map(([x, y]) => ({ c: c + x, r: r + y }));
        if (cells.some((cell) => occupied.has(keyOf(cell)))) continue;
        if (!allowTouch && cells.some((cell) => touchesOccupied(cell, occupied, cells))) continue;
        spots.push({ c, r, rotation: variant.rotation, mirror: variant.mirror, cells: variant.cells });
      }
    }
  }
  return spots;
}

function touchesOccupied(cell, occupied, ownCells) {
  const own = new Set(ownCells.map(keyOf));
  return NEIGHBORS.some(([dc, dr]) => {
    const id = `${cell.c + dc},${cell.r + dr}`;
    return !own.has(id) && occupied.has(id);
  });
}

function variants(shapeId) {
  const found = [];
  const seen = new Set();
  for (const mirror of [false, true]) {
    for (const rotation of [0, 90, 180, 270]) {
      const cells = orientedCells(shapeId, rotation, mirror);
      const id = cells.map((cell) => cell.join(",")).sort().join(";");
      if (seen.has(id)) continue;
      seen.add(id);
      found.push({ rotation, mirror, cells });
    }
  }
  return found;
}

function shapeFits(shapeId, width, height) {
  return variants(shapeId).some((variant) => {
    const xs = variant.cells.map((cell) => cell[0]);
    const ys = variant.cells.map((cell) => cell[1]);
    return Math.max(...xs) - Math.min(...xs) + 1 <= width && Math.max(...ys) - Math.min(...ys) + 1 <= height;
  });
}

function orientedCells(shapeId, rotation, mirror) {
  const cells = transform(SHAPE_BY_ID[shapeId].cells, rotation, mirror);
  const [ax, ay] = cells[0];
  return cells.map(([x, y]) => [x - ax, y - ay]);
}

function transform(cells, rotation, mirrored) {
  let next = cells.map(([x, y]) => (mirrored ? [-x, y] : [x, y]));
  const turns = ((((rotation % 360) + 360) % 360) / 90);
  for (let i = 0; i < turns; i += 1) next = next.map(([x, y]) => [y, -x]);
  return next;
}

function normalize(cells) {
  const minX = Math.min(...cells.map((cell) => cell[0]));
  const minY = Math.min(...cells.map((cell) => cell[1]));
  return cells.map(([x, y]) => [x - minX, y - minY]);
}

function canonical(cells) {
  const relative = normalize(cells);
  const forms = [];
  for (const mirrored of [false, true]) {
    for (const rotation of [0, 90, 180, 270]) {
      forms.push(normalize(transform(relative, rotation, mirrored)).map((cell) => cell.join(",")).sort().join(";"));
    }
  }
  forms.sort();
  return forms[0];
}

function sample(list, limit, rng) {
  if (!limit || list.length <= limit) return list.slice();
  const copy = list.slice();
  for (let i = 0; i < limit; i += 1) {
    const j = i + Math.floor(rng() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, limit);
}

function validGrid(grid, width, height) {
  return Array.isArray(grid) && grid.length === height && grid.every((row) => Array.isArray(row) && row.length === width);
}

function keyOf(cell) {
  return `${cell.c},${cell.r}`;
}

function pushBits(bits, value, width) {
  for (let i = width - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
}

function readBits(bits, cursor, width) {
  let value = 0;
  for (let i = 0; i < width; i += 1) value = (value << 1) | (bits[cursor.i++] || 0);
  return value;
}

function bitsToCode(bits) {
  let code = "";
  for (let i = 0; i < bits.length; i += 5) {
    let value = 0;
    for (let bit = 0; bit < 5; bit += 1) value = (value << 1) | bits[i + bit];
    code += ALPHABET[value];
  }
  return code;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
