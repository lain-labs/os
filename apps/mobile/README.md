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

## Release

`.github/workflows/apps.yml` builds the APK on a tag `app-v*` (and on a manual
run, which publishes nothing). Signing: `scripts/make-keystore.sh` creates the
key once and uploads the four `ANDROID_*` secrets — back the keystore up
outside this repository, or the app can never be updated in place again.

The package id is `com.lainos.app`. If the app already on Google Play was
published under another id, change `applicationId` in `android/app/build.gradle`
and `package_name` in `res/values/strings.xml` to that id before the first
release from here, and sign with the key Play knows.
