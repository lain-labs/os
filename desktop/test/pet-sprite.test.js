"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { LINES, POKE_MS, W, pixels, pose } = require("../src/pet-sprite");

test("every pose is a 16×16 grid of colours or gaps", () => {
  for (const p of ["idle", "blink", "look", "glitch", "hop"]) {
    const grid = pixels(p, 3, 0.5);
    assert.equal(grid.length, W);
    for (const row of grid) {
      assert.equal(row.length, W);
      for (const c of row) assert.ok(c === null || /^#[0-9a-f]{6}$/.test(c), `${p}: ${c}`);
    }
  }
});

test("a blink shuts her eyes and leaves the rest of her alone", () => {
  const open = pixels("idle");
  const shut = pixels("blink");
  const changed = open.flatMap((row, y) => (row.join() === shut[y].join() ? [] : [y]));
  assert.deepEqual(changed, [8, 9]);
});

test("a poke hops, glitches, then speaks until it runs out", () => {
  const poke = { at: 1000, say: LINES[0] };
  assert.equal(pose(1000, poke, false).pose, "hop");
  assert.equal(pose(1600, poke, false).pose, "glitch");
  assert.equal(pose(2000, poke, false).say, LINES[0]);
  assert.equal(pose(2000, poke, true).pose, "blink");
  assert.deepEqual(pose(1000 + POKE_MS, poke, false), { pose: "idle", frame: Math.floor((1000 + POKE_MS) / 80) });
});
