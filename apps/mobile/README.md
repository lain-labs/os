# Lain OS for Android

A Capacitor shell around the hosted chat with Lain, **chat.lain-os.com**. It
renders the live site, so a deploy updates the app; the APK changes only when
the shell itself does.

What the app adds to the website:

- **Share to Lain.** Android's share sheet lists *Ask Lain*: text or a link from
  any app opens a new chat with it already typed (`?prompt=`). It is never sent
  by itself (`android/app/src/main/java/com/lainos/app/MainActivity.java`).
- **Shortcuts** on a long press of the icon: new chat, the Lain OS desktop, the
  roadmap (`res/xml/shortcuts.xml`).
- **App Links** for `lain-os.com` and `chat.lain-os.com`, and `lainos://` links.
- An adaptive icon with an Android 13+ themed (monochrome) layer
  (`scripts/icon.py`, from `resources/lain-source.png`).

## Commands

```bash
npm install
npm test                # URL/navigation rules and release naming, no SDK needed
npm run sync:android    # generate www/ and copy config/plugins into android/
npm run android:apk     # debug APK (needs JDK 21 + Android SDK)
python3 scripts/icon.py # regenerate the icons
```

`LAIN_APP_URL` (default `https://chat.lain-os.com`) and `LAIN_APP_PATH`
(default `/`) choose what the app opens; re-sync after changing them.

## Store edition

`LAIN_STORE=play npm run sync:android` appends `LainOSStore/play` to the user
agent. The chat and lain-os.com answer such a build without buying credits with
crypto and without LAIN staking: Google Play requires its own billing for
digital goods sold inside an app. The APK on GitHub and the web keep
everything.

## Notifications

The app rings for what happens in public on lain-os.com: a new quest, answers
and votes on the Wired, stakers' votes and Lain's own trades, summed up in one
notification at most every 30 minutes (`push:activity` in lain-labs/backend).
The chat page registers (`librechat/branding/lain-push.js`) and only in a build
that carries a Firebase config, which says so with `LainOSPush/1` in its user
agent — asking Firebase for a token without one crashes the app.

To turn it on: add an Android app `com.lainos.app` to the Firebase project,
put its `google-services.json` base64-encoded into the repository secret
`GOOGLE_SERVICES_JSON_BASE64` (the Apps workflow writes the file and sets
`LAIN_PUSH=1`), and point the backend's `FCM_CREDENTIALS` at a service-account
key of the same project. Locally: drop the file into `android/app/` and run
`LAIN_PUSH=1 npm run sync:android`.

## Release

`.github/workflows/apps.yml` builds the APK on a tag `app-v*` (and on a manual
run, which publishes nothing). Signing: `scripts/make-keystore.sh` creates the
key once and uploads the four `ANDROID_*` secrets — back the keystore up
outside this repository, or the app can never be updated in place again.

The package id is `com.lainos.app`. If the app already on Google Play was
published under another id, change `applicationId` in `android/app/build.gradle`
and `package_name` in `res/values/strings.xml` to that id before the first
release from here, and sign with the key Play knows.
