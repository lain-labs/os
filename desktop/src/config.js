"use strict";

/**
 * What the shell is allowed to be: one site in a window, everything else in
 * the system browser. Pure — pinned by test/config.test.js without Electron.
 */

const DEFAULT_URL = "https://lain-os.com/";

/**
 * The desktop to open. LAIN_OS_URL points the shell at a staging or local
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

/** Same origin as the desktop: stays in the window. */
function isInternal(target, base) {
  try {
    return new URL(target).origin === new URL(base).origin;
  } catch {
    return false;
  }
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

module.exports = { DEFAULT_URL, appUrl, isInternal, externalTarget, restoredBounds };
