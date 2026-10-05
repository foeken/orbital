#!/bin/sh
# Both phones' checks on this Mac, as the scheduled checks run them (.github/workflows/checks.yml) (npm run phones [android|ios]; escalated: Gradle's
# cache and the simulator live outside the checkout). Android: the shared module's tests, the screens among them, and,
# with an Android SDK here, the debug build, its lint and its device tests compiled, and run on a phone or emulator when
# one is connected (adb devices; without an SDK CI builds it, the tests need none). iPhone: the UI tests on a simulator.
# A minute or so each here, against a quarter of an hour a push on GitHub's macOS runners, so a phone change is tested
# on this machine before it merges, and the scheduled run on main confirms it.
set -e
cd "$(dirname "$0")/.."
which=${1:-both}

if [ "$which" != ios ]; then
  . scripts/android-env.sh # the JDK and the Android SDK, if there is one (android_sdk)
  build=""
  [ -n "$android_sdk" ] && build=":androidApp:testDebugUnitTest :androidApp:assembleDebug :androidApp:lintDebug :androidApp:assembleDebugAndroidTest"
  [ -n "$build" ] || echo "phones: no Android SDK here, so the debug build is left to CI"
  # the device tests on whatever phone or emulator adb sees (emulator -avd <name>, or a phone over USB)
  adb="$android_sdk/platform-tools/adb"
  if [ -n "$build" ] && [ -x "$adb" ] && "$adb" devices | grep -q 'device$'; then build="$build :androidApp:connectedDebugAndroidTest"; fi
  [ -n "$build" ] && case "$build" in *connected*) ;; *) echo "phones: no phone or emulator connected, so the device tests are built, not run";; esac
  (cd android && ./gradlew :shared:jvmTest $build --console=plain)
  # the release APK as npm run release builds it, signed, read back and checked, on this Mac's debug key (never released)
  [ -z "$android_sdk" ] || sh scripts/android-release.sh --self-test
fi

if [ "$which" != android ]; then
  # Xcode's own components, CoreSimulator among them, come with its first launch; without them no simulator starts
  xcodebuild -checkFirstLaunchStatus || { echo "phones: Xcode needs its first-launch install: sudo xcodebuild -runFirstLaunch"; exit 1; }
  # A simulator of this checkout's own, made once on the newest iOS runtime as its first iPhone (the one
  # .github/workflows/checks.yml picks) and reused: two checkouts testing at once on one shared iPhone killed each other's
  # tests ("Test crashed with signal kill"). Named by the checkout's path, since every worktree's folder is "orbital".
  # ponytail: one left behind per checkout and runtime; xcrun simctl delete unavailable, or by name, clears them.
  name="Orbital $(pwd -P | shasum | cut -c1-8)"
  sim=$(xcrun simctl list devices available -j | NAME="$name" node -e "const d=JSON.parse(require('fs').readFileSync(0)).devices; const rt=Object.keys(d).filter(k=>k.includes('iOS')).sort().reverse()[0]; const mine=d[rt].find(x=>x.name===process.env.NAME); console.log(mine ? mine.udid : 'new '+d[rt].find(x=>x.name.startsWith('iPhone')).deviceTypeIdentifier+' '+rt)")
  case "$sim" in new\ *) set -- $sim; sim=$(xcrun simctl create "$name" "$2" "$3"); echo "phones: made the simulator $name";; esac
  (cd ios && xcodebuild test -project Orbital.xcodeproj -scheme Orbital -destination "platform=iOS Simulator,id=$sim" \
    -test-timeouts-enabled YES -default-test-execution-time-allowance 180 -maximum-test-execution-time-allowance 300 \
    -retry-tests-on-failure -test-iterations 2 \
    CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO -quiet)
fi
echo "phones: ok ($which)"
