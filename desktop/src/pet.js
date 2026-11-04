"use strict";

/**
 * The pet's page: draws the sprite each frame, pokes her on a click, opens the
 * chat on a double click, and moves the window when she is dragged. All it can
 * reach is `lainPet`, from pet-preload.js.
 */

const { pixels: spritePixels, pose: spritePose, LINES: SAYINGS } = LainSprite;

const canvas = document.getElementById("sprite");
const ctx = canvas.getContext("2d");
const bubble = document.getElementById("bubble");

let poke = null;
let lastLine = -1;
let blinkUntil = 0;
let nextBlink = performance.now() + 2500;

function draw(now) {
  if (now >= nextBlink) {
    blinkUntil = now + 140;
    nextBlink = now + 2500 + Math.random() * 3500;
  }
  const p = spritePose(now, poke, now < blinkUntil);
  // Standing, she leaves the top row empty; a hop spends it.
  const top = p.pose === "hop" ? 0 : 1;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  spritePixels(p.pose, p.frame, p.glint).forEach((row, y) =>
    row.forEach((color, x) => {
      if (!color) return;
      ctx.fillStyle = color;
      ctx.fillRect(x, y + top, 1, 1);
    }),
  );
  if (p.say) bubble.textContent = p.say;
  bubble.classList.toggle("on", Boolean(p.say));
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

function pokeHer() {
  let i;
  do i = Math.floor(Math.random() * SAYINGS.length);
  while (i === lastLine && SAYINGS.length > 1);
  lastLine = i;
  poke = { at: performance.now(), say: SAYINGS[i] };
}

// A press that travels more than a few pixels is a drag, not a poke.
let press = null;
canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  canvas.setPointerCapture(event.pointerId);
  press = { x: event.screenX, y: event.screenY, dragging: false };
  lainPet.dragStart();
});
canvas.addEventListener("pointermove", (event) => {
  if (!press) return;
  const dx = event.screenX - press.x;
  const dy = event.screenY - press.y;
  if (!press.dragging && Math.hypot(dx, dy) < 4) return;
  press.dragging = true;
  lainPet.dragTo(dx, dy);
});
canvas.addEventListener("pointerup", () => {
  if (press && !press.dragging) pokeHer();
  if (press?.dragging) lainPet.dragEnd();
  press = null;
});
canvas.addEventListener("dblclick", () => lainPet.openChat());

document.getElementById("chat").addEventListener("click", () => lainPet.openChat());
document.getElementById("hide").addEventListener("click", () => lainPet.hide());

// Say hello once she appears.
setTimeout(pokeHer, 600);
