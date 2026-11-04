"use strict";

/**
 * Lain on the desktop: a small transparent window that stays on top of the
 * others, the way the Codex app keeps its pet. She is drawn from local files
 * only (pet.html), poked by a click, opens the chat on a double click, and
 * goes where she is dragged. Where she stands and whether she is shown
 * survive a restart.
 */

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { petPosition } = require("./config");

const SIZE = { width: 230, height: 200 };

/** @param {{ openChat: () => void, onVisibility?: (shown: boolean) => void }} hooks */
function createPet({ openChat, onVisibility = () => {} }) {
  /** @type {BrowserWindow | null} */
  let pet = null;
  let dragOrigin = null;
  let state = readState();

  const fromPet = (event) => pet !== null && event.sender === pet.webContents;

  ipcMain.on("pet:open-chat", (event) => {
    if (fromPet(event)) openChat();
  });
  ipcMain.on("pet:hide", (event) => {
    if (fromPet(event)) hide();
  });
  ipcMain.on("pet:drag-start", (event) => {
    if (fromPet(event)) dragOrigin = pet.getPosition();
  });
  ipcMain.on("pet:drag-to", (event, dx, dy) => {
    if (!fromPet(event) || !dragOrigin || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    pet.setPosition(Math.round(dragOrigin[0] + dx), Math.round(dragOrigin[1] + dy));
  });
  ipcMain.on("pet:drag-end", (event) => {
    if (!fromPet(event)) return;
    dragOrigin = null;
    const [x, y] = pet.getPosition();
    save({ x, y });
  });

  function show() {
    if (!pet) {
      const at = petPosition(state, screen.getAllDisplays().map((display) => display.workArea), SIZE);
      pet = new BrowserWindow({
        ...SIZE,
        ...at,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        title: "Lain",
        webPreferences: {
          preload: path.join(__dirname, "pet-preload.js"),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webviewTag: false,
          spellcheck: false,
        },
      });
      // Her page is local and has nowhere to go.
      pet.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      pet.webContents.on("will-navigate", (event) => event.preventDefault());
      pet.once("ready-to-show", () => {
        pet?.showInactive();
        // X11 window managers only take "above" from a window that is mapped.
        pet?.setAlwaysOnTop(true, "floating");
        pet?.setVisibleOnAllWorkspaces(true);
      });
      pet.on("closed", () => {
        pet = null;
      });
      void pet.loadFile(path.join(__dirname, "pet.html"));
    } else {
      pet.showInactive();
    }
    save({ visible: true });
    onVisibility(true);
  }

  function hide() {
    pet?.close();
    save({ visible: false });
    onVisibility(false);
  }

  function save(patch) {
    state = { ...state, ...patch };
    try {
      fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
      fs.writeFileSync(stateFile(), JSON.stringify(state));
    } catch {
      // Where she stood is a convenience; a read-only profile just forgets it.
    }
  }

  return {
    show,
    hide,
    toggle: () => (pet ? hide() : show()),
    /** Shown unless she was hidden last time. */
    wanted: () => state?.visible !== false,
    isShown: () => pet !== null,
  };
}

function stateFile() {
  return path.join(app.getPath("userData"), "pet-state.json");
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return {};
  }
}

module.exports = { createPet, SIZE };
