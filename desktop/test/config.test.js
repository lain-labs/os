"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { DEFAULT_URL, appUrl, externalTarget, isInternal, navigationUrl, petPosition, restoredBounds } = require("../src/config");

test("the shell opens chat.lain-os.com unless pointed at a safe copy", () => {
  assert.equal(appUrl({}), "https://chat.lain-os.com/");
  assert.equal(appUrl({ LAIN_OS_URL: "https://staging.lain-os.com/" }), "https://staging.lain-os.com/");
  assert.equal(appUrl({ LAIN_OS_URL: "http://localhost:8000" }), "http://localhost:8000/");
  // Plain http to another machine would carry the session over the open network.
  assert.equal(appUrl({ LAIN_OS_URL: "http://lain-os.com" }), DEFAULT_URL);
  assert.equal(appUrl({ LAIN_OS_URL: "javascript:alert(1)" }), DEFAULT_URL);
});

test("chat and its OpenID login stay in the same window", () => {
  for (const url of [
    "https://chat.lain-os.com/c/new",
    "https://lain-os.com/oauth/authorize?client_id=chat&redirect_uri=https%3A%2F%2Fchat.lain-os.com%2Foauth%2Fopenid%2Fcallback",
    "https://lain-os.com/login",
    "https://lain-os.com/register",
    "https://lain-os.com/forgot-password",
    "https://chat.lain-os.com/oauth/openid/callback?code=example&state=example",
  ]) {
    assert.equal(navigationUrl(url, DEFAULT_URL), url);
  }
  assert.equal(isInternal("http://lain-os.com/login", DEFAULT_URL), false);
  assert.equal(isInternal("https://chat.lain-os.com.evil.test/", DEFAULT_URL), false);
  assert.equal(isInternal("https://lain-os.com.evil.test/", DEFAULT_URL), false);
  assert.equal(isInternal("https://x.com/lain___os", DEFAULT_URL), false);
  assert.equal(isInternal("not a url", DEFAULT_URL), false);
});

test("login home links and logout cannot reopen the old web desktop", () => {
  for (const url of ["https://lain-os.com/", "https://lain-os.com/?logged_out=1", "https://lain-os.com/desktop/"]) {
    assert.equal(navigationUrl(url, DEFAULT_URL), DEFAULT_URL);
  }
  assert.equal(navigationUrl("https://x.com/lain___os", DEFAULT_URL), null);
});

test("a staging chat only trusts its own origin", () => {
  const base = "http://localhost:3080/";
  assert.equal(navigationUrl("http://localhost:3080/c/new", base), "http://localhost:3080/c/new");
  assert.equal(navigationUrl("https://lain-os.com/login", base), null);
  assert.equal(navigationUrl(DEFAULT_URL, base), null);
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

test("the pet stands where she was left, or in the corner when that spot is gone", () => {
  const screens = [{ x: 0, y: 0, width: 1920, height: 1080 }, { x: 1920, y: 0, width: 1920, height: 1080 }];
  const size = { width: 230, height: 200 };
  assert.deepEqual(petPosition({ x: 2500, y: 300 }, screens, size), { x: 2500, y: 300 });
  // Half off the edge, on a monitor unplugged since, or never placed: the first display's corner.
  for (const stored of [{ x: 1800, y: 300 }, { x: 4000, y: 300 }, {}, null]) {
    assert.deepEqual(petPosition(stored, screens, size), { x: 1920 - 230 - 24, y: 1080 - 200 - 24 });
  }
});
