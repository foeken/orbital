'use strict';
// Renders the app icon (Tana prism symbol on a black rounded square, macOS layout) to build/icon.png and build/icon.icns.
// Run: ./node_modules/.bin/electron scripts/build-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SYMBOL = fs.readFileSync(path.join(__dirname, '..', 'build', 'tana-symbol.svg'), 'utf8');
const html = '<!doctype html><html><body style="margin:0;background:transparent">'
  + '<div style="position:absolute;left:100px;top:100px;width:824px;height:824px;border-radius:186px;background:#000;display:flex;align-items:center;justify-content:center">'
  + '<div style="width:340px;height:425px">' + SYMBOL.replace('<svg ', '<svg style="width:100%;height:100%" ') + '</div></div></body></html>';

app.dock && app.dock.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const out = path.join(__dirname, '..', 'build');
  fs.writeFileSync(path.join(out, 'icon.png'), image.toPNG());
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

