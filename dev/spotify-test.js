import { mountLobby } from "../shared/lobby.js";
import { isMuted, mountMuteButton } from "../shared/mute-button.js";
import {
  getRoomCode,
  isHost,
  leaveRoom,
  mountConnectionBadge,
  onAction,
  onRoomChange,
  sendAction,
  setState,
  updateSelfPlayer,
} from "../shared/online.js";
import {
  clearDiagnoseLog,
  completeLoginIfRedirected,
  explainError,
  formatDiagnoseLine,
  getDevices,
  getPreferredDeviceId,
  getStoredSession,
  isConfigured,
  login,
  logout,
  onDiagnose,
  parsePlaylistInput,
  parseTrackInput,
  pause,
  play,
  playViaPlaylist,
  playViaQueue,
  logDiagnose,
  redirectUri,
  resume,
  setPreferredDeviceId,
  TEST_TRACK_URI,
} from "../shared/spotify.js";

const app = document.getElementById("app");
const NO_DEVICE_HINT =
  "Öffne Spotify, starte kurz einen Song und pausiere ihn, dann aktualisieren.";
const PICK_DEVICE_HINT = "Bitte Gerät auswählen";
const SAME_ACCOUNT_HINT =
  "Ein Spotify-Konto kann nur auf einem Gerät gleichzeitig abspielen";
const END_MARGIN_MS = 2000;

let session = getStoredSession();
let devices = [];
let deviceId = getPreferredDeviceId();
let clipSec = 30;
let muted = isMuted();
let lastCueId = "";
let countdownTimer = 0;
let countdownUntil = 0;
let lobby = null;
let room = null;
let muteControl = null;
let unsubDiagnose = null;
const unsubs = [];
let bootError = "";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function showError(node, err, context) {
  const message = explainError(err);
  console.error(`[spotify-test] ${context}`, err);
  if (!node) return;
  node.hidden = false;
  node.className = "note is-bad";
  const bits = [message];
  if (err?.status) bits.push(`HTTP ${err.status}`);
  if (err?.reason) bits.push(err.reason);
  node.textContent = bits.join(" · ");
}

function showNote(node, text, bad = false) {
  if (!node) return;
  node.hidden = !text;
  node.className = bad ? "note is-bad" : "note";
  node.textContent = text || "";
}

function clearUnsubs() {
  while (unsubs.length) unsubs.pop()();
}

function selectedDeviceId() {
  return deviceId || devices.find((row) => row.active)?.id || devices[0]?.id || "";
}

function trackFromInput() {
  const input = app.querySelector("[name=track]");
  return parseTrackInput(input?.value || "");
}

function paintTrackPreview() {
  const node = app.querySelector("[data-track-preview]");
  const input = app.querySelector("[name=track]");
  if (!node || !input) return;
  if (!input.value.trim()) {
    showNote(node, "");
    return;
  }
  const { uri, error } = parseTrackInput(input.value);
  showNote(node, uri ? `Wird gesendet als: ${uri}` : error, !uri);
}

async function resumeHere() {
  const hint = app.querySelector("[data-local-hint]");
  const id = selectedDeviceId();
  if (!id) {
    showNote(hint, NO_DEVICE_HINT, true);
    return;
  }
  stopCountdown();
  try {
    const state = await resume(id);
    showNote(
      hint,
      state?.isPlaying ? "Fortsetzen klappt – das Handy spielt." : "Fortsetzen angenommen, aber es läuft nichts.",
      !state?.isPlaying
    );
  } catch (err) {
    showError(hint, err, "Fortsetzen");
  }
}

function paintPlaylistPreview() {
  const node = app.querySelector("[data-playlist-preview]");
  const input = app.querySelector("[name=playlist]");
  if (!node || !input) return;
  if (!input.value.trim()) {
    showNote(node, "");
    return;
  }
  const { uri, error } = parsePlaylistInput(input.value);
  showNote(node, uri ? `Wird gesendet als: ${uri}` : error, !uri);
}

function selectedDevice() {
  const id = selectedDeviceId();
  return devices.find((row) => row.id === id) || null;
}

function paintSelectedDevice() {
  const node = app.querySelector("[data-plays-on]");
  if (!node) return;
  const device = selectedDevice();
  if (device) {
    node.hidden = false;
    node.className = "note spotify-plays-on";
    node.textContent = `Spielt auf: ${device.name}`;
    return;
  }
  if (devices.length) {
    node.hidden = false;
    node.className = "note is-bad spotify-plays-on";
    node.textContent = PICK_DEVICE_HINT;
    return;
  }
  node.hidden = true;
  node.textContent = "";
}

/** Gerät wählen: gespeichert / aktiv / bei genau einem Gerät automatisch. */
function pickDeviceId(list = devices) {
  if (list.length === 1) return list[0].id;
  const preferred = getPreferredDeviceId();
  if (preferred && list.some((row) => row.id === preferred)) return preferred;
  if (deviceId && list.some((row) => row.id === deviceId)) return deviceId;
  return list.find((row) => row.active)?.id || list[0]?.id || "";
}

/**
 * Für Abspielen: falls nötig Geräte neu laden.
 * Bei genau einem Gerät automatisch nehmen, sonst „Bitte Gerät auswählen“.
 */
async function ensurePlayDevice({ reloadIfMissing = true } = {}) {
  const hint = app.querySelector("[data-local-hint]");
  let id = selectedDeviceId();
  if (id && devices.some((row) => row.id === id)) return id;
  if (!reloadIfMissing) {
    showNote(hint, devices.length ? PICK_DEVICE_HINT : NO_DEVICE_HINT, true);
    paintSelectedDevice();
    return "";
  }
  await refreshDevices();
  id = selectedDeviceId();
  if (id && devices.some((row) => row.id === id)) return id;
  showNote(hint, devices.length ? PICK_DEVICE_HINT : NO_DEVICE_HINT, true);
  paintSelectedDevice();
  return "";
}

/** Gemeinsamer Start: Lag, Hinweis, Countdown – für play / Warteschlange / Playlist. */
async function startHere(runner, clip, sentAt) {
  muted = isMuted();
  const lagNode = app.querySelector("[data-lag]");
  const hint = app.querySelector("[data-local-hint]");
  if (muted) {
    stopCountdown();
    if (lagNode) lagNode.textContent = "Stumm – nicht abgespielt";
    showNote(hint, "Dieses Gerät ist stumm.");
    logDiagnose("Abspiel gestoppt: dieses Gerät ist stumm");
    return;
  }
  const id = await ensurePlayDevice({ reloadIfMissing: true });
  if (!id) {
    if (lagNode) lagNode.textContent = "";
    logDiagnose(`Abspiel gestoppt: kein Gerät gewählt (${devices.length} in der Liste)`);
    return;
  }
  const device = devices.find((row) => row.id === id);
  logDiagnose(
    `Abspiel startet lokal · Gerät=${device?.name || id} · eigenes Token · ${isHost() ? "Host" : "Mitspieler"}`
  );
  const t0 = Number(sentAt) || Date.now();
  if (lagNode) lagNode.textContent = "Starte …";
  try {
    const result = await runner(id);
    const lag = (result?.acceptedAt || Date.now()) - t0;
    if (lagNode) {
      lagNode.textContent = `Abspielen bestätigt nach ${lag} ms${result?.retried ? " (nach Wiederholung)" : ""}`;
    }
    showNote(hint, "");
    startCountdown(clip, result?.state);
  } catch (err) {
    if (lagNode) lagNode.textContent = "";
    logDiagnose(`Abspiel fehlgeschlagen: ${explainError(err)}`);
    showError(hint, err, "Abspielen");
  }
}

function sameSpotifyAccounts(players) {
  const counts = new Map();
  for (const player of players || []) {
    const key = player.spotifyUserId || "";
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.values()].some((n) => n > 1);
}

function paintSameAccountWarning(node, players) {
  if (!node) return;
  if (sameSpotifyAccounts(players)) {
    showNote(node, SAME_ACCOUNT_HINT, true);
  } else {
    showNote(node, "");
  }
}

async function publishSpotifyToRoom() {
  if (!getRoomCode() || !session) return;
  try {
    await updateSelfPlayer({
      spotifyName: session.displayName || "",
      spotifyUserId: session.userId || "",
    });
  } catch (err) {
    console.error("[spotify-test] Spotify-Name teilen", err);
  }
}

/** Restzeit bis kurz vor Songende (ms) oder 0, wenn die Länge unbekannt ist. */
function msUntilSongEnd(state) {
  if (!state?.durationMs) return 0;
  const elapsed = Date.now() - (state.checkedAt || Date.now());
  return Math.max(1000, state.durationMs - state.progressMs - elapsed - END_MARGIN_MS);
}

function paintDiagnose(rows) {
  const pre = app.querySelector("[data-diagnose]");
  if (!pre) return;
  if (!rows?.length) {
    pre.textContent = "Noch keine Spotify-Aufrufe.";
    return;
  }
  pre.textContent = rows.map(formatDiagnoseLine).join("\n");
}

function stopCountdown() {
  window.clearInterval(countdownTimer);
  countdownTimer = 0;
  countdownUntil = 0;
  const node = app.querySelector("[data-countdown]");
  if (node) node.textContent = "";
}

function startCountdown(seconds, state) {
  stopCountdown();
  const node = app.querySelector("[data-countdown]");
  const clipMs = seconds ? seconds * 1000 : Infinity;
  const endMs = msUntilSongEnd(state) || Infinity;
  const waitMs = Math.min(clipMs, endMs);
  if (waitMs === Infinity) {
    if (node) node.textContent = "Ganzer Song – Länge unbekannt, kein automatisches Pause.";
    return;
  }
  const beforeEnd = endMs <= clipMs;
  const doneText = beforeEnd ? "Automatisch pausiert (kurz vor Songende)." : `Automatisch pausiert (${seconds} Sekunden).`;
  countdownUntil = Date.now() + waitMs;
  let pausing = false;
  const tick = async () => {
    const left = Math.max(0, Math.ceil((countdownUntil - Date.now()) / 1000));
    const label = app.querySelector("[data-countdown]");
    if (label) {
      label.textContent = left ? `${beforeEnd ? "Pause vor Songende" : "Pause"} in ${left}s` : "Pausiere …";
    }
    if (left > 0 || pausing) return;
    pausing = true;
    window.clearInterval(countdownTimer);
    countdownTimer = 0;
    if (muted) {
      if (label) label.textContent = "Stumm – kein Pause nötig";
      return;
    }
    const id = selectedDeviceId();
    try {
      await pause(id);
      if (label) label.textContent = "Pausiert";
      const hint = app.querySelector("[data-local-hint]");
      showNote(hint, doneText);
    } catch (err) {
      if (label) label.textContent = "Pause fehlgeschlagen";
      const hint = app.querySelector("[data-local-hint]");
      if (hint) showError(hint, err, "Pause");
    }
  };
  countdownTimer = window.setInterval(tick, 250);
  tick();
}

async function pauseHere() {
  stopCountdown();
  const id = selectedDeviceId();
  if (!id) return;
  try {
    await pause(id);
  } catch (err) {
    const hint = app.querySelector("[data-local-hint]");
    if (hint) showError(hint, err, "Stumm-Pause");
  }
}

async function playHere(trackUri, startMs, clip, sentAt) {
  await startHere((id) => play(trackUri, id, startMs), clip, sentAt);
}

async function playQueueHere(trackUri, clip, sentAt) {
  await startHere((id) => playViaQueue(trackUri, id), clip, sentAt);
}

async function playPlaylistHere(playlistInput, target, clip, sentAt) {
  await startHere((id) => playViaPlaylist(playlistInput, target, id), clip, sentAt);
}

/**
 * Standardweg aus den Feldern lesen: Playlist + Song-ID (falls Song-Link da), sonst Position.
 * @returns {{ playlistUri: string, trackUri: string, position: number, error: string }}
 */
function playlistTargetFromInputs({ forceMode = "" } = {}) {
  const playlist = parsePlaylistInput(app.querySelector("[name=playlist]")?.value || "");
  if (!playlist.uri) return { playlistUri: "", trackUri: "", position: 0, error: playlist.error };
  const position = Math.max(0, Math.floor(Number(app.querySelector("[name=playlist-offset]")?.value) || 0));
  const trackRaw = app.querySelector("[name=track]")?.value || "";
  const useTrack = forceMode === "track" || (forceMode !== "position" && trackRaw.trim());
  if (!useTrack) return { playlistUri: playlist.uri, trackUri: "", position, error: "" };
  const track = parseTrackInput(trackRaw);
  if (!track.uri) return { playlistUri: "", trackUri: "", position: 0, error: track.error };
  return { playlistUri: playlist.uri, trackUri: track.uri, position: 0, error: "" };
}

function cueTarget(cue) {
  return cue.trackUri ? { trackUri: cue.trackUri } : { position: Number(cue.position) || 0 };
}

/** Nur Playlist + Song/Position – nie Geräte-ID oder Token. */
function sanitizeCue(raw) {
  if (!raw || typeof raw !== "object") return null;
  const playlistUri = typeof raw.playlistUri === "string" ? raw.playlistUri : "";
  const trackUri = typeof raw.trackUri === "string" ? raw.trackUri : "";
  if (!playlistUri && !trackUri) return null;
  const sentAt = Number(raw.sentAt) || Date.now();
  const cueId =
    typeof raw.cueId === "string" && raw.cueId
      ? raw.cueId
      : `${sentAt}-${Number(raw.seq) || 0}`;
  return {
    cueId,
    playlistUri,
    trackUri,
    position: Math.max(0, Math.floor(Number(raw.position) || 0)),
    clipSec: Math.max(0, Math.floor(Number(raw.clipSec) || 0)),
    sentAt,
  };
}

function formatCueStamp(ms) {
  return new Date(ms).toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

async function refreshDevices() {
  const hint = app.querySelector("[data-device-hint]");
  const box = app.querySelector("[data-devices]");
  if (!session) return;
  try {
    devices = await getDevices();
    deviceId = pickDeviceId(devices);
    if (deviceId) setPreferredDeviceId(deviceId);
    paintDevices(box);
    paintSelectedDevice();
    if (!devices.length) showNote(hint, NO_DEVICE_HINT, true);
    else if (!deviceId) showNote(hint, PICK_DEVICE_HINT, true);
    else showNote(hint, "");
  } catch (err) {
    devices = [];
    deviceId = "";
    paintDevices(box);
    paintSelectedDevice();
    showError(hint, err, "Geräte");
  }
}

function paintDevices(box) {
  if (!box) return;
  box.innerHTML = "";
  if (!devices.length) {
    box.append(el("p", "lead", "Keine Geräte."));
    paintSelectedDevice();
    return;
  }
  for (const device of devices) {
    const row = el("label", "switch-row");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "device";
    radio.value = device.id;
    radio.checked = device.id === deviceId;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      deviceId = device.id;
      setPreferredDeviceId(device.id);
      paintSelectedDevice();
      const hint = app.querySelector("[data-device-hint]");
      showNote(hint, "");
    });
    const meta = [device.type, device.active ? "aktiv" : "", device.restricted ? "eingeschränkt" : ""]
      .filter(Boolean)
      .join(" · ");
    row.append(radio, el("span", "", `${device.name}${meta ? ` (${meta})` : ""}`));
    box.append(row);
  }
  paintSelectedDevice();
}

/**
 * Befehl auf diesem Gerät ausführen (Host und Mitspieler gleich).
 * Nutzt nur das lokale Spotify-Token und die lokal gewählte Geräte-ID.
 */
async function applyCue(raw, source) {
  const cue = sanitizeCue(raw);
  if (!cue) {
    logDiagnose(`Befehl ignoriert (ungültig) · Quelle=${source}`);
    return;
  }
  if (cue.cueId === lastCueId) {
    logDiagnose(`Befehl schon verarbeitet · cueId=${cue.cueId} · Quelle=${source}`);
    return;
  }
  lastCueId = cue.cueId;

  const songBit = cue.trackUri
    ? `Song-ID=${cue.trackUri}`
    : `Position=${cue.position}`;
  logDiagnose(
    `Befehl vom Host empfangen · Playlist=${cue.playlistUri || "–"} · ${songBit} · Zeit=${formatCueStamp(
      cue.sentAt
    )} · cueId=${cue.cueId} · Quelle=${source}`
  );

  if (cue.playlistUri) {
    await playPlaylistHere(cue.playlistUri, cueTarget(cue), cue.clipSec, cue.sentAt);
  } else {
    await playHere(cue.trackUri, 0, cue.clipSec, cue.sentAt);
  }
}

async function playAll() {
  const hint = app.querySelector("[data-local-hint]");
  const target = playlistTargetFromInputs();
  if (target.error) {
    showNote(hint, target.error, true);
    return;
  }
  if (!room) {
    showNote(hint, "Kein Raum – zuerst Lobby starten.", true);
    return;
  }
  const sentAt = Date.now();
  const cue = {
    cueId: `${sentAt}-${Math.random().toString(36).slice(2, 9)}`,
    playlistUri: target.playlistUri,
    trackUri: target.trackUri || "",
    position: target.trackUri ? 0 : target.position,
    sentAt,
    clipSec,
  };
  const songBit = cue.trackUri ? `Song-ID=${cue.trackUri}` : `Position=${cue.position}`;
  logDiagnose(
    `Sende Befehl an alle · Playlist=${cue.playlistUri} · ${songBit} · Zeit=${formatCueStamp(
      sentAt
    )} · cueId=${cue.cueId} (ohne Geräte-ID, ohne Token)`
  );
  try {
    // Zuerst Zustand + Action, dann lokal abspielen – Mitspieler sollen nicht auf den Host warten.
    await setState({ cue });
    await sendAction({ type: "play-all", payload: cue });
  } catch (err) {
    showError(hint, err, "An alle senden");
    logDiagnose(`Senden fehlgeschlagen: ${explainError(err)}`);
    return;
  }
  // Host spielt über dieselbe Logik wie Mitspieler (Dedup verhindert Doppelstart über state/action).
  await applyCue(cue, "host-lokal");
}

function appendDiagnose(parent) {
  parent.append(el("h2", "lobby-list-title", "Diagnose"));
  const tools = el("div", "btn-row");
  const clear = el("button", "btn", "Diagnose leeren");
  clear.type = "button";
  clear.addEventListener("click", () => clearDiagnoseLog());
  tools.append(clear);
  parent.append(tools);
  const pre = el("pre", "play-log spotify-diagnose");
  pre.setAttribute("data-diagnose", "1");
  parent.append(pre);
}

function showLobby() {
  const slot = app.querySelector("[data-online]");
  if (!slot) return;
  clearUnsubs();
  room = null;
  lobby?.destroy();
  lobby = mountLobby(slot, {
    gameId: "spotify-test",
    title: "Mehrere Handys",
    lead: "Raum erstellen, auf dem zweiten Handy beitreten, dann starten.",
    minPlayers: 1,
    renderRoomExtra(container, { room: next }) {
      container.innerHTML = "";
      const warn = el("p", "note is-bad");
      paintSameAccountWarning(warn, next?.players);
      if (!warn.hidden) container.append(warn);
      publishSpotifyToRoom();
    },
    async onBeforeStart() {
      lastCueId = "";
      await setState({});
    },
    onStart(next) {
      queueMicrotask(() => {
        lobby.destroy();
        lobby = null;
        showRoomPlay(next);
      });
    },
    onLeave() {
      /* Slot bleibt die Lobby. */
    },
  });
}

function showRoomPlay(initial) {
  const slot = app.querySelector("[data-online]");
  if (!slot) return;
  clearUnsubs();
  room = initial;
  lastCueId = "";
  slot.innerHTML = "";
  slot.classList.add("spotify-online-flat");

  const panel = el("div", "spotify-online-panel");
  const top = el("div", "lobby-top");
  top.append(el("p", "lobby-kicker", "Mehrere Handys"));
  const badge = el("div");
  unsubs.push(mountConnectionBadge(badge));
  top.append(badge);
  panel.append(top);
  panel.append(el("h2", "", "Gemeinsam abspielen"));
  const status = el("p", "lead");
  const list = el("ul", "lobby-players");
  const accountWarn = el("p", "note is-bad");
  accountWarn.hidden = true;
  panel.append(status, list, accountWarn);
  panel.append(
    el(
      "p",
      "note",
      "Der Host schickt Playlist-ID plus Song-ID (oder Position). Jedes Handy startet den Song auf seinem eigenen Spotify-Gerät."
    )
  );
  publishSpotifyToRoom();

  const actions = el("div", "btn-row");
  if (isHost()) {
    const all = el("button", "btn primary", "Für alle abspielen");
    all.type = "button";
    all.addEventListener("click", async () => {
      all.disabled = true;
      try {
        await playAll();
      } finally {
        all.disabled = false;
      }
    });
    actions.append(all);
  } else {
    panel.append(el("p", "lead", "Warten auf den Host …"));
  }
  const back = el("button", "btn", "Zurück zur Lobby");
  back.type = "button";
  back.addEventListener("click", async () => {
    try {
      await leaveRoom();
    } catch (err) {
      console.error("[spotify-test] Lobby", err);
    }
    showLobby();
  });
  actions.append(back);
  panel.append(actions);
  slot.append(panel);

  function paint(next) {
    if (!next) {
      showLobby();
      return;
    }
    room = next;
    status.textContent = `Raum ${next.code} · ${next.you.isHost ? "Du bist Host" : "Du bist Mitspieler"}`;
    list.innerHTML = "";
    for (const player of next.players) {
      const item = el("li", "lobby-player");
      const dot = el("span", `lobby-dot${player.online ? " is-on" : ""}`);
      const info = el("div", "lobby-player-info");
      info.append(el("span", "lobby-player-name", player.name));
      const tags = [];
      if (player.isSelf) tags.push("Du");
      if (player.isHost) tags.push("Host");
      if (player.spotifyName) tags.push(player.spotifyName);
      if (!player.online) tags.push("offline");
      info.append(el("span", "lobby-player-meta", tags.join(" · ")));
      item.append(dot, info);
      list.append(item);
    }
    paintSameAccountWarning(accountWarn, next.players);
    if (next.state?.cue) applyCue(next.state.cue, "raum-zustand");
  }

  paint(initial);
  unsubs.push(onRoomChange((next) => paint(next)));
  unsubs.push(
    onAction((action) => {
      if (action.type !== "play-all") return;
      // Jedes Gerät (auch Mitspieler) – keine Host-Prüfung.
      applyCue(action.payload, "action");
    })
  );
  logDiagnose(
    `Raum bereit · ${isHost() ? "Host" : "Mitspieler"} · lauscht auf „play-all“ · Spotify=${
      session?.displayName || "–"
    }`
  );
}

function render() {
  const keepTrack = app.querySelector("[name=track]")?.value || "";
  const keepPlaylist = app.querySelector("[name=playlist]")?.value || "";
  const keepOffset = app.querySelector("[name=playlist-offset]")?.value || "0";
  const keepClip = clipSec;
  lobby?.destroy();
  lobby = null;
  muteControl?.destroy();
  muteControl = null;
  clearUnsubs();
  room = null;
  app.innerHTML = "";

  const screen = el("div", "screen spotify-page");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  screen.append(body, dock);
  app.append(screen);

  const top = el("div", "lobby-top");
  top.append(el("p", "lobby-kicker", "Techniktest"));
  const tools = el("div", "lobby-top-tools");
  muteControl = mountMuteButton(tools, {
    onChange(next) {
      muted = next;
    },
    onMute: pauseHere,
  });
  muted = isMuted();
  top.append(tools);
  body.append(top);

  body.append(el("h1", "", "Spotify"));
  body.append(
    el("p", "lead", "Prüfen, ob Songs auf dem Handy starten und stoppen – auch auf mehreren Geräten.")
  );
  body.append(el("p", "note spotify-uri", `Redirect-URI: ${redirectUri()}`));

  const hint = el("p", "note is-bad");
  hint.setAttribute("data-local-hint", "1");
  if (bootError) hint.textContent = bootError;
  else hint.hidden = true;
  body.append(hint);

  if (!isConfigured()) {
    body.append(
      el(
        "p",
        "note is-bad",
        "Client ID fehlt. In shared/spotify-config.js SPOTIFY_CLIENT_ID eintragen und die Redirect-URIs im Spotify Dashboard setzen."
      )
    );
  }

  if (!session) {
    const loginBtn = el("button", "btn primary", "Mit Spotify anmelden");
    loginBtn.type = "button";
    loginBtn.addEventListener("click", async () => {
      loginBtn.disabled = true;
      try {
        await login();
      } catch (err) {
        loginBtn.disabled = false;
        showError(hint, err, "Anmeldung");
      }
    });
    dock.append(loginBtn);
  } else {
    body.append(el("p", "spotify-account", `Spotify-Konto: ${session.displayName}`));
    const out = el("button", "btn", "Abmelden");
    out.type = "button";
    out.addEventListener("click", () => {
      logout();
      session = null;
      devices = [];
      deviceId = "";
      stopCountdown();
      render();
    });
    body.append(out);

    body.append(el("h2", "lobby-list-title", "Gerät"));
    const deviceHint = el("p", "note");
    deviceHint.setAttribute("data-device-hint", "1");
    deviceHint.hidden = true;
    const deviceBox = el("div", "stack");
    deviceBox.setAttribute("data-devices", "1");
    const playsOn = el("p", "note spotify-plays-on");
    playsOn.setAttribute("data-plays-on", "1");
    playsOn.hidden = true;
    body.append(deviceHint, playsOn, deviceBox);
    const refresh = el("button", "btn primary", "Geräte aktualisieren");
    refresh.type = "button";
    refresh.addEventListener("click", () => refreshDevices());
    body.append(refresh);

    body.append(el("h2", "lobby-list-title", "Playlist (Standardweg)"));
    body.append(
      el(
        "p",
        "note",
        "Abspielen läuft über die Playlist: mit Song-Link startet genau dieser Song (muss in der Playlist sein), ohne Song-Link die Position."
      )
    );
    const plLabel = el("label", "lobby-field", "Playlist-Link");
    const plInput = el("input", "text-input");
    plInput.name = "playlist";
    plInput.placeholder = "https://open.spotify.com/playlist/…";
    plInput.autocomplete = "off";
    plInput.spellcheck = false;
    plInput.value = keepPlaylist;
    plInput.addEventListener("input", paintPlaylistPreview);
    plLabel.append(plInput);
    body.append(plLabel);
    const plPreview = el("p", "note spotify-uri");
    plPreview.setAttribute("data-playlist-preview", "1");
    plPreview.hidden = true;
    body.append(plPreview);

    const trackLabel = el("label", "lobby-field", "Song-Link (optional)");
    const track = el("input", "text-input");
    track.name = "track";
    track.placeholder = "https://open.spotify.com/track/…";
    track.autocomplete = "off";
    track.spellcheck = false;
    track.value = keepTrack;
    track.addEventListener("input", paintTrackPreview);
    trackLabel.append(track);
    body.append(trackLabel);
    const preview = el("p", "note spotify-uri");
    preview.setAttribute("data-track-preview", "1");
    preview.hidden = true;
    body.append(preview);

    const offsetLabel = el("label", "lobby-field", "Position in der Playlist (ab 0, nur ohne Song-Link)");
    const offsetInput = el("input", "text-input");
    offsetInput.name = "playlist-offset";
    offsetInput.type = "number";
    offsetInput.min = "0";
    offsetInput.step = "1";
    offsetInput.value = keepOffset;
    offsetLabel.append(offsetInput);
    body.append(offsetLabel);

    body.append(el("h2", "lobby-list-title", "Dauer"));
    const times = el("div", "btn-row");
    for (const [sec, label] of [
      [30, "30 Sekunden"],
      [0, "Ganzer Song"],
    ]) {
      const button = el("button", keepClip === sec ? "btn primary" : "btn", label);
      button.type = "button";
      button.dataset.sec = String(sec);
      button.addEventListener("click", () => {
        clipSec = sec;
        for (const node of times.querySelectorAll("button")) {
          node.className = Number(node.dataset.sec) === clipSec ? "btn primary" : "btn";
        }
      });
      times.append(button);
    }
    body.append(times);

    const lag = el("p", "play-log");
    lag.setAttribute("data-lag", "1");
    const count = el("p", "lead");
    count.setAttribute("data-countdown", "1");
    body.append(lag, count);

    const playBtn = el("button", "btn primary", "Abspielen");
    playBtn.type = "button";
    playBtn.addEventListener("click", async () => {
      const target = playlistTargetFromInputs();
      if (target.error) {
        showNote(hint, target.error, true);
        return;
      }
      playBtn.disabled = true;
      try {
        await playPlaylistHere(target.playlistUri, cueTarget(target), clipSec, Date.now());
      } finally {
        playBtn.disabled = false;
      }
    });
    dock.append(playBtn);

    /** Testknopf, der einen Start-Weg mit den aktuellen Feldern ausführt. */
    const testButton = (label, run) => {
      const button = el("button", "btn", label);
      button.type = "button";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await run();
        } finally {
          button.disabled = false;
        }
      });
      return button;
    };
    const withTrack = (run) => async () => {
      const { uri, error } = trackFromInput();
      if (!uri) {
        showNote(hint, error, true);
        return;
      }
      await run(uri);
    };
    const withPlaylist = (mode) => async () => {
      const target = playlistTargetFromInputs({ forceMode: mode });
      if (target.error) {
        showNote(hint, target.error, true);
        return;
      }
      await playPlaylistHere(target.playlistUri, cueTarget(target), clipSec, Date.now());
    };

    body.append(el("h2", "lobby-list-title", "Tests"));
    const tests = el("div", "btn-row");
    tests.append(
      testButton("Über Playlist (Position)", withPlaylist("position")),
      testButton("Über Playlist (Song-ID)", withPlaylist("track")),
      testButton("Fortsetzen (ohne Track)", resumeHere),
      testButton("Direkt (uris)", withTrack((uri) => playHere(uri, 0, clipSec, Date.now()))),
      testButton("Über Warteschlange", withTrack((uri) => playQueueHere(uri, clipSec, Date.now()))),
      testButton("Test-Track (uris)", () => playHere(TEST_TRACK_URI, 0, clipSec, Date.now()))
    );
    body.append(tests);
  }

  appendDiagnose(body);

  body.append(el("hr", "spotify-rule"));
  const online = el("div", "spotify-online");
  online.setAttribute("data-online", "1");
  body.append(online);

  const hub = el("a", "btn", "Zur Übersicht");
  hub.href = "../index.html";
  dock.append(hub);

  clipSec = keepClip;
  muted = isMuted();
  showLobby();
  paintTrackPreview();
  paintPlaylistPreview();
  if (session) refreshDevices();
}

unsubDiagnose = onDiagnose(paintDiagnose);

completeLoginIfRedirected()
  .then((ok) => {
    if (ok) session = getStoredSession();
  })
  .catch((err) => {
    bootError = explainError(err);
    console.error("[spotify-test] Redirect", err);
  })
  .finally(() => {
    session = getStoredSession();
    render();
  });
