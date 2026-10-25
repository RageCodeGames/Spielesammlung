import { effectiveYear } from "./suspicious.js";

export const CSV_HEADER = "ID;Titel;Interpret;Album;Jahr;Verdächtig";
export const CSV_HEADER_ALL = "Variante;ID;Titel;Interpret;Album;Jahr;Verdächtig";

function escapeField(value) {
  const text = String(value ?? "");
  if (/[;"\t\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * CSV-Export.
 * @param {Array} songs
 * @param {{ withVariant?: boolean }} [options]
 */
export function buildSongCsv(songs, options = {}) {
  const withVariant = options.withVariant === true;
  const lines = [withVariant ? CSV_HEADER_ALL : CSV_HEADER];
  for (const song of songs) {
    const cells = [];
    if (withVariant) {
      const names = Array.isArray(song.variantNames)
        ? song.variantNames
        : song.variantName
          ? [song.variantName]
          : [];
      cells.push(escapeField(names.join(", ")));
    }
    cells.push(
      song.id,
      escapeField(song.title),
      escapeField(song.artist),
      escapeField(song.album),
      effectiveYear(song) || "",
      song.suspicious ? "ja" : "nein"
    );
    lines.push(cells.join(";"));
  }
  return `${lines.join("\n")}\n`;
}

function detectDelimiter(line) {
  const tabs = (line.match(/\t/g) || []).length;
  const semis = (line.match(/;/g) || []).length;
  const commas = (line.match(/,/g) || []).length;
  if (tabs >= semis && tabs >= commas && tabs > 0) return "\t";
  if (semis >= commas && semis > 0) return ";";
  if (commas > 0) return ",";
  return ";";
}

/** Einfacher CSV-Splitter inkl. Anführungszeichen. */
export function splitCsvLine(line, delimiter) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells.map((cell) => cell.trim());
}

function isHeaderRow(cells) {
  const lower = cells.map((c) => c.toLowerCase());
  return lower.includes("id") || lower.includes("jahr") || lower[0] === "id" || lower.includes("variante");
}

function validYear(value) {
  const year = Math.floor(Number(String(value).trim()));
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return null;
  return year;
}

/**
 * Korrekturdatei parsen. Spalte „Variante“ wird ignoriert.
 * @returns {{ changes: Array, unknown: Array, invalid: Array }}
 */
export function parseYearCorrections(text, songsById) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const changes = [];
  const unknown = [];
  const invalid = [];
  if (!lines.length) return { changes, unknown, invalid };

  const delimiter = detectDelimiter(lines[0]);
  let start = 0;
  let idIdx = 0;
  let yearIdx = -1;
  const firstCells = splitCsvLine(lines[0], delimiter);
  if (isHeaderRow(firstCells)) {
    start = 1;
    const lower = firstCells.map((c) => c.toLowerCase());
    idIdx = lower.indexOf("id");
    if (idIdx < 0) idIdx = lower[0] === "variante" ? 1 : 0;
    yearIdx = lower.indexOf("jahr");
    if (yearIdx < 0) {
      /* letzte Spalte, die nicht „Verdächtig“ heißt */
      yearIdx = lower.lastIndexOf("verdächtig") >= 0 ? lower.length - 2 : firstCells.length - 1;
      if (yearIdx < 0) yearIdx = firstCells.length - 1;
    }
  }

  const seen = new Set();
  for (let i = start; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i], delimiter);
    if (!cells.length) continue;
    const id = String(cells[idIdx] || "").trim();
    const yearRaw = yearIdx >= 0 ? cells[yearIdx] : cells[cells.length - 1];
    const year = validYear(yearRaw);
    if (!id) {
      invalid.push({ line: i + 1, id: "", year: yearRaw, reason: "Keine ID" });
      continue;
    }
    if (year == null) {
      invalid.push({ line: i + 1, id, year: yearRaw, reason: "Ungültiges Jahr" });
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const song = songsById?.[id];
    if (!song) {
      unknown.push({ line: i + 1, id, year });
      continue;
    }
    const from = effectiveYear(song);
    if (from === year && !song.suspicious) continue;
    changes.push({
      id,
      title: song.title,
      artist: song.artist,
      from,
      to: year,
    });
  }
  return { changes, unknown, invalid };
}
