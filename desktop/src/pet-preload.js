"use strict";

/**
 * What the pet's own page may ask of the app: open the chat, hide her, and
 * move her window. The chat page never gets this — it keeps preload.js.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "lainPet",
  Object.freeze({
    openChat: () => ipcRenderer.send("pet:open-chat"),
    hide: () => ipcRenderer.send("pet:hide"),
    dragStart: () => ipcRenderer.send("pet:drag-start"),
    dragTo: (dx, dy) => ipcRenderer.send("pet:drag-to", Number(dx), Number(dy)),
    dragEnd: () => ipcRenderer.send("pet:drag-end"),
  }),
);
