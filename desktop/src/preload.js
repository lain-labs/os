"use strict";

/**
 * The one thing the page learns about the app: that it is the app. Sandboxed
 * and context-isolated — no Node, no IPC, nothing to call.
 */

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("lainDesktop", Object.freeze({ desktop: true, platform: process.platform }));
