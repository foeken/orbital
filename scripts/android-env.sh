# The JDK and Android SDK the Android scripts build with (sourced by scripts/phones.sh and scripts/android-release.sh):
# JAVA_HOME, else the system's, else Homebrew's openjdk@21 or openjdk (keg-only, so java_home misses them); ANDROID_HOME,
# else android/local.properties, else Android Studio's, else Homebrew's command-line tools (brew install --cask
# android-commandlinetools, with sdkmanager's platform and build-tools in it). android_sdk is the SDK found, or empty.
if [ -z "$JAVA_HOME" ]; then
  JAVA_HOME=$(/usr/libexec/java_home 2>/dev/null || true)
  [ -n "$JAVA_HOME" ] || JAVA_HOME="$(brew --prefix openjdk@21 2>/dev/null)/libexec/openjdk.jdk/Contents/Home"
  [ -x "$JAVA_HOME/bin/java" ] || JAVA_HOME="$(brew --prefix openjdk 2>/dev/null)/libexec/openjdk.jdk/Contents/Home"
fi
[ -x "$JAVA_HOME/bin/java" ] || { echo "no JDK; brew install openjdk@21"; exit 1; }
export JAVA_HOME
if [ -z "$ANDROID_HOME" ] && [ ! -f android/local.properties ] && [ ! -d "$HOME/Library/Android/sdk" ] && [ -d "$(brew --prefix 2>/dev/null)/share/android-commandlinetools/platforms" ]; then
  export ANDROID_HOME="$(brew --prefix)/share/android-commandlinetools"
fi
android_sdk=${ANDROID_HOME:-$(sed -n 's/^sdk\.dir=//p' android/local.properties 2>/dev/null)}
[ -n "$android_sdk" ] || [ ! -d "$HOME/Library/Android/sdk" ] || android_sdk="$HOME/Library/Android/sdk"
