import { mountLobby } from "../shared/lobby.js";
import { isMuted, mountMuteButton } from "../shared/mute-button.js";
import {
  isHost,
  leaveRoom,
  mountConnectionBadge,
  onAction,
  onRoomChange,
  sendAction,
  setState,
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
  parseTrackUri,
  pause,
  play,
  redirectUri,
  setPreferredDeviceId,
} from "../shared/spotify.js";

const app = document.getElementById("app");
const NO_DEVICE_HINT =
  "Öffne Spotify, starte kurz einen Song und pausiere ihn, dann aktualisieren.";

let session = getStoredSession();
let devices = [];
let deviceId = getPreferredDeviceId();
let clipSec = 30;
let muted = isMuted();
let lastCueSeq = 0;
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
  return parseTrackUri(input?.value || "");
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

function startCountdown(seconds) {
  stopCountdown();
  const node = app.querySelector("[data-countdown]");
  if (!seconds) {
    if (node) node.textContent = "Ganzer Song – kein automatisches Pause.";
    return;
  }
  countdownUntil = Date.now() + seconds * 1000;
  let pausing = false;
  const tick = async () => {
    const left = Math.max(0, Math.ceil((countdownUntil - Date.now()) / 1000));
    const label = app.querySelector("[data-countdown]");
    if (label) label.textContent = left ? `Pause in ${left}s` : "Pausiere …";
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
      showNote(hint, "Automatisch pausiert (30 Sekunden).");
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
  muted = isMuted();
  const lagNode = app.querySelector("[data-lag]");
  const hint = app.querySelector("[data-local-hint]");
  if (muted) {
    stopCountdown();
    if (lagNode) lagNode.textContent = "Stumm – nicht abgespielt";
    showNote(hint, "Dieses Gerät ist stumm.");
    return;
  }
  const id = selectedDeviceId();
  if (!id) {
    showNote(hint, NO_DEVICE_HINT, true);
    if (lagNode) lagNode.textContent = "";
    return;
  }
  const t0 = Date.now();
  try {
    await play(trackUri, id, startMs);
    const lag = Date.now() - (Number(sentAt) || t0);
    if (lagNode) lagNode.textContent = `Abspielen bestätigt nach ${lag} ms`;
    showNote(hint, "");
    startCountdown(clip);
  } catch (err) {
    if (lagNode) lagNode.textContent = "";
    showError(hint, err, "Abspielen");
  }
}

async function refreshDevices() {
  const hint = app.querySelector("[data-device-hint]");
  const box = app.querySelector("[data-devices]");
  if (!session) return;
  try {
    devices = await getDevices();
    const preferred = getPreferredDeviceId();
    if (preferred && devices.some((row) => row.id === preferred)) {
      deviceId = preferred;
    } else if (deviceId && devices.some((row) => row.id === deviceId)) {
      /* aktuelle Auswahl behalten */
    } else {
      deviceId = devices.find((row) => row.active)?.id || devices[0]?.id || "";
    }
    if (deviceId) setPreferredDeviceId(deviceId);
    paintDevices(box);
    if (!devices.length) showNote(hint, NO_DEVICE_HINT, true);
    else showNote(hint, "");
  } catch (err) {
    devices = [];
    paintDevices(box);
    showError(hint, err, "Geräte");
  }
}

function paintDevices(box) {
  if (!box) return;
  box.innerHTML = "";
  if (!devices.length) {
    box.append(el("p", "lead", "Keine Geräte."));
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
    });
    const meta = [device.type, device.active ? "aktiv" : "", device.restricted ? "eingeschränkt" : ""]
      .filter(Boolean)
      .join(" · ");
    row.append(radio, el("span", "", `${device.name}${meta ? ` (${meta})` : ""}`));
    box.append(row);
  }
}

function handleCue(cue) {
  if (!cue?.trackUri) return;
  const seq = Number(cue.seq) || 0;
  if (seq && seq <= lastCueSeq) return;
  if (seq) lastCueSeq = seq;
  playHere(cue.trackUri, cue.startMs || 0, Number(cue.clipSec) || 0, cue.sentAt);
}

async function playAll() {
  const hint = app.querySelector("[data-local-hint]");
  const uri = trackFromInput();
  if (!uri) {
    showNote(hint, "Bitte einen Spotify-Song-Link einfügen (open.spotify.com/track/…).", true);
    return;
  }
  const sentAt = Date.now();
  const seq = lastCueSeq + 1;
  lastCueSeq = seq;
  const cue = { seq, trackUri: uri, startMs: 0, sentAt, clipSec };
  await playHere(uri, 0, clipSec, sentAt);
  if (!room) return;
  try {
    await sendAction({ type: "play-all", payload: cue });
    if (isHost()) await setState({ cue });
  } catch (err) {
    showError(hint, err, "An alle senden");
  }
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
    async onBeforeStart() {
      lastCueSeq = 0;
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
  lastCueSeq = 0;
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
  panel.append(status, list);
  panel.append(
    el(
      "p",
      "note",
      "Der Host schickt nur die Track-URI. Jedes Handy startet den Song auf seinem eigenen Spotify-Gerät."
    )
  );

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
      if (!player.online) tags.push("offline");
      info.append(el("span", "lobby-player-meta", tags.join(" · ")));
      item.append(dot, info);
      list.append(item);
    }
    if (next.state?.cue) handleCue(next.state.cue);
  }

  paint(initial);
  unsubs.push(onRoomChange((next) => paint(next)));
  unsubs.push(
    onAction((action) => {
      if (action.type === "play-all") handleCue(action.payload);
    })
  );
}

function render() {
  const keepTrack = app.querySelector("[name=track]")?.value || "";
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
    body.append(el("p", "", `Angemeldet: ${session.displayName}`));
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
    body.append(deviceHint, deviceBox);
    const refresh = el("button", "btn primary", "Geräte aktualisieren");
    refresh.type = "button";
    refresh.addEventListener("click", () => refreshDevices());
    body.append(refresh);

    body.append(el("h2", "lobby-list-title", "Song"));
    const trackLabel = el("label", "lobby-field", "Spotify-Link");
    const track = el("input", "text-input");
    track.name = "track";
    track.placeholder = "https://open.spotify.com/track/…";
    track.autocomplete = "off";
    track.spellcheck = false;
    track.value = keepTrack;
    trackLabel.append(track);
    body.append(trackLabel);

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
      const uri = trackFromInput();
      if (!uri) {
        showNote(hint, "Bitte einen Spotify-Song-Link einfügen (open.spotify.com/track/…).", true);
        return;
      }
      playBtn.disabled = true;
      try {
        await playHere(uri, 0, clipSec, Date.now());
      } finally {
        playBtn.disabled = false;
      }
    });
    dock.append(playBtn);
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
