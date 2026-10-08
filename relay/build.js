'use strict';
// Bundles the relay for ChatGPT Sites: worker.js and server.js into dist/server/index.js, one ES module whose node: imports
// the Worker's Node compatibility answers. npm run build (README.md).
const fs = require('node:fs');
const crypto = require('node:crypto');
const esbuild = require('esbuild');

fs.rmSync('dist', { recursive: true, force: true });
esbuild.build({
  entryPoints: ['worker.js'], outfile: 'dist/server/index.js', bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  external: ['pg'], // PostgreSQL is for a relay on Node; a Site has D1
  define: { 'require.main': 'undefined', // server.js starts a server of its own only when run with node
    // /health says which server.js runs, the same hash orbital.md's relay says for the same file
    'process.env.RELAY_SHA256': JSON.stringify(crypto.createHash('sha256').update(fs.readFileSync('server.js')).digest('hex')) },
  // server.js requires node: modules; a Worker has them as ES modules, so each require becomes an import
  plugins: [{ name: 'node-builtins', setup(b) {
    b.onResolve({ filter: /^node:/ }, ({ path, namespace }) => (namespace === 'builtin' ? { path, external: true } : { path, namespace: 'builtin' }));
    // node:sqlite is not in a Worker, and only the Node relay's sqliteStore asks for it
    b.onLoad({ filter: /.*/, namespace: 'builtin' }, ({ path }) => ({ contents: path === 'node:sqlite' ? '' : 'export * from ' + JSON.stringify(path) + ';', loader: 'js' }));
  } }],
}).then(() => {
  fs.mkdirSync('dist/.openai', { recursive: true });
  fs.copyFileSync('.openai/hosting.json', 'dist/.openai/hosting.json');
}, () => process.exit(1));
