/**
 * Simulationslauf: 10 Runden mit Testspielern, Spotify inkl. 502 nachgestellt.
 * Start: node games/zeitsprung/play-sim.js
 */

import {
  beginMatch,
  computeStartMs,
  finishReveal,
  firstValidGap,
  makeCue,
  proposePlace,
  START_MODE_RANDOM,
  START_MODE_START,
} from "./logic.js";
import { positionMsWasIgnored, sleepDecision } from "./play-policy.js";
import { isTransientSpotifyStatus, spotifyRetryDelayMs } from "../../shared/spotify-retry.js";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function trackId(i) {
  return `${"a".repeat(20)}${String(i).padStart(2, "0")}`;
}

function fakeCatalog() {
  const playlistId = `${"b".repeat(20)}01`;
  const songs = [];
  for (let i = 0; i < 40; i += 1) {
    const id = trackId(i);
    songs.push({
      id,
      uri: `spotify:track:${id}`,
      title: `Song ${i}`,
      artist: `Interpret ${i}`,
      year: 1970 + (i % 40),
      playlistId,
      durationMs: i % 3 === 0 ? 0 : 180_000 + i * 1000,
      playlistIndex: i,
    });
  }
  return songs;
}

function retryPlay(fake, cue) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return fake.play(cue);
    } catch (err) {
      lastErr = err;
      if (!isTransientSpotifyStatus(err.status) || attempt === 2) throw err;
    }
  }
  throw lastErr;
}

class FakeSpotify {
  constructor() {
    this.plays = [];
    this.seeks = [];
    this.sleepHints = [];
    this.failPlayOnce = new Set();
    this.ignorePosition = new Set();
  }

  play(cue) {
    if (this.failPlayOnce.has(cue.cueId)) {
      this.failPlayOnce.delete(cue.cueId);
      const err = new Error("Bad Gateway");
      err.status = 502;
      err.code = "spotify-temp";
      throw err;
    }
    const positionMs = Math.max(0, Math.floor(Number(cue.positionMs) || 0));
    this.plays.push({ cueId: cue.cueId, trackUri: cue.trackUri, positionMs });
    const ignore = this.ignorePosition.has(cue.cueId);
    const progressMs = ignore ? 1200 : positionMs + 1600;
    return {
      unreadable: false,
      progressMs,
      durationMs: cue.durationMs || 180_000,
      isPlaying: true,
      uri: cue.trackUri,
    };
  }

  maybeSeek(cue, playback) {
    const startMs = Math.max(0, Math.floor(Number(cue.positionMs) || 0));
    if (positionMsWasIgnored(startMs, playback.progressMs)) {
      this.seeks.push({ cueId: cue.cueId, startMs, progressMs: playback.progressMs });
    }
  }
}

function runPolicyChecks() {
  assert(computeStartMs(0, 30, START_MODE_START, 0.5) === 0, "Anfang bleibt 0");
  const unknown = computeStartMs(0, 30, START_MODE_RANDOM, 0.5);
  assert(unknown === 50_000, `Unbekannte Länge Mitte: ${unknown}`);
  const unknownLow = computeStartMs(0, 30, START_MODE_RANDOM, 0);
  const unknownHigh = computeStartMs(0, 30, START_MODE_RANDOM, 1);
  assert(unknownLow === 30_000 && unknownHigh === 70_000, "Fallback 30–70 s");
  const long = computeStartMs(180_000, 30, START_MODE_RANDOM, 0.4);
  assert(long === 72_000, `180s bei 40%: ${long}`);
  const short = computeStartMs(90_000, 30, START_MODE_RANDOM, 0.6);
  assert(short <= 54_000, `Song unter 2:30 muss früher starten (${short})`);
  assert(short >= 18_000, `90s-Song nicht vor 20% (${short})`);

  assert(!positionMsWasIgnored(50_000, 51_600), "übernommener Startpunkt");
  assert(positionMsWasIgnored(50_000, 1200), "ignorierter Startpunkt");
  assert(!positionMsWasIgnored(0, 1500), "Start am Anfang braucht kein Seek");

  assert(isTransientSpotifyStatus(502) && isTransientSpotifyStatus(429), "502/429 vorübergehend");
  assert(!isTransientSpotifyStatus(404), "404 nicht vorübergehend");
  assert(spotifyRetryDelayMs(502, 0) === 1000, "Retry 1 s");
  assert(spotifyRetryDelayMs(502, 1) === 2000, "Retry 2 s");
  assert(spotifyRetryDelayMs(429, 0, "3") === 3000, "Retry-After Sekunden");

  assert(!sleepDecision({ chosenId: "d1", devices: [{ id: "d1" }] }).sleep, "Gerät da");
  assert(sleepDecision({ chosenId: "d1", devices: [{ id: "d2" }] }).sleep, "Gerät fehlt");
  assert(!sleepDecision({ chosenId: "d1", devices: [], serverError: true }).sleep, "kein Schlafen bei 502");
  assert(!sleepDecision({ chosenId: "d1", devices: [], loadFailed: true }).sleep, "kein Schlafen bei Ladefehler");
}

function runTenRounds() {
  const songs = fakeCatalog();
  const players = [
    { id: "host", name: "Host", dummy: false },
    { id: "p2", name: "Test 2", dummy: true },
    { id: "p3", name: "Test 3", dummy: true },
  ];
  const match = beginMatch(players, {
    playlistIds: [songs[0].playlistId],
    mix: false,
    goal: 20,
    clipSec: 30,
    startMode: START_MODE_RANDOM,
    startTokens: 2,
    challengeOn: false,
  }, songs);
  let { state, secrets } = match;
  const fake = new FakeSpotify();
  const rounds = [];

  for (let n = 0; n < 10; n += 1) {
    assert(state.phase === "listen" && state.cue?.cueId, `Runde ${n + 1}: Cue fehlt (${state.phase})`);
    const cue = state.cue;
    if (n === 1 || n === 4 || n === 7) fake.failPlayOnce.add(cue.cueId);
    if (n === 6) fake.ignorePosition.add(cue.cueId);

    const withoutDuration = makeCue(
      { ...songs[0], durationMs: 0, id: trackId(99), uri: `spotify:track:${trackId(99)}` },
      30,
      songs[0].playlistId,
      START_MODE_RANDOM
    );
    assert(
      withoutDuration.positionMs >= 30_000 && withoutDuration.positionMs <= 70_000,
      `Cue ohne Länge muss 30–70 s setzen (${withoutDuration.positionMs})`
    );

    if (cue.startMode === START_MODE_RANDOM) {
      if (cue.durationMs > 0) {
        assert(cue.positionMs > 0, `Runde ${n + 1}: position_ms fehlt trotz Länge`);
      } else {
        assert(
          cue.positionMs >= 30_000 && cue.positionMs <= 70_000,
          `Runde ${n + 1}: Fallback 30–70 s, war ${cue.positionMs}`
        );
      }
    }

    const playback = retryPlay(fake, cue);
    fake.maybeSeek(cue, playback);
    rounds.push(cue.cueId);

    const year = secrets.current.year;
    const gap = firstValidGap(state.timelines[state.activeId], year);
    const placed = proposePlace(state, secrets, state.activeId, gap);
    assert(!placed.error, `Runde ${n + 1}: Legen ${placed.error}`);
    state = placed.state;
    secrets = placed.secrets;
    if (state.phase === "end") break;
    if (state.phase === "reveal") {
      const next = finishReveal(state, secrets);
      assert(!next.error, `Runde ${n + 1}: Reveal ${next.error}`);
      state = next.state;
      secrets = next.secrets;
    }
  }

  assert(rounds.length === 10, `Nur ${rounds.length} Runden`);
  assert(fake.plays.length === 10, `Play-Aufrufe ${fake.plays.length}, erwartet 10`);
  const ids = fake.plays.map((row) => row.cueId);
  assert(new Set(ids).size === 10, "Jeder Cue genau einmal abgespielt");
  for (const play of fake.plays) {
    assert(Number.isFinite(play.positionMs), "Play ohne position_ms");
  }
  assert(fake.seeks.length === 1, `Seek nur als Notlösung, war ${fake.seeks.length}`);
  assert(fake.seeks[0].cueId === rounds[6], "Seek nur in der Runde mit ignoriertem position_ms");
  assert(fake.sleepHints.length === 0, "Keine Schlafen-Meldung");
  return { plays: fake.plays.length, seeks: fake.seeks.length };
}

runPolicyChecks();
const summary = runTenRounds();
console.log(`OK: 10 Runden, ${summary.plays} Play-Aufrufe, ${summary.seeks} Seek-Notlösung, keine Schlafen-Meldung`);
