import { mountLobby } from "../shared/lobby.js";
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
  completeLoginIfRedirected,
  explainError,
  getDevices,
  getStoredSession,
  isConfigured,
  login,
  logout,
  parseTrackUri,
  pause,
  play,
  redirectUri,
} from "../shared/spotify.js";

const app = document.getElementById("app");

let session = getStoredSession();
let devices = [];
let deviceId = "";
let clipSec = 30;
let muted = false;
let lastCueSeq = 0;
let countdownTimer = 0;
let countdownUntil = 0;
let lobby = null;
let room = null;
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
  node.hidden = false;
  node.className = "note is-bad";
  node.textContent = message;
}

function showNote(node, text, bad = false) {
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

function stopCountdown() {
  window.clearInterval(countdownTimer);
  countdownTimer = 0;
  countdownUntil = 0;
  const node = app.querySelector("[data-countdown]");
  if (node) node.textContent = "";
}

function startCountdown(seconds) {
  stopCountdown();
  if (!seconds) {
    const node = app.querySelector("[data-countdown]");
    if (node) node.textContent = "Ganzer Song – kein automatisches Pause.";
    return;
  }
  countdownUntil = Date.now() + seconds * 1000;
  const tick = async () => {
    const left = Math.max(0, Math.ceil((countdownUntil - Date.now()) / 1000));
    const node = app.querySelector("[data-countdown]");
    if (node) node.textContent = left ? `Pause in ${left}s` : "Pausiert";
    if (left > 0) return;
    stopCountdown();
    if (muted) return;
    try {
      await pause(selectedDeviceId());
    } catch (err) {
      const hint = app.querySelector("[data-local-hint]");
      if (hint) showError(hint, err, "Pause");
    }
  };
  countdownTimer = window.setInterval(tick, 250);
  tick();
}

async function playHere(trackUri, startMs, clip, sentAt) {
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
    showNote(
      hint,
      "Kein aktives Gerät gefunden. Öffne die Spotify-App, spiele kurz irgendeinen Song ab und tippe auf Aktualisieren.",
      true
    );
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
    if (deviceId && !devices.some((row) => row.id === deviceId)) deviceId = "";
    if (!deviceId) {
      deviceId = devices.find((row) => row.active)?.id || devices[0]?.id || "";
    }
    paintDevices(box);
    if (!devices.length) {
      showNote(
        hint,
        "Öffne die Spotify-App, spiele kurz irgendeinen Song ab und tippe auf Aktualisieren.",
        true
      );
    } else {
      showNote(hint, "");
    }
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
      if (radio.checked) deviceId = device.id;
    });
    const meta = [device.type, device.active ? "aktiv" : ""].filter(Boolean).join(" · ");
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
  slot.classList.add("lobby");
  const screen = el("div", "screen");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  screen.append(body, dock);
  slot.append(screen);

  const top = el("div", "lobby-top");
  top.append(el("p", "lobby-kicker", "Mehrere Handys"));
  const badge = el("div");
  unsubs.push(mountConnectionBadge(badge));
  top.append(badge);
  body.append(top);
  body.append(el("h2", "", "Gemeinsam abspielen"));
  const status = el("p", "lead");
  const list = el("ul", "lobby-players");
  body.append(status, list);
  body.append(
    el(
      "p",
      "note",
      "Der Host schickt nur die Track-URI. Jedes Handy startet den Song auf seinem eigenen Spotify-Gerät."
    )
  );

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
    dock.append(all);
  } else {
    body.append(el("p", "lead", "Warten auf den Host …"));
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
  dock.append(back);

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

  unsubs.push(
    onRoomChange((next) => {
      paint(next);
    })
  );
  unsubs.push(
    onAction((action) => {
      if (action.type === "play-all") handleCue(action.payload);
    })
  );
}

function render() {
  const keepTrack = app.querySelector("[name=track]")?.value || "";
  const keepMuted = muted;
  const keepClip = clipSec;
  lobby?.destroy();
  lobby = null;
  clearUnsubs();
  room = null;
  app.innerHTML = "";
  const screen = el("div", "screen");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  screen.append(body, dock);
  app.append(screen);

  body.append(el("p", "lobby-kicker", "Techniktest"));
  body.append(el("h1", "", "Spotify"));
  body.append(
    el("p", "lead", "Prüfen, ob Songs auf dem Handy starten und stoppen – auch auf mehreren Geräten.")
  );
  const uriNote = el("p", "note spotify-uri", `Redirect-URI: ${redirectUri()}`);
  body.append(uriNote);

  const hint = el("p", "note is-bad");
  hint.setAttribute("data-local-hint", "1");
  if (bootError) {
    hint.textContent = bootError;
  } else {
    hint.hidden = true;
  }
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
    const refresh = el("button", "btn", "Aktualisieren");
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

    const mute = el("label", "switch-row");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = keepMuted;
    muted = keepMuted;
    check.addEventListener("change", () => {
      muted = check.checked;
    });
    mute.append(check, el("span", "", "Stumm (dieses Gerät spielt nichts)"));
    body.append(mute);

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

  body.append(el("hr", "spotify-rule"));
  const online = el("div");
  online.setAttribute("data-online", "1");
  body.append(online);

  const hub = el("a", "btn", "Zur Übersicht");
  hub.href = "../index.html";
  dock.append(hub);

  clipSec = keepClip;
  muted = keepMuted;
  showLobby();
  if (session) refreshDevices();
}

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
