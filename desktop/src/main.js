"use strict";

/**
 * Lain OS on the desktop: the lain-os.com desktop — windows, taskbar, start
 * menu, lain.exe — in a window of its own, so it lives in the dock and the
 * app switcher instead of in a browser tab.
 *
 * The shell adds nothing the site does not have, on purpose. The page runs
 * sandboxed with no Node, one origin stays inside the window and every other
 * link goes to the system browser, no permission the site has not needed so
 * far is granted, and a page that cannot load says so with a retry instead of
 * a blank window. The site can tell it is in the app from the user agent
 * (`LainOSDesktop/<version>`) or `window.lainDesktop`.
 */

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, Menu, screen, session, shell } = require("electron");
const { appUrl, externalTarget, isInternal, restoredBounds } = require("./config");

const URL_TO_OPEN = appUrl();
const OFFLINE_PAGE = path.join(__dirname, "offline.html");
const OFFLINE_URL = pathToFileURL(OFFLINE_PAGE).href;
const ICON = app.isPackaged ? path.join(process.resourcesPath, "icon.png") : path.join(__dirname, "..", "build", "icon.png");

/** @type {BrowserWindow | null} */
let win = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(start);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function start() {
  // Nothing on lain-os.com asks for the camera, the microphone, location or
  // notifications today; a permission it never needed is one a compromised
  // page cannot use either.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === "clipboard-sanitized-write" || permission === "fullscreen");
  });
  session.defaultSession.setUserAgent(`${session.defaultSession.getUserAgent()} LainOSDesktop/${app.getVersion()}`);

  Menu.setApplicationMenu(buildMenu());
  createWindow();
}

function createWindow() {
  const bounds = restoredBounds(readState(), screen.getAllDisplays().map((display) => display.workArea));

  win = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "Lain OS",
    backgroundColor: "#07060b",
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  if (bounds.maximized) win.maximize();
  if (bounds.fullscreen) win.setFullScreen(true);
  win.once("ready-to-show", () => win?.show());

  const contents = win.webContents;

  // A new window is a link out: lain-os.com stays here, the rest goes to the browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url, URL_TO_OPEN)) {
      void contents.loadURL(url);
    } else {
      openOutside(url);
    }
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    if (isInternal(url, URL_TO_OPEN) || url.split("?")[0] === OFFLINE_URL) return;
    event.preventDefault();
    openOutside(url);
  });

  // The offline page is the only local file the window shows; its retry
  // button navigates back to the site, which passes the guard above.
  contents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted: a navigation replaced it */) return;
    void win?.loadFile(OFFLINE_PAGE, { query: { url: isInternal(url, URL_TO_OPEN) ? url : URL_TO_OPEN } });
  });

  for (const event of ["resize", "move", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "close"]) {
    win.on(event, saveStateSoon);
  }
  win.on("closed", () => {
    win = null;
  });

  void win.loadURL(URL_TO_OPEN);
}

function openOutside(url) {
  const target = externalTarget(url);
  if (target) void shell.openExternal(target);
}

function buildMenu() {
  const mac = process.platform === "darwin";
  return Menu.buildFromTemplate([
    ...(mac ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Home", accelerator: "CmdOrCtrl+Shift+H", click: () => void win?.loadURL(URL_TO_OPEN) },
        { role: "reload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }]),
      ],
    },
    { role: "windowMenu" },
  ]);
}

/* ------------------------------------------------------------ geometry --- */

function stateFile() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return null;
  }
}

let saveTimer = null;

function saveStateSoon() {
  if (!win) return;
  const state = {
    ...(win.isMaximized() || win.isFullScreen() ? readState() ?? {} : win.getBounds()),
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
  };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
      fs.writeFileSync(stateFile(), JSON.stringify(state));
    } catch {
      // Geometry is a convenience; a read-only profile just forgets it.
    }
  }, 300);
}
