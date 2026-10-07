const SW_URL = new URL("../sw.js", import.meta.url);

let reloading = false;
let banner = null;

function reloadOnce() {
  if (reloading) return;
  reloading = true;
  window.location.reload();
}

function showBanner(worker) {
  if (banner || !worker) return;

  banner = document.createElement("div");
  banner.className = "update-banner";
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Update verfügbar – neu laden";
  button.addEventListener("click", () => {
    button.disabled = true;
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") reloadOnce();
    });
    worker.postMessage({ type: "SKIP_WAITING" });
  });

  banner.append(button);
  document.body.append(banner);
  document.body.classList.add("has-update");
}

function watch(registration) {
  if (registration.waiting && navigator.serviceWorker.controller) {
    showBanner(registration.waiting);
  }

  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        showBanner(worker);
      }
    });
  });
}

export function initUpdates() {
  if (!("serviceWorker" in navigator)) return;

  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) reloadOnce();
  });

  register();

  async function register() {
    let registration;
    try {
      registration = await navigator.serviceWorker.register(SW_URL, {
        updateViaCache: "none",
      });
    } catch {
      try {
        registration = await navigator.serviceWorker.register(SW_URL);
      } catch {
        return;
      }
    }

    watch(registration);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        registration.update().catch(() => {});
      }
    });
  }
}
