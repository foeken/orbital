#!/bin/sh
# Cut a release: bump the version, build the arm64 bundle, zip it, publish it to GitHub.
# The app's updater (updater.js) reads the newest release of the same repo through the gh CLI.
# Signing and notarization reuse the setup Meeting Notes uses (see ~/Code/meeting-notes/RELEASING.md):
# the Developer ID certificate and the notarytool credentials stay in the Keychain and never enter the repo.
# Usage: npm run release [patch|minor|major|<version>]
set -e
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "working tree is dirty; commit first"; exit 1; }

# Both credentials are checked before the version is bumped: a failure afterwards leaves a local commit and tag
# to undo. `store-credentials` created the profile; `history` is the cheapest proof that it still authenticates.
profile="${TANA_NOTARY_PROFILE:-notarytool}"
security find-identity -v -p codesigning | grep -q 'Developer ID Application' \
  || { echo "no Developer ID Application identity in the keychain"; exit 1; }
xcrun notarytool history --keychain-profile "$profile" >/dev/null \
  || { echo "notarytool profile '$profile' cannot authenticate; create it with: xcrun notarytool store-credentials"; exit 1; }

npm version "${1:-patch}"
version=$(node -p "require('./package.json').version")
# @electron/osx-sign signs the helpers inside-out with the hardened runtime and Electron's entitlements, and
# @electron/notarize submits, waits and staples the ticket into the bundle. Both already ship with the packager.
npm run package -- --osx-sign --osx-notarize.keychainProfile="$profile"
app="dist/Tana Companion-darwin-arm64/Tana Companion.app"
xcrun stapler validate "$app"
spctl --assess --type execute -vv "$app" # what Gatekeeper will say on a stranger's Mac, before it is published
zip="dist/Tana-Companion-$version-arm64.zip"
rm -f "$zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
git push --follow-tags
gh release create "v$version" "$zip" --title "v$version" --generate-notes
echo "released v$version"
