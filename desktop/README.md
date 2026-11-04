# Lain OS desktop

The full chat at **https://chat.lain-os.com/** in a window of its own, so Lain
lives in the dock and the app switcher rather than in a browser tab.

Lain herself stands on the desktop beside it, the way the Codex app keeps its
pet: the TUI's 16×16 pixel Lain in a small transparent window above the others.
A click pokes her (a hop, a glitch, a line), a double click or ◆ opens the chat,
she goes where she is dragged, and ✕ or **View → Lain on the Desktop** hides
and shows her. Her page is a local file with its own narrow preload; the chat
page gets none of it. Where she stands and whether she is shown survive a
restart.

Otherwise the shell adds nothing the site does not have, on purpose:

- the page runs sandboxed and context-isolated, with no Node and no IPC;
- chat.lain-os.com and its OpenID sign-in at lain-os.com stay in the same
  window and session, including server redirects; every other link opens in the system
  browser, and only `https:`, `http:` and `mailto:` ever leave the app;
- login's home link and logout return to chat;
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
