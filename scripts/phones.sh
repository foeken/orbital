#!/bin/sh
# Both phones' checks on this Mac, as the full gate runs them (.github/workflows/checks.yml) (npm run phones [android|ios]; escalated: Gradle's
# cache and the simulator live outside the checkout). Android: the shared module's tests, the screens among them, and,
# with an Android SDK here, the debug build, its lint and its device tests compiled, and run on a phone or emulator when
# one is connected (adb devices; without an SDK CI builds it, the tests need none). iPhone: the UI tests on a simulator.
# A minute or so each here, against a quarter of an hour a push on GitHub's macOS runners, so a phone change is tested
# on this machine before it is ready, and the full gate runs it again before it reaches main.
set -e
cd "$(dirname "$0")/.."
which=${1:-both}

if [ "$which" != ios ]; then
  . scripts/android-env.sh # the JDK and the Android SDK, if there is one (android_sdk)
  build=""
  [ -n "$android_sdk" ] && build=":androidApp:assembleDebug :androidApp:lintDebug :androidApp:assembleDebugAndroidTest"
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
  # the newest iOS runtime's first iPhone, as .github/workflows/checks.yml picks it
  sim=$(xcrun simctl list devices available -j | node -e "const d=JSON.parse(require('fs').readFileSync(0)).devices; const rt=Object.keys(d).filter(k=>k.includes('iOS')).sort().reverse()[0]; console.log(d[rt].find(x=>x.name.startsWith('iPhone')).udid)")
  (cd ios && xcodebuild test -project Orbital.xcodeproj -scheme Orbital -destination "platform=iOS Simulator,id=$sim" \
    -test-timeouts-enabled YES -default-test-execution-time-allowance 180 -retry-tests-on-failure -test-iterations 2 \
    CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO -quiet)
fi
echo "phones: ok ($which)"
