/**
 * Verdeckte Karte / Marker per Pointer in die Zeitleiste ziehen.
 * touch-action: none, kein Seiten-Scroll.
 */

const EDGE = 48;
const SCROLL_STEP = 28;

export function bindTimelineDrag({ source, timeline, lockedGap, onHover, onDrop, onCancel }) {
  if (!source || !timeline) return () => {};

  let dragging = false;
  let ghost = null;
  let pointerId = null;
  let hoverGap = null;

  const gaps = () => [...timeline.querySelectorAll("[data-gap]")];

  const gapAt = (x, y) => {
    const list = gaps();
    if (!list.length) return null;
    let best = null;
    let bestDist = Infinity;
    for (const node of list) {
      const r = node.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dist = Math.hypot(x - cx, y - cy);
      const along = x >= r.left - 24 && x <= r.right + 24;
      if (along && Math.abs(y - cy) < r.height + 40 && dist < bestDist) {
        best = node;
        bestDist = dist;
      }
    }
    if (!best) {
      const tl = timeline.getBoundingClientRect();
      if (y < tl.top - 20 || y > tl.bottom + 20) return null;
      if (x <= tl.left) best = list[0];
      else if (x >= tl.right) best = list[list.length - 1];
    }
    if (!best) return null;
    const g = Number(best.getAttribute("data-gap"));
    if (!Number.isFinite(g)) return null;
    if (lockedGap != null && g === lockedGap) return null;
    return g;
  };

  const paintHover = (g) => {
    hoverGap = g;
    for (const node of gaps()) {
      const n = Number(node.getAttribute("data-gap"));
      node.classList.toggle("is-drop", g != null && n === g);
    }
    onHover?.(g);
  };

  const autoScroll = (x) => {
    const r = timeline.getBoundingClientRect();
    if (x < r.left + EDGE) timeline.scrollLeft -= SCROLL_STEP;
    else if (x > r.right - EDGE) timeline.scrollLeft += SCROLL_STEP;
  };

  const moveGhost = (x, y) => {
    if (!ghost) return;
    const w = ghost.offsetWidth || 115;
    const h = ghost.offsetHeight || 67;
    ghost.style.transform = `translate(${x - w / 2}px, ${y - h / 2}px)`;
  };

  const stop = (commit, x, y) => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("zs-dragging");
    ghost?.remove();
    ghost = null;
    for (const node of gaps()) node.classList.remove("is-drop");
    if (pointerId != null) {
      try {
        source.releasePointerCapture(pointerId);
      } catch {
        /* schon weg */
      }
    }
    pointerId = null;
    if (commit) {
      const g = gapAt(x, y);
      if (g != null) onDrop?.(g);
      else onCancel?.();
    } else {
      onCancel?.();
    }
    hoverGap = null;
  };

  const onDown = (event) => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    source.setPointerCapture(pointerId);
    document.body.classList.add("zs-dragging");
    ghost = document.createElement("div");
    ghost.className = "zs-drag-ghost";
    ghost.setAttribute("aria-hidden", "true");
    ghost.textContent = source.getAttribute("data-drag-label") || "?";
    document.body.append(ghost);
    moveGhost(event.clientX, event.clientY);
  };

  const onMove = (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    event.preventDefault();
    moveGhost(event.clientX, event.clientY);
    autoScroll(event.clientX);
    paintHover(gapAt(event.clientX, event.clientY));
  };

  const onUp = (event) => {
    if (event.pointerId !== pointerId) return;
    stop(true, event.clientX, event.clientY);
  };

  const onCancelEvt = (event) => {
    if (event.pointerId !== pointerId) return;
    stop(false, event.clientX, event.clientY);
  };

  source.style.touchAction = "none";
  source.addEventListener("pointerdown", onDown);
  source.addEventListener("pointermove", onMove);
  source.addEventListener("pointerup", onUp);
  source.addEventListener("pointercancel", onCancelEvt);

  return () => {
    stop(false, 0, 0);
    source.removeEventListener("pointerdown", onDown);
    source.removeEventListener("pointermove", onMove);
    source.removeEventListener("pointerup", onUp);
    source.removeEventListener("pointercancel", onCancelEvt);
  };
}
