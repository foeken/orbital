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
  # a JDK: JAVA_HOME, the system's, or Homebrew's openjdk@21 or openjdk (keg-only, so java_home misses them)
  if [ -z "$JAVA_HOME" ]; then
    JAVA_HOME=$(/usr/libexec/java_home 2>/dev/null || true)
    [ -n "$JAVA_HOME" ] || JAVA_HOME="$(brew --prefix openjdk@21 2>/dev/null)/libexec/openjdk.jdk/Contents/Home"
    [ -x "$JAVA_HOME/bin/java" ] || JAVA_HOME="$(brew --prefix openjdk 2>/dev/null)/libexec/openjdk.jdk/Contents/Home"
  fi
  [ -x "$JAVA_HOME/bin/java" ] || { echo "phones: no JDK; brew install openjdk@21"; exit 1; }
  export JAVA_HOME
  # an Android SDK: ANDROID_HOME, android/local.properties, Android Studio's, or Homebrew's command-line tools
  # (brew install --cask android-commandlinetools, with sdkmanager's platform and build-tools in it)
  if [ -z "$ANDROID_HOME" ] && [ ! -f android/local.properties ] && [ ! -d "$HOME/Library/Android/sdk" ] && [ -d "$(brew --prefix 2>/dev/null)/share/android-commandlinetools/platforms" ]; then
    export ANDROID_HOME="$(brew --prefix)/share/android-commandlinetools"
  fi
  build=""
  [ -n "$ANDROID_HOME" ] || [ -f android/local.properties ] || [ -d "$HOME/Library/Android/sdk" ] && build=":androidApp:assembleDebug :androidApp:lintDebug :androidApp:assembleDebugAndroidTest"
  [ -n "$build" ] || echo "phones: no Android SDK here, so the debug build is left to CI"
  # the device tests on whatever phone or emulator adb sees (emulator -avd <name>, or a phone over USB)
  adb="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
  if [ -n "$build" ] && [ -x "$adb" ] && "$adb" devices | grep -q 'device$'; then build="$build :androidApp:connectedDebugAndroidTest"; fi
  [ -n "$build" ] && case "$build" in *connected*) ;; *) echo "phones: no phone or emulator connected, so the device tests are built, not run";; esac
  (cd android && ./gradlew :shared:jvmTest $build --console=plain)
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
