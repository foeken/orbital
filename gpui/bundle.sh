#!/bin/sh
# Wraps the spike's binary in a minimal app bundle, so macOS (and Computer Use) sees an app: bundle.sh [debug|release]
set -e
cd "$(dirname "$0")"
profile=${1:-debug}
if [ "$profile" = release ]; then cargo build --release; else cargo build; fi
app="target/$profile/Orbital GPUI.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "target/$profile/orbital-gpui" "$app/Contents/MacOS/orbital-gpui"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Orbital GPUI</string>
  <key>CFBundleIdentifier</key><string>com.dreetje.orbital.gpui</string>
  <key>CFBundleExecutable</key><string>orbital-gpui</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
echo "$app"
