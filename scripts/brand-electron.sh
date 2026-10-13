#!/bin/sh
[ "$(uname -s)" = Darwin ] || exit 0
app=node_modules/electron/dist/Electron.app
plutil -replace CFBundleName -string Orbital "$app/Contents/Info.plist" &&
plutil -replace CFBundleDisplayName -string Orbital "$app/Contents/Info.plist" &&
plutil -replace CFBundleIdentifier -string com.dreetje.orbital.dev "$app/Contents/Info.plist" &&
cp build/icon.icns "$app/Contents/Resources/electron.icns" &&
codesign --force --deep --sign - "$app"
