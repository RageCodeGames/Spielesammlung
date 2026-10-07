/** Reine Spiellogik für Schiffe versenken. Kein DOM. */

export const SIZE = 10;
export const COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

export const FLEETS = {
  classic: [5, 4, 3, 3, 2],
  paper: [5, 4, 4, 3, 3, 3, 2, 2, 2, 2],
};

const NAMES = {
  2: "U-Boot",
  3: "Zerstörer",
  4: "Kreuzer",
  5: "Schlachtschiff",
};

export function shipName(size) {
  return NAMES[size] || `Schiff (${size})`;
}

export function coord(c, r) {
  return `${COLS[c]}${r + 1}`;
}

export function emptyGrid() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
}

function fleetSlots(fleetId) {
  return FLEETS[fleetId].map((size) => ({ size, sunk: false, group: null }));
}

export function createShips(fleetId) {
  return FLEETS[fleetId].map((size, id) => ({
    id,
    size,
    name: shipName(size),
    orientation: "h",
    cells: null,
  }));
}

export function freshState() {
  const fleetId = "classic";
  const ships = createShips(fleetId);
  return {
    version: 1,
    phase: "settings",
    fleetId,
    allowTouch: false,
    ships,
    selectedId: ships[0].id,
    orientation: "h",
    enemy: emptyGrid(),
    enemyFleet: fleetSlots(fleetId),
    nextGroup: 1,
    incoming: emptyGrid(),
    shotLog: [],
    history: [],
    outcome: null,
  };
}

export function isRunning(data) {
  return Boolean(
    data &&
      data.version === 1 &&
      (data.phase === "place" || data.phase === "battle" || data.phase === "end") &&
      Array.isArray(data.ships) &&
      Array.isArray(data.enemy) &&
      Array.isArray(data.incoming)
  );
}

function cloneGrid(grid) {
  return grid.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
}

function snapshotBattle(state) {
  return {
    phase: state.phase,
    outcome: state.outcome,
    enemy: cloneGrid(state.enemy),
    enemyFleet: state.enemyFleet.map((slot) => ({ ...slot })),
    nextGroup: state.nextGroup,
    incoming: cloneGrid(state.incoming),
    shotLog: state.shotLog.map((entry) => ({ ...entry })),
  };
}

export function footprint(c, r, size, orientation) {
  const cells = [];
  let oob = false;
  for (let i = 0; i < size; i += 1) {
    const cc = c + (orientation === "h" ? i : 0);
    const rr = r + (orientation === "v" ? i : 0);
    if (cc < 0 || rr < 0 || cc >= SIZE || rr >= SIZE) oob = true;
    else cells.push({ c: cc, r: rr });
  }
  return { cells, oob };
}

function cellKey(c, r) {
  return `${c},${r}`;
}

export function placementIssue(ships, ignoreId, cells, allowTouch) {
  if (!cells || cells.length === 0) return "rand";
  const occupied = new Set();
  const blocked = new Set();
  for (const ship of ships) {
    if (!ship.cells || ship.id === ignoreId) continue;
    for (const cell of ship.cells) {
      occupied.add(cellKey(cell.c, cell.r));
      if (!allowTouch) {
        for (let dr = -1; dr <= 1; dr += 1) {
          for (let dc = -1; dc <= 1; dc += 1) {
            const cc = cell.c + dc;
            const rr = cell.r + dr;
            if (cc >= 0 && rr >= 0 && cc < SIZE && rr < SIZE) blocked.add(cellKey(cc, rr));
          }
        }
      }
    }
  }
  for (const cell of cells) {
    if (occupied.has(cellKey(cell.c, cell.r))) return "ueberlapp";
  }
  if (!allowTouch) {
    for (const cell of cells) {
      if (blocked.has(cellKey(cell.c, cell.r))) return "beruehrung";
    }
  }
  return null;
}

export function previewAt(state, c, r) {
  const ship = state.ships.find((item) => item.id === state.selectedId);
  if (!ship) return { cells: [], issue: "keins" };
  const fp = footprint(c, r, ship.size, state.orientation);
  if (fp.oob) return { cells: fp.cells, issue: "rand" };
  return {
    cells: fp.cells,
    issue: placementIssue(state.ships, ship.id, fp.cells, state.allowTouch),
  };
}

export function shipAt(ships, c, r) {
  return (
    ships.find((ship) => ship.cells && ship.cells.some((cell) => cell.c === c && cell.r === r)) ||
    null
  );
}

export function allPlaced(ships) {
  return ships.every((ship) => ship.cells && ship.cells.length === ship.size);
}

export function beginPlacement(state, fleetId, allowTouch) {
  const ships = createShips(fleetId);
  return {
    ...state,
    phase: "place",
    fleetId,
    allowTouch,
    ships,
    selectedId: ships[0] ? ships[0].id : null,
    orientation: "h",
    enemy: emptyGrid(),
    enemyFleet: fleetSlots(fleetId),
    nextGroup: 1,
    incoming: emptyGrid(),
    shotLog: [],
    history: [],
    outcome: null,
  };
}

export function toggleOrientation(state) {
  return { ...state, orientation: state.orientation === "h" ? "v" : "h" };
}

export function selectShip(state, id) {
  const ship = state.ships.find((item) => item.id === id);
  if (!ship || ship.cells) return state;
  return { ...state, selectedId: id, orientation: ship.orientation || state.orientation };
}

export function placeSelected(state, c, r) {
  const preview = previewAt(state, c, r);
  if (preview.issue) return { state, issue: preview.issue, cells: preview.cells };
  const ships = state.ships.map((ship) =>
    ship.id === state.selectedId
      ? { ...ship, cells: preview.cells.map((cell) => ({ ...cell })), orientation: state.orientation }
      : ship
  );
  const next = ships.find((ship) => !ship.cells);
  return {
    state: { ...state, ships, selectedId: next ? next.id : null },
    issue: null,
    cells: preview.cells,
  };
}

export function liftAt(state, c, r) {
  const ship = shipAt(state.ships, c, r);
  if (!ship) return state;
  return {
    ...state,
    selectedId: ship.id,
    orientation: ship.orientation,
    ships: state.ships.map((item) => (item.id === ship.id ? { ...item, cells: null } : item)),
  };
}

export function resetShips(state) {
  const ships = state.ships.map((ship) => ({ ...ship, cells: null }));
  return { ...state, ships, selectedId: ships[0] ? ships[0].id : null, orientation: "h" };
}

function shuffle(list, rng) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const swap = copy[i];
    copy[i] = copy[j];
    copy[j] = swap;
  }
  return copy;
}

function placeNext(ships, index, allowTouch, rng, budget) {
  if (index >= ships.length) return true;
  if (budget.left <= 0) return false;
  const ship = ships[index];
  const spots = [];
  for (const orientation of ["h", "v"]) {
    for (let r = 0; r < SIZE; r += 1) {
      for (let c = 0; c < SIZE; c += 1) {
        const fp = footprint(c, r, ship.size, orientation);
        if (fp.oob) continue;
        if (placementIssue(ships, ship.id, fp.cells, allowTouch)) continue;
        spots.push({ cells: fp.cells, orientation });
      }
    }
  }
  for (const spot of shuffle(spots, rng)) {
    budget.left -= 1;
    ship.cells = spot.cells;
    ship.orientation = spot.orientation;
    if (placeNext(ships, index + 1, allowTouch, rng, budget)) return true;
    ship.cells = null;
    if (budget.left <= 0) return false;
  }
  return false;
}

export function randomPlacement(sizes, allowTouch, rng = Math.random) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ships = sizes.map((size, id) => ({
      id,
      size,
      name: shipName(size),
      orientation: "h",
      cells: null,
    }));
    const budget = { left: 20000 };
    if (placeNext(ships, 0, allowTouch, rng, budget)) return ships;
  }
  return null;
}

export function dealRandom(state, rng = Math.random) {
  const placed = randomPlacement(
    state.ships.map((ship) => ship.size),
    state.allowTouch,
    rng
  );
  if (!placed) return { state, ok: false };
  return {
    ok: true,
    state: {
      ...state,
      ships: state.ships.map((ship, index) => ({
        ...ship,
        cells: placed[index].cells.map((cell) => ({ ...cell })),
        orientation: placed[index].orientation,
      })),
      selectedId: null,
    },
  };
}

export function beginBattle(state) {
  if (!allPlaced(state.ships)) return state;
  return { ...state, phase: "battle", selectedId: null };
}

function around(cells) {
  const inside = new Set(cells.map((cell) => cellKey(cell.c, cell.r)));
  const result = [];
  const seen = new Set();
  for (const cell of cells) {
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        const cc = cell.c + dc;
        const rr = cell.r + dr;
        const id = cellKey(cc, rr);
        if (cc < 0 || rr < 0 || cc >= SIZE || rr >= SIZE) continue;
        if (inside.has(id) || seen.has(id)) continue;
        seen.add(id);
        result.push({ c: cc, r: rr });
      }
    }
  }
  return result;
}

function clearGroup(state, group) {
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      const cell = state.enemy[r][c];
      if (!cell || cell.group !== group) continue;
      if (cell.auto) state.enemy[r][c] = null;
      else if (cell.kind === "sunk") state.enemy[r][c] = { kind: "hit", auto: false, group: null };
    }
  }
  state.enemyFleet = state.enemyFleet.map((slot) =>
    slot.group === group ? { ...slot, sunk: false, group: null } : slot
  );
}

function chooseLine(grid, c, r, fleet) {
  const horizontal = lineInAxis(grid, c, r, 1, 0);
  const vertical = lineInAxis(grid, c, r, 0, 1);
  const remaining = fleet.filter((slot) => !slot.sunk).map((slot) => slot.size);
  const matches = [horizontal, vertical].filter((line) => remaining.includes(line.length));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return horizontal.length >= vertical.length ? horizontal : vertical;
  return horizontal.length >= vertical.length ? horizontal : vertical;
}

function lineInAxis(grid, c, r, dc, dr) {
  const cells = [{ c, r }];
  for (const sign of [1, -1]) {
    let cc = c + dc * sign;
    let rr = r + dr * sign;
    while (cc >= 0 && rr >= 0 && cc < SIZE && rr < SIZE) {
      const cell = grid[rr][cc];
      if (!cell || cell.kind !== "hit" || cell.auto) break;
      cells.push({ c: cc, r: rr });
      cc += dc * sign;
      rr += dr * sign;
    }
  }
  return cells;
}

export function markEnemy(state, c, r, kind) {
  const next = {
    ...state,
    enemy: cloneGrid(state.enemy),
    enemyFleet: state.enemyFleet.map((slot) => ({ ...slot })),
    history: state.history.concat(snapshotBattle(state)),
  };
  const current = next.enemy[r][c];
  if (current && current.kind === "sunk" && current.group) clearGroup(next, current.group);

  if (kind === "sunk") {
    const line = chooseLine(next.enemy, c, r, next.enemyFleet);
    const slot = next.enemyFleet.find((item) => !item.sunk && item.size === line.length);
    if (!slot) return { state, error: "Diese Größe ist nicht mehr übrig." };
    const group = next.nextGroup;
    next.nextGroup += 1;
    for (const cell of line) {
      next.enemy[cell.r][cell.c] = { kind: "sunk", auto: false, group };
    }
    slot.sunk = true;
    slot.group = group;
    if (!next.allowTouch) {
      for (const cell of around(line)) {
        if (!next.enemy[cell.r][cell.c]) {
          next.enemy[cell.r][cell.c] = { kind: "water", auto: true, group };
        }
      }
    }
    if (next.enemyFleet.every((item) => item.sunk)) {
      next.phase = "end";
      next.outcome = "won";
    }
    return { state: next, error: null };
  }

  next.enemy[r][c] = { kind, auto: false, group: null };
  return { state: next, error: null };
}

export function fireIncoming(state, c, r) {
  if (state.incoming[r][c]) return { state, already: true, result: null, ship: null };
  const incoming = cloneGrid(state.incoming);
  const ship = shipAt(state.ships, c, r);
  let result = "water";
  if (!ship) {
    incoming[r][c] = { result: "water" };
  } else {
    incoming[r][c] = { result: "hit" };
    const sunk = ship.cells.every((cell) => incoming[cell.r][cell.c]);
    if (sunk) {
      result = "sunk";
      for (const cell of ship.cells) incoming[cell.r][cell.c] = { result: "sunk" };
    } else {
      result = "hit";
    }
  }
  const entry = {
    c,
    r,
    result,
    name: result === "sunk" ? ship.name : null,
    size: result === "sunk" ? ship.size : null,
  };
  const allSunk = state.ships.every((item) =>
    item.cells.every((cell) => {
      const mark = incoming[cell.r][cell.c];
      return mark && (mark.result === "hit" || mark.result === "sunk");
    })
  );
  return {
    state: {
      ...state,
      incoming,
      shotLog: state.shotLog.concat(entry),
      history: state.history.concat(snapshotBattle(state)),
      phase: allSunk ? "end" : state.phase,
      outcome: allSunk ? "lost" : state.outcome,
    },
    already: false,
    result,
    ship: result === "sunk" ? ship : null,
  };
}

export function undo(state) {
  if (state.phase !== "battle" || state.history.length === 0) return state;
  const prev = state.history[state.history.length - 1];
  return {
    ...state,
    phase: prev.phase,
    outcome: prev.outcome,
    enemy: cloneGrid(prev.enemy),
    enemyFleet: prev.enemyFleet.map((slot) => ({ ...slot })),
    nextGroup: prev.nextGroup,
    incoming: cloneGrid(prev.incoming),
    shotLog: prev.shotLog.map((entry) => ({ ...entry })),
    history: state.history.slice(0, -1),
  };
}

export function ownShotStats(enemy) {
  let shots = 0;
  let hits = 0;
  for (const row of enemy) {
    for (const cell of row) {
      if (!cell || cell.auto) continue;
      if (cell.kind === "water" || cell.kind === "hit" || cell.kind === "sunk") {
        shots += 1;
        if (cell.kind === "hit" || cell.kind === "sunk") hits += 1;
      }
    }
  }
  const rate = shots === 0 ? 0 : Math.round((hits / shots) * 100);
  return { shots, hits, rate };
}

export function ownShipSunk(ship, incoming) {
  return ship.cells.every((cell) => {
    const mark = incoming[cell.r][cell.c];
    return mark && (mark.result === "hit" || mark.result === "sunk");
  });
}

export function logText(entry, index) {
  const word = entry.result === "water" ? "Wasser" : entry.result === "hit" ? "Treffer" : "Versenkt";
  const detail = entry.result === "sunk" && entry.name ? ` (${entry.name}, ${entry.size})` : "";
  return `${index + 1}. ${coord(entry.c, entry.r)} ${word}${detail}`;
}
