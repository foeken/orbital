#!/bin/sh
# Puts gpui 0.2.2 from crates.io in vendor/gpui (gitignored) with Orbital's patches applied, for Cargo.toml's
# [patch.crates-io]. Today one patch: glyphs drawn without font smoothing, as Orbital's CSS draws them
# (-webkit-font-smoothing: antialiased), so text has the web page's weight rather than macOS's thickened strokes.
set -e
cd "$(dirname "$0")"
[ -f vendor/gpui/.patched ] && exit 0
rm -rf vendor/gpui && mkdir -p vendor
curl -sSfL https://static.crates.io/crates/gpui/gpui-0.2.2.crate | tar xz -C vendor
mv vendor/gpui-0.2.2 vendor/gpui
for p in patches/*.patch; do patch -s -p1 -d vendor/gpui < "$p"; done
touch vendor/gpui/.patched
