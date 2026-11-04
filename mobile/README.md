# Lain OS Mobile

An Android and iOS shell for the hosted chat at https://chat.lain-os.com/. It keeps the chat and its Lain OS sign-in at https://lain-os.com/ in the same WebView. It requires a network connection and does not run the LainOS agent locally. Other links open outside the app. The offline screen offers a retry.

## Build a test APK

Requires Node.js 20+, JDK 21 and Android SDK 36.

```sh
npm ci
export ANDROID_HOME=/path/to/Android/Sdk
npm run android:apk
```

The output is `android/app/build/outputs/apk/debug/app-debug.apk`. This build uses the Android debug signing key and is intended for testing, not public distribution. A release requires a persistent, protected signing key and device testing. The Android application ID is `lain.os`; it should be confirmed before publishing because it becomes permanent once released.

The app does not request camera, microphone or notification permissions. Web push is not available in Android WebView. Login, upload and other interactive flows should be checked on a physical Android device before release.

## iPhone test build without a Mac

The `iOS test build` GitHub Actions workflow runs when a `codex/ios-test-*`
branch is pushed or when it is started manually in Actions (after the workflow
is present on the default branch).
It builds the iPhone device target on a macOS runner without an Apple signing
identity and uploads `LainOS-unsigned.ipa` and its SHA-256 checksum for seven
days. The workflow has to be committed and pushed to GitHub first. This is an
unsigned personal test artifact, not an App Store or TestFlight release and it
cannot be installed directly by iOS.

To install it on an iPhone, set up [SideStore](https://docs.sidestore.io/docs/installation/prerequisites)
following its current Linux instructions, transfer the IPA to the phone, and
use SideStore to sign and install it with your Apple Account. Free-account apps
need periodic refresh and Apple limits the number of active apps. Device, iOS
version, SideStore setup and Apple account restrictions affect whether this
works. SideStore's own installation and pairing must be completed first.

The app loads the hosted site over the network. Test login, navigation, uploads
and recovery from lost connectivity on a real iPhone. The LainOS agent does not run locally on the phone.
