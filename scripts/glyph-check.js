'use strict';
// The phones' glyphs are generated (scripts/phone-glyphs.js, icons.js): fails when the checked-in ones are not what the
// build scripts make now, so a glyph added to the list or changed in icons.js cannot ship without them. Reads only.
const fs = require('node:fs');
const path = require('node:path');
const android = require('./build-android-glyphs');
const ios = require('./build-ios-glyphs');

const stale = [];
if (!fs.existsSync(android.file) || fs.readFileSync(android.file, 'utf8') !== android.source()) stale.push(path.relative(process.cwd(), android.file));
let count = 0;
for (const [out, want] of ios.catalogs) {
  count += Object.keys(want).length;
  // (Finder's .DS_Store aside: git ignores it)
  const have = fs.existsSync(out) ? fs.readdirSync(out, { recursive: true }).filter((f) => !path.basename(f).startsWith('.') && fs.statSync(path.join(out, f)).isFile()) : [];
  for (const name of new Set([...Object.keys(want), ...have])) {
    const file = path.join(out, name);
    if (!(name in want) || !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== want[name]) stale.push(path.relative(process.cwd(), file));
  }
}
if (stale.length) {
  console.error('glyphs out of date (run node scripts/build-android-glyphs.js and node scripts/build-ios-glyphs.js):\n  ' + stale.join('\n  '));
  process.exit(1);
}
console.log('glyph-check: ok (' + count + ' iPhone files, the app\'s and the widgets\', GlyphData.kt)');
