'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'linux') throw new Error('This installer is for Linux');
const source = path.resolve(__dirname, '..', 'dist', 'Orbital-linux-' + process.arch);
fs.accessSync(path.join(source, 'Orbital'), fs.constants.X_OK);
const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const target = path.join(data, 'orbital');
fs.mkdirSync(target, { recursive: true });
fs.cpSync(source, target, { recursive: true });
fs.copyFileSync(path.resolve(__dirname, '..', 'build', 'icon.png'), path.join(target, 'icon.png'));
const bin = path.join(os.homedir(), '.local', 'bin');
fs.mkdirSync(bin, { recursive: true });
const launcher = path.join(bin, 'orbital');
if (fs.existsSync(launcher) || fs.lstatSync(launcher, { throwIfNoEntry: false })) {
  if (!fs.lstatSync(launcher).isSymbolicLink() || fs.readlinkSync(launcher) !== path.join(target, 'Orbital')) throw new Error('An unrelated launcher already exists at ' + launcher);
} else fs.symlinkSync(path.join(target, 'Orbital'), launcher);
const apps = path.join(data, 'applications');
fs.mkdirSync(apps, { recursive: true });
const quote = (value) => '"' + value.replace(/[\\"`$]/g, '\\$&') + '"';
fs.writeFileSync(path.join(apps, 'orbital.desktop'), [
  '[Desktop Entry]', 'Type=Application', 'Name=Orbital', 'Comment=Outliner for Tana',
  'Exec=' + quote(path.join(target, 'Orbital')) + ' %u',
  'Icon=' + path.join(target, 'icon.png'),
  'Terminal=false', 'Categories=Office;', 'StartupWMClass=Orbital', 'MimeType=x-scheme-handler/orbital;', '',
].join('\n'));
spawnSync('update-desktop-database', [apps]);
spawnSync('xdg-mime', ['default', 'orbital.desktop', 'x-scheme-handler/orbital']);
console.log('Installed ' + launcher + ' and ' + path.join(apps, 'orbital.desktop'));
