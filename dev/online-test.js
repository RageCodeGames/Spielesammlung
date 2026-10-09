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

const app = document.getElementById("app");
const unsubs = [];
let room = null;

function clearUnsubs() {
  while (unsubs.length) unsubs.pop()();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function showLobby() {
  clearUnsubs();
  lobby = mountLobby(app, {
    gameId: "online-test",
    title: "Online-Test",
    lead: "Zweites Gerät oder privates Fenster für den zweiten Spieler.",
    onStart(next) {
      queueMicrotask(() => {
        lobby.destroy();
        showPlay(next);
      });
    },
    onLeave() {
      /* Lobby bleibt auf der Startansicht. */
    },
  });
}

let lobby = null;
showLobby();

function showPlay(initial) {
  room = initial;
  app.innerHTML = "";
  const screen = el("div", "screen");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  screen.append(body, dock);
  app.append(screen);

  const top = el("div", "lobby-top");
  top.append(el("p", "lobby-kicker", "Online-Test"));
  const badge = el("div");
  unsubs.push(mountConnectionBadge(badge));
  top.append(badge);
  body.append(top);
  body.append(el("h1", null, "Testrunde"));
  const codeLine = el("p", "lead");
  const list = el("ul", "lobby-players");
  const log = el("pre", "play-log");
  body.append(codeLine, el("h2", "lobby-list-title", "Spieler"), list, el("h2", "lobby-list-title", "Aktionen"), log);

  const ping = el("button", "btn primary", "Test-Aktion senden");
  ping.type = "button";
  ping.addEventListener("click", async () => {
    ping.disabled = true;
    try {
      const me = room?.you?.name || "Spieler";
      await sendAction({ type: "ping", payload: { text: `Hallo von ${me}` } });
    } catch (err) {
      log.textContent = err?.message || "Senden fehlgeschlagen.";
    }
    ping.disabled = false;
  });
  const back = el("button", "btn", "Zurück zur Lobby");
  back.type = "button";
  back.addEventListener("click", async () => {
    try {
      await leaveRoom();
    } catch {
      /* egal */
    }
    showLobby();
  });
  const hub = el("a", "btn", "Zur Übersicht");
  hub.href = "../index.html";
  dock.append(ping, back, hub);

  function paint(next) {
    if (!next) {
      showLobby();
      return;
    }
    room = next;
    codeLine.textContent = `Raum ${next.code} · ${next.you.isHost ? "Du bist Host" : "Du bist Mitspieler"}`;
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
    const lines = Array.isArray(next.state?.log) ? next.state.log : [];
    log.textContent = lines.length
      ? lines
          .map((row) => {
            const who = next.players.find((p) => p.id === row.from)?.name || row.from || "?";
            const text = row.payload?.text || row.type || "Aktion";
            return `${who}: ${text}`;
          })
          .join("\n")
      : "Noch keine Aktionen.";
  }

  paint(initial);

  unsubs.push(
    onRoomChange((next) => {
      paint(next);
    })
  );

  unsubs.push(
    onAction(async (action) => {
      if (!isHost()) return;
      const logRows = Array.isArray(room?.state?.log) ? room.state.log : [];
      await setState({
        log: [...logRows, { from: action.from, type: action.type, payload: action.payload, at: action.at }],
      });
    })
  );
}
