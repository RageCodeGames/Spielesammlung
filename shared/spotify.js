/**
 * Spotify Web API im Browser: PKCE, Geräte, Play/Pause.
 * Kein Client Secret – der Token-Tausch läuft direkt vom Handy.
 */

import { SPOTIFY_CLIENT_ID } from "./spotify-config.js";
import { get, set } from "./storage.js";

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_URL = "https://api.spotify.com/v1";
const SCOPES = "user-read-playback-state user-modify-playback-state";
const TOKEN_KEY = "kajuete:spotify-tokens";
const PKCE_KEY = "kajuete:spotify-pkce";
const REFRESH_MARGIN_MS = 60_000;

export class SpotifyError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = "SpotifyError";
    this.code = code;
    this.status = status;
  }
}

let refreshWait = null;

export function isConfigured() {
  return Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_ID !== "HIER EINFÜGEN");
}

/** Redirect-URI = aktuelle Seite ohne Query/Hash. Muss 1:1 im Dashboard stehen. */
export function redirectUri() {
  return `${location.origin}${location.pathname}`;
}

export function getStoredSession() {
  const tokens = get(TOKEN_KEY, null);
  if (!tokens?.access_token) return null;
  return {
    displayName: tokens.displayName || "Spotify-Konto",
    userId: tokens.userId || "",
    expiresAt: Number(tokens.expiresAt) || 0,
  };
}

export function parseTrackUri(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const spotify = raw.match(/^spotify:track:([A-Za-z0-9]+)/i);
  if (spotify) return `spotify:track:${spotify[1]}`;
  try {
    const url = new URL(raw);
    const fromPath = url.pathname.match(/\/track\/([A-Za-z0-9]+)/);
    if (fromPath) return `spotify:track:${fromPath[1]}`;
  } catch {
    /* kein Link */
  }
  const loose = raw.match(/track\/([A-Za-z0-9]+)/i);
  if (loose) return `spotify:track:${loose[1]}`;
  return "";
}

export function explainError(err) {
  if (err instanceof SpotifyError) return err.message;
  return err?.message || "Etwas ist schiefgelaufen.";
}

export async function login() {
  if (!isConfigured()) {
    throw new SpotifyError(
      "no-client-id",
      "In shared/spotify-config.js fehlt die Spotify Client ID."
    );
  }
  const verifier = randomString(64);
  const state = randomString(16);
  const challenge = await sha256Base64Url(verifier);
  set(PKCE_KEY, { verifier, state, at: Date.now() });
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", SPOTIFY_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", SCOPES);
  location.assign(url.toString());
}

export function logout() {
  set(TOKEN_KEY, null);
  set(PKCE_KEY, null);
}

/**
 * Nach dem Redirect von Spotify: Code gegen Token tauschen.
 * @returns {Promise<boolean>} true, wenn ein Login abgeschlossen wurde
 */
export async function completeLoginIfRedirected() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const error = params.get("error");
  const state = params.get("state");
  if (!code && !error) return false;

  const pkce = get(PKCE_KEY, null);
  clearAuthParams();
  if (error) {
    set(PKCE_KEY, null);
    throw new SpotifyError("auth-denied", authErrorMessage(error));
  }
  if (!pkce?.verifier) {
    throw new SpotifyError("auth-lost", "Die Anmeldung ist unterbrochen. Bitte nochmal mit Spotify anmelden.");
  }
  if (pkce.state && state && pkce.state !== state) {
    set(PKCE_KEY, null);
    throw new SpotifyError("auth-state", "Die Anmeldung wurde abgebrochen (ungültiger Zustand). Bitte nochmal anmelden.");
  }
  try {
    const tokens = await requestToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      code_verifier: pkce.verifier,
    });
    await storeTokens(tokens);
  } finally {
    set(PKCE_KEY, null);
  }
  return true;
}

export async function getDevices() {
  const data = await api("GET", "/me/player/devices");
  const list = Array.isArray(data?.devices) ? data.devices : [];
  return list.map((device) => ({
    id: device.id,
    name: device.name || "Gerät",
    type: device.type || "",
    active: device.is_active === true,
    restricted: device.is_restricted === true,
  }));
}

export async function play(trackUri, deviceId, startMs = 0) {
  const uri = parseTrackUri(trackUri) || trackUri;
  if (!uri || !uri.startsWith("spotify:track:")) {
    throw new SpotifyError("bad-track", "Das ist kein gültiger Spotify-Song-Link.");
  }
  const position = Math.max(0, Math.floor(Number(startMs) || 0));
  const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
  try {
    await api("PUT", `/me/player/play${query}`, {
      uris: [uri],
      position_ms: position,
    });
  } catch (err) {
    if (deviceId && (err?.code === "no-device" || err?.status === 404)) {
      await api("PUT", "/me/player", { device_ids: [deviceId], play: false });
      await api("PUT", `/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
        uris: [uri],
        position_ms: position,
      });
      return;
    }
    throw err;
  }
}

export async function pause(deviceId) {
  const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
  try {
    await api("PUT", `/me/player/pause${query}`);
  } catch (err) {
    if (err?.status === 404) return;
    throw err;
  }
}

async function api(method, path, body) {
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}` };
  const options = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${API_URL}${path}`, options);
  if (response.status === 204 || response.status === 202) return null;
  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!response.ok) throw fromApiError(response.status, data);
  return data;
}

export async function getAccessToken() {
  const tokens = get(TOKEN_KEY, null);
  if (!tokens?.access_token) {
    throw new SpotifyError("auth-expired", "Anmeldung abgelaufen. Bitte erneut mit Spotify anmelden.");
  }
  if (Date.now() < Number(tokens.expiresAt) - REFRESH_MARGIN_MS) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) {
    logout();
    throw new SpotifyError("auth-expired", "Anmeldung abgelaufen. Bitte erneut mit Spotify anmelden.");
  }
  if (!refreshWait) {
    refreshWait = refreshTokens(tokens.refresh_token).finally(() => {
      refreshWait = null;
    });
  }
  const next = await refreshWait;
  return next.access_token;
}

async function refreshTokens(refreshToken) {
  try {
    const tokens = await requestToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    return storeTokens({
      ...tokens,
      refresh_token: tokens.refresh_token || refreshToken,
    });
  } catch (err) {
    if (err instanceof SpotifyError && (err.code === "auth-expired" || err.status === 400 || err.status === 401)) {
      logout();
      throw new SpotifyError("auth-expired", "Anmeldung abgelaufen. Bitte erneut mit Spotify anmelden.");
    }
    throw err;
  }
}

async function requestToken(params) {
  if (!isConfigured()) {
    throw new SpotifyError("no-client-id", "In shared/spotify-config.js fehlt die Spotify Client ID.");
  }
  const body = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    ...params,
  });
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    console.error("[spotify] Token", err);
    throw new SpotifyError("network", "Keine Verbindung zu Spotify.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw fromTokenError(response.status, data);
  if (!data.access_token) throw new SpotifyError("auth", "Spotify hat kein Zugriffstoken geliefert.");
  return data;
}

async function storeTokens(tokens) {
  const expiresIn = Math.max(30, Number(tokens.expires_in) || 3600);
  const prev = get(TOKEN_KEY, null) || {};
  const next = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || prev.refresh_token || "",
    expiresAt: Date.now() + expiresIn * 1000,
    tokenType: tokens.token_type || "Bearer",
    scope: tokens.scope || SCOPES,
    displayName: prev.displayName || "",
    userId: prev.userId || "",
  };
  set(TOKEN_KEY, next);
  try {
    const me = await fetchMe(next.access_token);
    next.displayName = me.display_name || me.id || "Spotify-Konto";
    next.userId = me.id || "";
    set(TOKEN_KEY, next);
  } catch (err) {
    console.error("[spotify] Profil", err);
  }
  return next;
}

async function fetchMe(accessToken) {
  const response = await fetch(`${API_URL}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw fromApiError(response.status, data);
  return data;
}

function fromTokenError(status, data) {
  const desc = String(data?.error_description || data?.error || "");
  const lower = desc.toLowerCase();
  if (status === 400 && /redirect/i.test(desc)) {
    return new SpotifyError(
      "redirect",
      `Redirect-URI stimmt nicht. Im Dashboard genau eintragen: ${redirectUri()}`,
      status
    );
  }
  if (/invalid_client|invalid client/i.test(desc) || status === 400 && /client/i.test(lower)) {
    return new SpotifyError(
      "client",
      "Ungültige Client ID oder die App ist im Spotify Developer Dashboard nicht richtig eingerichtet.",
      status
    );
  }
  if (/not registered|developer dashboard|user may not be registered/i.test(desc)) {
    return new SpotifyError(
      "allowlist",
      "Dieses Spotify-Konto ist im Developer Dashboard nicht freigeschaltet (User Management).",
      status
    );
  }
  if (status === 401 || /invalid_grant|expired/i.test(lower)) {
    return new SpotifyError("auth-expired", "Anmeldung abgelaufen. Bitte erneut mit Spotify anmelden.", status);
  }
  return new SpotifyError("auth", desc || "Anmeldung bei Spotify fehlgeschlagen.", status);
}

function fromApiError(status, data) {
  const reason = String(data?.error?.reason || "");
  const message = String(data?.error?.message || data?.error_description || data?.error || "");
  const blob = `${reason} ${message}`.toLowerCase();
  if (status === 401) {
    return new SpotifyError("auth-expired", "Anmeldung abgelaufen. Bitte erneut mit Spotify anmelden.", status);
  }
  if (status === 403 && (/premium/i.test(blob) || reason === "PREMIUM_REQUIRED")) {
    return new SpotifyError("premium", "Spotify Premium ist nötig, um Songs per App zu starten.", status);
  }
  if (/not registered|developer dashboard/i.test(blob)) {
    return new SpotifyError(
      "allowlist",
      "Dieses Spotify-Konto ist im Developer Dashboard nicht freigeschaltet (User Management).",
      status
    );
  }
  if (status === 404 || reason === "NO_ACTIVE_DEVICE" || /no active device|no device/i.test(blob)) {
    return new SpotifyError(
      "no-device",
      "Kein aktives Gerät gefunden. Öffne die Spotify-App, spiele kurz irgendeinen Song und tippe auf Aktualisieren.",
      status
    );
  }
  if (status === 403) {
    return new SpotifyError("forbidden", message || "Spotify hat den Befehl abgelehnt.", status);
  }
  return new SpotifyError("api", message || `Spotify-Fehler (${status}).`, status);
}

function authErrorMessage(error) {
  if (error === "access_denied") return "Anmeldung abgebrochen.";
  return `Spotify hat die Anmeldung abgelehnt (${error}).`;
}

function clearAuthParams() {
  const url = new URL(location.href);
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.searchParams.delete("error");
  history.replaceState({}, "", url.pathname + url.search + url.hash);
}

function randomString(bytes) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return base64Url(arr);
}

async function sha256Base64Url(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64Url(new Uint8Array(hash));
}

function base64Url(bytes) {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
