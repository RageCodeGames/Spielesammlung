/** Buchstaben gleichmäßig auf dem Rechteckrand, mehr auf den langen Seiten. */

function pointOnRect(d, rw, rh) {
  const peri = 2 * (rw + rh);
  let t = ((d % peri) + peri) % peri;
  if (t < rw) return { x: t, y: 0, rot: 180 };
  t -= rw;
  if (t < rh) return { x: rw, y: t, rot: -90 };
  t -= rh;
  if (t < rw) return { x: rw - t, y: rh, rot: 0 };
  t -= rw;
  return { x: 0, y: rh - t, rot: 90 };
}

export function layoutLetterRing(stage, buttons, center) {
  const n = buttons.length;
  if (!n || !stage) return;
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (width < 40 || height < 40) return;

  const margin = 4;
  const minGap = 8;
  const minSize = 40;
  const maxSize = Math.min(80, width * 0.26, height * 0.16);
  let lo = minSize;
  let hi = Math.max(minSize, maxSize);
  let size = minSize;

  for (let i = 0; i < 14; i += 1) {
    const mid = (lo + hi) / 2;
    const rw = Math.max(1, width - 2 * margin - mid);
    const rh = Math.max(1, height - 2 * margin - mid);
    const peri = 2 * (rw + rh);
    if (peri / n >= mid + minGap) {
      size = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const rw = Math.max(1, width - 2 * margin - size);
  const rh = Math.max(1, height - 2 * margin - size);
  const peri = 2 * (rw + rh);
  const font = Math.round(size * 0.46);

  for (let i = 0; i < n; i += 1) {
    const { x, y, rot } = pointOnRect(((i + 0.5) / n) * peri, rw, rh);
    const btn = buttons[i];
    btn.style.width = `${size}px`;
    btn.style.height = `${size}px`;
    btn.style.fontSize = `${font}px`;
    btn.style.left = `${margin + x}px`;
    btn.style.top = `${margin + y}px`;
    btn.style.transform = `rotate(${rot}deg)`;
  }

  if (center) {
    const inset = Math.max(12, Math.round(margin + size + 6));
    center.style.inset = `${inset}px`;
  }
}
