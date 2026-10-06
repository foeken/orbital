// Bundles the engine (index.js) into the one script the app injects: bun ios/engine/build.js <out.js>
// The desktop modules main/timeline.js and main/settings.js require are swapped for stand-ins.js, and Loro for its base64 build (its WASM
// inline, instantiated synchronously), so the bundle is one file with nothing to fetch.
const fs = require('node:fs');
const path = require('node:path');
const here = __dirname, standIns = path.join(here, 'stand-ins.js');
const DESKTOP = new Set(['../db', './pins', './rows', './documents']);

const result = await Bun.build({
  entrypoints: [path.join(here, 'index.js')], target: 'browser', format: 'iife', minify: true,
  // the repo and commit this was built from (source.js), as the desktop's user agent says them: a web view's fetch drops
  // a user-agent header, so the phones send them in x-client-name
  define: { 'process.env.ORBITAL_CLIENT': JSON.stringify(require('../../source').userAgent('orbital-ios')) },
  plugins: [{ name: 'phone', setup(b) {
    b.onResolve({ filter: /.*/ }, ({ path: p, importer }) => {
      if (p === 'node:crypto' || p === 'crypto') return { path: standIns };
      if (p === 'loro-crdt') return { path: path.join(here, '../../node_modules/loro-crdt/base64/index.js') };
      if (DESKTOP.has(p) && /main[\\/](timeline|settings)\.js$/.test(importer)) return { path: standIns }; // the desktop pages the phone runs
      if (p === 'nucleo-ui') return { path: p, namespace: 'nucleo' };
    });
    // The Nucleo UI set behind Set icon (build/nucleo-ui.json.gz, scripts/build-nucleo.js), gzipped and in base64, for the
    // icons you gave saved searches (index.js searches). Built from the local Nucleo library, so a machine without it
    // gets an empty set and the default glyph.
    b.onLoad({ filter: /.*/, namespace: 'nucleo' }, () => {
      const file = path.join(here, '../../build/nucleo-ui.json.gz');
      return { contents: 'export default ' + JSON.stringify(fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : ''), loader: 'js' };
    });
  } }],
});
if (!result.success) { console.error(result.logs.join('\n')); process.exit(1); }
// only on the session page: the same web view signs in on Tana's own pages, where this has no business
const out = "if (location.origin === 'https://home.tana.inc' && location.pathname === '/api/auth/session') {\n" + await result.outputs[0].text() + '\n}\n';
await Bun.write(process.argv[2] || path.join(here, 'engine.js'), out);
console.log('engine', (out.length / 1e6).toFixed(1) + ' MB');
