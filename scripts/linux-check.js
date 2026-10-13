'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const palette = fs.readFileSync(require.resolve('../renderer/palette'), 'utf8');
const state = fs.readFileSync(require.resolve('../renderer/state'), 'utf8');
const comboSource = palette.slice(palette.indexOf('const KEYNAMES ='), palette.indexOf('const validCombo ='));
const defaultsSource = state.slice(state.indexOf('const DEFAULT_HOTKEYS ='), state.indexOf('const NOTE_PAGES ='));
const combo = (platform) => vm.runInNewContext(comboSource + '\ncomboOf', { tana: { platform } });
const defaults = (platform) => vm.runInNewContext(defaultsSource + '\n({ keys: DEFAULT_HOTKEYS, label: keyLabel })', { tana: { platform } });
const linux = combo('linux'), mac = combo('darwin');
const event = (key, mods = {}) => ({ key: key.toLowerCase(), code: 'Key' + key, ...mods });
assert.equal(linux(event('S', { ctrlKey: true })), '⌘S');
assert.equal(mac(event('S', { ctrlKey: true })), '⌃S');
assert.equal(mac(event('S', { metaKey: true })), '⌘S');
assert.equal(linux(event('N', { ctrlKey: true, altKey: true, shiftKey: true })), defaults('linux').keys.newWindow);
assert.equal(linux(event('S', { ctrlKey: true, shiftKey: true })), defaults('linux').keys.toggleSidebar);
assert.equal(linux(event('D', { ctrlKey: true, shiftKey: true })), defaults('linux').keys.today);
assert.equal(linux({ key: '?', code: 'Slash', ctrlKey: true, shiftKey: true }), '⇧⌘/');
assert.equal(linux({ key: 'Control', ctrlKey: true }), '⌘');
assert.equal(defaults('linux').label('⌥⇧⌘N'), 'Ctrl+Alt+Shift+N');
assert.equal(defaults('darwin').label('⌥⇧⌘N'), '⌥⇧⌘N');
const keys = Object.values(defaults('linux').keys);
assert.equal(new Set(keys).size, keys.length, 'Linux defaults do not collide');
assert.ok(keys.every((key) => !key.includes('⌃')), 'Ctrl is the primary modifier for every Linux default');
if (process.platform === 'linux') {
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = '/tmp/orbital-xdg-check';
  try { assert.equal(require('../userdata').appDataDir(), process.env.XDG_CONFIG_HOME); }
  finally { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; }
  const fetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => { requests++; throw new Error('Linux must not fetch a macOS update'); };
  require('../updater').check().then(() => {
    assert.equal(requests, 0);
  }).catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { globalThis.fetch = fetch; });
}
console.log('Linux shortcuts and data paths ok');
