'use strict';
// Orbital for Android is for every Android phone (AGENTS.md, Every platform; docs/ANDROID.md, Review guidelines): what a
// user can do is never kept to one maker, one model or one build. This holds the mechanical part offline, so a PR fails
// here and not at release (scripts/android-release.sh reads the same back from the signed APK):
// - every widget is offered on the home screen and on the lock or cover screen (widgetCategory home_screen|keyguard);
//   Samsung's Flex Window metadata may add the Flip's cover screen, never stand in for them. 0.10.0's release offered
//   the Timeline's two on the cover screen only and Today's Tasks on the home screen only.
// - the debug build ships what the release ships: no resources or manifest of its own (src/debug), which is how the
//   debug build showed widgets the release did not
// - the app's code does not branch on who made the phone or which model it is (Build.MANUFACTURER, Build.MODEL, …):
//   it asks for a feature (WebViewFeature, Build.VERSION.SDK_INT) and falls back when it is missing
// - a Quick Settings tile (QuickAddTile, the iPhone's Lock Screen Quick Add) is bound by the system alone: an exported
//   service without BIND_QUICK_SETTINGS_TILE is one any app can start
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = path.join(root, 'android/androidApp/src');
const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile()) : []);
const rel = (f) => path.relative(root, f);

const widgets = files(path.join(app, 'main/res/xml')).filter((f) => /<appwidget-provider\b/.test(fs.readFileSync(f, 'utf8')));
assert.ok(widgets.length >= 3, 'the widgets\u2019 provider XML is where this check looks for it (android/androidApp/src/main/res/xml)');
for (const f of widgets) {
  const category = (fs.readFileSync(f, 'utf8').match(/android:widgetCategory="([^"]*)"/) || [])[1] || '';
  for (const where of ['home_screen', 'keyguard']) assert.ok(category.split('|').includes(where), rel(f) + ': not offered on the ' + (where === 'home_screen' ? 'home screen' : 'lock or cover screen') + ' (widgetCategory="' + category + '"); every widget goes on every screen');
}
assert.deepEqual(files(path.join(app, 'debug')).map(rel), [], 'the debug build has resources or a manifest of its own: it would offer what the release does not');
const manifest = fs.readFileSync(path.join(app, 'main/AndroidManifest.xml'), 'utf8');
const tiles = (manifest.match(/<service\b[^>]*>(?:(?!<\/service>)[\s\S])*android\.service\.quicksettings\.action\.QS_TILE[\s\S]*?<\/service>/g) || []);
assert.ok(tiles.length >= 1, 'Quick Add\u2019s Quick Settings tile is declared in the manifest (the iPhone\u2019s Lock Screen Quick Add)');
for (const t of tiles) assert.match(t, /android:permission="android\.permission\.BIND_QUICK_SETTINGS_TILE"/, 'a Quick Settings tile any app could bind: give it android:permission="android.permission.BIND_QUICK_SETTINGS_TILE"');
// Orbital's own way in (FromOrbital): its links write at once, so no other app may start it (docs/ANDROID.md Security)
const own = (manifest.match(/<activity\b[^>]*android:name="\.FromOrbital"[^>]*>/) || [''])[0];
assert.match(own, /android:exported="false"/, 'FromOrbital, the way in whose orbital: links write at once, must stay android:exported="false"');
const gated = ['android/androidApp/src/main', 'android/shared/src/commonMain', 'android/shared/src/androidMain']
  .flatMap((d) => files(path.join(root, d))).filter((f) => /\.(kt|java)$/.test(f))
  .filter((f) => /\bBuild\.(MANUFACTURER|MODEL|BRAND|DEVICE|PRODUCT|HARDWARE|BOARD)\b/.test(fs.readFileSync(f, 'utf8')));
assert.deepEqual(gated.map(rel), [], 'the app branches on the phone\u2019s maker or model: ask for the feature instead (docs/ANDROID.md, Review guidelines)');
console.log('android-check: ok (' + widgets.length + ' widgets on every screen, ' + tiles.length + ' tile bound by the system alone, no debug-only resources, no maker or model branches)');
