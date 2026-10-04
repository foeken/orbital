#!/bin/sh
# Orbital for Android as a download (docs/ANDROID.md, Releasing): the release APK of this checkout at package.json's
# version, signed with Orbital's release key and read back before scripts/release.sh attaches it to the GitHub release,
# beside the Mac's zip, as Orbital-android.apk, the name the Help tour's code fetches from the latest release.
#   sh scripts/android-release.sh --check       the key is here, opens, and is the pinned one; builds nothing
#   sh scripts/android-release.sh <out.apk>     build, sign, check, and copy the APK to out.apk
#   sh scripts/android-release.sh --self-test   the same on this Mac's debug key, test-only and never published (npm run phones)
# The key is a keystore kept outside the repo: ORBITAL_ANDROID_KEYSTORE (default ~/.android/orbital-release.jks), its
# alias ORBITAL_ANDROID_KEY_ALIAS (default orbital), its password ORBITAL_ANDROID_KEYSTORE_PASSWORD or else read from
# 1Password (ORBITAL_ANDROID_KEY_OP, default the Echo vault's item "Orbital Android release key", which also holds the
# keystore itself and its fingerprint; op signed in, or OP_ECHO_SERVICE_ACCOUNT_TOKEN as the service account).
# A phone takes an update only when it carries the certificate the installed
# copy has, so that certificate's SHA-256 is pinned in android/release-key.sha256 and any other key is refused, Android's
# debug key above all. ORBITAL_ANDROID_CERT_SHA256 stands in for that file in the self-test.
set -e
cd "$(dirname "$0")/.."
mode=$1
case "$mode" in --check|--self-test) ;; ''|-*) echo "usage: sh scripts/android-release.sh --check | --self-test | <out.apk>"; exit 2;; esac
. scripts/android-env.sh
[ -n "$android_sdk" ] || { echo "android: no Android SDK (ANDROID_HOME)"; exit 1; }
tools=$(ls -d "$android_sdk"/build-tools/* 2>/dev/null | sort -V | tail -1)
[ -x "$tools/apksigner" ] || { echo "android: no build-tools with apksigner in $android_sdk"; exit 1; }

if [ "$mode" = --self-test ]; then
  # the debug key and its well-known values (Android's own, the same on every Mac): what it signs is never published
  export ORBITAL_ANDROID_KEYSTORE="$HOME/.android/debug.keystore" ORBITAL_ANDROID_KEY_ALIAS=androiddebugkey \
    ORBITAL_ANDROID_KEYSTORE_PASSWORD=android ORBITAL_ANDROID_KEY_PASSWORD=android
else
  export ORBITAL_ANDROID_KEYSTORE="${ORBITAL_ANDROID_KEYSTORE:-$HOME/.android/orbital-release.jks}" ORBITAL_ANDROID_KEY_ALIAS="${ORBITAL_ANDROID_KEY_ALIAS:-orbital}"
  [ -n "$ORBITAL_ANDROID_KEYSTORE_PASSWORD" ] || ORBITAL_ANDROID_KEYSTORE_PASSWORD=$(
    [ -z "$OP_ECHO_SERVICE_ACCOUNT_TOKEN" ] || [ -n "$OP_SERVICE_ACCOUNT_TOKEN" ] || export OP_SERVICE_ACCOUNT_TOKEN="$OP_ECHO_SERVICE_ACCOUNT_TOKEN"
    op read "${ORBITAL_ANDROID_KEY_OP:-op://Echo/Orbital Android release key/password}" 2>/dev/null) || true
  export ORBITAL_ANDROID_KEYSTORE_PASSWORD ORBITAL_ANDROID_KEY_PASSWORD="${ORBITAL_ANDROID_KEY_PASSWORD:-$ORBITAL_ANDROID_KEYSTORE_PASSWORD}"
fi

# The key: there, open with its password, the pinned one, and not a debug key
[ -f "$ORBITAL_ANDROID_KEYSTORE" ] || { echo "android: no release key at $ORBITAL_ANDROID_KEYSTORE (docs/ANDROID.md, Releasing); ORBITAL_ANDROID=0 npm run release releases the Mac alone"; exit 1; }
[ -n "$ORBITAL_ANDROID_KEYSTORE_PASSWORD" ] || { echo "android: no password for the release key: ORBITAL_ANDROID_KEYSTORE_PASSWORD, or 1Password (op) with the item ${ORBITAL_ANDROID_KEY_OP:-op://Echo/Orbital Android release key/password}"; exit 1; }
cert=$("$JAVA_HOME/bin/keytool" -list -v -keystore "$ORBITAL_ANDROID_KEYSTORE" -alias "$ORBITAL_ANDROID_KEY_ALIAS" -storepass:env ORBITAL_ANDROID_KEYSTORE_PASSWORD 2>&1) \
  || { echo "android: cannot open $ORBITAL_ANDROID_KEY_ALIAS in $ORBITAL_ANDROID_KEYSTORE: $(echo "$cert" | tail -1)"; exit 1; }
sha=$(echo "$cert" | sed -n 's/^.*SHA256: *//p' | head -1 | tr -d ': ' | tr 'A-F' 'a-f')
if [ "$mode" = --self-test ]; then pin=$sha; else pin=$(echo "${ORBITAL_ANDROID_CERT_SHA256:-$(cat android/release-key.sha256 2>/dev/null)}" | tr -d ': \n' | tr 'A-F' 'a-f'); fi
[ -n "$pin" ] || { echo "android: no release key pinned: put its certificate's SHA-256 ($sha) in android/release-key.sha256, in a pull request of its own"; exit 1; }
[ "$sha" = "$pin" ] || { echo "android: $ORBITAL_ANDROID_KEYSTORE is not the pinned release key (android/release-key.sha256): phones would refuse its APK as an update"; exit 1; }
# keytool names the owner most significant part last: Owner: C=US, O=Android, CN=Android Debug
if [ "$mode" != --self-test ] && echo "$cert" | grep -Eq '^Owner: (.*, )?CN=Android Debug(,|$)'; then echo "android: that is a debug key, not a release key"; exit 1; fi
[ "$mode" != --check ] || { echo "android: release key ok"; exit 0; }

if [ "$mode" = --self-test ]; then
  # what a release refuses, then the build itself into a scratch file that is removed afterwards
  out=$(mktemp -d)/Orbital-android-selftest.apk
  trap 'rm -rf "$(dirname "$out")"' EXIT
  said=$(ORBITAL_ANDROID_CERT_SHA256=00 sh "$0" --check 2>&1) && { echo "android: self-test: a key that is not the pinned one passed"; exit 1; }
  case "$said" in *"not the pinned release key"*) ;; *) echo "android: self-test: unexpected refusal: $said"; exit 1;; esac
  said=$(ORBITAL_ANDROID_CERT_SHA256=$sha sh "$0" --check 2>&1) && { echo "android: self-test: the debug key passed as a release key"; exit 1; }
  case "$said" in *"debug key"*) ;; *) echo "android: self-test: unexpected refusal: $said"; exit 1;; esac
  daemon=""
else
  out=$mode
  daemon=--no-daemon # the key's password goes with the build, not into a daemon that outlives it
fi

# The build. Gradle reads the version off package.json (androidApp/build.gradle.kts) and signs with the key above.
apk=android/androidApp/build/outputs/apk/release/androidApp-release.apk
rm -f "$apk"
(cd android && ./gradlew :androidApp:assembleRelease --console=plain $daemon)

# Read back: signed by that key alone, with a v2 or v3 signature, the version release.sh tags, and not debuggable
signed=$("$tools/apksigner" verify --verbose --print-certs "$apk")
echo "$signed" | grep -Eq '^Verified using v[23] scheme .*: true' || { echo "android: the APK has no v2 or v3 signature"; exit 1; }
[ "$(echo "$signed" | sed -n 's/^Number of signers: //p')" = 1 ] || { echo "android: the APK should have one signer"; exit 1; }
[ "$(echo "$signed" | sed -n 's/^V[0-9.]* Signer: certificate SHA-256 digest: //p' | sort -u)" = "$pin" ] || { echo "android: the APK is not signed with the pinned key"; exit 1; }
version=$(node -p "require('./package.json').version")
code=$(node -p "const [a, b, c] = require('./package.json').version.split('.').map(Number); a * 1e6 + b * 1e3 + c")
badging=$("$tools/aapt2" dump badging "$apk")
echo "$badging" | grep -q "^package: name='com.dreetje.orbital' versionCode='$code' versionName='$version'" \
  || { echo "android: the APK is not com.dreetje.orbital $version ($code): $(echo "$badging" | head -1)"; exit 1; }
if echo "$badging" | grep -q 'application-debuggable'; then echo "android: the APK is debuggable"; exit 1; fi
# every widget is offered on every screen (widgetCategory home_screen 0x1 and keyguard 0x2: the lock screen and a Flip's
# cover screen): the first release APK offered the Timeline's two on the cover screen only and Today's Tasks on the home
# screen only, so a phone's home screen listed Today's Tasks alone (the debug build had more)
for xml in $("$tools/aapt2" dump resources "$apk" | awk '/ xml\/[a-z_]*_widget$/ { getline; print $3 }'); do
  category=$("$tools/aapt2" dump xmltree --file "$xml" "$apk" | sed -n 's/.*widgetCategory([^)]*)=0x//p')
  [ -n "$category" ] && [ $((0x$category & 3)) = 3 ] || { echo "android: a widget ($xml) is not offered on both the home screen and the lock or cover screen"; exit 1; }
done
cp "$apk" "$out"
if [ "$mode" = --self-test ]; then echo "android: self-test ok: Orbital $version ($code) built, signed with the debug key (test-only) and read back; a debug key and an unpinned key are refused"
else echo "android: $out, Orbital $version ($code), signed by $sha"; fi
