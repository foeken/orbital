#!/bin/sh
# Both phones' checks on this Mac, as CI and the iOS workflow run them (npm run phones [android|ios]; escalated: Gradle's
# cache and the simulator live outside the checkout). Android: the shared module's tests, the screens among them, and,
# with an Android SDK here, the debug build (without one CI builds it; the tests need no SDK). iPhone: the UI tests on a
# simulator. A minute or so each here, against a quarter of an hour a push on GitHub's macOS runners, so a phone change
# is tested on this machine and CI only confirms it.
set -e
cd "$(dirname "$0")/.."
which=${1:-both}

if [ "$which" != ios ]; then
  # a JDK: JAVA_HOME, the system's, or Homebrew's openjdk@21 (brew install openjdk@21; keg-only, so java_home misses it)
  if [ -z "$JAVA_HOME" ]; then
    JAVA_HOME=$(/usr/libexec/java_home 2>/dev/null || true)
    [ -n "$JAVA_HOME" ] || JAVA_HOME="$(brew --prefix openjdk@21 2>/dev/null)/libexec/openjdk.jdk/Contents/Home"
  fi
  [ -x "$JAVA_HOME/bin/java" ] || { echo "phones: no JDK; brew install openjdk@21"; exit 1; }
  export JAVA_HOME
  build=""
  [ -n "$ANDROID_HOME" ] || [ -f android/local.properties ] || [ -d "$HOME/Library/Android/sdk" ] && build=:androidApp:assembleDebug
  [ -n "$build" ] || echo "phones: no Android SDK here, so the debug build is left to CI"
  (cd android && ./gradlew :shared:jvmTest $build --console=plain)
fi

if [ "$which" != android ]; then
  # Xcode's own components, CoreSimulator among them, come with its first launch; without them no simulator starts
  xcodebuild -checkFirstLaunchStatus || { echo "phones: Xcode needs its first-launch install: sudo xcodebuild -runFirstLaunch"; exit 1; }
  # the newest iOS runtime's first iPhone, as .github/workflows/ios.yml picks it
  sim=$(xcrun simctl list devices available -j | node -e "const d=JSON.parse(require('fs').readFileSync(0)).devices; const rt=Object.keys(d).filter(k=>k.includes('iOS')).sort().reverse()[0]; console.log(d[rt].find(x=>x.name.startsWith('iPhone')).udid)")
  (cd ios && xcodebuild test -project Orbital.xcodeproj -scheme Orbital -destination "platform=iOS Simulator,id=$sim" \
    -test-timeouts-enabled YES -default-test-execution-time-allowance 180 -retry-tests-on-failure -test-iterations 2 \
    CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO -quiet)
fi
echo "phones: ok ($which)"
