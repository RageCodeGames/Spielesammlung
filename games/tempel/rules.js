/**
 * Zahlen für Tempelgold – eine Tabelle, leicht änderbar.
 * Kammerkarten insgesamt = 5 × Spielerzahl.
 */

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 10;
export const ROUND_COUNT = 4;

/** Spielerzahl → Rollen und Kammerkarten */
export const TABLE = {
  3: { adventurers: 2, guardians: 2, empty: 8, gold: 5, traps: 2 },
  4: { adventurers: 3, guardians: 2, empty: 12, gold: 6, traps: 2 },
  5: { adventurers: 3, guardians: 2, empty: 16, gold: 7, traps: 2 },
  6: { adventurers: 4, guardians: 2, empty: 20, gold: 8, traps: 2 },
  7: { adventurers: 5, guardians: 3, empty: 26, gold: 7, traps: 2 },
  8: { adventurers: 6, guardians: 3, empty: 30, gold: 8, traps: 2 },
  9: { adventurers: 6, guardians: 3, empty: 34, gold: 9, traps: 2 },
  10: { adventurers: 7, guardians: 4, empty: 37, gold: 10, traps: 3 },
};

export function cardsPerHand(round) {
  return Math.max(2, 6 - Number(round) || 1);
}

export function tableFor(playerCount) {
  const row = TABLE[playerCount];
  if (!row) {
    throw new Error("Tempelgold braucht 3 bis 10 Spieler.");
  }
  return row;
}

export function tableTotalsMatch() {
  for (const [n, row] of Object.entries(TABLE)) {
    const cards = row.empty + row.gold + row.traps;
    const want = 5 * Number(n);
    if (cards !== want) return false;
  }
  return true;
}
