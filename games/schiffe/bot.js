// Bot-Strategien. Der Bot sieht nur Schussergebnisse, nie die Schiffspositionen.

import { emptyGrid, randomFleet, rulesFor, shapeVariants, shipAt } from "./logic.js";

const CROSS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NEIGHBORS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
const HUNT_WEIGHT = 40;

export function chooseShot(view, difficulty, rng = Math.random) {
  if (difficulty === "easy") return pick(unknownCells(view, false), rng);
  if (difficulty === "medium") return mediumShot(view, rng);
  return hardShot(view, rng);
}

export function benchmarkBots(games = 200, rules = rulesFor("classic", false)) {
  const out = {};
  for (const difficulty of ["easy", "medium", "hard"]) {
    let total = 0;
    let failed = 0;
    for (let i = 0; i < games; i += 1) {
      const shots = huntFleet(difficulty, rules);
      if (shots == null) failed += 1;
      else total += shots;
    }
    const n = games - failed;
    out[difficulty] = { games: n, failed, average: n ? Math.round((total / n) * 10) / 10 : null };
  }
  return out;
}

function huntFleet(difficulty, rules) {
  const ships = randomFleet(rules);
  if (!ships) return null;
  const width = rules.width;
  const height = rules.height;
  const grid = emptyGrid(width, height);
  const remaining = ships.map((ship) => ({ shapeId: ship.shapeId, size: ship.size, id: ship.id, sunk: false }));
  let shots = 0;
  const limit = width * height + 2;
  while (remaining.some((slot) => !slot.sunk) && shots < limit) {
    const view = {
      width,
      height,
      allowTouch: !!rules.allowTouch,
      grid: grid.map((row) => row.map((cell) => cell)),
      remaining: remaining.filter((slot) => !slot.sunk).map((slot) => ({ shapeId: slot.shapeId, size: slot.size })),
    };
    const shot = chooseShot(view, difficulty, Math.random);
    if (!shot) return null;
    shots += 1;
    const ship = shipAt(ships, shot.c, shot.r);
    if (!ship) {
      grid[shot.r][shot.c] = "water";
      continue;
    }
    grid[shot.r][shot.c] = "hit";
    const sunk = ship.cells.every((cell) => grid[cell.r][cell.c]);
    if (!sunk) continue;
    for (const cell of ship.cells) grid[cell.r][cell.c] = "sunk";
    const slot = remaining.find((item) => item.id === ship.id);
    if (slot) slot.sunk = true;
    if (!rules.allowTouch) {
      for (const cell of ship.cells) {
        for (const [dc, dr] of NEIGHBORS) {
          const col = cell.c + dc;
          const row = cell.r + dr;
          if (col < 0 || row < 0 || col >= width || row >= height) continue;
          if (!grid[row][col]) grid[row][col] = "water";
        }
      }
    }
  }
  return remaining.every((slot) => slot.sunk) ? shots : null;
}

function mediumShot(view, rng) {
  const hits = listCells(view.grid, "hit");
  if (hits.length) {
    const line = [];
    const aroundHits = [];
    for (const group of connectedHits(view.grid, view.width, view.height)) {
      const ext = lineEnds(group, view);
      if (ext.length) line.push(...ext);
      for (const cell of group) {
        for (const [dc, dr] of CROSS) {
          const c = cell.c + dc;
          const r = cell.r + dr;
          if (isOpen(view, c, r, true)) aroundHits.push({ c, r });
        }
      }
    }
    const pickFrom = unique(line.length ? line : aroundHits);
    if (pickFrom.length) return pick(pickFrom, rng);
  }
  return pick(unknownCells(view, true), rng);
}

function hardShot(view, rng) {
  const hits = listCells(view.grid, "hit");
  const hunting = hits.length > 0;
  const scores = Array.from({ length: view.height }, () => Array(view.width).fill(0));
  let any = false;
  for (const ship of view.remaining) {
    for (const cells of placements(ship.shapeId, view, hunting)) {
      any = true;
      const weight = hunting ? HUNT_WEIGHT : 1;
      for (const cell of cells) {
        if (!view.grid[cell.r][cell.c]) scores[cell.r][cell.c] += weight;
      }
    }
  }
  if (!any && hunting) {
    for (const ship of view.remaining) {
      for (const cells of placements(ship.shapeId, view, false)) {
        any = true;
        for (const cell of cells) {
          if (!view.grid[cell.r][cell.c]) scores[cell.r][cell.c] += 1;
        }
      }
    }
  }
  let best = 0;
  const top = [];
  for (let r = 0; r < view.height; r += 1) {
    for (let c = 0; c < view.width; c += 1) {
      const value = scores[r][c];
      if (value > best) {
        best = value;
        top.length = 0;
      }
      if (value && value === best) top.push({ c, r });
    }
  }
  if (top.length) return pick(top, rng);
  return pick(unknownCells(view, true), rng);
}

function placements(shapeId, view, mustCoverHit) {
  const found = [];
  const sunkAdj = view.allowTouch ? null : adjacentTo(view.grid, "sunk", view.width, view.height);
  for (const variant of shapeVariants(shapeId)) {
    const xs = variant.cells.map((cell) => cell[0]);
    const ys = variant.cells.map((cell) => cell[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    for (let r = -minY; r <= view.height - maxY - 1; r += 1) {
      for (let c = -minX; c <= view.width - maxX - 1; c += 1) {
        let ok = true;
        let covers = false;
        const cells = [];
        for (const [x, y] of variant.cells) {
          const col = c + x;
          const row = r + y;
          const mark = view.grid[row][col];
          if (mark === "water" || mark === "sunk") {
            ok = false;
            break;
          }
          if (sunkAdj && sunkAdj[row][col]) {
            ok = false;
            break;
          }
          if (mark === "hit") covers = true;
          cells.push({ c: col, r: row });
        }
        if (ok && (!mustCoverHit || covers)) found.push(cells);
      }
    }
  }
  return found;
}

function unknownCells(view, skipSureWater) {
  const cells = [];
  const sunkAdj = skipSureWater && !view.allowTouch ? adjacentTo(view.grid, "sunk", view.width, view.height) : null;
  for (let r = 0; r < view.height; r += 1) {
    for (let c = 0; c < view.width; c += 1) {
      if (view.grid[r][c]) continue;
      if (sunkAdj && sunkAdj[r][c]) continue;
      cells.push({ c, r });
    }
  }
  return cells;
}

function isOpen(view, c, r, skipSureWater) {
  if (c < 0 || r < 0 || c >= view.width || r >= view.height) return false;
  if (view.grid[r][c]) return false;
  if (skipSureWater && !view.allowTouch) {
    for (const [dc, dr] of NEIGHBORS) {
      const col = c + dc;
      const row = r + dr;
      if (col < 0 || row < 0 || col >= view.width || row >= view.height) continue;
      if (view.grid[row][col] === "sunk") return false;
    }
  }
  return true;
}

function listCells(grid, kind) {
  const cells = [];
  for (let r = 0; r < grid.length; r += 1) {
    for (let c = 0; c < grid[r].length; c += 1) {
      if (grid[r][c] === kind) cells.push({ c, r });
    }
  }
  return cells;
}

function connectedHits(grid, width, height) {
  const seen = new Set();
  const groups = [];
  for (const start of listCells(grid, "hit")) {
    const id = `${start.c},${start.r}`;
    if (seen.has(id)) continue;
    const group = [];
    const queue = [start];
    seen.add(id);
    while (queue.length) {
      const cell = queue.pop();
      group.push(cell);
      for (const [dc, dr] of CROSS) {
        const c = cell.c + dc;
        const r = cell.r + dr;
        const key = `${c},${r}`;
        if (c < 0 || r < 0 || c >= width || r >= height || seen.has(key)) continue;
        if (grid[r][c] !== "hit") continue;
        seen.add(key);
        queue.push({ c, r });
      }
    }
    groups.push(group);
  }
  return groups;
}

function lineEnds(group, view) {
  if (group.length < 2) return [];
  const sameRow = group.every((cell) => cell.r === group[0].r);
  const sameCol = group.every((cell) => cell.c === group[0].c);
  const ends = [];
  if (sameRow) {
    const cols = group.map((cell) => cell.c);
    const r = group[0].r;
    const left = { c: Math.min(...cols) - 1, r };
    const right = { c: Math.max(...cols) + 1, r };
    if (isOpen(view, left.c, left.r, true)) ends.push(left);
    if (isOpen(view, right.c, right.r, true)) ends.push(right);
  } else if (sameCol) {
    const rows = group.map((cell) => cell.r);
    const c = group[0].c;
    const up = { c, r: Math.min(...rows) - 1 };
    const down = { c, r: Math.max(...rows) + 1 };
    if (isOpen(view, up.c, up.r, true)) ends.push(up);
    if (isOpen(view, down.c, down.r, true)) ends.push(down);
  }
  return ends;
}

function adjacentTo(grid, kind, width, height) {
  const flags = Array.from({ length: height }, () => Array(width).fill(false));
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      if (grid[r][c] !== kind) continue;
      for (const [dc, dr] of NEIGHBORS) {
        const col = c + dc;
        const row = r + dr;
        if (col < 0 || row < 0 || col >= width || row >= height) continue;
        flags[row][col] = true;
      }
    }
  }
  return flags;
}

function unique(cells) {
  const seen = new Set();
  const out = [];
  for (const cell of cells) {
    const id = `${cell.c},${cell.r}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(cell);
  }
  return out;
}

function pick(cells, rng) {
  if (!cells.length) return null;
  return cells[Math.floor(rng() * cells.length)];
}
