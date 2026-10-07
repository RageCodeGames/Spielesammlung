import { APP_NAME, APP_TAGLINE, games } from "./games.js";
import { isSoundEnabled, playTone, setSoundEnabled, unlock } from "./sound.js";
import { initUpdates } from "./update.js";

function renderSoundButton(button) {
  const on = isSoundEnabled();
  button.textContent = on ? "Ton an" : "Ton aus";
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.setAttribute("aria-label", on ? "Ton ausschalten" : "Ton einschalten");
}

function createTile(game) {
  const item = document.createElement("li");
  const link = document.createElement("a");
  link.className = "tile";
  link.href = game.href;

  const emoji = document.createElement("span");
  emoji.className = "tile-emoji";
  emoji.setAttribute("aria-hidden", "true");
  emoji.textContent = game.emoji;

  const text = document.createElement("span");
  text.className = "tile-text";

  const name = document.createElement("h2");
  name.className = "tile-name";
  name.textContent = game.name;

  const description = document.createElement("p");
  description.className = "tile-desc";
  description.textContent = game.description;

  text.append(name, description);

  if (game.available === false) {
    link.classList.add("tile-soon");
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "Bald verfügbar";
    text.append(badge);
  }

  link.append(emoji, text);
  item.append(link);
  return item;
}

function initHub() {
  const app = document.getElementById("app");
  if (!app) return;

  document.title = APP_NAME;

  const header = document.createElement("header");
  header.className = "hub-header";

  const heading = document.createElement("div");
  heading.className = "hub-heading";

  const title = document.createElement("h1");
  title.textContent = APP_NAME;

  const tagline = document.createElement("p");
  tagline.className = "tagline";
  tagline.textContent = APP_TAGLINE;

  heading.append(title, tagline);

  const soundButton = document.createElement("button");
  soundButton.type = "button";
  soundButton.className = "sound-toggle";
  renderSoundButton(soundButton);
  soundButton.addEventListener("click", async () => {
    const next = !isSoundEnabled();
    setSoundEnabled(next);
    renderSoundButton(soundButton);
    if (next) {
      await unlock();
      playTone({ frequency: 587, duration: 0.14, type: "sine" });
    }
  });

  header.append(heading, soundButton);

  const main = document.createElement("main");
  const list = document.createElement("ul");
  list.className = "tiles";
  for (const game of games) {
    list.append(createTile(game));
  }
  main.append(list);

  app.append(header, main);
}

initHub();
initUpdates();
