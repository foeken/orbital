#!/bin/sh
# Compares the GPUI Timeline with the web page's, pixel for pixel: compare.sh [light|dark] [WxH]
# Writes web-, gpui-, side- and overlay-<theme>.png to $OUT (default /tmp/orbital-gpui-compare) and prints how close
# they are. Needs Google Chrome (or CHROME), a Python with Pillow (PYTHON), and to run outside the sandbox: it opens a
# window, a loopback port and Chrome. The mock stamps rows relative to when it loaded, so clock times may differ.
set -e
theme=${1:-light}; size=${2:-1100x760}; out=${OUT:-/tmp/orbital-gpui-compare}; py=${PYTHON:-python3}
here=$(cd "$(dirname "$0")" && pwd); mkdir -p "$out"
SIZE=$size THEME=$theme SHOT="$out/web-$theme.png" node "$here/web-shot.js" >/dev/null
cat > "$out/wid.swift" <<'EOF'
import CoreGraphics
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list { if (w["kCGWindowOwnerName"] as? String) == "Orbital GPUI", (w["kCGWindowLayer"] as? Int) == 0 { print(w["kCGWindowNumber"]!) } }
EOF
[ -x "$out/wid" ] || swiftc -O "$out/wid.swift" -o "$out/wid"
"$here/../bundle.sh" release >/dev/null 2>&1
pkill -f 'Orbital GPUI.app/Contents/MacOS/orbital-gpui' || true; sleep 0.5
open -n --env ORBITAL_THEME=$theme --env ORBITAL_SIZE=$size "$here/../target/release/Orbital GPUI.app"; sleep 2.5
screencapture -o -x -l"$("$out/wid" | head -1)" "$out/gpui-$theme.png"
"$py" "$here/compare.py" "$theme" "$out"
