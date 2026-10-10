import { makeQrSvg } from "./qrcode.js";
import {
  OFFLINE_MESSAGE,
  OnlineError,
  createRoom,
  getStoredName,
  initOnline,
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

/**
 * Wiederverwendbare Lobby: Raum erstellen, beitreten, Spielerliste, Start.
 * @returns {{ destroy: () => void }}
 */
export function mountLobby(root, options = {}) {
  const gameId = options.gameId || "game";
  const title = options.title || "Online-Spiel";
  const leadText = options.lead || "Raum erstellen oder mit einem Code beitreten.";
  const settings = options.settings || {};
  const onStart = options.onStart;
  const onBeforeStart = options.onBeforeStart;
  const onLeave = options.onLeave;
  const minPlayers = Math.max(1, Number(options.minPlayers) || 1);
  const maxPlayers = Math.max(minPlayers, Number(options.maxPlayers) || 99);
  let destroyed = false;
  let started = false;
  let snapshot = null;
  let hintTimer = 0;
  let unsubBadge = null;

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
    if (next?.status === "playing" && !started) {
      started = true;
      onStart?.(next);
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

  function hint(text, sticky = false) {
    const note = body.querySelector(".lobby-hint");
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

  async function onCreate() {
    const name = body.querySelector("[name=name]")?.value;
    try {
      await createRoom(gameId, name, settings);
    } catch (err) {
      hint(errorMessage(err), true);
    }
  }

  async function onJoin() {
    const name = body.querySelector("[name=name]")?.value;
    const code = body.querySelector("[name=code]")?.value;
    try {
      await joinRoom(code, name);
    } catch (err) {
      hint(errorMessage(err), true);
    }
  }

  async function onStartClick() {
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
      hint(errorMessage(err), true);
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
      hint(errorMessage(err));
    }
  }

  async function kick(id) {
    try {
      await kickPlayer(id);
    } catch (err) {
      hint(errorMessage(err));
    }
  }

  async function onExit() {
    try {
      await leaveRoom();
    } catch {
      /* lokal trotzdem zurück */
    }
    snapshot = null;
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

  function renderEntry() {
    if (unsubBadge) {
      unsubBadge();
      unsubBadge = null;
    }
    body.innerHTML = "";
    dock.innerHTML = "";
    const prefill = options.joinCode || joinCodeFromUrl() || "";
    const name = getStoredName();

    body.append(el("p", "lobby-kicker", title));
    body.append(el("h1", null, "Zusammen spielen"));
    body.append(el("p", "lead", leadText));

    const nameLabel = el("label", "lobby-field", "Dein Name");
    const nameInput = el("input", "text-input");
    nameInput.name = "name";
    nameInput.autocomplete = "nickname";
    nameInput.maxLength = 20;
    nameInput.value = name;
    nameLabel.append(nameInput);
    body.append(nameLabel);

    const codeLabel = el("label", "lobby-field", "Raumcode");
    const codeInput = el("input", "text-input");
    codeInput.name = "code";
    codeInput.autocomplete = "off";
    codeInput.spellcheck = false;
    codeInput.maxLength = 4;
    codeInput.placeholder = "z. B. K7P3";
    codeInput.value = prefill;
    codeInput.addEventListener("input", () => {
      const caret = codeInput.selectionStart;
      const next = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
      codeInput.value = next;
      try {
        codeInput.setSelectionRange(caret, caret);
      } catch {
        /* Mobil */
      }
    });
    codeLabel.append(codeInput);
    body.append(codeLabel);

    const note = el("p", "lobby-hint");
    note.hidden = true;
    body.append(note);

    const createBtn = el("button", "btn primary", "Raum erstellen");
    createBtn.type = "button";
    createBtn.addEventListener("click", onCreate);
    const joinBtn = el("button", "btn", "Beitreten");
    joinBtn.type = "button";
    joinBtn.addEventListener("click", onJoin);
    dock.append(createBtn, joinBtn);
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

    const note = el("p", "lobby-hint");
    note.hidden = true;
    body.append(note);

    if (room.status === "kicked") {
      body.append(el("p", "note is-bad", "Du wurdest entfernt."));
      const ok = el("button", "btn primary", "OK");
      ok.type = "button";
      ok.addEventListener("click", () => {
        snapshot = null;
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
    if (typeof navigator !== "undefined" && navigator.onLine === false && !snapshot) {
      renderOffline();
      return;
    }
    if (snapshot) {
      renderRoom(snapshot);
      return;
    }
    renderEntry();
  }

  initOnline()
    .then(() => {
      if (!destroyed) render();
    })
    .catch((err) => {
      if (destroyed) return;
      if (err instanceof OnlineError && err.code === "offline") renderOffline();
      else {
        renderEntry();
        hint(errorMessage(err));
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
