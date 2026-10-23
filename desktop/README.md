# Lain OS desktop

The lain-os.com desktop — windows, taskbar, start menu, `lain.exe` — in a
window of its own, so Lain lives in the dock and the app switcher rather than
in a browser tab.

The shell adds nothing the site does not have, on purpose:

- the page runs sandboxed and context-isolated, with no Node and no IPC;
- lain-os.com stays in the window, every other link opens in the system
  browser, and only `https:`, `http:` and `mailto:` ever leave the app;
- no permission is granted beyond clipboard writes and fullscreen;
- a page that cannot load shows a "no carrier" screen with a retry;
- window size, position, maximised and fullscreen state survive a restart,
  and a window is never restored onto a monitor that is gone;
- the site can tell it is in the app from the user agent
  (`LainOSDesktop/<version>`) or `window.lainDesktop`.

`LAIN_OS_URL` points it at another copy of the site — `https://` anywhere, or
`http://localhost` for development.

```bash
cd desktop
npm install
npm test            # the URL and window rules, no Electron needed
npm start           # run it
npm run dist:linux  # AppImage + deb in dist/
npm run dist:win    # NSIS installer
npm run dist:mac    # dmg (on a Mac)
```

Installers are named without a version (`LainOS-linux-x86_64.AppImage`, …) so
`releases/latest/download/<name>` stays a permanent link.
