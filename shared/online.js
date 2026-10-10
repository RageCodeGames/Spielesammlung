/**
 * Gemeinsames Online-Fundament: Firebase Realtime Database, anonyme Anmeldung.
 * Spiele importieren diese Datei nur im Online-Modus – Offline-Spiele bleiben unberührt.
 */

import { firebaseConfig } from "./firebase-config.js";
import { get, set } from "./storage.js";

export const OFFLINE_MESSAGE = "Online-Modus braucht Internet";

const SDK = "https://www.gstatic.com/firebasejs/11.6.0";
const PLAYER_ID_KEY = "kajuete:player-id";
const PLAYER_NAME_KEY = "kajuete:player-name";
const ROOM_SESSION_KEY = "kajuete:online-room";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 4;
const ROOM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class OnlineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OnlineError";
    this.code = code;
  }
}

let fb = null;
let app = null;
let auth = null;
let db = null;
let uid = null;
let initPromise = null;

let roomCode = null;
let gameId = null;
let hostId = null;
let connected = false;
let disconnectOp = null;
let unsubRoom = null;
let unsubActions = null;
let unsubInfo = null;
let unsubSecrets = null;
let lastSnapshot = null;
let lastSecrets = null;
const pendingActions = [];

const roomListeners = new Set();
const actionListeners = new Set();
const connectionListeners = new Set();
const secretListeners = new Set();

function rememberPlayerId(id) {
  uid = id;
  set(PLAYER_ID_KEY, id);
}

export function getPlayerId() {
  return uid || get(PLAYER_ID_KEY, null);
}

export function getStoredName() {
  return get(PLAYER_NAME_KEY, "") || "";
}

export function getRoomCode() {
  return roomCode;
}

export function isHost() {
  return Boolean(uid && hostId && uid === hostId);
}

export function isConnected() {
  return connected;
}

export function getRoomSnapshot() {
  return lastSnapshot;
}

function fail(code, message) {
  throw new OnlineError(code, message);
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Firebase speichert keine leeren Arrays – sie fehlen beim Lesen.
 * Objekte mit Zahlen-Keys (selten) werden wie Arrays gelesen.
 */
export function readArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => value[key]);
  }
  return [];
}

/**
 * Spielzustand nach dem Lesen aus Firebase absichern.
 * undefined und leere Arrays fehlen in der Datenbank – hier wiederherstellen.
 *
 * @param {object|null|undefined} data
 * @param {{ arrays?: string[], defaults?: Record<string, unknown> }} shape
 *   arrays: Feldnamen, die immer Arrays sein müssen
 *   defaults: fehlende/null-Werte; boolean/number werden typisiert
 */
export function normalizeRemote(data, shape = {}) {
  if (!data || typeof data !== "object") return data;
  const out = { ...data };
  for (const key of shape.arrays || []) {
    out[key] = readArray(data[key]);
  }
  const defaults = shape.defaults || {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const raw = out[key];
    if (raw == null) {
      out[key] = fallback;
      continue;
    }
    if (typeof fallback === "boolean") out[key] = !!raw;
    else if (typeof fallback === "number") out[key] = Number(raw);
  }
  return out;
}

function rethrow(err) {
  console.error("[online]", err);
  if (err instanceof OnlineError) throw err;
  const code = String(err?.code || "");
  const message = String(err?.message || "");
  if (/permission/i.test(code) || /permission/i.test(message)) {
    fail(
      "denied",
      "Kein Zugriff auf die Datenbank. Bitte zuerst die Regeln in der Firebase-Konsole setzen."
    );
  }
  if (code === "auth/operation-not-allowed") {
    fail("auth", "Anonyme Anmeldung ist in der Firebase-Konsole noch nicht aktiv.");
  }
  if (code === "auth/network-request-failed" || /Failed to fetch|network/i.test(message)) {
    fail("offline", OFFLINE_MESSAGE);
  }
  throw err;
}

function requireOnline() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    fail("offline", OFFLINE_MESSAGE);
  }
}

function normalizeName(name) {
  const text = String(name || "").trim().slice(0, 20);
  return text || "Spieler";
}

export function normalizeRoomCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_LEN);
}

function isValidCode(code) {
  return new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`).test(code);
}

function randomCode() {
  const bytes = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

function saveSession(code, name, id) {
  set(PLAYER_NAME_KEY, name);
  set(ROOM_SESSION_KEY, { code, name, gameId: id });
}

function clearSession() {
  set(ROOM_SESSION_KEY, null);
}

export function getSession() {
  return get(ROOM_SESSION_KEY, null);
}

function emitConnection() {
  for (const cb of connectionListeners) {
    try {
      cb(connected);
    } catch (err) {
      console.error(err);
    }
  }
}

function mapRoom(code, data) {
  if (!data || !data.meta) return null;
  const playersRaw = data.players && typeof data.players === "object" ? data.players : {};
  const players = Object.entries(playersRaw)
    .map(([id, player]) => ({
      id,
      name: player?.name || "Spieler",
      online: player?.online === true,
      seat: Number.isFinite(player?.seat) ? player.seat : 99,
      joinedAt: player?.joinedAt || 0,
      isHost: id === data.meta.hostId,
      isSelf: id === uid,
      dummy: player?.dummy === true || String(id).startsWith("sim-"),
    }))
    .sort((a, b) => a.seat - b.seat || a.joinedAt - b.joinedAt);
  return {
    code,
    gameId: data.meta.gameId,
    hostId: data.meta.hostId,
    status: data.meta.status || "lobby",
    settings: data.meta.settings || {},
    createdAt: data.meta.createdAt || 0,
    state: data.state ?? null,
    players,
    you: {
      id: uid,
      name: players.find((p) => p.isSelf)?.name || "",
      isHost: uid === data.meta.hostId,
    },
  };
}

function emitRoom(snapshot) {
  lastSnapshot = snapshot;
  for (const cb of roomListeners) {
    try {
      cb(snapshot);
    } catch (err) {
      console.error(err);
    }
  }
}

async function loadFirebase() {
  requireOnline();
  try {
    const [appMod, authMod, dbMod] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-database.js`),
    ]);
    return { appMod, authMod, dbMod };
  } catch {
    fail("offline", OFFLINE_MESSAGE);
  }
}

async function doInit() {
  requireOnline();
  const mods = await loadFirebase();
  fb = mods;
  try {
    app = mods.appMod.getApp();
  } catch {
    app = mods.appMod.initializeApp(firebaseConfig);
  }
  auth = mods.authMod.getAuth(app);
  db = mods.dbMod.getDatabase(app);

  if (!auth.currentUser) {
    try {
      await mods.authMod.signInAnonymously(auth);
    } catch (err) {
      if (err?.code === "auth/network-request-failed") fail("offline", OFFLINE_MESSAGE);
      fail("auth", "Anmeldung fehlgeschlagen.");
    }
  }

  const user = auth.currentUser;
  if (!user) fail("auth", "Anmeldung fehlgeschlagen.");
  rememberPlayerId(user.uid);

  if (!unsubInfo) {
    unsubInfo = mods.dbMod.onValue(
      mods.dbMod.ref(db, ".info/connected"),
      (snap) => {
        connected = snap.val() === true;
        emitConnection();
        if (connected && roomCode && uid) {
          attachPresence().catch(() => {});
        }
      }
    );
  }

  return { uid };
}

export function initOnline() {
  if (!initPromise) {
    initPromise = doInit().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

export async function restoreSession() {
  const session = getSession();
  if (!session?.code) return false;
  try {
    await joinRoom(session.code, session.name || "Spieler");
    return true;
  } catch (err) {
    console.error("[online] Sitzung konnte nicht wiederhergestellt werden", err);
    clearSession();
    return false;
  }
}

async function cleanupOldRooms() {
  const cutoff = Date.now() - ROOM_MAX_AGE_MS;
  const { ref, get: fbGet, query, orderByChild, endAt, remove } = fb.dbMod;
  let entries = [];
  try {
    const snap = await fbGet(query(ref(db, "roomIndex"), orderByChild("createdAt"), endAt(cutoff)));
    if (snap.exists()) entries = Object.entries(snap.val());
  } catch {
    try {
      const snap = await fbGet(ref(db, "roomIndex"));
      if (snap.exists()) {
        entries = Object.entries(snap.val()).filter(([, row]) => (row?.createdAt || 0) < cutoff);
      }
    } catch {
      return;
    }
  }

  await Promise.all(
    entries.map(async ([code]) => {
      if (!isValidCode(code)) return;
      try {
        await remove(ref(db, `rooms/${code}`));
        await remove(ref(db, `roomIndex/${code}`));
      } catch {
        /* fremder oder noch gültiger Raum */
      }
    })
  );
}

async function attachPresence() {
  if (!db || !uid || !roomCode) return;
  const { ref, onDisconnect, set: fbSet } = fb.dbMod;
  const onlineRef = ref(db, `rooms/${roomCode}/players/${uid}/online`);
  if (disconnectOp) {
    try {
      await disconnectOp.cancel();
    } catch {
      /* egal */
    }
  }
  disconnectOp = onDisconnect(onlineRef);
  await disconnectOp.set(false);
  await fbSet(onlineRef, true);
}

function emitSecrets(payload) {
  lastSecrets = payload;
  for (const cb of secretListeners) {
    try {
      cb(payload);
    } catch (err) {
      console.error(err);
    }
  }
}

function detachSecretListener() {
  if (unsubSecrets) {
    unsubSecrets();
    unsubSecrets = null;
  }
}

function listenToSecrets(code) {
  detachSecretListener();
  if (!fb?.dbMod || !db || !uid || !code) return;
  const { ref, onValue } = fb.dbMod;
  const asHost = uid === hostId;
  const path = asHost ? `roomSecrets/${code}` : `roomSecrets/${code}/${uid}`;
  unsubSecrets = onValue(
    ref(db, path),
    (snap) => {
      if (asHost) {
        const all = snap.exists() && typeof snap.val() === "object" && !Array.isArray(snap.val()) ? snap.val() : {};
        emitSecrets({ mine: all[uid] || null, all });
      } else {
        emitSecrets({ mine: snap.val() || null, all: null });
      }
    },
    (err) => {
      console.error("[online] Geheime Daten", err);
    }
  );
}

function detachRoomListeners() {
  if (unsubRoom) {
    unsubRoom();
    unsubRoom = null;
  }
  if (unsubActions) {
    unsubActions();
    unsubActions = null;
  }
  detachSecretListener();
  pendingActions.length = 0;
}

function listenToRoom(code) {
  detachRoomListeners();
  const { ref, onValue, onChildAdded } = fb.dbMod;
  unsubRoom = onValue(ref(db, `rooms/${code}`), (snap) => {
    if (!snap.exists()) {
      hostId = null;
      emitRoom(null);
      if (roomCode === code) {
        roomCode = null;
        gameId = null;
        clearSession();
        detachRoomListeners();
        if (disconnectOp) {
          disconnectOp.cancel().catch(() => {});
          disconnectOp = null;
        }
      }
      return;
    }
    const snapshot = mapRoom(code, snap.val());
    const hostChanged = hostId !== snapshot.hostId;
    hostId = snapshot.hostId;
    if (hostChanged || !unsubSecrets) listenToSecrets(code);
    if (uid && !snapshot.players.some((p) => p.isSelf)) {
      emitRoom({ ...snapshot, status: "kicked" });
      leaveRoom({ kicked: true }).catch(() => {});
      return;
    }
    emitRoom(snapshot);
  });

  unsubActions = onChildAdded(ref(db, `rooms/${code}/actions`), (snap) => {
    const payload = snap.val();
    if (!payload) return;
    const action = { id: snap.key, ...payload, _refPath: snap.ref.toString() };
    deliverAction(action, snap.ref);
  });
}

function deliverAction(action, actionRef) {
  if (!actionListeners.size) {
    pendingActions.push({ action, actionRef });
    if (pendingActions.length > 80) pendingActions.shift();
    return;
  }
  for (const cb of actionListeners) {
    try {
      cb(action);
    } catch (err) {
      console.error(err);
    }
  }
  if (isHost() && actionRef) {
    fb.dbMod.remove(actionRef).catch(() => {});
  }
}

async function writePlayer(code, name, seat, already) {
  const { ref, set: fbSet, update } = fb.dbMod;
  const playerRef = ref(db, `rooms/${code}/players/${uid}`);
  if (already) {
    await update(playerRef, { name, online: true });
  } else {
    await fbSet(playerRef, {
      name,
      online: true,
      seat,
      joinedAt: Date.now(),
    });
  }
  await attachPresence();
}

export async function createRoom(newGameId, hostName, settings = {}) {
  try {
    return await createRoomInner(newGameId, hostName, settings);
  } catch (err) {
    rethrow(err);
  }
}

async function createRoomInner(newGameId, hostName, settings = {}) {
  await initOnline();
  if (!connected && navigator.onLine === false) fail("offline", OFFLINE_MESSAGE);
  await leaveRoom({ switching: true });
  await cleanupOldRooms();

  const name = normalizeName(hostName);
  const id = String(newGameId || "game");
  const { ref, get: fbGet, set: fbSet } = fb.dbMod;

  let code = "";
  for (let i = 0; i < 16; i += 1) {
    const candidate = randomCode();
    const existing = await fbGet(ref(db, `rooms/${candidate}/meta`));
    if (!existing.exists()) {
      code = candidate;
      break;
    }
  }
  if (!code) fail("busy", "Kein freier Raumcode. Bitte nochmal versuchen.");

  const createdAt = Date.now();
  await fbSet(ref(db, `rooms/${code}`), {
    meta: {
      gameId: id,
      hostId: uid,
      createdAt,
      status: "lobby",
      settings: jsonSafe(settings && typeof settings === "object" ? settings : {}),
    },
    players: {
      [uid]: {
        name,
        online: true,
        seat: 0,
        joinedAt: createdAt,
      },
    },
  });
  await fbSet(ref(db, `roomIndex/${code}`), {
    createdAt,
    hostId: uid,
    gameId: id,
  });

  roomCode = code;
  gameId = id;
  hostId = uid;
  saveSession(code, name, id);
  listenToRoom(code);
  listenToSecrets(code);
  await attachPresence();
  return code;
}

export async function joinRoom(code, name, options = {}) {
  try {
    await initOnline();
    const normalized = normalizeRoomCode(code);
    if (!isValidCode(normalized)) fail("bad-code", "Ungültiger Raumcode.");
    const playerName = normalizeName(name);

    if (roomCode && roomCode !== normalized) {
      await leaveRoom({ switching: true });
    }

    const { ref, get: fbGet } = fb.dbMod;
    const snap = await fbGet(ref(db, `rooms/${normalized}`));
    if (!snap.exists()) fail("not-found", "Raum nicht gefunden.");
    const data = snap.val();
    const meta = data.meta || {};
    if (meta.status === "closed") fail("closed", "Der Raum ist geschlossen.");

    const players = data.players && typeof data.players === "object" ? data.players : {};
    const already = players[uid];
    const maxPlayers = Number(options.maxPlayers);
    if (!already && Number.isFinite(maxPlayers) && maxPlayers > 0 && Object.keys(players).length >= maxPlayers) {
      fail("full", "Raum ist voll");
    }
    const seats = Object.values(players).map((p) => Number(p?.seat) || 0);
    const seat = already && Number.isFinite(already.seat) ? already.seat : (seats.length ? Math.max(...seats) + 1 : 0);

    await writePlayer(normalized, playerName, seat, already);
    roomCode = normalized;
    gameId = meta.gameId || null;
    hostId = meta.hostId || null;
    saveSession(normalized, playerName, gameId);
    listenToRoom(normalized);
    listenToSecrets(normalized);
    return normalized;
  } catch (err) {
    rethrow(err);
  }
}

async function cancelPresence() {
  if (!disconnectOp) return;
  try {
    await disconnectOp.cancel();
  } catch {
    /* offline */
  }
  disconnectOp = null;
}

function clearLocalRoom({ keepSession = false } = {}) {
  roomCode = null;
  gameId = null;
  hostId = null;
  lastSnapshot = null;
  lastSecrets = null;
  if (!keepSession) clearSession();
}

async function deleteRoomData(code) {
  if (!code || !fb?.dbMod || !db) return;
  const { ref, remove } = fb.dbMod;
  await remove(ref(db, `roomSecrets/${code}`));
  await remove(ref(db, `rooms/${code}`));
  await remove(ref(db, `roomIndex/${code}`));
}

/** Host beendet den Raum für alle. Sitzung wird gelöscht, niemand tritt automatisch wieder bei. */
export async function closeRoom() {
  try {
    await initOnline();
    const code = roomCode;
    if (!code) {
      clearLocalRoom();
      return;
    }
    if (!isHost()) fail("not-host", "Nur der Host kann den Raum schließen.");
    const { ref, update } = fb.dbMod;
    try {
      await update(ref(db, `rooms/${code}/meta`), { status: "closed" });
    } catch (err) {
      console.error("[online] Status closed", err);
    }
    detachRoomListeners();
    await cancelPresence();
    try {
      await deleteRoomData(code);
    } catch (err) {
      console.error("[online] Raum löschen", err);
    }
    clearLocalRoom();
    emitRoom({
      code,
      gameId: null,
      hostId: uid,
      status: "closed",
      settings: {},
      createdAt: 0,
      state: null,
      players: [],
      you: { id: uid, name: "", isHost: true },
    });
  } catch (err) {
    rethrow(err);
  }
}

export async function leaveRoom(options = {}) {
  const code = roomCode;
  const wasHost = isHost();
  const kicked = options.kicked === true;
  const switching = options.switching === true;
  const asPlayer = options.asPlayer === true;

  if (wasHost && !kicked && !switching && !asPlayer) {
    return closeRoom();
  }

  detachRoomListeners();
  await cancelPresence();

  if (code && uid && fb?.dbMod && db && !kicked) {
    const { ref, remove } = fb.dbMod;
    try {
      await remove(ref(db, `rooms/${code}/players/${uid}`));
    } catch {
      /* Raum kann schon weg sein */
    }
  }

  clearLocalRoom({ keepSession: switching });
}

/**
 * Mitspieler verlässt ein laufendes Spiel: zuerst den Host benachrichtigen, dann austreten.
 * Der Host schließt den Raum über closeRoom().
 */
export async function leavePlay() {
  try {
    await initOnline();
    if (isHost()) return closeRoom();
    const name = lastSnapshot?.you?.name || lastSnapshot?.players?.find((row) => row.isSelf)?.name || "Spieler";
    try {
      await sendAction({ type: "leave", payload: { name } });
    } catch (err) {
      console.error("[online] Verlassen melden", err);
    }
    return leaveRoom({ asPlayer: true });
  } catch (err) {
    rethrow(err);
  }
}

export function roomExitMessage(snapshot) {
  if (snapshot?.status === "kicked") return "Du wurdest entfernt.";
  return "Der Host hat den Raum geschlossen";
}

export function isRoomGone(snapshot) {
  return !snapshot || snapshot.status === "kicked" || snapshot.status === "closed";
}

/** Mitspieler, die seit dem letzten Stand fehlen (nicht man selbst). */
export function playersWhoLeft(prev, next) {
  if (!prev?.players || !next?.players) return [];
  return prev.players.filter((player) => !player.isSelf && !next.players.some((row) => row.id === player.id));
}

export function onRoomChange(callback) {
  roomListeners.add(callback);
  if (lastSnapshot !== null || roomCode) callback(lastSnapshot);
  return () => roomListeners.delete(callback);
}

export function onAction(callback) {
  actionListeners.add(callback);
  if (pendingActions.length) {
    const queued = pendingActions.splice(0, pendingActions.length);
    for (const item of queued) deliverAction(item.action, item.actionRef);
  }
  return () => actionListeners.delete(callback);
}

export function onConnectionChange(callback) {
  connectionListeners.add(callback);
  callback(connected);
  return () => connectionListeners.delete(callback);
}

/**
 * Geheime Daten: Mitspieler hören nur den eigenen Pfad, der Host alle.
 * callback({ mine, all }) – all ist nur beim Host gesetzt.
 */
export function onSecrets(callback) {
  secretListeners.add(callback);
  if (lastSecrets !== null) callback(lastSecrets);
  return () => secretListeners.delete(callback);
}

export async function writeAllSecrets(map) {
  try {
    await initOnline();
    if (!roomCode) fail("no-room", "Kein Raum.");
    if (!isHost()) fail("not-host", "Nur der Host schreibt geheime Daten.");
    const { ref, set: fbSet } = fb.dbMod;
    await fbSet(ref(db, `roomSecrets/${roomCode}`), jsonSafe(map && typeof map === "object" ? map : {}));
  } catch (err) {
    rethrow(err);
  }
}

export async function writePlayerSecret(playerId, data) {
  try {
    await initOnline();
    if (!roomCode) fail("no-room", "Kein Raum.");
    if (!isHost()) fail("not-host", "Nur der Host schreibt geheime Daten.");
    if (!playerId) fail("bad-player", "Kein Spieler.");
    const { ref, set: fbSet } = fb.dbMod;
    await fbSet(ref(db, `roomSecrets/${roomCode}/${playerId}`), jsonSafe(data ?? null));
  } catch (err) {
    rethrow(err);
  }
}

export async function addDummyPlayer(displayName) {
  try {
    await initOnline();
    if (!roomCode) fail("no-room", "Kein Raum.");
    if (!isHost()) fail("not-host", "Nur der Host kann Testspieler anlegen.");
    const { ref, get: fbGet, set: fbSet } = fb.dbMod;
    const snap = await fbGet(ref(db, `rooms/${roomCode}/players`));
    const players = snap.exists() && typeof snap.val() === "object" ? snap.val() : {};
    const seats = Object.values(players).map((row) => Number(row?.seat) || 0);
    const seat = seats.length ? Math.max(...seats) + 1 : 0;
    const id = `sim-${randomCode()}${randomCode()}`.slice(0, 16);
    await fbSet(ref(db, `rooms/${roomCode}/players/${id}`), {
      name: normalizeName(displayName),
      online: true,
      seat,
      joinedAt: Date.now(),
      dummy: true,
    });
    return id;
  } catch (err) {
    rethrow(err);
  }
}

export async function setState(state) {
  try {
    await initOnline();
    if (!roomCode) fail("no-room", "Kein Raum.");
    if (!isHost()) fail("not-host", "Nur der Host schreibt den Spielzustand.");
    const { ref, set: fbSet } = fb.dbMod;
    await fbSet(ref(db, `rooms/${roomCode}/state`), jsonSafe(state ?? null));
  } catch (err) {
    rethrow(err);
  }
}

export async function updateSettings(settings) {
  try {
    await initOnline();
    if (!roomCode) fail("no-room", "Kein Raum.");
    if (!isHost()) fail("not-host", "Nur der Host ändert die Einstellungen.");
    const { ref, update } = fb.dbMod;
    await update(ref(db, `rooms/${roomCode}/meta`), { settings: jsonSafe(settings || {}) });
  } catch (err) {
    rethrow(err);
  }
}

export async function sendAction(action) {
  try {
    await initOnline();
    if (!roomCode || !uid) fail("no-room", "Kein Raum.");
    const { ref, push } = fb.dbMod;
    await push(ref(db, `rooms/${roomCode}/actions`), {
      from: uid,
      type: action?.type || "action",
      payload: action?.payload ?? action ?? null,
      at: Date.now(),
    });
  } catch (err) {
    rethrow(err);
  }
}

export async function startGame() {
  try {
    await initOnline();
    if (!roomCode) fail("no-room", "Kein Raum.");
    if (!isHost()) fail("not-host", "Nur der Host kann das Spiel starten.");
    const { ref, update } = fb.dbMod;
    await update(ref(db, `rooms/${roomCode}/meta`), { status: "playing" });
  } catch (err) {
    rethrow(err);
  }
}

export async function kickPlayer(playerId) {
  try {
    await initOnline();
    if (!isHost()) fail("not-host", "Nur der Host kann Spieler entfernen.");
    if (!playerId || playerId === uid) return;
    const { ref, remove } = fb.dbMod;
    await remove(ref(db, `rooms/${roomCode}/players/${playerId}`));
    try {
      await remove(ref(db, `roomSecrets/${roomCode}/${playerId}`));
    } catch {
      /* noch keine Geheimnisse */
    }
  } catch (err) {
    rethrow(err);
  }
}

export async function setPlayerOrder(ids) {
  try {
    await initOnline();
    if (!isHost()) fail("not-host", "Nur der Host ändert die Reihenfolge.");
    const { ref, set: fbSet } = fb.dbMod;
    await Promise.all(
      ids.map((id, seat) => fbSet(ref(db, `rooms/${roomCode}/players/${id}/seat`), seat))
    );
  } catch (err) {
    rethrow(err);
  }
}

export function joinUrl(code) {
  const url = new URL(location.href);
  url.searchParams.set("join", normalizeRoomCode(code) || code);
  url.hash = "";
  return url.toString();
}

export function joinCodeFromUrl() {
  try {
    return normalizeRoomCode(new URL(location.href).searchParams.get("join"));
  } catch {
    return "";
  }
}

export function mountConnectionBadge(target) {
  const el = typeof target === "string" ? document.querySelector(target) : target;
  if (!el) return () => {};
  el.classList.add("net-status");
  const paint = (ok) => {
    el.textContent = ok ? "Verbunden" : "Keine Verbindung";
    el.classList.toggle("is-on", ok);
    el.classList.toggle("is-off", !ok);
  };
  paint(connected);
  return onConnectionChange(paint);
}
