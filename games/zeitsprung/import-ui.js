import {
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
import { DEFAULT_VARIANT_NAME } from "./rules.js";
import { effectiveYear, isSuspiciousAlbum } from "./suspicious.js";
import {
  deleteSonglist,
  listSonglists,
  loadSonglist,
  mergeCatalogWithStored,
  saveSonglist,
} from "./songlist-store.js";

let app = document.getElementById("app");

let session = getStoredSession();
let list = null;
let variants = [];
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

let onBack = () => {};

export function showImport(root, options = {}) {
  app = root;
  onBack = options.onBack || (() => {});
  if (options.session) session = options.session;
  if (options.bootError) bootError = options.bootError;
  paint();
  listSonglists()
    .then((rows) => {
      variants = rows;
      paint();
    })
    .catch((err) => {
      console.error("[zeitsprung] Varianten", err);
    });
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
    if (!list.name) list.name = DEFAULT_VARIANT_NAME;
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
    const allBtn = el("button", "btn", "Alle (diese Variante)");
    allBtn.type = "button";
    const allVariantsBtn = el("button", "btn", "Alle Varianten");
    allVariantsBtn.type = "button";
    const cancel = el("button", "btn", "Abbrechen");
    cancel.type = "button";
    const finish = (value) => {
      back.remove();
      resolve(value);
    };
    suspectBtn.addEventListener("click", () => finish("suspect"));
    allBtn.addEventListener("click", () => finish("all"));
    allVariantsBtn.addEventListener("click", () => finish("all-variants"));
    cancel.addEventListener("click", () => finish(null));
    back.addEventListener("click", (event) => {
      if (event.target === back) finish(null);
    });
    dialog.append(suspectBtn, allBtn, allVariantsBtn, cancel);
    back.append(dialog);
    document.body.append(back);
    suspectBtn.focus();
  });
}

function askConfirm(message) {
  return new Promise((resolve) => {
    const back = el("div", "dialog-back");
    const dialog = el("div", "dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.append(el("p", "", message));
    const ok = el("button", "btn primary", "Löschen");
    ok.type = "button";
    const cancel = el("button", "btn", "Abbrechen");
    cancel.type = "button";
    const finish = (value) => {
      back.remove();
      resolve(value);
    };
    ok.addEventListener("click", () => finish(true));
    cancel.addEventListener("click", () => finish(false));
    back.addEventListener("click", (event) => {
      if (event.target === back) finish(false);
    });
    dialog.append(ok, cancel);
    back.append(dialog);
    document.body.append(back);
    cancel.focus();
  });
}

async function collectAllVariantSongs(onlySuspect) {
  const rows = variants.length ? variants : await listSonglists();
  const byId = new Map();
  for (const meta of rows) {
    const stored = await loadSonglist(meta.playlistId);
    if (!stored) continue;
    const name = stored.name || meta.name || DEFAULT_VARIANT_NAME;
    for (const song of Object.values(stored.songs || {})) {
      if (!song?.id) continue;
      if (onlySuspect && !song.suspicious) continue;
      const prev = byId.get(song.id);
      if (!prev) {
        byId.set(song.id, {
          ...song,
          variantNames: [name],
        });
      } else {
        if (!prev.variantNames.includes(name)) prev.variantNames.push(name);
        if (song.yearOverride != null && prev.yearOverride == null) prev.yearOverride = song.yearOverride;
        if (song.suspicious) prev.suspicious = true;
      }
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      String(a.title).localeCompare(String(b.title), "de") ||
      String(a.artist).localeCompare(String(b.artist), "de")
  );
}

async function songsIndexAllVariants() {
  const rows = variants.length ? variants : await listSonglists();
  const byId = {};
  for (const meta of rows) {
    const stored = await loadSonglist(meta.playlistId);
    if (!stored) continue;
    for (const song of Object.values(stored.songs || {})) {
      if (!song?.id) continue;
      if (!byId[song.id]) byId[song.id] = { ...song };
      else if (song.yearOverride != null && byId[song.id].yearOverride == null) {
        byId[song.id] = { ...byId[song.id], yearOverride: song.yearOverride };
      }
    }
  }
  return byId;
}

async function downloadCsv(csv, fileName, shareTitle) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
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
        await navigator.share({ files: [file], title: shareTitle, text: shareTitle });
        shared = true;
      } else {
        await navigator.share({ title: shareTitle, text: csv });
        shared = true;
      }
    }
  } catch (err) {
    if (err?.name !== "AbortError") console.error("[zeitsprung] Teilen", err);
  }
  return { copied, shared };
}

async function exportSongList() {
  const scope = await askExportScope();
  if (!scope) return;

  let rows;
  let withVariant = false;
  let fileName = "zeitsprung-songs.csv";
  if (scope === "all-variants") {
    setStatus("Lade alle Varianten …");
    try {
      rows = await collectAllVariantSongs(false);
      withVariant = true;
      fileName = "zeitsprung-alle-varianten.csv";
    } catch (err) {
      setStatus(explainError(err) || err.message, true);
      return;
    }
  } else {
    if (!list) {
      setStatus("Zuerst eine Variante laden.", true);
      return;
    }
    rows = songRows().filter((song) => (scope === "suspect" ? song.suspicious : true));
  }

  if (!rows.length) {
    setStatus(scope === "suspect" ? "Keine verdächtigen Songs." : "Keine Songs zum Export.", true);
    return;
  }
  const csv = buildSongCsv(rows, { withVariant });
  const { copied, shared } = await downloadCsv(csv, fileName, list?.title || "Zeitsprung Songliste");
  const bits = [`${rows.length} Songs exportiert`];
  if (withVariant) bits.push("alle Varianten");
  if (copied) bits.push("Zwischenablage");
  bits.push("Datei");
  if (shared) bits.push("Teilen");
  setStatus(bits.join(" · "));
}

async function openCorrectionPreview(raw) {
  setStatus("Prüfe Korrekturen …");
  let songsById;
  try {
    songsById = await songsIndexAllVariants();
    if (!Object.keys(songsById).length && list?.songs) songsById = list.songs;
  } catch (err) {
    setStatus(explainError(err) || err.message, true);
    return;
  }
  if (!Object.keys(songsById).length) {
    setStatus("Keine Songlisten geladen – zuerst Varianten anlegen.", true);
    return;
  }
  const parsed = parseYearCorrections(raw, songsById);
  correctionPreview = { ...parsed, raw: String(raw || "") };
  if (!parsed.changes.length && !parsed.unknown.length && !parsed.invalid.length) {
    setStatus("Keine brauchbaren Zeilen gefunden.", true);
  } else {
    setStatus(
      `Vorschau: ${parsed.changes.length} Änderungen in allen Varianten · ${parsed.unknown.length} unbekannte IDs · ${parsed.invalid.length} ungültig`
    );
  }
  paint();
}

async function applyCorrections() {
  if (!correctionPreview?.changes?.length) return;
  const changes = correctionPreview.changes;
  saving = true;
  paint();
  try {
    const rows = variants.length ? variants : await listSonglists();
    let listsTouched = 0;
    let songHits = 0;
    for (const meta of rows) {
      const stored = await loadSonglist(meta.playlistId);
      if (!stored) continue;
      let dirty = false;
      for (const change of changes) {
        const song = stored.songs[change.id];
        if (!song) continue;
        song.yearOverride = change.to;
        song.suspicious = false;
        dirty = true;
        songHits += 1;
      }
      if (dirty) {
        await saveSonglist(stored);
        listsTouched += 1;
      }
    }
    if (list?.playlistId) {
      list = (await loadSonglist(list.playlistId)) || list;
    }
    correctionPreview = null;
    variants = await listSonglists().catch(() => variants);
    setStatus(
      `${changes.length} Korrekturen in ${listsTouched} Varianten übernommen (${songHits} Song-Einträge).`
    );
  } catch (err) {
    console.error("[zeitsprung] Korrekturen", err);
    setStatus(explainError(err) || err.message, true);
  } finally {
    saving = false;
    paint();
  }
}

async function removeCurrentVariant() {
  if (!list?.playlistId) return;
  const name = list.name || list.title || "diese Variante";
  const ok = await askConfirm(`Variante „${name}“ wirklich löschen? Das lässt sich nicht rückgängig machen.`);
  if (!ok) return;
  saving = true;
  paint();
  try {
    const id = list.playlistId;
    await deleteSonglist(id);
    list = null;
    correctionPreview = null;
    variants = await listSonglists().catch(() => variants.filter((row) => row.playlistId !== id));
    setStatus(`Variante „${name}“ gelöscht.`);
  } catch (err) {
    console.error("[zeitsprung] Variante löschen", err);
    setStatus(explainError(err) || err.message, true);
  } finally {
    saving = false;
    paint();
  }
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
    box.append(el("p", "note is-bad", "Unbekannte IDs (in keiner Variante):"));
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
  const keepName =
    app.querySelector("[name=variant-name]")?.value || list?.name || DEFAULT_VARIANT_NAME;

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
      variants = await listSonglists().catch(() => variants);
      paint();
      loadBtn.disabled = false;
    });
    body.append(loadBtn);

    if (variants.length) {
      body.append(el("h2", "lobby-list-title", "Gespeicherte Varianten"));
      for (const row of variants) {
        const open = el("button", "btn", `${row.name} (${row.songCount} Songs)`);
        open.type = "button";
        open.addEventListener("click", async () => {
          try {
            const stored = await loadSonglist(row.playlistId);
            if (!stored) {
              setStatus("Variante nicht gefunden.", true);
              return;
            }
            list = stored;
            if (!String(stored.name || "").trim()) {
              list.name = DEFAULT_VARIANT_NAME;
              await persist();
            } else {
              paint();
            }
            setStatus(`„${list.name}“ geladen`);
          } catch (err) {
            setStatus(explainError(err) || err.message, true);
          }
        });
        body.append(open);
      }
    }

    if (list) {
      const nameLabel = el("label", "lobby-field", "Name der Variante");
      const nameInput = el("input", "text-input");
      nameInput.name = "variant-name";
      nameInput.value = keepName;
      nameInput.addEventListener("change", () => {
        list.name = nameInput.value.trim() || DEFAULT_VARIANT_NAME;
        persist();
      });
      nameLabel.append(nameInput);
      body.append(nameLabel);

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
      const deleteBtn = el("button", "btn", "Variante löschen");
      deleteBtn.type = "button";
      deleteBtn.disabled = saving;
      deleteBtn.addEventListener("click", () => removeCurrentVariant());
      io.append(exportBtn, deleteBtn);
      body.append(io);

      body.append(el("h2", "lobby-list-title", "Korrekturen einspielen"));
      body.append(
        el(
          "p",
          "note",
          "Jahre gelten per Track-ID in allen Varianten. Eine Spalte „Variante“ wird ignoriert."
        )
      );
      const importLabel = el("label", "lobby-field", "Text einfügen (ID;…;Jahr)");
      const importArea = document.createElement("textarea");
      importArea.className = "text-input zs-import-area";
      importArea.name = "corrections";
      importArea.rows = 5;
      importArea.placeholder = "Variante;ID;Titel;Interpret;Album;Jahr;Verdächtig";
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

  const back = el("button", "btn", "Zurück");
  back.type = "button";
  back.addEventListener("click", () => onBack());
  dock.append(back);
}
