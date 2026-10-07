import {
  allPlaced,
  beginBattle,
  beginPlacement,
  coord,
  COLS,
  dealRandom,
  fireIncoming,
  freshState,
  isRunning,
  liftAt,
  logText,
  markEnemy,
  ownShipSunk,
  ownShotStats,
  placeSelected,
  previewAt,
  resetShips,
  selectShip,
  shipAt,
  SIZE,
  toggleOrientation,
  undo,
} from "./logic.js";
import { playTone, unlock } from "../../shared/sound.js";
import { get, set } from "../../shared/storage.js";
import { requestWakeLock } from "../../shared/wakelock.js";
import { initUpdates } from "../../shared/update.js";

const STORAGE_KEY = "kajuete:schiffe";

let state = freshState();
let pendingMenu = null;
let toastTimer = 0;
let announceTimer = 0;

const app = document.getElementById("app");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function save() {
  if (state.phase === "place" || state.phase === "battle" || state.phase === "end") set(STORAGE_KEY, state);
}

function toast(message) {
  document.querySelector(".toast")?.remove();
  const node = el("div", "toast", message);
  node.setAttribute("role", "status");
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 1400);
}

function confirmDialog(message, onYes) {
  const back = el("div", "dialog-back");
  const dialog = el("div", "dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.append(el("p", "", message));
  const yes = el("button", "btn primary", "Ja, neu beginnen");
  yes.type = "button";
  const no = el("button", "btn", "Abbrechen");
  no.type = "button";
  yes.addEventListener("click", () => {
    back.remove();
    onYes();
  });
  no.addEventListener("click", () => back.remove());
  dialog.append(yes, no);
  back.append(dialog);
  document.body.append(back);
  yes.focus();
}

function playResult(result) {
  if (result === "water") playTone({ frequency: 196, duration: 0.2, type: "sine" });
  else if (result === "hit") playTone({ frequency: 523, duration: 0.16, type: "square" });
  else {
    playTone({ frequency: 659, duration: 0.18, type: "triangle" });
    setTimeout(() => playTone({ frequency: 880, duration: 0.28, type: "triangle" }), 150);
  }
}

function showAnnounce(kind, title, sub) {
  document.querySelector(".announce")?.remove();
  clearTimeout(announceTimer);
  const overlay = el("div", `announce ${kind}`);
  overlay.setAttribute("role", "status");
  overlay.append(el("strong", "", title));
  if (sub) overlay.append(el("span", "", sub));
  const close = () => {
    clearTimeout(announceTimer);
    overlay.remove();
  };
  overlay.addEventListener("click", close);
  document.body.append(overlay);
  announceTimer = setTimeout(close, 2000);
}

function backLink() {
  const link = el("a", "back");
  link.href = "../../index.html";
  const arrow = el("span", "", "←");
  arrow.setAttribute("aria-hidden", "true");
  link.append(arrow, document.createTextNode(" Zurück"));
  return link;
}

function askNewGame() {
  if (state.phase === "place" || state.phase === "battle") {
    confirmDialog("Neues Spiel beginnen? Der laufende Spielstand wird gelöscht.", startFresh);
    return;
  }
  startFresh();
}

function startFresh() {
  pendingMenu = null;
  state = freshState();
  set(STORAGE_KEY, state);
  render();
}

function miniShip(size, sunk) {
  const ship = el("span", sunk ? "mini-ship sunk" : "mini-ship");
  ship.setAttribute("aria-hidden", "true");
  for (let i = 0; i < size; i += 1) ship.append(el("i"));
  return ship;
}

function fleetRow(label, ships, own) {
  const row = el("div", own ? "fleet-row own" : "fleet-row");
  row.append(el("span", "fleet-label", label));
  const list = el("span", "mini-ships");
  for (const ship of ships) list.append(miniShip(ship.size, ship.sunk));
  row.append(list);
  return row;
}

function makeGrid(kind) {
  const grid = el("div", "grid");
  grid.append(el("div", "corner"));
  for (let c = 0; c < SIZE; c += 1) grid.append(el("div", "coord", COLS[c]));
  for (let r = 0; r < SIZE; r += 1) {
    grid.append(el("div", "coord", String(r + 1)));
    for (let c = 0; c < SIZE; c += 1) {
      const button = el("button", "cell");
      button.type = "button";
      button.dataset.c = String(c);
      button.dataset.r = String(r);
      grid.append(button);
    }
  }
  paintGrid(grid, kind);
  return grid;
}

function cellButton(grid, c, r) {
  return grid.querySelector(`.cell[data-c="${c}"][data-r="${r}"]`);
}

function paintGrid(grid, kind) {
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      const button = cellButton(grid, c, r);
      button.className = "cell";
      const label = [
        `${kind === "enemy" ? "Gegner" : kind === "place" ? "Feld" : "Eigenes Feld"} ${coord(c, r)}`,
      ];
      if (kind === "place") {
        const ship = shipAt(state.ships, c, r);
        if (ship) {
          button.classList.add("ship");
          label.push(ship.name);
        }
      } else if (kind === "own" || kind === "reveal") {
        const ship = shipAt(state.ships, c, r);
        const mark = state.incoming[r][c];
        if (ship) button.classList.add("ship");
        if (mark?.result === "water") {
          button.classList.add("mark-water");
          label.push("Wasser");
        } else if (mark?.result === "sunk" || (ship && ownShipSunk(ship, state.incoming))) {
          button.classList.add("mark-sunk");
          label.push("Versenkt");
        } else if (mark?.result === "hit") {
          button.classList.add("mark-hit");
          label.push("Treffer");
        } else if (ship) {
          label.push(ship.name);
        }
      } else {
        const mark = state.enemy[r][c];
        if (mark?.kind === "water") {
          button.classList.add("mark-water");
          if (mark.auto) button.classList.add("auto");
          label.push(mark.auto ? "Wasser, automatisch" : "Wasser");
        } else if (mark?.kind === "hit") {
          button.classList.add("mark-hit");
          label.push("Treffer");
        } else if (mark?.kind === "sunk") {
          button.classList.add("mark-sunk");
          label.push("Versenkt");
        }
        if (pendingMenu && pendingMenu.c === c && pendingMenu.r === r) button.classList.add("is-picked");
      }
      button.setAttribute("aria-label", label.join(", "));
    }
  }
}

function paintPreview(grid, c, r) {
  for (const button of grid.querySelectorAll(".cell")) {
    button.classList.remove("preview-ok", "preview-bad");
  }
  const preview = previewAt(state, c, r);
  const className = preview.issue ? "preview-bad" : "preview-ok";
  for (const cell of preview.cells) {
    cellButton(grid, cell.c, cell.r)?.classList.add(className);
  }
  return preview;
}

function fitBoards() {
  const battle = document.querySelector(".battle");
  if (!battle) return;
  const status = battle.querySelector(".status");
  const titles = battle.querySelectorAll(".board-title");
  let titleH = 0;
  titles.forEach((title) => {
    titleH += title.offsetHeight;
  });
  const availW = battle.clientWidth;
  const availH = battle.clientHeight - status.offsetHeight - titleH - 8;
  let cell = Math.floor(Math.min((availW - 16) / 10, availH / 2 / 10));
  let label = Math.max(14, Math.round(cell * 0.72));
  while (cell > 8 && (cell * 10 + label > availW || cell * 10 + label > availH / 2)) {
    cell -= 1;
    label = Math.max(14, Math.round(cell * 0.72));
  }
  document.documentElement.style.setProperty("--cell", `${Math.max(8, cell)}px`);
  document.documentElement.style.setProperty("--label", `${label}px`);
}

function renderSettings() {
  document.body.classList.remove("is-battle");
  let fleetId = state.fleetId || "classic";
  let allowTouch = state.allowTouch;
  const view = el("section", "setup");
  view.append(backLink());
  view.append(el("h1", "", "Schiffe versenken"));
  view.append(el("p", "lead", "Jeder spielt auf dem eigenen Handy. Die Schüsse ruft ihr euch zu."));

  const classic = el("button", "choice", "");
  classic.type = "button";
  classic.append(el("strong", "", "Klassisch"), el("small", "", "5, 4, 3, 3, 2"));
  const paper = el("button", "choice", "");
  paper.type = "button";
  paper.append(el("strong", "", "Papier"), el("small", "", "5, 4, 4, 3, 3, 3, 2, 2, 2, 2"));

  const touch = el("button", "switch-row");
  touch.type = "button";
  touch.setAttribute("role", "switch");
  const touchTitle = el("strong", "", "Schiffe dürfen sich berühren");
  const touchHelp = el("small");
  touch.append(touchTitle, touchHelp);

  function paintChoices() {
    classic.classList.toggle("is-on", fleetId === "classic");
    paper.classList.toggle("is-on", fleetId === "paper");
    classic.setAttribute("aria-pressed", fleetId === "classic" ? "true" : "false");
    paper.setAttribute("aria-pressed", fleetId === "paper" ? "true" : "false");
    touch.classList.toggle("is-on", allowTouch);
    touch.setAttribute("aria-checked", allowTouch ? "true" : "false");
    touchHelp.textContent = allowTouch
      ? "An: Schiffe dürfen Kante an Kante und diagonal liegen."
      : "Aus: Schiffe brauchen Abstand, auch diagonal.";
  }

  classic.addEventListener("click", () => {
    fleetId = "classic";
    paintChoices();
  });
  paper.addEventListener("click", () => {
    fleetId = "paper";
    paintChoices();
  });
  touch.addEventListener("click", () => {
    allowTouch = !allowTouch;
    paintChoices();
  });
  paintChoices();

  const next = el("button", "btn primary", "Weiter");
  next.type = "button";
  next.addEventListener("click", () => {
    state = beginPlacement(state, fleetId, allowTouch);
    save();
    render();
  });

  const choices = el("div", "choices");
  choices.append(classic, paper);
  view.append(choices, touch, next);
  app.replaceChildren(view);
}

function renderPlace() {
  document.body.classList.remove("is-battle");
  const view = el("section", "place");
  const bar = el("div", "battle-bar");
  bar.append(backLink());
  const fresh = el("button", "btn", "Neues Spiel");
  fresh.type = "button";
  fresh.addEventListener("click", askNewGame);
  bar.append(el("span", "spacer"), fresh);
  view.append(bar);
  view.append(el("h1", "", "Schiffe legen"));

  const grid = makeGrid("place");
  view.append(grid);

  let pointer = null;

  grid.addEventListener("pointerdown", (event) => {
    const button = event.target.closest(".cell");
    if (!button || event.button !== 0) return;
    const c = Number(button.dataset.c);
    const r = Number(button.dataset.r);
    grid.setPointerCapture(event.pointerId);
    const lift = Boolean(shipAt(state.ships, c, r));
    pointer = { id: event.pointerId, c, r, lift };
    if (!lift) paintPreview(grid, c, r);
  });

  grid.addEventListener("pointerup", (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const action = pointer;
    pointer = null;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const button = hit && hit.closest ? hit.closest(".cell") : null;
    const same = button && Number(button.dataset.c) === action.c && Number(button.dataset.r) === action.r;
    for (const cell of grid.querySelectorAll(".cell")) cell.classList.remove("preview-ok", "preview-bad");
    if (!same) return;
    if (action.lift) {
      state = liftAt(state, action.c, action.r);
      save();
      render();
      return;
    }
    if (state.selectedId == null) {
      toast("Zuerst ein Schiff wählen");
      return;
    }
    const result = placeSelected(state, action.c, action.r);
    if (result.issue) {
      for (const cell of result.cells) cellButton(grid, cell.c, cell.r)?.classList.add("preview-bad");
      const reason =
        result.issue === "rand"
          ? "Ragt über den Rand"
          : result.issue === "ueberlapp"
            ? "Liegt auf einem Schiff"
            : "Berührt ein anderes Schiff";
      toast(reason);
      setTimeout(() => {
        for (const cell of grid.querySelectorAll(".preview-bad")) cell.classList.remove("preview-bad");
      }, 450);
      return;
    }
    state = result.state;
    save();
    render();
  });

  const tools = el("div", "btn-row place-tools");
  const turn = el(
    "button",
    "btn",
    state.orientation === "h" ? "Drehen · waagerecht" : "Drehen · senkrecht"
  );
  turn.type = "button";
  turn.addEventListener("click", () => {
    state = toggleOrientation(state);
    save();
    render();
  });
  const random = el("button", "btn", "Zufällig verteilen");
  random.type = "button";
  random.addEventListener("click", () => {
    const dealt = dealRandom(state);
    if (!dealt.ok) {
      toast("Kein Platz gefunden, bitte noch einmal");
      return;
    }
    state = dealt.state;
    save();
    render();
  });
  const reset = el("button", "btn", "Alles zurücksetzen");
  reset.type = "button";
  reset.addEventListener("click", () => {
    state = resetShips(state);
    save();
    render();
  });
  tools.append(turn, random, reset);

  const dock = el("div", "dock");
  const open = state.ships.filter((ship) => !ship.cells);
  if (open.length === 0) dock.append(el("p", "lead", "Alle Schiffe stehen."));
  for (const ship of open) {
    const chip = el("button", ship.id === state.selectedId ? "ship-chip is-on" : "ship-chip");
    chip.type = "button";
    chip.setAttribute("aria-pressed", ship.id === state.selectedId ? "true" : "false");
    chip.append(miniShip(ship.size, false), el("span", "", `${ship.name} · ${ship.size}`));
    chip.addEventListener("click", () => {
      state = selectShip(state, ship.id);
      save();
      render();
    });
    dock.append(chip);
  }

  const done = el("button", "btn primary", "Fertig");
  done.type = "button";
  done.disabled = !allPlaced(state.ships);
  done.addEventListener("click", () => {
    if (!allPlaced(state.ships)) return;
    state = beginBattle(state);
    save();
    render();
  });

  view.append(tools, dock, done);
  app.replaceChildren(view);
  document.documentElement.style.setProperty("--cell", "34px");
  document.documentElement.style.setProperty("--label", "22px");
  const width = view.clientWidth - 8;
  const cell = Math.max(16, Math.min(46, Math.floor((width - 22) / 10)));
  document.documentElement.style.setProperty("--cell", `${cell}px`);
  document.documentElement.style.setProperty("--label", "22px");
}

function renderBattle() {
  document.body.classList.add("is-battle");
  const bar = el("div", "battle-bar");
  bar.append(backLink());
  const undoButton = el("button", "btn", "Rückgängig");
  undoButton.type = "button";
  undoButton.disabled = state.history.length === 0;
  undoButton.addEventListener("click", () => {
    state = undo(state);
    pendingMenu = null;
    save();
    render();
  });
  const fresh = el("button", "btn", "Neues Spiel");
  fresh.type = "button";
  fresh.addEventListener("click", askNewGame);
  bar.append(el("span", "spacer"), undoButton, fresh);

  const battle = el("div", "battle");
  const enemyBlock = el("div", "board-block");
  enemyBlock.append(el("p", "board-title", "Gegnerisches Feld"));
  const enemyGrid = makeGrid("enemy");
  enemyGrid.addEventListener("click", (event) => {
    const button = event.target.closest(".cell");
    if (!button) return;
    pendingMenu = { c: Number(button.dataset.c), r: Number(button.dataset.r) };
    render();
  });
  enemyBlock.append(enemyGrid);

  const status = el("div", "status");
  status.append(
    fleetRow(
      "Gegner",
      state.enemyFleet.map((slot) => ({ size: slot.size, sunk: slot.sunk })),
      false
    ),
    fleetRow(
      "Ich",
      state.ships.map((ship) => ({ size: ship.size, sunk: ownShipSunk(ship, state.incoming) })),
      true
    )
  );

  const ownBlock = el("div", "board-block");
  ownBlock.append(el("p", "board-title", "Mein Feld"));
  const ownGrid = makeGrid("own");
  ownGrid.addEventListener("click", async (event) => {
    const button = event.target.closest(".cell");
    if (!button) return;
    const c = Number(button.dataset.c);
    const r = Number(button.dataset.r);
    const result = fireIncoming(state, c, r);
    if (result.already) {
      toast("Schon beschossen");
      return;
    }
    state = result.state;
    pendingMenu = null;
    save();
    await unlock();
    playResult(result.result);
    const title = result.result === "water" ? "WASSER" : result.result === "hit" ? "TREFFER!" : "VERSENKT!";
    const sub = result.result === "sunk" ? `(${result.ship.name}, ${result.ship.size})` : "";
    render();
    showAnnounce(result.result, title, sub);
  });
  ownBlock.append(ownGrid);
  battle.append(enemyBlock, status, ownBlock);
  app.replaceChildren(bar, battle);

  if (pendingMenu) {
    const menu = el("div", "mark-menu");
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", "Schuss eintragen");
    menu.append(el("p", "", coord(pendingMenu.c, pendingMenu.r)));
    const actions = [
      ["water", "Wasser"],
      ["hit", "Treffer"],
      ["sunk", "Versenkt"],
      ["cancel", "Abbrechen"],
    ];
    for (const [kind, label] of actions) {
      const button = el("button", "", label);
      button.type = "button";
      button.addEventListener("click", () => {
        if (kind === "cancel") {
          pendingMenu = null;
          render();
          return;
        }
        const marked = markEnemy(state, pendingMenu.c, pendingMenu.r, kind);
        if (marked.error) {
          toast(marked.error);
          return;
        }
        state = marked.state;
        pendingMenu = null;
        save();
        render();
      });
      menu.append(button);
    }
    app.append(menu);
  }

  requestAnimationFrame(() => {
    fitBoards();
    requestAnimationFrame(fitBoards);
  });
}

function renderEnd() {
  document.body.classList.remove("is-battle");
  const view = el("section", "end-screen");
  view.append(backLink());
  view.append(el("h1", "", state.outcome === "won" ? "Gewonnen" : "Verloren"));
  const stats = ownShotStats(state.enemy);
  view.append(
    el("p", "lead", `${stats.shots} eigene Schüsse · Trefferquote ${stats.rate} %`)
  );
  view.append(el("h2", "", "Mein Feld"));
  const grid = makeGrid("reveal");
  grid.classList.add("end-grid");
  for (const button of grid.querySelectorAll(".cell")) button.disabled = true;
  view.append(grid);
  view.append(el("h2", "", "Schüsse des Gegners"));
  const list = el("ol", "log");
  if (state.shotLog.length === 0) list.append(el("li", "", "Keine Schüsse"));
  state.shotLog.forEach((entry, index) => list.append(el("li", "", logText(entry, index))));
  view.append(list);
  const fresh = el("button", "btn primary", "Neues Spiel");
  fresh.type = "button";
  fresh.addEventListener("click", startFresh);
  const hub = el("a", "btn", "Zum Hub");
  hub.href = "../../index.html";
  const row = el("div", "btn-row");
  row.append(fresh, hub);
  view.append(row);
  app.replaceChildren(view);
}

let showingResume = false;

function draw() {
  document.body.dataset.phase = showingResume ? "resume" : state.phase;
  if (showingResume) {
    renderResumeScreen();
    return;
  }
  if (state.phase === "settings") renderSettings();
  else if (state.phase === "place") renderPlace();
  else if (state.phase === "battle") renderBattle();
  else renderEnd();
}

function render() {
  showingResume = false;
  draw();
}

function renderResumeScreen() {
  document.body.classList.remove("is-battle");
  const view = el("section", "setup");
  view.append(backLink());
  view.append(el("h1", "", "Schiffe versenken"));
  view.append(el("p", "lead", "Es gibt ein angefangenes Spiel auf diesem Handy."));
  const resume = el("button", "btn primary", "Spiel fortsetzen");
  resume.type = "button";
  resume.addEventListener("click", () => {
    showingResume = false;
    draw();
  });
  const fresh = el("button", "btn", "Neues Spiel");
  fresh.type = "button";
  fresh.addEventListener("click", startFresh);
  const stack = el("div", "stack");
  stack.append(resume, fresh);
  view.append(stack);
  app.replaceChildren(view);
}

function boot() {
  document.title = "Schiffe versenken – Kajütenspiele";
  requestWakeLock();
  initUpdates();
  const saved = get(STORAGE_KEY, null);
  if (isRunning(saved)) {
    state = saved;
    showingResume = true;
  } else {
    state = freshState();
  }
  draw();
}

window.addEventListener("resize", fitBoards);
if (window.visualViewport) window.visualViewport.addEventListener("resize", fitBoards);
window.addEventListener("pagehide", save);

boot();
