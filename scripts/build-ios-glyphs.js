'use strict';
// The iPhone app's glyphs (ios/Orbital/Assets.xcassets/Glyphs): the Nucleo line icons of icons.js, the ones the desktop
// draws, as template vectors the app tints like SF Symbols (Image("Glyphs/<name>")). Only the names the app uses; add
// one to scripts/phone-glyphs.js, the list both phones share, when a screen needs it. Run: node scripts/build-ios-glyphs.js
const fs = require('node:fs');
const path = require('node:path');
const { USED, HEAVY } = require('./phone-glyphs');

const window = {};
new Function('window', fs.readFileSync(path.join(__dirname, '..', 'icons.js'), 'utf8'))(window);
const out = path.join(__dirname, '..', 'ios', 'Orbital', 'Assets.xcassets', 'Glyphs');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'Contents.json'), JSON.stringify({ info: { author: 'xcode', version: 1 }, properties: { 'provides-namespace': true } }, null, 2) + '\n');
const write = (name, svg) => {
  const dir = path.join(out, name + '.imageset');
  fs.mkdirSync(dir);
  // black rather than currentColor, which CoreSVG does not resolve: a template image keeps only the shape
  fs.writeFileSync(path.join(dir, name + '.svg'), svg.replace(/currentColor/g, '#000') + '\n');
  fs.writeFileSync(path.join(dir, 'Contents.json'), JSON.stringify({ images: [{ filename: name + '.svg', idiom: 'universal' }], info: { author: 'xcode', version: 1 },
    properties: { 'preserves-vector-representation': true, 'template-rendering-intent': 'template' } }, null, 2) + '\n');
};
for (const name of USED) {
  if (!window.ICONS[name]) throw new Error('no glyph ' + name + ' in icons.js');
  write(name, window.ICONS[name]);
}
for (const [name, [from, width]] of Object.entries(HEAVY)) write(name, window.ICONS[from].replace(/stroke-width="(?:[\d.]+|var\(--nucleo-stroke-width, [\d.]+\))"/g, 'stroke-width="' + width + '"'));
// (the weight is a number, or Nucleo's CSS variable as the timeline glyph has it)
console.log('wrote', USED.length + Object.keys(HEAVY).length, 'glyphs to', path.relative(process.cwd(), out));
