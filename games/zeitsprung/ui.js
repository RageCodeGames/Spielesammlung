import { mountOrientation } from "../../shared/orientation.js";
import {
  completeLoginIfRedirected,
  explainError,
  fetchPlaylistCatalog,
  getStoredSession,
  isConfigured,
  login,
  logout,
  parsePlaylistInput,
  redirectUri,
} from "../../shared/spotify.js";
import { buildSongCsv, parseYearCorrections } from "./csv.js";
import { effectiveYear, isSuspiciousAlbum } from "./suspicious.js";
import { loadSonglist, mergeCatalogWithStored, saveSonglist } from "./songlist-store.js";

const app = document.getElementById("app");
/** Import/Lobby/Start: Hochformat. Querformat erst im laufenden Spiel (Zeitleiste). */
const orientation = mountOrientation("portrait");

let session = getStoredSession();
let list = null;
let filterQuery = "";
let onlySuspicious = false;
let statusText = "";
let statusBad = false;
let saving = false;
let bootError = "";
/** @type {null | { changes: Array, unknown: Array, invalid: Array, raw: string }} */
let correctionPreview = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setStatus(text, bad = false) {
  statusText = text || "";
  statusBad = bad;
  const node = app.querySelector("[data-status]");
  if (!node) return;
  node.hidden = !statusText;
  node.className = bad ? "note is-bad" : "note";
  node.textContent = statusText;
}

/** Für später: Zeitleiste → Querformat, Spielende → Hochformat. */
export function setZeitsprungPlayOrientation(playing) {
  orientation.setPreferred(playing ? "landscape" : "portrait");
}

function songRows() {
  if (!list?.songs) return [];
  return Object.values(list.songs).sort(
    (a, b) =>
      String(a.title).localeCompare(String(b.title), "de") ||
      String(a.artist).localeCompare(String(b.artist), "de")
  );
}

function visibleSongs() {
  const q = filterQuery.trim().toLowerCase();
  return songRows().filter((song) => {
    if (onlySuspicious && !song.suspicious) return false;
    if (!q) return true;
    const year = String(effectiveYear(song));
    return (
      song.title.toLowerCase().includes(q) ||
      song.artist.toLowerCase().includes(q) ||
      song.album.toLowerCase().includes(q) ||
      year.includes(q)
    );
  });
}

async function persist() {
  if (!list) return;
  saving = true;
  paint();
  try {
    list = await saveSonglist(list);
    setStatus(`Gespeichert · ${Object.keys(list.songs).length} Songs`);
  } catch (err) {
    console.error("[zeitsprung] speichern", err);
    setStatus(explainError(err) || err.message, true);
  } finally {
    saving = false;
    paint();
  }
}

async function loadFromSpotify(playlistInput) {
  const parsed = parsePlaylistInput(playlistInput);
  if (!parsed.uri) {
    setStatus(parsed.error, true);
    return;
  }
  setStatus("Lade Playlist von Spotify …");
  try {
    const catalog = await fetchPlaylistCatalog(parsed.uri);
    catalog.tracks = catalog.tracks.map((track) => ({
      ...track,
      suspicious: isSuspiciousAlbum(track.album, track.albumType),
    }));
    const stored = await loadSonglist(catalog.id);
    list = mergeCatalogWithStored(catalog, stored);
    list = await saveSonglist(list);
    correctionPreview = null;
    setStatus(`„${list.title}“ · ${Object.keys(list.songs).length} Songs (Korrekturen behalten)`);
    paint();
  } catch (err) {
    console.error("[zeitsprung] laden", err);
    setStatus(explainError(err) || err.message, true);
  }
}

function askExportScope() {
  return new Promise((resolve) => {
    const back = el("div", "dialog-back");
    const dialog = el("div", "dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.append(el("p", "", "Welche Songs exportieren?"));
    const suspectBtn = el("button", "btn primary", "Nur verdächtige");
    suspectBtn.type = "button";
    const allBtn = el("button", "btn", "Alle");
    allBtn.type = "button";
    const cancel = el("button", "btn", "Abbrechen");
    cancel.type = "button";
    const finish = (value) => {
      back.remove();
      resolve(value);
    };
    suspectBtn.addEventListener("click", () => finish("suspect"));
    allBtn.addEventListener("click", () => finish("all"));
    cancel.addEventListener("click", () => finish(null));
    back.addEventListener("click", (event) => {
      if (event.target === back) finish(null);
    });
    dialog.append(suspectBtn, allBtn, cancel);
    back.append(dialog);
    document.body.append(back);
    suspectBtn.focus();
  });
}

async function exportSongList() {
  if (!list) return;
  const scope = await askExportScope();
  if (!scope) return;
  const rows = songRows().filter((song) => (scope === "suspect" ? song.suspicious : true));
  if (!rows.length) {
    setStatus(scope === "suspect" ? "Keine verdächtigen Songs." : "Keine Songs zum Export.", true);
    return;
  }
  const csv = buildSongCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const fileName = "zeitsprung-songs.csv";
  const file = new File([blob], fileName, { type: "text/csv" });

  let copied = false;
  try {
    await navigator.clipboard.writeText(csv);
    copied = true;
  } catch (err) {
    console.error("[zeitsprung] Zwischenablage", err);
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);

  let shared = false;
  try {
    if (navigator.share) {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "Zeitsprung Songliste", text: list.title || "Songliste" });
        shared = true;
      } else {
        await navigator.share({ title: "Zeitsprung Songliste", text: csv });
        shared = true;
      }
    }
  } catch (err) {
    if (err?.name !== "AbortError") console.error("[zeitsprung] Teilen", err);
  }

  const bits = [`${rows.length} Songs exportiert`];
  if (copied) bits.push("Zwischenablage");
  bits.push("Datei");
  if (shared) bits.push("Teilen");
  setStatus(bits.join(" · "));
}

function openCorrectionPreview(raw) {
  if (!list) {
    setStatus("Zuerst eine Playlist laden.", true);
    return;
  }
  const parsed = parseYearCorrections(raw, list.songs);
  correctionPreview = { ...parsed, raw: String(raw || "") };
  if (!parsed.changes.length && !parsed.unknown.length && !parsed.invalid.length) {
    setStatus("Keine brauchbaren Zeilen gefunden.", true);
  } else {
    setStatus(
      `Vorschau: ${parsed.changes.length} Änderungen · ${parsed.unknown.length} unbekannte IDs · ${parsed.invalid.length} ungültig`
    );
  }
  paint();
}

async function applyCorrections() {
  if (!list || !correctionPreview?.changes?.length) return;
  for (const change of correctionPreview.changes) {
    const song = list.songs[change.id];
    if (!song) continue;
    song.yearOverride = change.to;
    song.suspicious = false;
  }
  const count = correctionPreview.changes.length;
  correctionPreview = null;
  await persist();
  setStatus(`${count} Korrekturen übernommen und gespeichert.`);
}

function paintCorrectionPreview(parent) {
  if (!correctionPreview) return;
  const box = el("div", "zs-correction");
  box.append(el("h2", "lobby-list-title", "Korrekturen – Vorschau"));
  if (correctionPreview.changes.length) {
    const ul = el("ul", "zs-correction-list");
    for (const change of correctionPreview.changes) {
      const item = el(
        "li",
        "",
        `${change.title}: ${change.from || "–"} → ${change.to}`
      );
      ul.append(item);
    }
    box.append(ul);
  } else {
    box.append(el("p", "lead", "Keine gültigen Änderungen."));
  }
  if (correctionPreview.unknown.length) {
    box.append(el("p", "note is-bad", "Unbekannte IDs (nicht in der Liste):"));
    const ul = el("ul", "zs-correction-list is-bad");
    for (const row of correctionPreview.unknown) {
      ul.append(el("li", "", `${row.id} → ${row.year}`));
    }
    box.append(ul);
  }
  if (correctionPreview.invalid.length) {
    box.append(el("p", "note is-bad", "Ungültige Zeilen:"));
    const ul = el("ul", "zs-correction-list is-bad");
    for (const row of correctionPreview.invalid) {
      ul.append(el("li", "", `Zeile ${row.line}: ${row.id || "–"} · ${row.reason} (${row.year ?? ""})`));
    }
    box.append(ul);
  }
  const actions = el("div", "btn-row");
  const apply = el("button", "btn primary", "Übernehmen");
  apply.type = "button";
  apply.disabled = !correctionPreview.changes.length || saving;
  apply.addEventListener("click", () => applyCorrections());
  const cancel = el("button", "btn", "Abbrechen");
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    correctionPreview = null;
    paint();
  });
  actions.append(apply, cancel);
  box.append(actions);
  parent.append(box);
}

function paintList(container) {
  container.innerHTML = "";
  const rows = visibleSongs();
  if (!list) {
    container.append(el("p", "lead", "Noch keine Liste geladen."));
    return;
  }
  if (!rows.length) {
    container.append(el("p", "lead", "Keine Songs für diesen Filter."));
    return;
  }
  const table = el("div", "zs-song-list");
  for (const song of rows) {
    const row = el(
      "article",
      `zs-song${song.suspicious ? " is-suspect" : ""}${song.excluded ? " is-excluded" : ""}`
    );
    const top = el("div", "zs-song-top");
    top.append(el("strong", "zs-song-title", song.title));
    top.append(el("span", "zs-song-artist", song.artist || "–"));
    row.append(top);
    row.append(el("p", "zs-song-album", song.album || "–"));
    if (song.suspicious) {
      row.append(el("p", "note is-bad zs-suspect-flag", "Verdächtiges Jahr (Remaster/Compilation/…)"));
    }

    const tools = el("div", "zs-song-tools");
    const yearLabel = el("label", "lobby-field zs-year-field", "Jahr");
    const yearInput = el("input", "text-input");
    yearInput.type = "number";
    yearInput.min = "1900";
    yearInput.max = "2100";
    yearInput.value = String(effectiveYear(song) || "");
    yearInput.addEventListener("change", () => {
      const next = Math.floor(Number(yearInput.value) || 0);
      if (!next) {
        song.yearOverride = null;
      } else {
        song.yearOverride = next;
        song.suspicious = false;
      }
      persist();
    });
    yearLabel.append(yearInput);
    if (song.year && song.yearOverride != null && song.yearOverride !== song.year) {
      yearLabel.append(el("span", "zs-year-meta", `Spotify: ${song.year}`));
    }
    tools.append(yearLabel);

    const exclude = el("button", "btn", song.excluded ? "Wieder aufnehmen" : "Ausschließen");
    exclude.type = "button";
    exclude.addEventListener("click", () => {
      song.excluded = !song.excluded;
      persist();
    });
    tools.append(exclude);
    row.append(tools);
    table.append(row);
  }
  container.append(table);
  const stats = songRows();
  const excluded = stats.filter((s) => s.excluded).length;
  const suspects = stats.filter((s) => s.suspicious && !s.excluded).length;
  container.append(
    el(
      "p",
      "note",
      `${stats.length} Songs · ${excluded} ausgeschlossen · ${suspects} verdächtig · sichtbar ${rows.length}`
    )
  );
}

function paint() {
  const keepPlaylist = app.querySelector("[name=playlist]")?.value || "";
  const keepQuery = app.querySelector("[name=search]")?.value ?? filterQuery;
  filterQuery = keepQuery;
  const keepSuspect = app.querySelector("[name=only-suspect]")?.checked ?? onlySuspicious;
  onlySuspicious = keepSuspect;
  const keepImport = app.querySelector("[name=corrections]")?.value || correctionPreview?.raw || "";

  app.innerHTML = "";
  const screen = el("div", "screen zs-page");
  const body = el("div", "screen-body");
  const dock = el("div", "screen-dock");
  screen.append(body, dock);
  app.append(screen);

  body.append(el("p", "lobby-kicker", "Vorbereitung"));
  body.append(el("h1", "", "Zeitsprung"));
  body.append(el("p", "lead", "Songliste aus einer Spotify-Playlist laden, Jahre prüfen, für alle speichern."));
  body.append(el("p", "note spotify-uri", `Redirect-URI: ${redirectUri()}`));
  body.append(
    el(
      "p",
      "note",
      "Die Playlist muss dir gehören oder du musst Mitbearbeiter sein (Spotify seit März 2026). Bei Fehlern: abmelden und neu anmelden (Playlist-Rechte)."
    )
  );

  const status = el("p", statusBad ? "note is-bad" : "note");
  status.setAttribute("data-status", "1");
  if (!statusText) status.hidden = true;
  else status.textContent = statusText;
  if (bootError) {
    status.hidden = false;
    status.className = "note is-bad";
    status.textContent = bootError;
  }
  body.append(status);

  if (!isConfigured()) {
    body.append(el("p", "note is-bad", "Spotify Client ID fehlt in shared/spotify-config.js."));
  }

  if (!session) {
    const loginBtn = el("button", "btn primary", "Mit Spotify anmelden");
    loginBtn.type = "button";
    loginBtn.addEventListener("click", async () => {
      loginBtn.disabled = true;
      try {
        await login();
      } catch (err) {
        loginBtn.disabled = false;
        setStatus(explainError(err), true);
      }
    });
    dock.append(loginBtn);
  } else {
    body.append(el("p", "spotify-account", `Spotify-Konto: ${session.displayName}`));
    const out = el("button", "btn", "Abmelden");
    out.type = "button";
    out.addEventListener("click", () => {
      logout();
      session = null;
      list = null;
      correctionPreview = null;
      paint();
    });
    body.append(out);

    const plLabel = el("label", "lobby-field", "Playlist-Link");
    const plInput = el("input", "text-input");
    plInput.name = "playlist";
    plInput.placeholder = "https://open.spotify.com/playlist/…";
    plInput.value = keepPlaylist || (list ? `spotify:playlist:${list.playlistId}` : "");
    plLabel.append(plInput);
    body.append(plLabel);

    const loadBtn = el("button", "btn primary", list ? "Erneut von Spotify laden" : "Songs laden");
    loadBtn.type = "button";
    loadBtn.disabled = saving;
    loadBtn.addEventListener("click", async () => {
      loadBtn.disabled = true;
      await loadFromSpotify(plInput.value);
      loadBtn.disabled = false;
    });
    body.append(loadBtn);

    if (list) {
      body.append(el("h2", "lobby-list-title", list.title || "Songliste"));
      const filters = el("div", "zs-filters");
      const searchLabel = el("label", "lobby-field", "Suche");
      const search = el("input", "text-input");
      search.name = "search";
      search.placeholder = "Titel, Interpret, Album, Jahr";
      search.value = filterQuery;
      search.addEventListener("input", () => {
        filterQuery = search.value;
        paintList(app.querySelector("[data-song-list]"));
      });
      searchLabel.append(search);
      filters.append(searchLabel);
      const suspectRow = el("label", "switch-row");
      const suspect = document.createElement("input");
      suspect.type = "checkbox";
      suspect.name = "only-suspect";
      suspect.checked = onlySuspicious;
      suspect.addEventListener("change", () => {
        onlySuspicious = suspect.checked;
        paintList(app.querySelector("[data-song-list]"));
      });
      suspectRow.append(suspect, el("span", "", "Nur verdächtige Jahre"));
      filters.append(suspectRow);
      body.append(filters);

      const io = el("div", "btn-row zs-io");
      const exportBtn = el("button", "btn", "Liste exportieren");
      exportBtn.type = "button";
      exportBtn.addEventListener("click", () => exportSongList());
      io.append(exportBtn);
      body.append(io);

      body.append(el("h2", "lobby-list-title", "Korrekturen einspielen"));
      const importLabel = el("label", "lobby-field", "Text einfügen (ID;…;Jahr)");
      const importArea = document.createElement("textarea");
      importArea.className = "text-input zs-import-area";
      importArea.name = "corrections";
      importArea.rows = 5;
      importArea.placeholder = "ID;Titel;Interpret;Album;Jahr;Verdächtig";
      importArea.value = keepImport;
      importLabel.append(importArea);
      body.append(importLabel);
      const fileLabel = el("label", "lobby-field", "Oder Datei wählen");
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = ".csv,text/csv,text/plain";
      fileInput.addEventListener("change", async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          importArea.value = text;
          openCorrectionPreview(text);
        } catch (err) {
          console.error("[zeitsprung] Datei", err);
          setStatus("Datei konnte nicht gelesen werden.", true);
        }
      });
      fileLabel.append(fileInput);
      body.append(fileLabel);
      const previewBtn = el("button", "btn", "Korrekturen einspielen");
      previewBtn.type = "button";
      previewBtn.addEventListener("click", () => openCorrectionPreview(importArea.value));
      body.append(previewBtn);

      paintCorrectionPreview(body);

      const listBox = el("div");
      listBox.setAttribute("data-song-list", "1");
      body.append(listBox);
      paintList(listBox);
    }
  }

  const hub = el("a", "btn", "Zur Übersicht");
  hub.href = "../../index.html";
  dock.append(hub);
}

completeLoginIfRedirected()
  .then((ok) => {
    if (ok) session = getStoredSession();
  })
  .catch((err) => {
    bootError = explainError(err);
    console.error("[zeitsprung] Redirect", err);
  })
  .finally(() => {
    session = getStoredSession();
    paint();
  });
