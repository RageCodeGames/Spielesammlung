/**
 * Hub-Inhalt. APP_NAME ist der Titel der Sammlung (einzige Stelle im Script).
 *
 * Neues Spiel: einen Eintrag in `games` ergänzen und eine Seite unter
 * games/<ordner>/index.html anlegen. Die neue Datei in sw.js bei PRECACHE
 * eintragen und dort die Cache-Version erhöhen.
 *
 * available: false markiert die Kachel mit „Bald verfügbar“.
 *
 * Der Name unter dem Homescreen-Icon steht zusätzlich in manifest.json
 * (name, short_name) und im Apple-Meta-Tag von index.html.
 */

export const APP_NAME = "Kajütenspiele";

export const APP_TAGLINE = "Kleine Spiele für zwischendurch – auch ohne Netz.";

export const games = [
  {
    id: "tapper",
    name: "Tapper",
    description: "Nennt Begriffe, bevor die Bombe explodiert.",
    emoji: "👆",
    href: "./games/tapper/index.html",
    available: true,
  },
  {
    id: "schiffe",
    name: "Schiffe versenken",
    description: "Finde die versteckten Schiffe.",
    emoji: "🚢",
    href: "./games/schiffe/index.html",
    available: true,
  },
  {
    id: "tempel",
    name: "Tempelgold",
    description: "Bluff und Deduktion im Tempel.",
    emoji: "🏛️",
    href: "./games/tempel/index.html",
    available: true,
  },
];
