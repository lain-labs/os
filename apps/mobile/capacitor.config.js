'use strict';

const { allowNavigation, resolveAppUrl, resolveStartUrl, resolveUserAgent } = require('./src/app-url');
const { version } = require('./package.json');

const appUrl = resolveAppUrl();
const startUrl = resolveStartUrl();
const { hostname, protocol } = new URL(appUrl);

/**
 * The shell renders the hosted chat with Lain, so `server.url` is the whole
 * app. `www/` is only the local fallback the WebView shows when that
 * URL cannot be reached (`server.errorPath`); regenerate it with `npm run www`.
 *
 * @type {import('@capacitor/cli').CapacitorConfig}
 */
const config = {
    appId: 'com.lainos.app',
    appName: 'Lain OS',
    webDir: 'www',
    backgroundColor: '#03060f',
    // Lets the backend recognise the native shell (see resources/js/lib/native.ts)
    // and, for a Google Play or App Store build (LAIN_STORE=play|appstore),
    // which store edition of the wallet to serve (resources/js/lib/storeEdition.ts).
    appendUserAgent: resolveUserAgent(process.env, version),
    zoomEnabled: false,
    server: {
        url: startUrl,
        hostname,
        androidScheme: 'https',
        cleartext: protocol === 'http:',
        errorPath: 'error.html',
        allowNavigation: allowNavigation(appUrl),
    },
    android: {
        allowMixedContent: false,
        webContentsDebuggingEnabled: false,
    },
    ios: {
        // The site paints its own safe-area padding, so the WebView must not
        // add another inset on top of it.
        contentInset: 'never',
        limitsNavigationsToAppBoundDomains: false,
    },
    plugins: {
        SplashScreen: {
            launchAutoHide: true,
            launchShowDuration: 500,
            backgroundColor: '#03060f',
            androidSplashResourceName: 'splash',
            showSpinner: false,
        },
        // Registration happens in the chat page (lain-labs/backend: librechat/branding/lain-push.js),
        // and only in a build with a Firebase config (see resolveUserAgent).
        PushNotifications: {
            presentationOptions: ['badge', 'sound', 'alert'],
        },
        StatusBar: {
            style: 'DARK',
            backgroundColor: '#03060f',
            overlaysWebView: false,
        },
    },
};

module.exports = config;
