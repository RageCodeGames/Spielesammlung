let sentinel = null;
let desired = false;

async function acquire() {
  if (!desired || sentinel) return;
  if (!("wakeLock" in navigator)) return;

  try {
    const lock = await navigator.wakeLock.request("screen");
    if (!desired) {
      lock.release().catch(() => {});
      return;
    }
    sentinel = lock;
    lock.addEventListener("release", () => {
      if (sentinel === lock) sentinel = null;
    });
  } catch {
    /* nicht unterstützt oder vom System abgelehnt */
  }
}

export function requestWakeLock() {
  desired = true;
  return acquire();
}

export function releaseWakeLock() {
  desired = false;
  const current = sentinel;
  sentinel = null;
  if (!current) return Promise.resolve();
  return current.release().catch(() => {});
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !desired) return;
  sentinel = null;
  acquire();
});
