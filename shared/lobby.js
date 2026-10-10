import { makeQrSvg } from "./qrcode.js";
import {
  OFFLINE_MESSAGE,
  OnlineError,
  createRoom,
  getStoredName,
  initOnline,
  restoreSession,
  joinCodeFromUrl,
  joinRoom,
  joinUrl,
  kickPlayer,
  leaveRoom,
  mountConnectionBadge,
  onConnectionChange,
  onRoomChange,
  setPlayerOrder,
  startGame,
  updateSettings,
} from "./online.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const input = document.createElement("textarea");
      input.value = text;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.left = "-9999px";
      document.body.appendChild(input);
      input.select();
      const ok = document.execCommand("copy");
      input.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function errorMessage(err) {
  if (err instanceof OnlineError) return err.message;
  const code = String(err?.code || "");
  if (err?.code === "auth/network-request-failed") return OFFLINE_MESSAGE;
  if (/permission/i.test(code) || /permission/i.test(err?.message || "")) {
    return "Kein Zugriff auf die Datenbank. Bitte zuerst die Regeln in der Firebase-Konsole setzen.";
  }
  if (err?.code === "auth/operation-not-allowed") {
    return "Anonyme Anmeldung ist in der Firebase-Konsole noch nicht aktiv.";
  }
  return err?.message || "Etwas ist schiefgelaufen.";
}

function showError(hint, err, sticky = true) {
  console.error("[lobby]", err);
  hint(errorMessage(err), sticky);
}

/**
 * Wiederverwendbare Lobby: Raum erstellen/beitreten, optionale Einstellungen, Start.
 *
 * settingsPanel (optional):
 *   { initial, summarize(settings), render(container, { settings, isHost, onChange }) }
 *
 * @returns {{ destroy: () => void }}
 */
export function mountLobby(root, options = {}) {
  const gameId = options.gameId || "game";
  const title = options.title || "Online-Spiel";
  const leadText = options.lead || "Raum erstellen oder mit einem Code beitreten.";
  const settingsPanel = options.settingsPanel || null;
  const settings = options.settings || settingsPanel?.initial || {};
  const onStart = options.onStart;
  const onBeforeStart = options.onBeforeStart;
  const onLeave = options.onLeave;
  const minPlayers = Math.max(1, Number(options.minPlayers) || 1);
  const maxPlayers = Math.max(minPlayers, Number(options.maxPlayers) || 99);
  const joinPrefill = options.joinCode || joinCodeFromUrl() || "";
  let destroyed = false;
  let started = false;
  let snapshot = null;
  let hintTimer = 0;
  let unsubBadge = null;
  let settingsOpen = false;
  let entryStep = joinPrefill ? "join" : "choice";
  let lastRoomFinger = "";
  let busy = false;
  let busyLabel = "";
  let lastError = "";
  let pendingName = getStoredName();
  let pendingCode = joinPrefill;

  function roomFingerprint(room) {
    if (!room) return "";
    const players = room.players
      .map((p) => `${p.id}:${p.name}:${p.online ? 1 : 0}:${p.seat}`)
      .join("|");
    return `${room.code}:${room.status}:${players}`;
  }

  root.innerHTML = "";
  root.classList.add("lobby");

  const screen = el("div", "screen");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  screen.append(body, dock);
  root.append(screen);

  const unsubRoom = onRoomChange((next) => {
    snapshot = next;
    if (destroyed) return;
    if (busy && !next) return;
    if (next?.status === "playing" && !started) {
      started = true;
      try {
        onStart?.(next);
      } catch (err) {
        started = false;
        showError(hint, err, true);
        render();
      }
      return;
    }
    const finger = roomFingerprint(next);
    if (finger && finger === lastRoomFinger && body.querySelector(".lobby-code")) {
      const sum = body.querySelector(".lobby-settings-sum");
      if (sum && settingsPanel?.summarize) sum.textContent = settingsPanel.summarize(next.settings || {});
      return;
    }
    render();
  });

  const unsubNet = onConnectionChange(() => {
    if (destroyed || started || snapshot) return;
    render();
  });

  const onBrowserNet = () => {
    if (!destroyed && !started) render();
  };
  window.addEventListener("online", onBrowserNet);
  window.addEventListener("offline", onBrowserNet);

  function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new OnlineError("timeout", message));
      }, ms);
      promise.then(
        (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          window.clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  function setBusy(label) {
    busy = Boolean(label);
    busyLabel = label || "";
    if (label) lastError = "";
  }

  function hint(text, sticky = false) {
    if (text && sticky) lastError = text;
    const note = body.querySelector(".lobby-hint") || dock.querySelector(".lobby-hint");
    if (note) {
      note.textContent = text;
      note.hidden = !text;
    }
    window.clearTimeout(hintTimer);
    if (text && !sticky) {
      hintTimer = window.setTimeout(() => {
        if (note) note.hidden = true;
      }, 2400);
    }
  }

  function appendDockStatus() {
    if (lastError) {
      const note = el("p", "note is-bad lobby-hint");
      note.textContent = lastError;
      dock.append(note);
    }
  }

  async function share(code) {
    const url = joinUrl(code);
    if (navigator.share) {
      try {
        await navigator.share({
          title,
          text: `Raumcode ${code}`,
          url,
        });
        return;
      } catch (err) {
        if (err?.name === "AbortError") return;
      }
    }
    const ok = await copyText(url);
    hint(ok ? "Link kopiert" : url);
  }

  function nameField(value = pendingName || getStoredName()) {
    const nameLabel = el("label", "lobby-field", "Dein Name");
    const nameInput = el("input", "text-input");
    nameInput.name = "name";
    nameInput.autocomplete = "nickname";
    nameInput.maxLength = 20;
    nameInput.value = value;
    nameInput.disabled = busy;
    nameInput.addEventListener("input", () => {
      pendingName = nameInput.value;
    });
    nameLabel.append(nameInput);
    return nameLabel;
  }

  function codeField(value = "") {
    const codeLabel = el("label", "lobby-field", "Raumcode");
    const codeInput = el("input", "text-input");
    codeInput.name = "code";
    codeInput.autocomplete = "off";
    codeInput.spellcheck = false;
    codeInput.maxLength = 4;
    codeInput.placeholder = "z. B. K7P3";
    codeInput.value = value;
    codeInput.disabled = busy;
    codeInput.addEventListener("input", () => {
      const caret = codeInput.selectionStart;
      const next = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
      codeInput.value = next;
      pendingCode = next;
      try {
        codeInput.setSelectionRange(caret, caret);
      } catch {
        /* Mobil */
      }
    });
    codeLabel.append(codeInput);
    return codeLabel;
  }

  async function onCreate() {
    if (busy) return;
    pendingName = body.querySelector("[name=name]")?.value ?? pendingName;
    setBusy("Raum wird erstellt …");
    render();
    try {
      await withTimeout(
        createRoom(gameId, pendingName, snapshot?.settings || settings),
        20000,
        "Zeitüberschreitung beim Anlegen. Netz prüfen oder später nochmal versuchen."
      );
    } catch (err) {
      showError(hint, err, true);
      lastError = errorMessage(err);
    } finally {
      setBusy("");
      if (!destroyed && !snapshot) render();
    }
  }

  async function onJoin() {
    if (busy) return;
    pendingName = body.querySelector("[name=name]")?.value ?? pendingName;
    pendingCode = body.querySelector("[name=code]")?.value ?? pendingCode;
    setBusy("Tritt bei …");
    render();
    try {
      await withTimeout(
        joinRoom(pendingCode, pendingName),
        20000,
        "Zeitüberschreitung beim Beitreten. Code und Netz prüfen."
      );
    } catch (err) {
      showError(hint, err, true);
      lastError = errorMessage(err);
    } finally {
      setBusy("");
      if (!destroyed && !snapshot) render();
    }
  }

  async function onStartClick() {
    const startBtn = dock.querySelector(".btn.primary");
    if (startBtn) startBtn.disabled = true;
    try {
      if (snapshot && snapshot.players.length < minPlayers) {
        hint(`Mindestens ${minPlayers} Spieler.`, true);
        return;
      }
      if (snapshot && snapshot.players.length > maxPlayers) {
        hint(`Höchstens ${maxPlayers} Spieler – bitte welche entfernen.`, true);
        return;
      }
      if (onBeforeStart) await onBeforeStart(snapshot);
      await startGame();
    } catch (err) {
      showError(hint, err, true);
    } finally {
      if (!started && startBtn) startBtn.disabled = false;
    }
  }

  async function onHostSettingsChange(next) {
    if (!snapshot?.you?.isHost) return;
    snapshot = { ...snapshot, settings: next };
    const sum = body.querySelector(".lobby-settings-sum");
    if (sum && settingsPanel?.summarize) sum.textContent = settingsPanel.summarize(next);
    try {
      await updateSettings(next);
    } catch (err) {
      showError(hint, err, true);
    }
  }

  async function move(id, dir) {
    if (!snapshot?.you?.isHost) return;
    const ids = snapshot.players.map((p) => p.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try {
      await setPlayerOrder(ids);
    } catch (err) {
      showError(hint, err);
    }
  }

  async function kick(id) {
    try {
      await kickPlayer(id);
    } catch (err) {
      showError(hint, err);
    }
  }

  async function onExit() {
    try {
      await leaveRoom();
    } catch (err) {
      console.error("[lobby] Verlassen", err);
    }
    snapshot = null;
    entryStep = "choice";
    onLeave?.();
    render();
  }

  function renderOffline() {
    if (unsubBadge) {
      unsubBadge();
      unsubBadge = null;
    }
    body.innerHTML = "";
    dock.innerHTML = "";
    body.append(
      el("p", "lobby-kicker", title),
      el("h1", null, "Kein Netz"),
      el("p", "note", OFFLINE_MESSAGE)
    );
  }

  function appendHint() {
    const note = el("p", "lobby-hint");
    note.hidden = true;
    body.append(note);
    return note;
  }

  function renderChoice() {
    if (unsubBadge) {
      unsubBadge();
      unsubBadge = null;
    }
    body.innerHTML = "";
    dock.innerHTML = "";
    body.append(el("p", "lobby-kicker", title));
    body.append(el("h1", null, "Zusammen spielen"));
    body.append(el("p", "lead", leadText));
    const create = el("button", "choice");
    create.type = "button";
    create.append(el("strong", "", "Raum erstellen"), el("small", "", "Du bist Host: Code teilen, Regeln festlegen, starten."));
    create.addEventListener("click", () => {
      entryStep = "create";
      render();
    });
    const join = el("button", "choice");
    join.type = "button";
    join.append(el("strong", "", "Raum beitreten"), el("small", "", "Mit Code oder Link auf ein bestehendes Spiel."));
    join.addEventListener("click", () => {
      entryStep = "join";
      render();
    });
    body.append(create, join);
    appendHint();
    if (lastError) body.append(el("p", "note is-bad", lastError));
  }

  function renderCreate() {
    if (unsubBadge) {
      unsubBadge();
      unsubBadge = null;
    }
    body.innerHTML = "";
    dock.innerHTML = "";
    body.append(el("p", "lobby-kicker", title));
    body.append(el("h1", null, "Raum erstellen"));
    body.append(el("p", "lead", "Name eingeben – der Raum wird sofort angelegt."));
    body.append(nameField());
    appendHint();
    const go = el("button", "btn primary", busy ? "Raum wird erstellt …" : "Raum erstellen");
    go.type = "button";
    go.disabled = busy;
    go.addEventListener("click", onCreate);
    const back = el("button", "btn", "Zurück");
    back.type = "button";
    back.disabled = busy;
    back.addEventListener("click", () => {
      if (busy) return;
      lastError = "";
      entryStep = "choice";
      render();
    });
    appendDockStatus();
    dock.append(go, back);
  }

  function renderJoin() {
    if (unsubBadge) {
      unsubBadge();
      unsubBadge = null;
    }
    body.innerHTML = "";
    dock.innerHTML = "";
    body.append(el("p", "lobby-kicker", title));
    body.append(el("h1", null, "Raum beitreten"));
    body.append(el("p", "lead", "Code und Namen eingeben."));
    body.append(nameField());
    body.append(codeField(pendingCode || joinPrefill));
    appendHint();
    const go = el("button", "btn primary", busy ? "Tritt bei …" : "Beitreten");
    go.type = "button";
    go.disabled = busy;
    go.addEventListener("click", onJoin);
    const back = el("button", "btn", "Zurück");
    back.type = "button";
    back.disabled = busy;
    back.addEventListener("click", () => {
      if (busy) return;
      lastError = "";
      entryStep = "choice";
      render();
    });
    appendDockStatus();
    dock.append(go, back);
  }

  function renderSettingsBlock(room, host) {
    if (!settingsPanel) return;
    const current = room.settings && Object.keys(room.settings).length ? room.settings : settings;
    if (settingsPanel.summarize) {
      body.append(el("p", "lobby-settings-sum", settingsPanel.summarize(current)));
    }
    if (host && settingsPanel.render) {
      const box = el("details", "lobby-settings");
      box.open = settingsOpen;
      box.addEventListener("toggle", () => {
        settingsOpen = box.open;
      });
      const summary = el("summary", "", "Einstellungen");
      box.append(summary);
      const inner = el("div", "lobby-settings-body");
      box.append(inner);
      body.append(box);
      settingsPanel.render(inner, {
        settings: current,
        isHost: true,
        onChange: onHostSettingsChange,
      });
    }
  }

  function renderRoom(room) {
    body.innerHTML = "";
    dock.innerHTML = "";
    const host = room.you.isHost;

    const top = el("div", "lobby-top");
    const badge = el("div");
    if (unsubBadge) unsubBadge();
    unsubBadge = mountConnectionBadge(badge);
    top.append(el("p", "lobby-kicker", title), badge);
    body.append(top);

    if (host) {
      body.append(el("p", "lead", "Andere treten mit diesem Code bei:"));
      body.append(el("p", "lobby-code", room.code));
      const qrWrap = el("div", "lobby-qr");
      qrWrap.innerHTML = makeQrSvg(joinUrl(room.code), `QR-Code für Raum ${room.code}`);
      body.append(qrWrap);
      const shareBtn = el("button", "btn", "Link teilen");
      shareBtn.type = "button";
      shareBtn.addEventListener("click", () => share(room.code));
      body.append(shareBtn);
    } else {
      body.append(el("p", "lead", "Du bist im Raum"));
      body.append(el("p", "lobby-code", room.code));
      body.append(el("p", "note", "Warten, bis die Runde startet."));
    }

    renderSettingsBlock(room, host);

    body.append(el("h2", "lobby-list-title", "Spieler"));
    const list = el("ul", "lobby-players");
    for (const player of room.players) {
      const item = el("li", "lobby-player");
      const dot = el("span", `lobby-dot${player.online ? " is-on" : ""}`);
      const label = el("span", "lobby-player-name", player.name);
      const tags = [];
      if (player.isSelf) tags.push("Du");
      if (player.isHost) tags.push("Host");
      if (!player.online) tags.push("offline");
      const meta = el("span", "lobby-player-meta", tags.join(" · "));
      const info = el("div", "lobby-player-info");
      info.append(label, meta);
      item.append(dot, info);
      if (host && room.players.length > 1) {
        const tools = el("div", "lobby-player-tools");
        const up = el("button", "btn lobby-icon", "▲");
        up.type = "button";
        up.title = "Nach oben";
        up.disabled = room.players[0].id === player.id;
        up.addEventListener("click", () => move(player.id, -1));
        const down = el("button", "btn lobby-icon", "▼");
        down.type = "button";
        down.title = "Nach unten";
        down.disabled = room.players[room.players.length - 1].id === player.id;
        down.addEventListener("click", () => move(player.id, 1));
        tools.append(up, down);
        if (!player.isSelf) {
          const removeBtn = el("button", "btn lobby-icon", "×");
          removeBtn.type = "button";
          removeBtn.title = "Entfernen";
          removeBtn.addEventListener("click", () => kick(player.id));
          tools.append(removeBtn);
        }
        item.append(tools);
      }
      list.append(item);
    }
    body.append(list);

    appendHint();

    if (room.status === "kicked") {
      body.append(el("p", "note is-bad", "Du wurdest entfernt."));
      const ok = el("button", "btn primary", "OK");
      ok.type = "button";
      ok.addEventListener("click", () => {
        snapshot = null;
        entryStep = "choice";
        render();
      });
      dock.append(ok);
      return;
    }

    if (host) {
      const tooFew = room.players.length < minPlayers;
      const tooMany = room.players.length > maxPlayers;
      if (tooFew) body.append(el("p", "note", `Mindestens ${minPlayers} Spieler.`));
      if (tooMany) body.append(el("p", "note is-bad", `Höchstens ${maxPlayers} Spieler – bitte welche entfernen.`));
      const startBtn = el("button", "btn primary", "Spiel starten");
      startBtn.type = "button";
      startBtn.disabled = tooFew || tooMany;
      startBtn.addEventListener("click", onStartClick);
      dock.append(startBtn);
    }
    const leaveBtn = el("button", "btn", host ? "Raum schließen" : "Verlassen");
    leaveBtn.type = "button";
    leaveBtn.addEventListener("click", onExit);
    dock.append(leaveBtn);
  }

  function render() {
    if (destroyed || started) return;
    const keepScroll = Boolean(snapshot && body.querySelector(".lobby-code"));
    const top = keepScroll ? body.scrollTop : 0;
    if (typeof navigator !== "undefined" && navigator.onLine === false && !snapshot) {
      renderOffline();
      lastRoomFinger = "";
      return;
    }
    if (snapshot) {
      renderRoom(snapshot);
      lastRoomFinger = roomFingerprint(snapshot);
      body.scrollTop = top;
      requestAnimationFrame(() => {
        body.scrollTop = top;
      });
      return;
    }
    lastRoomFinger = "";
    if (entryStep === "create") renderCreate();
    else if (entryStep === "join") renderJoin();
    else renderChoice();
  }

  initOnline()
    .then(async () => {
      if (destroyed) return;
      if (!busy && !snapshot && entryStep === "choice") await restoreSession();
      if (!destroyed) render();
    })
    .catch((err) => {
      if (destroyed) return;
      console.error("[lobby] Anmeldung", err);
      if (err instanceof OnlineError && err.code === "offline") renderOffline();
      else {
        lastError = errorMessage(err);
        render();
        hint(lastError, true);
      }
    });

  render();

  return {
    destroy() {
      destroyed = true;
      window.clearTimeout(hintTimer);
      window.removeEventListener("online", onBrowserNet);
      window.removeEventListener("offline", onBrowserNet);
      unsubRoom();
      unsubNet();
      if (unsubBadge) unsubBadge();
      root.classList.remove("lobby");
      root.innerHTML = "";
    },
  };
}
