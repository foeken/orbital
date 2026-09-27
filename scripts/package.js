// Build dist/Orbital-darwin-arm64/Orbital.app with @electron/packager. A script, not the packager's CLI, because only the
// JS API takes hooks, and one is needed: Chromium ships its own strings (context menus, form validation) in 55 languages,
// 220 folders and ~9 MB (Electron 45), and the app is English only, so every other language goes (#414). It goes right after
// Electron is extracted, before anything is signed: removing a folder from a signed bundle breaks the signature.
// Usage: node scripts/package.js [notarytool profile]  (with a profile: signed with the Developer ID and notarized)
const fs = require('node:fs'), path = require('node:path');

// What the package leaves out of the repo (everything else in the working directory is copied in, untracked files too).
const ignore = /^\/(dist|docs|build\/icon\.png|\.git|\.tana-log|\.superpowers|AGENTS\.md|node_modules\/loro-crdt\/(base64|browser|bundler|web)(\/|$)|scripts\/(fixtures(\/|$)|[^/]*-check\.js$))/;

// English and its variants (en_GB, en_GB_FEMININE, …). The empty ones in Contents/Resources tell macOS which languages
// the app speaks, so they go too: otherwise AppKit's own menu items would still follow the system language.
const english = (name) => !name.endsWith('.lproj') || /^en(_[A-Z]+)*\.lproj$/.test(name);
const dropLocales = ({ buildPath }) => {
  const app = path.join(buildPath, 'Electron.app', 'Contents');
  for (const dir of [path.join(app, 'Frameworks', 'Electron Framework.framework', 'Resources'), path.join(app, 'Resources')]) {
    for (const name of fs.readdirSync(dir)) if (!english(name)) fs.rmSync(path.join(dir, name), { recursive: true });
  }
};

if (require.main === module) {
  const profile = process.argv[2];
  import('@electron/packager').then(({ packager }) => packager({
    dir: '.', name: 'Orbital', platform: 'darwin', arch: 'arm64', icon: 'build/icon.icns', out: 'dist', overwrite: true,
    ignore, appBundleId: 'com.dreetje.orbital', afterExtract: [dropLocales],
    ...(profile && { osxSign: true, osxNotarize: { keychainProfile: profile } }),
  })).then((paths) => console.log('Wrote new app to: ' + paths.join(', ')), (e) => { console.error(e); process.exit(1); });
}

module.exports = { ignore, dropLocales };
