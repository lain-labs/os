'use strict';

/**
 * The URL resolver decides what the app renders and which hosts stay inside the
 * WebView, so it is worth a test that runs without Android or Xcode.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
    DEFAULT_APP_PATH,
    DEFAULT_APP_URL,
    allowNavigation,
    resolveAppPath,
    resolveAppUrl,
    resolveStartUrl,
    resolveStoreEdition,
    resolveUserAgent,
} = require('../src/app-url');

test('falls back to the production URL', () => {
    assert.equal(resolveAppUrl({}), DEFAULT_APP_URL);
});

test('accepts an http override for LAN builds', () => {
    assert.equal(resolveAppUrl({ LAIN_APP_URL: 'http://192.168.1.10:8000/' }), 'http://192.168.1.10:8000');
});

test('rejects a malformed or non-http override', () => {
    assert.equal(resolveAppUrl({ LAIN_APP_URL: 'nope' }), DEFAULT_APP_URL);
    assert.equal(resolveAppUrl({ LAIN_APP_URL: 'file:///etc/passwd' }), DEFAULT_APP_URL);
});

test('allows the app host, its subdomains, and the OAuth providers', () => {
    const hosts = allowNavigation('https://chat.lain-os.com');

    assert.ok(hosts.includes('chat.lain-os.com'));
    assert.ok(hosts.includes('*.chat.lain-os.com') && hosts.includes('lain-os.com'));
    assert.ok(hosts.includes('x.com'));
    assert.equal(hosts.includes('*'), false);
});

test('tracks the override host instead of the production one', () => {
    assert.deepEqual(allowNavigation('http://192.168.1.10:8000').slice(0, 2), [
        '192.168.1.10',
        '*.192.168.1.10',
    ]);
});

test('launches on the wallet, not on the site home', () => {
    assert.equal(resolveAppPath({}), DEFAULT_APP_PATH);
    assert.equal(resolveStartUrl({}), `${DEFAULT_APP_URL}/`);
    assert.equal(
        resolveStartUrl({ LAIN_APP_URL: 'http://192.168.1.10:8000/' }),
        'http://192.168.1.10:8000/',
    );
});

test('a landing route may never move the app to another origin', () => {
    assert.equal(resolveAppPath({ LAIN_APP_PATH: '//evil.example/wallet' }), DEFAULT_APP_PATH);
    assert.equal(resolveAppPath({ LAIN_APP_PATH: 'https://evil.example' }), DEFAULT_APP_PATH);
    assert.equal(resolveAppPath({ LAIN_APP_PATH: 'wallet' }), DEFAULT_APP_PATH);
    assert.equal(resolveAppPath({ LAIN_APP_PATH: '/bridge?to=sol' }), '/bridge?to=sol');
});

test('a root landing route keeps its slash, query and all', () => {
    assert.equal(resolveAppPath({ LAIN_APP_PATH: '/' }), '/');
    assert.equal(resolveAppPath({ LAIN_APP_PATH: '/?ref=app' }), '/?ref=app');
});

test('the WebView is pointed at the landing route, and the host stays the host', () => {
    const config = require('../capacitor.config');

    assert.equal(config.server.url, `${DEFAULT_APP_URL}/`);
    assert.equal(config.server.hostname, new URL(DEFAULT_APP_URL).hostname);
    assert.ok(config.server.allowNavigation.includes(new URL(DEFAULT_APP_URL).hostname));
});

test('keeps the encrypted wallet vault out of Android backups', () => {
    const manifest = fs.readFileSync(
        path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
        'utf8',
    );

    assert.match(manifest, /android:allowBackup="false"/);
});

test('only a known store names a store edition', () => {
    assert.equal(resolveStoreEdition({}), null);
    assert.equal(resolveStoreEdition({ LAIN_STORE: 'play' }), 'play');
    assert.equal(resolveStoreEdition({ LAIN_STORE: ' AppStore ' }), 'appstore');
    assert.equal(resolveStoreEdition({ LAIN_STORE: 'huawei' }), null);
});

test('the user agent carries the store token only in a store build', () => {
    assert.equal(resolveUserAgent({}, '1.2.3'), 'LainOSMobile/1.2.3');
    assert.equal(resolveUserAgent({ LAIN_VERSION_NAME: '2.0.0' }, '1.2.3'), 'LainOSMobile/2.0.0');
    assert.equal(
        resolveUserAgent({ LAIN_STORE: 'play' }, '1.2.3'),
        'LainOSMobile/1.2.3 LainOSStore/play',
    );
    // The site matches exactly this token (resources/js/lib/storeEdition.ts).
    assert.match(resolveUserAgent({ LAIN_STORE: 'appstore' }), /\bLainOSStore\/(play|appstore)\b/);

    // The chat registers for notifications only in a build that has a Firebase config.
    assert.equal(resolveUserAgent({ LAIN_PUSH: '1' }, '1.2.3'), 'LainOSMobile/1.2.3 LainOSPush/1');
    assert.doesNotMatch(resolveUserAgent({}, '1.2.3'), /LainOSPush/);
});
