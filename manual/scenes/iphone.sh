#!/bin/sh
# The pictures of the iPhone chapter (manual/phone.html): the iPhone app itself on its invented sample content
# (ios/Orbital/*-sample.json, launched with -sample; ios/README.md Design shots), in a simulator of its own, light and
# dark, written as manual/media/phone-<shot>-<theme>.webp. run.js draws the desktop on the mock; this draws the phone.
# Outside the sandbox (Xcode, the simulator), a few minutes with the build:
#   sh manual/scenes/iphone.sh [shot …]
set -eu
cd "$(dirname "$0")/../.."
DEVICE='Orbital Manual'
BUILD="${TMPDIR:-/tmp}/orbital-manual-iphone"
APP="$BUILD/Build/Products/Debug-iphonesimulator/Orbital.app"
# a shot: its name | the app's launch arguments | seconds from launch to the picture
SHOTS='timeline|-sample|7
menu|-sample -menu|6
search|-sample -zoom tana:search:0000000000000000000000000s1|6
document|-sample -zoom tana:text:00000000000000000000000d01|6
meeting|-sample -zoom tana:event:0000000000000000000000000d|6
chat|-sample -zoom tana:chat:000000000000000000000000c1|6
sensitive|-sample -zoom tana:text:0000000000000000000000000b|6
ask|-sample -typing|8
quickadd|-sample -add|7
settings|-sample -settings|5'

xcodebuild -project ios/Orbital.xcodeproj -scheme Orbital -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$BUILD" CODE_SIGNING_ALLOWED=NO -quiet build >/dev/null
ID=$(xcrun simctl list devices | sed -n "s/^ *$DEVICE (\([0-9A-F-]*\)).*/\1/p" | head -1)
[ -n "$ID" ] || ID=$(xcrun simctl create "$DEVICE" com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro)
xcrun simctl boot "$ID" 2>/dev/null || true
xcrun simctl bootstatus "$ID" -b >/dev/null
xcrun simctl status_bar "$ID" override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3 --dataNetwork wifi
xcrun simctl install "$ID" "$APP"
for theme in light dark; do
  xcrun simctl ui "$ID" appearance "$theme"
  echo "$SHOTS" | while IFS='|' read -r name args wait; do
    if [ $# -gt 0 ] && ! echo " $* " | grep -q " $name "; then continue; fi
    # shellcheck disable=SC2086 # the arguments are words
    xcrun simctl launch --terminate-running-process "$ID" com.dreetje.orbital $args >/dev/null
    sleep "$wait"
    xcrun simctl io "$ID" screenshot --type=png "$BUILD/shot.png" 2>/dev/null
    # half the phone's pixels: sharp at the size the page draws it, and a fifth of the bytes
    cwebp -quiet -q 82 -resize 603 0 "$BUILD/shot.png" -o "manual/media/phone-$name-$theme.webp"
    echo "phone-$name-$theme"
  done
done
xcrun simctl terminate "$ID" com.dreetje.orbital 2>/dev/null || true
xcrun simctl shutdown "$ID"
