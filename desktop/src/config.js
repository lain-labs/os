"use strict";

/**
 * What the shell is allowed to be: one site in a window, everything else in
 * the system browser. Pure — pinned by test/config.test.js without Electron.
 */

const DEFAULT_URL = "https://chat.lain-os.com/";
const LOGIN_ORIGIN = "https://lain-os.com";

/**
 * The chat to open. LAIN_OS_URL points the shell at a staging or local
 * copy of the site; anything that is not https (or http on this machine) is
 * ignored, because the window would otherwise load a page over the open
 * network with the user's session in it.
 */
function appUrl(env = process.env) {
  const raw = (env.LAIN_OS_URL || "").trim();
  if (!raw) return DEFAULT_URL;
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol === "https:" || (url.protocol === "http:" && local)) return url.href;
  } catch {
    // Not a URL: fall back.
  }
  return DEFAULT_URL;
}

/** Keep the chat and its OpenID sign-in in the same browser session. */
function isInternal(target, base) {
  try {
    const origin = new URL(target).origin;
    const baseOrigin = new URL(base).origin;
    return origin === baseOrigin || (baseOrigin === new URL(DEFAULT_URL).origin && origin === LOGIN_ORIGIN);
  } catch {
    return false;
  }
}

/** Login's home link and logout return to chat instead of the old web desktop. */
function navigationUrl(target, base) {
  if (!isInternal(target, base)) return null;
  const url = new URL(target);
  if (
    new URL(base).origin === new URL(DEFAULT_URL).origin &&
    url.origin === LOGIN_ORIGIN &&
    ["/", "/desktop", "/desktop/"].includes(url.pathname)
  ) {
    return DEFAULT_URL;
  }
  return url.href;
}

/**
 * A link the system may open for the user — a web page or a mail draft.
 * `file:`, `javascript:` and app schemes never leave the window: a page should
 * not be able to start programs on the machine by linking to them.
 */
function externalTarget(target) {
  try {
    const url = new URL(target);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Saved window geometry, or the default when it is unreadable or would sit on
 * no display that exists now (a monitor unplugged since the last run).
 */
function restoredBounds(stored, workAreas, fallback = { width: 1280, height: 820 }) {
  if (!stored || !Number.isFinite(stored.width) || !Number.isFinite(stored.height)) {
    return { ...fallback, maximized: false, fullscreen: false };
  }
  const bounds = {
    width: Math.max(900, Math.round(stored.width)),
    height: Math.max(600, Math.round(stored.height)),
    maximized: Boolean(stored.maximized),
    fullscreen: Boolean(stored.fullscreen),
  };
  if (Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
    const visible = workAreas.some(
      (area) =>
        stored.x < area.x + area.width &&
        stored.x + bounds.width > area.x &&
        stored.y < area.y + area.height &&
        stored.y + bounds.height > area.y,
    );
    if (visible) Object.assign(bounds, { x: Math.round(stored.x), y: Math.round(stored.y) });
  }
  return bounds;
}

/**
 * Where the desktop pet stands: where she was left, if all of her is still on
 * a display that exists now, else the bottom-right corner of the first one.
 */
function petPosition(stored, workAreas, size, margin = 24) {
  const fits = (area) =>
    stored.x >= area.x &&
    stored.y >= area.y &&
    stored.x + size.width <= area.x + area.width &&
    stored.y + size.height <= area.y + area.height;
  if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y) && workAreas.some(fits)) {
    return { x: Math.round(stored.x), y: Math.round(stored.y) };
  }
  const area = workAreas[0] ?? { x: 0, y: 0, width: 1280, height: 820 };
  return { x: area.x + area.width - size.width - margin, y: area.y + area.height - size.height - margin };
}

module.exports = { DEFAULT_URL, appUrl, isInternal, navigationUrl, externalTarget, restoredBounds, petPosition };
