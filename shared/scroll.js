/** Scrollposition von .screen-body merken und nach DOM-Austausch wiederherstellen. */

export function readScroll(root = document) {
  const el =
    (root.querySelector && root.querySelector(".screen-body")) ||
    (root.classList && root.classList.contains("screen-body") ? root : null);
  return el ? el.scrollTop : 0;
}

export function writeScroll(root, top) {
  const el =
    (root.querySelector && root.querySelector(".screen-body")) ||
    (root.classList && root.classList.contains("screen-body") ? root : null);
  if (!el) return;
  el.scrollTop = top;
  requestAnimationFrame(() => {
    el.scrollTop = top;
  });
}

/** Vor dem Neuzeichnen aufrufen, Rückgabe danach an writeScroll übergeben. */
export function preserveScreenScroll(root, paint) {
  const top = readScroll(root);
  paint();
  writeScroll(root, top);
}
