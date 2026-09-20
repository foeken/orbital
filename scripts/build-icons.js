'use strict';
// Builds icons.js from a local Tana line icon set (Nucleo export), which is not in this repo.
// Run: node scripts/build-icons.js <path-to-icon-set>
// Without the set, the two glyphs that only exist there (task, calendar) are kept from the current icons.js, so a
// glyph added to build/icons can be built in with a plain `node scripts/build-icons.js`.
// build/icons/tana.svg is ours: the Tana prism (build/tana-symbol.svg, Tana's own symbol) traced as a single-stroke
// 18x18 glyph on the same grid as the Nucleo set.
// Colours are stripped to currentColor so CSS controls the grey.
const fs = require('node:fs');
const path = require('node:path');
const SRC = process.argv[2] || process.env.TANA_ICON_SET;
const current = {}; // icons.js as it is now, for the glyphs the set alone provides
if (!SRC) { const window = {}; new Function('window', fs.readFileSync(path.join(__dirname, '..', 'icons.js'), 'utf8'))(window); Object.assign(current, window.ICONS); }
const WANT = { task: 'list-checkbox.svg', calendar: 'calendar.svg', sync: path.join(__dirname, '..', 'build', 'icons', 'cloud-refresh.svg'), doc: path.join(__dirname, '..', 'build', 'icons', 'report-file.svg'), space: path.join(__dirname, '..', 'build', 'icons', 'box-archive-3.svg'), member: path.join(__dirname, '..', 'build', 'icons', 'circle-user.svg'), lock: path.join(__dirname, '..', 'build', 'icons', 'lock.svg'), userLock: path.join(__dirname, '..', 'build', 'icons', 'user-lock.svg'), houseLock: path.join(__dirname, '..', 'build', 'icons', 'house-lock.svg'), users: path.join(__dirname, '..', 'build', 'icons', 'users-3.svg'), library: path.join(__dirname, '..', 'build', 'icons', 'bookmarked-book.svg'), pin: path.join(__dirname, '..', 'build', 'icons', 'pin.svg'), pinDate: path.join(__dirname, '..', 'build', 'icons', 'calendar-pin.svg'), any: path.join(__dirname, '..', 'build', 'icons', 'pop.svg'), darkLight: path.join(__dirname, '..', 'build', 'icons', 'dark-light.svg'), unassigned: path.join(__dirname, '..', 'build', 'icons', 'circle-dotted-user.svg'), createNew: path.join(__dirname, '..', 'build', 'icons', 'square-dashed-plus.svg'), apply: path.join(__dirname, '..', 'build', 'icons', 'check-2.svg'), field: path.join(__dirname, '..', 'build', 'icons', 'text-input.svg'), type: path.join(__dirname, '..', 'build', 'icons', 'shapes.svg'), inbox: path.join(__dirname, '..', 'build', 'icons', 'inbox.svg'), video: path.join(__dirname, '..', 'build', 'icons', 'video.svg'), code: path.join(__dirname, '..', 'build', 'icons', 'code.svg'), globe: path.join(__dirname, '..', 'build', 'icons', 'earth.svg'), link: path.join(__dirname, '..', 'build', 'icons', 'link.svg'), status: path.join(__dirname, '..', 'build', 'icons', 'status.svg'), assigned: path.join(__dirname, '..', 'build', 'icons', 'assigned.svg'), sort: path.join(__dirname, '..', 'build', 'icons', 'sort.svg'), group: path.join(__dirname, '..', 'build', 'icons', 'group.svg'), hidden: path.join(__dirname, '..', 'build', 'icons', 'eye-slash.svg') };
// Ours rather than Nucleo's: the Tana prism from build/tana-symbol.svg (Tana's own symbol), traced as a
// single-stroke glyph on the same 18x18 grid. Appended so the generated key order stays stable.
WANT.tana = path.join(__dirname, '..', 'build', 'icons', 'tana.svg');
WANT.trash = path.join(__dirname, '..', 'build', 'icons', 'trash-2.svg');
WANT.addTo = path.join(__dirname, '..', 'build', 'icons', 'folder-plus.svg');
WANT.today = path.join(__dirname, '..', 'build', 'icons', 'calendar-event.svg');
WANT.week = path.join(__dirname, '..', 'build', 'icons', 'calendar-minus-2.svg');
WANT.hiddenItems = path.join(__dirname, '..', 'build', 'icons', 'eye-closed.svg'); // Edit hidden items (Mark as sensitive keeps the eye-slash)
WANT.assignTo = path.join(__dirname, '..', 'build', 'icons', 'circle-user-plus.svg');
WANT.cleanup = path.join(__dirname, '..', 'build', 'icons', 'brush-2.svg'); // the view's Clean up pill: let go of the rows kept in place
WANT.notify = path.join(__dirname, '..', 'build', 'icons', 'bell-on.svg'); // "Notify on changes": watching a node for edits
WANT.reload = path.join(__dirname, '..', 'build', 'icons', 'refresh-anticlockwise.svg'); // Cmd+K "Reload": reloads the window, unlike sync's cloud-refresh
WANT.robot = path.join(__dirname, '..', 'build', 'icons', 'face-robot-2.svg'); // the badge on a node assigned to the local Codex agent
WANT.brain = path.join(__dirname, '..', 'build', 'icons', 'brain.svg'); // the model rows on the Assign to Agent page
WANT.host = path.join(__dirname, '..', 'build', 'icons', 'monitor.svg'); // the machine a Codex task runs on
WANT.home = path.join(__dirname, '..', 'build', 'icons', 'house.svg'); // the Home anchor crumb: the Library, or the saved search chosen as Home
// the disclosure chevron on a group heading: pointing right folded, turned a quarter down while the section is open,
// so the pair (chevron-left.svg is its mirror, kept beside it) needs only the one glyph built in
WANT.chevronRight = path.join(__dirname, '..', 'build', 'icons', 'chevron-right.svg');
// The sidebar's Changes section: one glyph per kind of change. A deletion keeps the trash glyph already built in
// above, so the same art is not carried under two names.
WANT.updated = path.join(__dirname, '..', 'build', 'icons', 'pen-writing.svg');
WANT.created = path.join(__dirname, '..', 'build', 'icons', 'file-plus.svg');
// Cmd+K rows for the keys the outline answers to
for (const [name, file] of [['expand', 'v-shaped-arrow-down'], ['collapse', 'v-shaped-arrow-up'], ['undo', 'undo'], ['redo', 'redo'], ['textLarger', 'text-size-increase'], ['textSmaller', 'text-size-decrease'], ['textReset', 'text'], ['rail', 'sidebar-right-4'], ['railShow', 'sidebar-right-show'], ['railHide', 'sidebar-right-hide'], ['back', 'arrow-left'], ['forward', 'arrow-right'], ['zoomIn', 'magnifier-3'], ['search', 'file-search'], ['filter', 'filter-2']]) WANT[name] = path.join(__dirname, '..', 'build', 'icons', file + '.svg');
const out = {};
for (const [name, file] of Object.entries(WANT)) {
  if (!SRC && !path.isAbsolute(file)) { if (!current[name]) throw new Error(name + ' needs the icon set: node scripts/build-icons.js <dir>'); out[name] = current[name]; continue; }
  let svg = fs.readFileSync(path.isAbsolute(file) ? file : path.join(SRC, file), 'utf8');
  svg = svg.replace(/<title>.*?<\/title>/, '')
    .replace(/^<svg[^>]*>/, (tag) => tag.replace(/\s(height|width)="[^"]*"/g, ''))
    .replace(/(stroke|fill)="#[0-9a-fA-F]{3,6}"/g, '$1="currentColor"').replace(/>\s+</g, '><').trim();
  out[name] = svg;
}
const js = '// Generated by scripts/build-icons.js from the Tana line icon set (Nucleo). Do not edit by hand.\n'
  + 'window.ICONS = ' + JSON.stringify(out, null, 2) + ';\n';
fs.writeFileSync(path.join(__dirname, '..', 'icons.js'), js);
console.log('wrote icons.js', Object.keys(out).join(', '));
