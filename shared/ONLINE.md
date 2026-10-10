# Online-Spiele (Firebase)

Gemeinsames Fundament: `shared/online.js`, `shared/lobby.js`, `shared/firebase-config.js`.
Regeln: `database.rules.json` (in der Firebase-Konsole veröffentlichen).

## Host ist die einzige Wahrheit

- Nur der Host schreibt den Spielzustand (`setState`) und Raum-Meta (Status, Einstellungen).
- Mitspieler schicken Aktionen (`sendAction`); der Host empfängt sie mit `onAction`, prüft sie und aktualisiert den Zustand.
- Alle Geräte rendern denselben Zustand aus `onRoomChange` – keine lokale „Wahrheit“ neben dem Host.

## Firebase speichert keine leeren Arrays und kein `undefined`

Beim Schreiben verschwinden u. a.:

- leere Arrays (`locked: []` → Feld fehlt)
- `undefined`-Felder
- manchmal `null` je nach Pfad

Beim **Einlesen** deshalb immer normalisieren, sonst stürzt die UI ab (z. B. `.includes` auf `undefined`).

Hilfsfunktionen in `online.js`:

```js
import { normalizeRemote, readArray } from "../../shared/online.js";

// Ein Array-Feld
const locked = readArray(raw.locked);

// Mehrere Felder auf einmal
const state = normalizeRemote(raw, {
  arrays: ["players", "locked", "usedCategories"],
  defaults: {
    started: false,
    paused: false,
    deadline: null,
  },
});
```

Vor dem Schreiben: `setState` serialisiert bereits JSON-sicher (`undefined` fliegt raus). Arrays mit Inhalt bleiben; leere Arrays fehlen beim nächsten Lesen – deshalb `normalizeRemote` / `readArray` in der eigenen `migrateState`.

## Lobby und `settingsPanel`

Ablauf: zuerst Raum (erstellen/beitreten), danach Einstellungen in der Lobby.

```js
mountLobby(app, {
  gameId: "mein-spiel",
  title: "Mein Spiel",
  minPlayers: 2,
  maxPlayers: 8,
  settingsPanel: {
    initial: defaultSettings(),
    summarize(settings) {
      // Kurzer Text für Mitspieler (nur lesen)
      return "Normal · 10 Runden · …";
    },
    render(container, { settings, isHost, onChange }) {
      // Host-UI: bei Änderung onChange(nextSettings) aufrufen
      // → schreibt meta.settings für alle live mit
    },
  },
  async onBeforeStart(room) {
    // Ersten Spielzustand setzen (Host)
    await setState(freshState(room.players, room.settings, …));
  },
  onStart(room) {
    // status === "playing" – Spielbildschirm für Host und Mitspieler
  },
});
```

`room.settings` kommt aus der Lobby; Mitspieler sehen `summarize`, der Host den aufklappbaren Bereich.

## Fehler nie still verschlucken

- Firebase-Fehler: Meldung auf dem Bildschirm **und** `console.error`
- Fehlgeschlagene `setState` / `sendAction` / Start: Nutzer informieren, Start-Button wieder freigeben
- `onStart` / Render nach Statuswechsel: try/catch mit sichtbarer Fehlermeldung

Offline-Spiele dürfen Firebase nicht laden, solange der Online-Modus nicht gewählt ist.

## Raum schließen und verlassen

In der Lobby und während des Spiels (⋯-Menü):

- **Host:** „Raum schließen“ (mit Bestätigung). Das Spiel endet für alle, Mitspieler sehen „Der Host hat den Raum geschlossen“ und landen auf dem Startbildschirm des Spiels. `rooms`, `roomIndex` und `roomSecrets` werden gelöscht. Die gespeicherte Sitzung ebenfalls – kein automatisches Wiederbeitreten.
- **Mitspieler:** „Raum verlassen“ (mit Bestätigung). Der Spieler verschwindet aus der Liste, die anderen sehen „Anna hat den Raum verlassen“. Sitzung wird gelöscht.

Während eines laufenden Spiels, je nach Spiel:

- **Schiffe versenken:** der andere gewinnt kampflos („Gegner hat das Spiel verlassen“).
- **Tapper:** der Spieler fliegt aus der Reihenfolge; bei weniger als 2 Spielern endet die Runde.
- **Tempelgold:** die Runde kann nicht weitergehen. Ende mit Hinweis und aufgedeckten Rollen.

Spiele rufen `closeRoom()` (Host) bzw. `leavePlay()` (Mitspieler) auf; die Lobby nutzt dieselben Bestätigungen.
