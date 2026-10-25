/** Album-Hinweise, die das Release-Jahr oft unzuverlässig machen. */

const SUSPICIOUS_WORDS = [
  "remaster",
  "remastered",
  "best of",
  "greatest hits",
  "hits",
  "collection",
  "anniversary",
  "deluxe",
  "live",
  "edition",
  "compilation",
];

export function isSuspiciousAlbum(albumName, albumType = "") {
  if (String(albumType || "").toLowerCase() === "compilation") return true;
  const name = String(albumName || "").toLowerCase();
  if (!name) return false;
  return SUSPICIOUS_WORDS.some((word) => name.includes(word));
}

export function effectiveYear(song) {
  if (song?.yearOverride != null && Number(song.yearOverride) > 0) return Number(song.yearOverride);
  return Number(song?.year) || 0;
}
