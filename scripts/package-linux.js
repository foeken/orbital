'use strict';
const path = require('node:path');
const { packager } = require('@electron/packager');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const ignore = pkg.scripts.package.match(/--ignore='([^']+)'/)[1].replace('build/icon\\.png|', '');

packager({
  dir: root,
  name: 'Orbital',
  platform: 'linux',
  arch: process.arch,
  out: path.join(root, 'dist'),
  overwrite: true,
  ignore: [new RegExp(ignore)],
}).then((paths) => {
  for (const dir of paths) console.log(path.join(dir, 'Orbital'));
}).catch((error) => { console.error(error); process.exitCode = 1; });
