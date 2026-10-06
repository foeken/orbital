#!/bin/sh
# Both phones' checks on this Mac (npm run phones [android|ios|clean]; escalated: Gradle's cache, the
# emulator and the simulator live outside the checkout).
# The only place the iPhone's tests run (there is no CI): before a phone change merges, and in npm run release.
set -e
cd "$(dirname "$0")/.."
which=${1:-both}
# This checkout's simulator, named by its path since every worktree's folder is "orbital" (npm run done deletes it, as
# does ~/.local/bin/dev-cleanup once the checkout is gone)
name="Orbital $(pwd -P | shasum | cut -c1-8)"

# npm run phones clean: this checkout's simulator and iPhone build output gone (npm run done, after a merge)
if [ "$which" = clean ]; then
  xcrun simctl list devices -j | NAME="$name" node -e "const d=JSON.parse(require('fs').readFileSync(0)).devices; for (const x of Object.values(d).flat()) if (x.name===process.env.NAME) console.log(x.udid)" |
    while read -r id; do xcrun simctl shutdown "$id" 2>/dev/null || true; xcrun simctl delete "$id" && echo "phones: deleted the simulator $name"; done
  rm -rf ios/.derived
  exit 0
fi

# Android: the shared module's tests, then, with an SDK, the debug build, its lint and its device tests. With no phone or
# emulator connected the first AVD (or $ORBITAL_AVD) is started headless for them and shut down after.
android_checks() {
  . scripts/android-env.sh # the JDK and the Android SDK, if there is one (android_sdk)
  build=""
  [ -n "$android_sdk" ] && build=":androidApp:testDebugUnitTest :androidApp:assembleDebug :androidApp:lintDebug :androidApp:assembleDebugAndroidTest"
  [ -n "$build" ] || echo "phones: no Android SDK here, so the debug build is not checked"
  adb="$android_sdk/platform-tools/adb" emu=""
  if [ -n "$build" ] && [ -x "$adb" ] && ! "$adb" devices | grep -q 'device$'; then
    avd=${ORBITAL_AVD:-$("$android_sdk/emulator/emulator" -list-avds 2>/dev/null | head -1)}
    if [ -n "$avd" ]; then
      echo "phones: starting the emulator $avd"
      "$android_sdk/emulator/emulator" -avd "$avd" -no-window -no-audio -no-snapshot-save -no-boot-anim >/dev/null 2>&1 &
      emu=$!
      "$adb" wait-for-device
      i=0; until [ "$("$adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] || [ $i -ge 90 ]; do sleep 2; i=$((i + 1)); done
    fi
  fi
  if [ -n "$build" ] && [ -x "$adb" ] && "$adb" devices | grep -q 'device$'; then build="$build :androidApp:connectedDebugAndroidTest"
  elif [ -n "$build" ]; then echo "phones: no phone, emulator or AVD here, so the device tests are built, not run"; fi
  status=0
  (cd android && ./gradlew :shared:jvmTest $build --console=plain) || status=$?
  [ -z "$emu" ] || "$adb" emu kill >/dev/null 2>&1 || kill "$emu" 2>/dev/null || true
  [ "$status" = 0 ] || return "$status"
  # the release APK as npm run release builds it, signed, read back and checked, on this Mac's debug key (never released)
  [ -z "$android_sdk" ] || sh scripts/android-release.sh --self-test
}

# iPhone: the UI tests on this checkout's simulator (name, above), made once on the newest iOS runtime as its first iPhone
# and reused: two checkouts testing at once on one shared iPhone killed each other's tests ("Test crashed with signal
# kill"). The tests run on three copies of it at once, which Xcode makes for the run and deletes after. Its build output
# stays in the checkout (ios/.derived), so both go with it.
ios_checks() {
  # Xcode's own components, CoreSimulator among them, come with its first launch; without them no simulator starts
  xcodebuild -checkFirstLaunchStatus || { echo "phones: Xcode needs its first-launch install: sudo xcodebuild -runFirstLaunch"; return 1; }
  sim=$(xcrun simctl list devices available -j | NAME="$name" node -e "const d=JSON.parse(require('fs').readFileSync(0)).devices; const rt=Object.keys(d).filter(k=>k.includes('iOS')).sort().reverse()[0]; const mine=d[rt].find(x=>x.name===process.env.NAME); console.log(mine ? mine.udid : 'new '+d[rt].find(x=>x.name.startsWith('iPhone')).deviceTypeIdentifier+' '+rt)")
  case "$sim" in new\ *) set -- $sim; sim=$(xcrun simctl create "$name" "$2" "$3"); echo "phones: made the simulator $name";; esac
  (cd ios && xcodebuild test -project Orbital.xcodeproj -scheme Orbital -destination "platform=iOS Simulator,id=$sim" -derivedDataPath .derived \
    -parallel-testing-enabled YES -parallel-testing-worker-count 3 \
    -test-timeouts-enabled YES -default-test-execution-time-allowance 180 -maximum-test-execution-time-allowance 300 \
    -retry-tests-on-failure -test-iterations 2 \
    CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO -quiet)
}

# One phone, or both one after the other: at once, the emulator, Gradle and the simulator copies starved each other
# and tests failed that pass alone
case "$which" in
  android) android_checks ;;
  ios) ios_checks ;;
  *) android_checks; ios_checks ;;
esac
echo "phones: ok ($which)"
