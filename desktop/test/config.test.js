"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { DEFAULT_URL, appUrl, externalTarget, isInternal, restoredBounds } = require("../src/config");

test("the shell opens lain-os.com unless pointed at a safe copy", () => {
  assert.equal(appUrl({}), DEFAULT_URL);
  assert.equal(appUrl({ LAIN_OS_URL: "https://staging.lain-os.com/" }), "https://staging.lain-os.com/");
  assert.equal(appUrl({ LAIN_OS_URL: "http://localhost:8000" }), "http://localhost:8000/");
  // Plain http to another machine would carry the session over the open network.
  assert.equal(appUrl({ LAIN_OS_URL: "http://lain-os.com" }), DEFAULT_URL);
  assert.equal(appUrl({ LAIN_OS_URL: "javascript:alert(1)" }), DEFAULT_URL);
});

test("one origin stays in the window", () => {
  assert.equal(isInternal("https://lain-os.com/wallet", DEFAULT_URL), true);
  assert.equal(isInternal("https://lain-os.com.evil.test/", DEFAULT_URL), false);
  assert.equal(isInternal("https://x.com/lain___os", DEFAULT_URL), false);
  assert.equal(isInternal("not a url", DEFAULT_URL), false);
});

test("only web pages and mail leave for the system", () => {
  assert.equal(externalTarget("https://github.com/lain-labs/os"), "https://github.com/lain-labs/os");
  assert.equal(externalTarget("mailto:hi@lain-os.com"), "mailto:hi@lain-os.com");
  assert.equal(externalTarget("file:///etc/passwd"), null);
  assert.equal(externalTarget("smb://share/x"), null);
  assert.equal(externalTarget("javascript:void(0)"), null);
});

test("a window is never restored onto a display that is gone", () => {
  const screens = [{ x: 0, y: 0, width: 1920, height: 1080 }];
  assert.deepEqual(restoredBounds({ x: 100, y: 80, width: 1200, height: 800 }, screens), {
    x: 100,
    y: 80,
    width: 1200,
    height: 800,
    maximized: false,
    fullscreen: false,
  });
  const offScreen = restoredBounds({ x: 3000, y: 80, width: 1200, height: 800 }, screens);
  assert.equal("x" in offScreen, false);
  assert.deepEqual(restoredBounds(null, screens), { width: 1280, height: 820, maximized: false, fullscreen: false });
  assert.equal(restoredBounds({ width: 10, height: 10 }, screens).width, 900);
});
