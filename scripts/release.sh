#!/bin/sh
# Cut a release: bump the version, build the arm64 bundle, zip it, publish it to GitHub.
# The source repo is private, so the zip is published to the public releases repo below; the app's updater
# (updater.js) reads that repo's latest release over the plain GitHub API, with no token and no gh CLI.
# Signing and notarization reuse the setup Meeting Notes uses (see ~/Code/meeting-notes/RELEASING.md):
# the Developer ID certificate and the notarytool credentials stay in the Keychain and never enter the repo.
# Usage: npm run release [patch|minor|major|<version>]
set -e
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "working tree is dirty; commit first"; exit 1; }

# Both credentials are checked before the version is bumped: a failure afterwards leaves a local commit and tag
# to undo. `store-credentials` created the profile; `history` is the cheapest proof that it still authenticates.
profile="${TANA_NOTARY_PROFILE:-notarytool}"
releases=${TANA_RELEASES_REPO:-foeken/tana-companion-releases}
security find-identity -v -p codesigning | grep -q 'Developer ID Application' \
  || { echo "no Developer ID Application identity in the keychain"; exit 1; }
xcrun notarytool history --keychain-profile "$profile" >/dev/null \
  || { echo "notarytool profile '$profile' cannot authenticate; create it with: xcrun notarytool store-credentials"; exit 1; }

npm version "${1:-patch}"
version=$(node -p "require('./package.json').version")
# @electron/osx-sign signs the helpers inside-out with the hardened runtime and Electron's entitlements, and
# @electron/notarize submits, waits and staples the ticket into the bundle. Both already ship with the packager.
npm run package -- --osx-sign --osx-notarize.keychainProfile="$profile"
app="dist/Orbital-darwin-arm64/Orbital.app"
xcrun stapler validate "$app"
spctl --assess --type execute -vv "$app" # what Gatekeeper will say on a stranger's Mac, before it is published
zip="dist/Tana-Companion-$version-arm64.zip"
rm -f "$zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
# main is protected by a ruleset with no bypass (direct pushes are refused, locally by the global pre-push hook
# and server-side by GitHub), so the version bump lands through a pull request; the tag is pushed on its own.
git switch -c "release/v$version"
git push -u origin "release/v$version"
gh pr create --title "v$version" --body "Version bump for v$version."
gh pr merge --merge --delete-branch # a merge commit keeps the tagged commit reachable from main; squash would not
git switch main
git pull --ff-only
git push origin "v$version"
gh release create "v$version" "$zip" --repo "$releases" --title "v$version" --notes "Orbital $version for Apple Silicon. Signed and notarized; unzip and move it to Applications."
echo "released v$version to $releases"
