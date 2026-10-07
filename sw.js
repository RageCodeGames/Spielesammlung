/* Service Worker für Kajütenspiele
 *
 * Bei jeder Änderung:
 *   1. Die Versionsnummer in CACHE_NAME erhöhen (z. B. kajuete-v1 → kajuete-v2).
 *   2. Neue oder umbenannte Dateien in PRECACHE eintragen.
 *
 * Erst danach erscheint das Banner „Update verfügbar – neu laden“.
 * skipWaiting läuft nicht von selbst – erst, wenn das Banner angetippt wird.
 */

const CACHE_NAME = "kajuete-v2";

const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./shared/styles.css",
  "./shared/games.js",
  "./shared/hub.js",
  "./shared/sound.js",
  "./shared/storage.js",
  "./shared/wakelock.js",
  "./shared/update.js",
  "./games/tapper/index.html",
  "./games/schiffe/index.html",
  "./games/schiffe/game.css",
  "./games/schiffe/logic.js",
  "./games/schiffe/ui.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

const SW_URL = new URL("./sw.js", self.location.href).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(PRECACHE.map((path) => precache(cache, path)))
    )
  );
});

// Nicht cache.addAll: das verwirft Weiterleitungen. „npx serve“ leitet
// index.html auf eine kürzere Adresse um, GitHub Pages nicht. Die Datei
// wird deshalb unter der ursprünglichen Adresse als normale Antwort gespeichert.
async function precache(cache, path) {
  const url = new URL(path, self.location.href).href;
  const response = await fetch(url, { cache: "reload" });
  if (!response.ok) {
    throw new Error(`Precache fehlgeschlagen (${response.status}): ${path}`);
  }

  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");

  await cache.put(
    url,
    new Response(await response.blob(), {
      status: 200,
      statusText: "OK",
      headers,
    })
  );
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (request.url.split("?")[0] === SW_URL) return;

  // Precache-Anfragen des Service Workers selbst nicht abfangen,
  // sonst bedient die alte Version das Update aus dem eigenen Cache.
  if (!event.clientId && !event.resultingClientId) return;

  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  return fetch(request);
}
