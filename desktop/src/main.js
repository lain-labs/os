"use strict";

/**
 * Lain OS chat on the desktop: chat.lain-os.com in a window of its own,
 * with OpenID sign-in kept in the same browser session.
 *
 * Lain herself stands on the desktop beside it (pet-window.js). Otherwise
 * the shell adds nothing the site does not have, on purpose. The page runs
 * sandboxed with no Node, the chat and sign-in stay inside the window and every other
 * link goes to the system browser, no permission the site has not needed so
 * far is granted, and a page that cannot load says so with a retry instead of
 * a blank window. The site can tell it is in the app from the user agent
 * (`LainOSDesktop/<version>`) or `window.lainDesktop`.
 */

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, Menu, screen, session, shell } = require("electron");
const { appUrl, externalTarget, navigationUrl, restoredBounds } = require("./config");
const { createPet } = require("./pet-window");

const URL_TO_OPEN = appUrl();
const OFFLINE_PAGE = path.join(__dirname, "offline.html");
const OFFLINE_URL = pathToFileURL(OFFLINE_PAGE).href;
const ICON = app.isPackaged ? path.join(process.resourcesPath, "icon.png") : path.join(__dirname, "..", "build", "icon.png");

/** @type {BrowserWindow | null} */
let win = null;
/** Lain on the desktop, beside the chat window rather than in it. */
let pet = null;

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
  if (!win) createWindow();
});

function start() {
  // Nothing on lain-os.com asks for the camera, the microphone, location or
  // notifications today; a permission it never needed is one a compromised
  // page cannot use either.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === "clipboard-sanitized-write" || permission === "fullscreen");
  });
  session.defaultSession.setUserAgent(`${session.defaultSession.getUserAgent()} LainOSDesktop/${app.getVersion()}`);

  pet = createPet({ openChat, onVisibility: () => Menu.setApplicationMenu(buildMenu()) });
  Menu.setApplicationMenu(buildMenu());
  createWindow();
  if (pet.wanted()) pet.show();
}

/** Bring the chat forward, opening it again if it was closed. */
function openChat() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
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

  // Chat and OpenID sign-in share cookies inside this window.
  contents.setWindowOpenHandler(({ url }) => {
    const target = navigationUrl(url, URL_TO_OPEN);
    if (target) {
      void contents.loadURL(target);
    } else {
      openOutside(url);
    }
    return { action: "deny" };
  });

  const guardNavigation = (event) => {
    if (!event.isMainFrame) return;
    const url = event.url;
    const target = navigationUrl(url, URL_TO_OPEN);
    if (target === url || url.split("?")[0] === OFFLINE_URL) return;
    event.preventDefault();
    if (target) void contents.loadURL(target);
    else openOutside(url);
  };
  contents.on("will-navigate", guardNavigation);
  contents.on("will-redirect", guardNavigation);

  // The offline page is the only local file the window shows; its retry
  // button navigates back to the site, which passes the guard above.
  contents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted: a navigation replaced it */) return;
    void win?.loadFile(OFFLINE_PAGE, { query: { url: navigationUrl(url, URL_TO_OPEN) || URL_TO_OPEN } });
  });

  for (const event of ["resize", "move", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "close"]) {
    win.on(event, saveStateSoon);
  }
  win.on("closed", () => {
    win = null;
    // The pet is not the app: closing the chat closes both, except on a Mac.
    if (process.platform !== "darwin") app.quit();
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
        {
          label: "Lain on the Desktop",
          type: "checkbox",
          checked: Boolean(pet?.isShown()),
          click: () => pet?.toggle(),
        },
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
