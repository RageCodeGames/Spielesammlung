/** Buchstaben-Ring: Seiten zwischen freien Ecken, gegen den Uhrzeigersinn. */

export const RING_MIN_GAP = 6;
const EDGE = 4;
const MIN_SIZE = 28;
/** Unten → rechts → oben → links: von jeder Seite alphabetisch von links nach rechts. */
const SIDES = ["bottom", "right", "top", "left"];
const ROT = { top: 180, right: -90, bottom: 0, left: 90 };

function roundCounts(n, lengths) {
  const total = lengths.reduce((sum, len) => sum + len, 0);
  const raw = lengths.map((len) => (n * len) / total);
  const counts = raw.map((value) => Math.floor(value));
  let rest = n - counts.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let i = 0; i < rest; i += 1) counts[order[i % order.length].index] += 1;
  return counts;
}

export function countPerSide(n, width, height) {
  return roundCounts(n, [width, height, width, height]);
}

function sizeLimit(sideLen, count, gap) {
  if (count <= 0) return Infinity;
  return (sideLen - 2 * EDGE - (count + 1) * gap) / (count + 2);
}

function tileSize(width, height, counts, gap) {
  const [bottom, right, top, left] = counts;
  const raw = Math.min(
    sizeLimit(width, top, gap),
    sizeLimit(width, bottom, gap),
    sizeLimit(height, right, gap),
    sizeLimit(height, left, gap),
    Math.min(width, height) * 0.22
  );
  return Math.max(MIN_SIZE, Math.floor(raw));
}

function alongSide(count, size, gap, start, lastStart) {
  if (count <= 0) return [];
  if (count === 1) return [(start + lastStart) / 2];
  const step = (lastStart - start) / (count - 1);
  return Array.from({ length: count }, (_, i) => start + i * step);
}

function sidePlacements(side, count, size, gap, width, height) {
  const first = EDGE + size + gap;
  const lastX = width - EDGE - 2 * size - gap;
  const lastY = height - EDGE - 2 * size - gap;
  const rot = ROT[side];
  // Von der Person an der Seite: links → rechts alphabetisch.
  if (side === "bottom") {
    return alongSide(count, size, gap, first, lastX).map((x) => ({
      x,
      y: height - EDGE - size,
      rot,
      side,
    }));
  }
  if (side === "right") {
    return alongSide(count, size, gap, first, lastY)
      .reverse()
      .map((y) => ({
        x: width - EDGE - size,
        y,
        rot,
        side,
      }));
  }
  if (side === "top") {
    return alongSide(count, size, gap, first, lastX)
      .reverse()
      .map((x) => ({ x, y: EDGE, rot, side }));
  }
  return alongSide(count, size, gap, first, lastY).map((y) => ({
    x: EDGE,
    y,
    rot,
    side,
  }));
}

export function planLetterRing(width, height, n, gap = RING_MIN_GAP) {
  if (n <= 0 || width < 40 || height < 40) {
    return { size: MIN_SIZE, positions: [], counts: [0, 0, 0, 0] };
  }
  const counts = countPerSide(n, width, height);
  const size = tileSize(width, height, counts, gap);
  const positions = [];
  for (let i = 0; i < SIDES.length; i += 1) {
    positions.push(...sidePlacements(SIDES[i], counts[i], size, gap, width, height));
  }
  return { size, positions, counts };
}

function boxesOverlap(a, b, minGap) {
  return (
    a.x < b.x + b.size + minGap - 0.01 &&
    a.x + a.size + minGap - 0.01 > b.x &&
    a.y < b.y + b.size + minGap - 0.01 &&
    a.y + a.size + minGap - 0.01 > b.y
  );
}

export function ringHasOverlap(plan, minGap = RING_MIN_GAP) {
  const boxes = plan.positions.map((pos) => ({ x: pos.x, y: pos.y, size: plan.size }));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (boxesOverlap(boxes[i], boxes[j], minGap)) return true;
    }
  }
  return false;
}

/** Prüft, dass auf jeder Seite die Positionen für den Sitzenden links→rechts laufen. */
export function sideReadsLeftToRight(plan) {
  const bySide = { bottom: [], right: [], top: [], left: [] };
  for (const pos of plan.positions) bySide[pos.side].push(pos);
  const bottomOk = bySide.bottom.every((p, i, arr) => i === 0 || p.x > arr[i - 1].x);
  const rightOk = bySide.right.every((p, i, arr) => i === 0 || p.y < arr[i - 1].y);
  const topOk = bySide.top.every((p, i, arr) => i === 0 || p.x < arr[i - 1].x);
  const leftOk = bySide.left.every((p, i, arr) => i === 0 || p.y > arr[i - 1].y);
  return bottomOk && rightOk && topOk && leftOk;
}

export function layoutLetterRing(stage, buttons, center) {
  const n = buttons.length;
  if (!n || !stage) return;
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  const plan = planLetterRing(width, height, n);
  const font = Math.round(plan.size * 0.46);

  for (let i = 0; i < n; i += 1) {
    const pos = plan.positions[i];
    const btn = buttons[i];
    if (!pos || !btn) continue;
    btn.style.width = `${plan.size}px`;
    btn.style.height = `${plan.size}px`;
    btn.style.fontSize = `${font}px`;
    btn.style.left = `${pos.x}px`;
    btn.style.top = `${pos.y}px`;
    btn.style.transform = `rotate(${pos.rot}deg)`;
  }

  if (center) {
    const inset = Math.max(12, Math.round(EDGE + plan.size + RING_MIN_GAP));
    center.style.inset = `${inset}px`;
  }
}
