'use strict';
// The iPhone app's glyphs (ios/Orbital/Assets.xcassets/Glyphs): the Nucleo line icons of icons.js, the ones the desktop
// draws, as template vectors the app tints like SF Symbols (Image("Glyphs/<name>")). Only the names the app uses; add
// one to scripts/phone-glyphs.js, the list both phones share, when a screen needs it. Run: node scripts/build-ios-glyphs.js
const fs = require('node:fs');
const path = require('node:path');
const { USED, HEAVY, WIDGETS } = require('./phone-glyphs');

const window = {};
new Function('window', fs.readFileSync(path.join(__dirname, '..', 'icons.js'), 'utf8'))(window);
const out = path.join(__dirname, '..', 'ios', 'Orbital', 'Assets.xcassets', 'Glyphs');
// every file of a catalog folder, by its path inside it, which scripts/glyph-check.js compares with the ones checked in;
// only: the names it keeps (the widgets'), or all
function files(only) {
  const all = { 'Contents.json': JSON.stringify({ info: { author: 'xcode', version: 1 }, properties: { 'provides-namespace': true } }, null, 2) + '\n' };
  const add = (name, svg) => {
    // black rather than currentColor, which CoreSVG does not resolve: a template image keeps only the shape
    all[name + '.imageset/' + name + '.svg'] = svg.replace(/currentColor/g, '#000') + '\n';
    all[name + '.imageset/Contents.json'] = JSON.stringify({ images: [{ filename: name + '.svg', idiom: 'universal' }], info: { author: 'xcode', version: 1 },
      properties: { 'preserves-vector-representation': true, 'template-rendering-intent': 'template' } }, null, 2) + '\n';
  };
  for (const name of USED) {
    if (!window.ICONS[name]) throw new Error('no glyph ' + name + ' in icons.js');
    if (!only || only.includes(name)) add(name, window.ICONS[name]);
  }
  // (the weight is a number, or Nucleo's CSS variable as the timeline glyph has it)
  for (const [name, [from, width]] of Object.entries(HEAVY)) if (!only || only.includes(name)) add(name, window.ICONS[from].replace(/stroke-width="(?:[\d.]+|var\(--nucleo-stroke-width, [\d.]+\))"/g, 'stroke-width="' + width + '"'));
  return all;
}
// the app's catalog and the widgets' (ios/Widgets), each folder with what it holds
const catalogs = [[out, files()], [path.join(__dirname, '..', 'ios', 'Widgets', 'Assets.xcassets', 'Glyphs'), files(WIDGETS)]];

module.exports = { catalogs };
if (require.main === module) {
  for (const [dir, all] of catalogs) {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [name, text] of Object.entries(all)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    }
    console.log('wrote', (Object.keys(all).length - 1) / 2, 'glyphs to', path.relative(process.cwd(), dir));
  }
}
