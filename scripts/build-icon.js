'use strict';
// Renders the app icon (the Orbital planet, white on a black rounded square, macOS layout) to build/icon.icns and
// build/icon.png, the dev Dock and About icon: 512 px, because main.js decodes it on main before the first window (#418).
// With --ios, the iPhone app's icon instead (ios/Orbital/Assets.xcassets): the same planet at the same share of the
// square, full bleed at 1024 px, since iOS rounds the corners itself.
// Run: ./node_modules/.bin/electron scripts/build-icon.js [--ios]
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SYMBOL = fs.readFileSync(path.join(__dirname, '..', 'build', 'orbital-symbol.svg'), 'utf8');
const IOS = process.argv.includes('--ios');
const square = IOS ? 'left:0;top:0;width:1024px;height:1024px' : 'left:100px;top:100px;width:824px;height:824px;border-radius:186px';
const planet = IOS ? Math.round(1024 * 520 / 824) : 520;
const html = '<!doctype html><html><body style="margin:0;background:transparent">'
  + '<div style="position:absolute;' + square + ';background:#000;display:flex;align-items:center;justify-content:center">'
  + '<div style="width:' + planet + 'px;height:' + planet + 'px">' + SYMBOL.replace('<svg ', '<svg style="width:100%;height:100%" ') + '</div></div></body></html>';

app.dock && app.dock.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  if (IOS) {
    const file = path.join(__dirname, '..', 'ios', 'Orbital', 'Assets.xcassets', 'AppIcon.appiconset', 'icon.png');
    fs.writeFileSync(file, image.toPNG());
    console.log('wrote ' + path.relative(path.join(__dirname, '..'), file));
    return app.quit();
  }
  const out = path.join(__dirname, '..', 'build');
  fs.writeFileSync(path.join(out, 'icon.png'), image.resize({ width: 512, height: 512 }).toPNG());
  const set = path.join(out, 'icon.iconset');
  fs.rmSync(set, { recursive: true, force: true }); fs.mkdirSync(set);
  for (const [name, size] of [['16x16', 16], ['16x16@2x', 32], ['32x32', 32], ['32x32@2x', 64], ['128x128', 128], ['128x128@2x', 256], ['256x256', 256], ['256x256@2x', 512], ['512x512', 512], ['512x512@2x', 1024]]) {
    fs.writeFileSync(path.join(set, 'icon_' + name + '.png'), image.resize({ width: size, height: size }).toPNG());
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(out, 'icon.icns')]);
  fs.rmSync(set, { recursive: true, force: true });
  console.log('wrote build/icon.png and build/icon.icns');
  app.quit();
});
