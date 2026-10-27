/**
 * Zeitsprung-Karten: eigenes Layout, Jahrzehntfarben, Anzeigetitel, Peek.
 */

const HOLD_MS = 800;
const MOVE_PX = 12;

const STRIP = [
  /\s*[-–—]\s*\d{4}\s+Remaster(?:ed)?\b.*$/i,
  /\s*[-–—]\s*Remaster(?:ed)?(?:\s+\d{4})?\b.*$/i,
  /\s*[-–—]\s*Radio\s+Edit\b.*$/i,
  /\s*[-–—]\s*Single\s+Version\b.*$/i,
  /\s*[-–—]\s*Live\b.*$/i,
  /\s*\((?:feat\.?|ft\.?|featuring)\b[^)]*\)\s*$/i,
  /\s*\[(?:feat\.?|ft\.?|featuring)\b[^\]]*\]\s*$/i,
  /\s*\(\d{4}\s+Remaster(?:ed)?\)\s*$/i,
  /\s*\(Remaster(?:ed)?(?:\s+\d{4})?\)\s*$/i,
];

export function displayTitle(raw) {
  let text = String(raw || "").trim();
  if (!text) return "";
  let prev = "";
  while (text !== prev) {
    prev = text;
    for (const re of STRIP) text = text.replace(re, "").trim();
  }
  return text;
}

export function decadeKey(year) {
  const y = Math.floor(Number(year) || 0);
  if (y < 1950) return "pre";
  if (y >= 2030) return "2030";
  return String(Math.floor(y / 10) * 10);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function twoLine(tag, className, text) {
  const node = el(tag, className, text);
  node.title = text;
  return node;
}

/** Aufgedeckte Karte: Interpret / Jahr / Titel. */
export function faceUpCard(card, { peek = true } = {}) {
  const year = Number(card?.year) || 0;
  const node = el("article", `zs-card zs-card-d${decadeKey(year)}`);
  node.append(twoLine("span", "zs-card-artist", String(card?.artist || "–")));
  node.append(el("strong", "zs-card-year", year ? String(year) : "—"));
  node.append(twoLine("span", "zs-card-title", displayTitle(card?.title) || "–"));
  if (peek) {
    node.setAttribute("data-peek", "1");
    node.dataset.peekArtist = String(card?.artist || "");
    node.dataset.peekTitle = String(card?.title || "");
    node.dataset.peekYear = year ? String(year) : "";
  }
  return node;
}

function decoQrSvg() {
  const n = 21;
  const on = Array.from({ length: n }, () => Array(n).fill(false));
  const paintFinder = (ox, oy) => {
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        on[oy + r][ox + c] = ring || core;
      }
    }
  };
  paintFinder(0, 0);
  paintFinder(14, 0);
  paintFinder(0, 14);
  for (let i = 8; i <= 12; i += 1) {
    on[6][i] = i % 2 === 0;
    on[i][6] = i % 2 === 0;
  }
  let seed = 0x5a17;
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const inFinder =
        (x < 8 && y < 8) || (x > 12 && y < 8) || (x < 8 && y > 12) || x === 6 || y === 6;
      if (inFinder) continue;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      on[y][x] = seed % 5 !== 0;
    }
  }
  const cell = 4;
  const quiet = 6;
  const size = n * cell + quiet * 2;
  let rects = "";
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (!on[y][x]) continue;
      rects += `<rect x="${quiet + x * cell}" y="${quiet + y * cell}" width="${cell}" height="${cell}"/>`;
    }
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("zs-qr");
  svg.innerHTML = `<rect width="${size}" height="${size}" rx="6" fill="#241c16"/><g fill="#e6d2a8">${rects}</g>`;
  return svg;
}

function paintFaceDown(node) {
  node.replaceChildren();
  const pattern = el("div", "zs-song-back-pattern");
  pattern.setAttribute("aria-hidden", "true");
  node.append(pattern);
  node.append(decoQrSvg());
  node.append(el("span", "zs-song-back-mark", "Zeitsprung"));
}

/** Verdeckte Karte, gleiche Maße. asButton für Ziehen. */
export function faceDownCard({ asButton = true } = {}) {
  const node = el(asButton ? "button" : "div", "zs-song-back");
  if (asButton) {
    node.type = "button";
    node.setAttribute("aria-label", "Songkarte");
  }
  node.setAttribute("data-drag-label", "Zeitsprung");
  paintFaceDown(node);
  return node;
}

export function fillDragGhost(ghost) {
  ghost.className = "zs-drag-ghost";
  ghost.setAttribute("aria-hidden", "true");
  const inner = el("div", "zs-song-back");
  paintFaceDown(inner);
  ghost.replaceChildren(inner);
}

export function revealFlipCard(card, { animate = true } = {}) {
  const stage = el("div", "zs-flip");
  const inner = el("div", "zs-flip-inner");
  const back = faceDownCard({ asButton: false });
  back.classList.add("zs-flip-face", "zs-flip-back");
  const front = faceUpCard(card, { peek: false });
  front.classList.add("zs-flip-face", "zs-flip-front");
  inner.append(back, front);
  stage.append(inner);
  if (animate) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => inner.classList.add("is-flipped"));
    });
  } else {
    inner.classList.add("is-flipped");
  }
  return stage;
}

let peekNode = null;
let peekTimer = 0;
let peekOpened = false;
let peekStart = { x: 0, y: 0, pointer: null };

export function hideCardPeek() {
  window.clearTimeout(peekTimer);
  peekTimer = 0;
  peekOpened = false;
  peekStart.pointer = null;
  peekNode?.remove();
  peekNode = null;
}

function showCardPeek(from) {
  hideCardPeek();
  peekOpened = true;
  const back = el("div", "zs-peek-back");
  back.setAttribute("role", "dialog");
  const card = el("article", "zs-peek-card");
  card.append(el("p", "zs-peek-artist", from.dataset.peekArtist || "–"));
  card.append(el("p", "zs-peek-year", from.dataset.peekYear || "—"));
  card.append(el("p", "zs-peek-title", from.dataset.peekTitle || "–"));
  back.append(card);
  const close = () => hideCardPeek();
  back.addEventListener("pointerdown", (event) => {
    if (event.target === back) close();
  });
  document.body.append(back);
  peekNode = back;
}

function peekTarget(event) {
  const node = event.target?.closest?.(".zs-card[data-peek]");
  if (!node || node.closest(".zs-peek-back") || node.closest(".zs-flip")) return null;
  return node;
}

function unbindPeekWindow() {
  window.removeEventListener("pointermove", onPeekMove);
  window.removeEventListener("pointerup", onPeekUp);
  window.removeEventListener("pointercancel", onPeekUp);
}

function onPeekDown(event) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  const card = peekTarget(event);
  if (!card) return;
  window.clearTimeout(peekTimer);
  peekOpened = false;
  peekStart = { x: event.clientX, y: event.clientY, pointer: event.pointerId };
  window.addEventListener("pointermove", onPeekMove);
  window.addEventListener("pointerup", onPeekUp);
  window.addEventListener("pointercancel", onPeekUp);
  peekTimer = window.setTimeout(() => {
    peekTimer = 0;
    if (peekStart.pointer !== event.pointerId) return;
    showCardPeek(card);
  }, HOLD_MS);
}

function onPeekMove(event) {
  if (peekStart.pointer !== event.pointerId) return;
  const dist = Math.hypot(event.clientX - peekStart.x, event.clientY - peekStart.y);
  if (dist <= MOVE_PX) return;
  window.clearTimeout(peekTimer);
  peekTimer = 0;
  unbindPeekWindow();
  if (peekOpened) hideCardPeek();
  peekStart.pointer = null;
}

function onPeekUp(event) {
  if (peekStart.pointer != null && event.pointerId !== peekStart.pointer) return;
  window.clearTimeout(peekTimer);
  peekTimer = 0;
  unbindPeekWindow();
  peekStart.pointer = null;
  if (peekOpened) hideCardPeek();
}

function onPeekMenu(event) {
  if (event.target?.closest?.(".zs-card[data-peek]")) event.preventDefault();
}

/** Long-Press auf Zeitleisten-Karten. Scrollen und Ziehen bleiben frei. */
export function bindCardPeek(root) {
  if (!root) return () => {};
  root.addEventListener("pointerdown", onPeekDown, { passive: true });
  root.addEventListener("contextmenu", onPeekMenu);
  return () => {
    root.removeEventListener("pointerdown", onPeekDown);
    root.removeEventListener("contextmenu", onPeekMenu);
    unbindPeekWindow();
    hideCardPeek();
  };
}
