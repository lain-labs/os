#!/usr/bin/env bash
#
# Creates the Android signing key the release APK is published with, and hands it
# to GitHub Actions as repository secrets.
#
# Run this once. The key is the app's identity: Android refuses to upgrade an
# installed app whose signature changed, so losing this file means every user has
# to uninstall before they can take another release. Back up
# android/lainos-release.jks and the password somewhere that is not this repo.
#
#   frontend/mobile/scripts/make-keystore.sh
#
# Nothing it writes is committed: *.jks and keystore.properties are git-ignored.

set -euo pipefail

cd "$(dirname "$0")/.."

KEYSTORE="android/lainos-release.jks"
PROPERTIES="android/keystore.properties"
ALIAS="cyberia"
VALIDITY_DAYS=10950 # 30 years — Play requires the key to outlive the app.

command -v keytool >/dev/null || {
    echo "keytool not found. Install a JDK (21) first." >&2
    exit 1
}

if [ -e "$KEYSTORE" ]; then
    echo "$KEYSTORE already exists — refusing to overwrite the app's identity." >&2
    echo "Delete it by hand if you are certain no release was ever signed with it." >&2
    exit 1
fi

read -rsp "Password for the new keystore (min 6 chars): " PASSWORD
echo
read -rsp "Repeat it: " CONFIRM
echo

[ "$PASSWORD" = "$CONFIRM" ] || {
    echo "Passwords do not match." >&2
    exit 1
}
[ ${#PASSWORD} -ge 6 ] || {
    echo "keytool requires at least 6 characters." >&2
    exit 1
}

keytool -genkeypair \
    -keystore "$KEYSTORE" \
    -alias "$ALIAS" \
    -keyalg RSA \
    -keysize 4096 \
    -validity "$VALIDITY_DAYS" \
    -storepass "$PASSWORD" \
    -keypass "$PASSWORD" \
    -dname "CN=Lain OS, OU=Lain OS, O=Lain OS, L=Internet, C=ZZ"

# Same file the CI job writes, so a local `npm run android:release` signs too.
cat >"$PROPERTIES" <<EOF
storeFile=lainos-release.jks
storePassword=$PASSWORD
keyAlias=$ALIAS
keyPassword=$PASSWORD
EOF
chmod 600 "$PROPERTIES" "$KEYSTORE"

echo
echo "Wrote $KEYSTORE and $PROPERTIES (both git-ignored)."
echo

FINGERPRINT=$(keytool -list -v -keystore "$KEYSTORE" -alias "$ALIAS" -storepass "$PASSWORD" |
    awk -F': ' '/SHA256:/ { print $2; exit }')

echo "SHA-256 fingerprint — this is what turns https://cyberia.church links into"
echo "app links. Put it in the Laravel .env as LAIN_ANDROID_SHA256_FINGERPRINT:"
echo
echo "  $FINGERPRINT"
echo

if ! command -v gh >/dev/null; then
    echo "gh is not installed, so the secrets have to be added by hand at"
    echo "  Settings -> Secrets and variables -> Actions:"
    echo "    ANDROID_KEYSTORE_BASE64   base64 -w0 frontend/mobile/$KEYSTORE"
    echo "    ANDROID_KEYSTORE_PASSWORD the password you just typed"
    echo "    ANDROID_KEY_ALIAS         $ALIAS"
    echo "    ANDROID_KEY_PASSWORD      the same password"
    exit 0
fi

read -rp "Upload these to GitHub Actions secrets with gh now? [y/N] " REPLY
case "$REPLY" in
y | Y)
    base64 -w0 "$KEYSTORE" | gh secret set ANDROID_KEYSTORE_BASE64
    printf '%s' "$PASSWORD" | gh secret set ANDROID_KEYSTORE_PASSWORD
    printf '%s' "$ALIAS" | gh secret set ANDROID_KEY_ALIAS
    printf '%s' "$PASSWORD" | gh secret set ANDROID_KEY_PASSWORD
    echo "Done. The next app-v* tag publishes a signed APK."
    ;;
*)
    echo "Skipped. Nothing left this machine."
    ;;
esac
