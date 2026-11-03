'use strict';

/**
 * Single source of truth for the site the Lain OS app renders.
 *
 * The shell has no bundle of its own: it points a native WebView at the hosted
 * chat with Lain (chat.lain-os.com), so a deploy updates the app without a
 * store release. Override with LAIN_APP_URL to build a staging or LAN app
 * (`LAIN_APP_URL=http://192.168.1.10:3080 npm run sync:android`), and the
 * landing route with LAIN_APP_PATH.
 */

const DEFAULT_APP_URL = 'https://chat.lain-os.com';

const DEFAULT_APP_PATH = '/';

/** Hosts that may take over the WebView; anything else opens in the browser. */
const EXTRA_NAVIGABLE_HOSTS = [
    // The chat signs in through lain-os.com's OpenID provider.
    'lain-os.com',
    '*.lain-os.com',
    'accounts.google.com',
    'api.twitter.com',
    'api.x.com',
    'twitter.com',
    'x.com',
];

function resolveAppUrl(env = process.env) {
    const candidate = env.LAIN_APP_URL || DEFAULT_APP_URL;

    try {
        const url = new URL(candidate);

        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            return DEFAULT_APP_URL;
        }

        return url.toString().replace(/\/$/, '');
    } catch {
        return DEFAULT_APP_URL;
    }
}

/**
 * The route the WebView launches on, as a same-origin absolute path.
 *
 * A full URL or a protocol-relative `//host` would quietly point the whole app
 * at another origin, so anything that is not a plain path falls back to the
 * chat instead of being followed.
 */
function resolveAppPath(env = process.env) {
    const candidate = env.LAIN_APP_PATH ?? DEFAULT_APP_PATH;

    if (typeof candidate !== 'string') {
        return DEFAULT_APP_PATH;
    }

    const raw = candidate.trim();

    if (!raw.startsWith('/') || raw.startsWith('//')) {
        return DEFAULT_APP_PATH;
    }

    try {
        const { pathname, search, hash } = new URL(raw, 'https://placeholder.invalid');
        // Trim a trailing slash, but never the one that *is* the path: "/"
        // with a query has to stay "/?x", not "?x".
        const route = pathname === '/' ? '/' : pathname.replace(/\/$/, '');

        return `${route}${search}${hash}`;
    } catch {
        return DEFAULT_APP_PATH;
    }
}

/** The exact URL the WebView opens: the app origin plus its landing route. */
function resolveStartUrl(env = process.env) {
    return `${resolveAppUrl(env)}${resolveAppPath(env)}`;
}

/**
 * `allowNavigation` entries for the resolved app URL: the host itself, its
 * subdomains, and the OAuth providers the site redirects through.
 */
function allowNavigation(appUrl) {
    const { hostname } = new URL(appUrl);

    return [hostname, `*.${hostname}`, ...EXTRA_NAVIGABLE_HOSTS];
}

/** The stores a build may be made for; see `resolveStoreEdition`. */
const STORE_EDITIONS = ['play', 'appstore'];

/**
 * Which store this build is for, from LAIN_STORE, or null for the APK served
 * from lain-os.com.
 *
 * A store build says so in its user agent (`LainOSStore/play`) and the chat
 * answers with its store edition (lain-labs/backend: librechat/branding and
 * the dashboard): buying credits with crypto and LAIN staking are left out,
 * because a store requires its own billing for digital goods sold in an app.
 * An edition this file does not know is not a store build.
 */
function resolveStoreEdition(env = process.env) {
    const candidate = String(env.LAIN_STORE ?? '').trim().toLowerCase();

    return STORE_EDITIONS.includes(candidate) ? candidate : null;
}

/**
 * What the shell appends to the WebView's user agent. `LainOSPush/1` is there
 * only when the build carries a Firebase config (LAIN_PUSH=1, set by the
 * workflow once google-services.json is in place): the chat page registers
 * for notifications only then, because asking Firebase for a token in a build
 * without its config crashes the app instead of failing.
 */
function resolveUserAgent(env = process.env, version = '1.0.0') {
    const edition = resolveStoreEdition(env);
    const parts = [`LainOSMobile/${env.LAIN_VERSION_NAME || version}`];
    if (edition) {
        parts.push(`LainOSStore/${edition}`);
    }
    if (String(env.LAIN_PUSH ?? '') === '1') {
        parts.push('LainOSPush/1');
    }

    return parts.join(' ');
}

module.exports = {
    DEFAULT_APP_PATH,
    DEFAULT_APP_URL,
    EXTRA_NAVIGABLE_HOSTS,
    allowNavigation,
    resolveAppPath,
    resolveAppUrl,
    resolveStartUrl,
    resolveStoreEdition,
    resolveUserAgent,
    STORE_EDITIONS,
};
