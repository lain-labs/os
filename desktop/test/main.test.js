"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const SOURCE_DIR = path.resolve(__dirname, "../src");
const CHAT = "https://chat.lain-os.com/";

/** Boot the real main module with Electron's boundary replaced, without opening a window. */
async function boot() {
  const windows = [];
  const externalUrls = [];
  let ready;
  const readiness = new Promise((resolve) => { ready = resolve; });
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    whenReady: () => readiness,
    getVersion: () => "0.1.1",
    getPath: () => "/unused-test-profile",
    quit: () => {},
  });

  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = Object.assign(new EventEmitter(), {
        loadedUrls: [],
        loadURL(url) {
          this.loadedUrls.push(url);
          return Promise.resolve();
        },
        setWindowOpenHandler(handler) { this.openWindow = handler; },
      });
      windows.push(this);
    }

    loadURL(url) { return this.webContents.loadURL(url); }
    static getAllWindows() { return windows; }
  }

  const electron = {
    app,
    BrowserWindow: FakeBrowserWindow,
    Menu: { buildFromTemplate: (template) => template, setApplicationMenu: () => {} },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    session: { defaultSession: {
      setPermissionRequestHandler: () => {},
      getUserAgent: () => "Test Electron",
      setUserAgent: () => {},
    } },
    shell: { openExternal: (url) => { externalUrls.push(url); return Promise.resolve(); } },
  };
  const context = vm.createContext({
    process: { env: {}, platform: "linux" },
    URL,
    setTimeout,
    clearTimeout,
  });

  function loadModule(filename) {
    const module = { exports: {} };
    const source = fs.readFileSync(filename, "utf8");
    const execute = vm.runInContext(`(function (require, module, exports, __dirname) {\n${source}\n})`, context, { filename });
    execute((id) => {
      if (id === "electron") return electron;
      if (id === "./config") return loadModule(path.join(SOURCE_DIR, "config.js"));
      if (id === "./pet-window") return { createPet: () => ({ show() {}, wanted: () => false, isShown: () => false }) };
      if (id === "node:fs") return { readFileSync: () => { throw new Error("No saved window state"); } };
      return require(id);
    }, module, module.exports, path.dirname(filename));
    return module.exports;
  }

  loadModule(path.join(SOURCE_DIR, "main.js"));
  ready();
  await readiness;
  assert.equal(windows.length, 1);
  return { contents: windows[0].webContents, externalUrls };
}

function navigate(contents, name, url) {
  // Supply only the current Electron event shape, not its deprecated positional arguments.
  const event = {
    url,
    isMainFrame: true,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  contents.emit(name, event);
  return event;
}

test("startup opens the full chat", async () => {
  const { contents, externalUrls } = await boot();
  assert.deepEqual(contents.loadedUrls, [CHAT]);
  assert.deepEqual(externalUrls, []);
});

for (const name of ["will-navigate", "will-redirect"]) {
  test(`${name} preserves the OpenID roundtrip in the current window`, async () => {
    const { contents, externalUrls } = await boot();
    for (const url of [
      "https://lain-os.com/oauth/authorize?client_id=chat&state=original",
      "https://lain-os.com/login",
      "https://chat.lain-os.com/oauth/openid/callback?code=original&state=original",
    ]) {
      assert.equal(navigate(contents, name, url).defaultPrevented, false, url);
    }
    // No replacement load: form submissions and OAuth parameters remain browser-owned.
    assert.deepEqual(contents.loadedUrls, [CHAT]);
    assert.deepEqual(externalUrls, []);
  });

  test(`${name} sends other origins to the system browser`, async () => {
    const { contents, externalUrls } = await boot();
    const urls = ["https://example.com/docs", "https://lain-os.com.evil.test/login"];
    for (const url of urls) {
      assert.equal(navigate(contents, name, url).defaultPrevented, true, url);
    }
    assert.deepEqual(externalUrls, urls);
    assert.deepEqual(contents.loadedUrls, [CHAT]);
  });

  test(`${name} returns login home and the old desktop to chat`, async () => {
    const { contents, externalUrls } = await boot();
    for (const url of ["https://lain-os.com/?logged_out=1", "https://lain-os.com/desktop", "https://lain-os.com/desktop/"]) {
      const previousLoads = contents.loadedUrls.length;
      assert.equal(navigate(contents, name, url).defaultPrevented, true, url);
      assert.equal(contents.loadedUrls.length, previousLoads + 1);
      assert.equal(contents.loadedUrls.at(-1), CHAT);
    }
    assert.deepEqual(externalUrls, []);
  });
}

test("an OpenID login popup continues in the existing window", async () => {
  const { contents, externalUrls } = await boot();
  const login = "https://lain-os.com/login";
  assert.equal(contents.openWindow({ url: login }).action, "deny");
  assert.deepEqual(contents.loadedUrls, [CHAT, login]);
  assert.deepEqual(externalUrls, []);
});
