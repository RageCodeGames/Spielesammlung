/**
 * Online-Zustand für Schiffe versenken (zwei Spieler, Host ist Wahrheit).
 * Flotten liegen im gemeinsamen State – die UI zeigt die gegnerische nie vor dem Ende.
 * Schüsse als Koordinaten-Objekte (boards[playerId]["c_r"]), damit Firebase keine Lücken verschluckt.
 */

import {
  allPlaced,
  copyBoard,
  emptyBoard,
  expandFleet,
  fleetCells,
  assessFleet,
  normalizeBoard,
  placementIssue,
  readMark,
  rulesFor,
  shipAt,
  writeMark,
} from "./logic.js";
import { normalizeRemote, readArray } from "../../shared/online.js";

const MODE_LABEL = {
  classic: "Klassisch",
  paper: "Papier",
  mixed: "Gemischt",
  custom: "Custom",
};

function copyShips(ships) {
  return (ships || []).map((ship) => ({
    ...ship,
    cells: ship.cells ? ship.cells.map((cell) => ({ ...cell })) : null,
  }));
}

function cloneOnline(state) {
  return {
    ...state,
    rules: state.rules
      ? { ...state.rules, counts: { ...(state.rules.counts || {}) } }
      : state.rules,
    ready: { ...(state.ready || {}) },
    playerNames: { ...(state.playerNames || {}) },
    fleets: Object.fromEntries(
      Object.entries(state.fleets || {}).map(([id, ships]) => [id, copyShips(ships)])
    ),
    boards: Object.fromEntries(
      Object.entries(state.boards || {}).map(([id, board]) => [id, copyBoard(board)])
    ),
    fleetStatus: Object.fromEntries(
      Object.entries(state.fleetStatus || {}).map(([id, slots]) => [
        id,
        (slots || []).map((slot) => ({ ...slot })),
      ])
    ),
    nextGroup: { ...(state.nextGroup || {}) },
    lastShot: state.lastShot ? { ...state.lastShot } : null,
    playerIds: [...(state.playerIds || [])],
  };
}

function fleetSlotsFromShips(ships) {
  return (ships || []).map((ship) => ({
    shapeId: ship.shapeId,
    name: ship.name,
    form: ship.form,
    size: ship.size,
    sunk: false,
    group: null,
  }));
}

function around(cells, width, height) {
  const blocked = new Set(cells.map((cell) => `${cell.c},${cell.r}`));
  const extra = [];
  for (const cell of cells) {
    for (let dc = -1; dc <= 1; dc += 1) {
      for (let dr = -1; dr <= 1; dr += 1) {
        if (dc === 0 && dr === 0) continue;
        const col = cell.c + dc;
        const row = cell.r + dr;
        const id = `${col},${row}`;
        if (col < 0 || row < 0 || col >= width || row >= height || blocked.has(id)) continue;
        blocked.add(id);
        extra.push({ c: col, r: row });
      }
    }
  }
  return extra;
}

/** Gegnerische Schüsse (kind) → eigenes Feld (result). */
function boardAsIncoming(board, width, height) {
  const out = emptyBoard();
  for (const [key, mark] of Object.entries(normalizeBoard(board, width, height))) {
    if (!mark) continue;
    out[key] = {
      result: mark.kind || mark.result,
      auto: !!mark.auto,
      group: mark.group ?? null,
    };
  }
  return out;
}

export function defaultOnlineSettings() {
  const rules = rulesFor("classic", false);
  return { ...rules, extraShot: true };
}

export function normalizeOnlineSettings(raw) {
  const base = defaultOnlineSettings();
  if (!raw || typeof raw !== "object") return base;
  const mode = ["classic", "paper", "mixed", "custom"].includes(raw.mode) ? raw.mode : "classic";
  const allowTouch = !!raw.allowTouch;
  const rules =
    mode === "custom"
      ? rulesFor("custom", allowTouch, {
          width: raw.width,
          height: raw.height,
          counts: raw.counts,
        })
      : rulesFor(mode, allowTouch);
  return { ...rules, extraShot: raw.extraShot !== false };
}

export function summarizeOnlineSettings(raw) {
  const settings = normalizeOnlineSettings(raw);
  const mode = MODE_LABEL[settings.mode] || "Klassisch";
  const size = `${settings.width}×${settings.height}`;
  const touch = settings.allowTouch ? "Berühren ok" : "kein Berühren";
  const again = settings.extraShot ? "Treffer = nochmal" : "immer abwechselnd";
  return `${mode} · ${size} · ${touch} · ${again}`;
}

export function beginOnlineMatch(players, settingsInput, rematchCount = 0, previousFirstId = null) {
  const settings = normalizeOnlineSettings(settingsInput);
  const check = assessFleet(settings);
  if (!check.ok) {
    throw new Error(check.message || "Diese Flotte passt nicht aufs Feld.");
  }
  const ordered = [...players].sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0)).slice(0, 2);
  if (ordered.length < 2) throw new Error("Zwei Spieler werden gebraucht.");
  const playerIds = ordered.map((player) => player.id);
  const playerNames = Object.fromEntries(ordered.map((player) => [player.id, player.name]));
  let firstShooterId = playerIds[0];
  if (rematchCount > 0 && previousFirstId) {
    firstShooterId = playerIds.find((id) => id !== previousFirstId) || playerIds[0];
  }
  const fleets = {};
  const boards = {};
  const fleetStatus = {};
  const ready = {};
  const nextGroup = {};
  for (const id of playerIds) {
    const ships = expandFleet(settings);
    fleets[id] = ships;
    boards[id] = emptyBoard();
    fleetStatus[id] = fleetSlotsFromShips(ships);
    ready[id] = false;
    nextGroup[id] = 1;
  }
  return {
    version: 3,
    versus: "online",
    phase: "place",
    rules: {
      mode: settings.mode,
      width: settings.width,
      height: settings.height,
      allowTouch: settings.allowTouch,
      counts: { ...settings.counts },
    },
    width: settings.width,
    height: settings.height,
    allowTouch: settings.allowTouch,
    extraShot: settings.extraShot !== false,
    playerIds,
    playerNames,
    firstShooterId,
    rematchCount,
    ready,
    fleets,
    boards,
    fleetStatus,
    nextGroup,
    turnPlayerId: null,
    lastShot: null,
    shotSeq: 0,
    winnerId: null,
  };
}

export function migrateOnlineState(data) {
  if (!data || typeof data !== "object") return null;
  if (data.versus !== "online" && data.version !== 3) return null;
  const settings = normalizeOnlineSettings({
    ...(data.rules || {}),
    allowTouch: data.allowTouch ?? data.rules?.allowTouch,
    extraShot: data.extraShot,
  });
  const next = normalizeRemote(data, {
    arrays: ["playerIds"],
    defaults: {
      rematchCount: 0,
      shotSeq: 0,
      turnPlayerId: null,
      lastShot: null,
      winnerId: null,
      phase: "place",
    },
  });
  const playerIds = readArray(next.playerIds).filter(Boolean).slice(0, 2);
  if (playerIds.length < 2) return null;
  const fleets = {};
  const boards = {};
  const fleetStatus = {};
  const ready = {};
  const nextGroup = {};
  for (const id of playerIds) {
    fleets[id] = copyShips(readArray(next.fleets?.[id]));
    if (!fleets[id].length) fleets[id] = expandFleet(settings);
    boards[id] = normalizeBoard(next.boards?.[id], settings.width, settings.height);
    fleetStatus[id] = readArray(next.fleetStatus?.[id]).map((slot) => ({
      shapeId: slot.shapeId,
      name: slot.name,
      form: slot.form,
      size: slot.size,
      sunk: !!slot.sunk,
      group: slot.group ?? null,
    }));
    if (!fleetStatus[id].length) fleetStatus[id] = fleetSlotsFromShips(fleets[id]);
    ready[id] = next.ready?.[id] === true;
    nextGroup[id] = Number(next.nextGroup?.[id]) || 1;
  }
  return {
    ...next,
    version: 3,
    versus: "online",
    rules: {
      mode: settings.mode,
      width: settings.width,
      height: settings.height,
      allowTouch: settings.allowTouch,
      counts: { ...settings.counts },
    },
    width: settings.width,
    height: settings.height,
    allowTouch: settings.allowTouch,
    extraShot: settings.extraShot !== false,
    playerIds,
    playerNames: { ...(next.playerNames || {}) },
    firstShooterId: next.firstShooterId || playerIds[0],
    rematchCount: Number(next.rematchCount) || 0,
    ready,
    fleets,
    boards,
    fleetStatus,
    nextGroup,
    turnPlayerId: next.turnPlayerId || null,
    lastShot: next.lastShot || null,
    shotSeq: Number(next.shotSeq) || 0,
    winnerId: next.winnerId || null,
  };
}

export function opponentId(state, myId) {
  return (state.playerIds || []).find((id) => id !== myId) || null;
}

export function validateFleetPayload(rules, ships) {
  const expected = expandFleet(rules);
  if (!Array.isArray(ships) || ships.length !== expected.length) {
    return { ok: false, error: "Die Flotte passt nicht zu den Regeln." };
  }
  const placed = copyShips(ships);
  for (let i = 0; i < expected.length; i += 1) {
    const ship = placed[i];
    const want = expected[i];
    if (!ship || ship.shapeId !== want.shapeId || !Array.isArray(ship.cells) || ship.cells.length !== want.size) {
      return { ok: false, error: "Nicht alle Schiffe sind korrekt gelegt." };
    }
    for (const cell of ship.cells) {
      if (!Number.isInteger(cell.c) || !Number.isInteger(cell.r)) {
        return { ok: false, error: "Ungültige Schiffsposition." };
      }
    }
    const issue = placementIssue(placed, ship.id, ship.cells, rules.allowTouch, rules.width, rules.height);
    if (issue) return { ok: false, error: "Schiffe überlappen oder berühren sich unerlaubt." };
  }
  if (!allPlaced(placed)) return { ok: false, error: "Noch nicht alle Schiffe liegen." };
  if (fleetCells(rules) <= 0) return { ok: false, error: "Keine Schiffe gewählt." };
  return { ok: true, ships: placed };
}

export function applyReady(state, playerId, ships) {
  if (state.phase !== "place") return { state, error: "Platzieren ist vorbei." };
  if (!state.playerIds.includes(playerId)) return { state, error: "Unbekannter Spieler." };
  const check = validateFleetPayload(state.rules, ships);
  if (!check.ok) return { state, error: check.error };
  const next = cloneOnline(state);
  next.fleets[playerId] = check.ships;
  next.fleetStatus[opponentId(next, playerId)] = fleetSlotsFromShips(check.ships);
  next.ready[playerId] = true;
  if (next.playerIds.every((id) => next.ready[id])) {
    next.phase = "battle";
    next.turnPlayerId = next.firstShooterId;
    next.lastShot = null;
  }
  return { state: next, error: null };
}

export function applyUnready(state, playerId) {
  if (state.phase !== "place") return state;
  if (!state.playerIds.includes(playerId)) return state;
  const next = cloneOnline(state);
  next.ready[playerId] = false;
  return next;
}

export function applyForfeit(state, leaverId) {
  if (!state || state.phase === "end") return { state, error: null };
  const winner = opponentId(state, leaverId);
  if (!winner) return { state, error: null };
  const next = cloneOnline(state);
  next.phase = "end";
  next.winnerId = winner;
  next.turnPlayerId = null;
  next.endReason = "left";
  next.leftId = leaverId;
  next.leftName = next.playerNames?.[leaverId] || "Gegner";
  return { state: next, error: null };
}

export function fireOnlineShot(state, shooterId, c, r) {
  if (state.phase !== "battle") return { state, result: "ignore" };
  if (state.turnPlayerId !== shooterId) return { state, result: "ignore" };
  if (!state.playerIds.includes(shooterId)) return { state, result: "ignore" };
  if (c < 0 || r < 0 || c >= state.width || r >= state.height) return { state, result: "ignore" };
  const board = state.boards[shooterId];
  if (!board || readMark(board, c, r)) return { state, result: "already" };
  const defenderId = opponentId(state, shooterId);
  if (!defenderId) return { state, result: "ignore" };
  const next = cloneOnline(state);
  const ship = shipAt(next.fleets[defenderId], c, r);
  let result = "water";
  let sunkShip = null;
  if (ship) {
    writeMark(next.boards[shooterId], c, r, { kind: "hit", auto: false, group: null });
    result = ship.cells.every((cell) => readMark(next.boards[shooterId], cell.c, cell.r)) ? "sunk" : "hit";
    if (result === "sunk") {
      sunkShip = ship;
      const group = next.nextGroup[shooterId] || 1;
      next.nextGroup[shooterId] = group + 1;
      for (const cell of ship.cells) {
        writeMark(next.boards[shooterId], cell.c, cell.r, { kind: "sunk", auto: false, group });
      }
      const slot = next.fleetStatus[shooterId]?.find(
        (item) => !item.sunk && item.shapeId === ship.shapeId
      );
      if (slot) {
        slot.sunk = true;
        slot.group = group;
      }
      if (!next.allowTouch) {
        for (const cell of around(ship.cells, next.width, next.height)) {
          if (!readMark(next.boards[shooterId], cell.c, cell.r)) {
            writeMark(next.boards[shooterId], cell.c, cell.r, { kind: "water", auto: true, group });
          }
        }
      }
    }
  } else {
    writeMark(next.boards[shooterId], c, r, { kind: "water", auto: false, group: null });
  }

  next.shotSeq = (next.shotSeq || 0) + 1;
  next.lastShot = {
    seq: next.shotSeq,
    shooterId,
    defenderId,
    c,
    r,
    result,
    shipName: sunkShip?.name || null,
    shipSize: sunkShip?.size || null,
    shapeId: sunkShip?.shapeId || null,
  };

  const allSunk = (next.fleetStatus[shooterId] || []).every((slot) => slot.sunk);
  if (allSunk) {
    next.phase = "end";
    next.winnerId = shooterId;
    next.turnPlayerId = null;
  } else if (next.extraShot && result !== "water") {
    next.turnPlayerId = shooterId;
  } else {
    next.turnPlayerId = defenderId;
  }
  return { state: next, result, ship: sunkShip };
}

export function beginOnlineRematch(state, players) {
  return beginOnlineMatch(
    players.map((player, index) => ({
      id: player.id,
      name: player.name || state.playerNames?.[player.id] || `Spieler ${index + 1}`,
      seat: index,
    })),
    {
      ...state.rules,
      extraShot: state.extraShot,
    },
    (state.rematchCount || 0) + 1,
    state.firstShooterId
  );
}

export function shotStatsFor(state, playerId) {
  const board = normalizeBoard(state.boards?.[playerId], state.width, state.height);
  const shots = Object.values(board).filter((mark) => mark && !mark.auto);
  const hits = shots.filter((mark) => mark.kind === "hit" || mark.kind === "sunk").length;
  return { shots: shots.length, hits, rate: shots.length ? Math.round((hits / shots.length) * 100) : 0 };
}

/** Lokale Ansicht für die bestehende Render-Pipeline – nur Host-Zustand, keine lokalen Markierungen. */
export function viewAsPlayer(online, myId) {
  const other = opponentId(online, myId);
  const ships = copyShips(online.fleets?.[myId] || []);
  const enemy = copyBoard(online.boards?.[myId] || emptyBoard());
  const incoming = boardAsIncoming(online.boards?.[other] || emptyBoard(), online.width, online.height);
  const enemyFleet = (online.fleetStatus?.[myId] || []).map((slot) => ({ ...slot }));
  const outcome =
    online.phase === "end"
      ? online.winnerId === myId
        ? "won"
        : "lost"
      : null;
  return {
    ...online,
    versus: "online",
    ships,
    enemy,
    incoming,
    enemyFleet,
    botShips: online.phase === "end" ? copyShips(online.fleets?.[other] || []) : [],
    turn: online.turnPlayerId === myId ? "player" : "opponent",
    outcome,
    code: null,
    history: [],
    selectedId: ships.find((ship) => !ship.cells)?.id ?? ships[0]?.id ?? null,
    rotation: 0,
    mirror: false,
    myId,
    opponentId: other,
  };
}

export function isOnlineRunning(data) {
  const state = migrateOnlineState(data);
  if (!state) return false;
  return ["place", "battle", "end"].includes(state.phase);
}
