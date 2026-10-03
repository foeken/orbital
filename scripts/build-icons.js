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
WANT.visible = path.join(__dirname, '..', 'build', 'icons', 'eye.svg'); // the header's sensitive switch while sensitive items are shown (eye-slash while hidden)
WANT.assignTo = path.join(__dirname, '..', 'build', 'icons', 'circle-user-plus.svg');
WANT.cleanup = path.join(__dirname, '..', 'build', 'icons', 'brush-2.svg'); // the view's Clean up pill: let go of the rows kept in place
WANT.notify = path.join(__dirname, '..', 'build', 'icons', 'bell-on.svg'); // "Notify on changes": watching a node for edits
WANT.reload = path.join(__dirname, '..', 'build', 'icons', 'refresh-anticlockwise.svg'); // Cmd+K "Reload": reloads the window, unlike sync's cloud-refresh
WANT.robot = path.join(__dirname, '..', 'build', 'icons', 'face-robot-2.svg'); // the badge on a node assigned to the local Codex agent
WANT.brain = path.join(__dirname, '..', 'build', 'icons', 'brain.svg'); // the model rows on the Assign to Agent page
WANT.host = path.join(__dirname, '..', 'build', 'icons', 'monitor.svg'); // the machine a Codex task runs on
WANT.home = path.join(__dirname, '..', 'build', 'icons', 'house.svg'); // the Home anchor crumb: the Library, or the saved search chosen as Home
// a task put off: the Later state's own glyph (zzz, asleep), drawn instead of the task list-checkbox on those rows
WANT.later = path.join(__dirname, '..', 'build', 'icons', 'zzz.svg');
// "No type" on the Set type page: a circle with a slash through it, for taking a choice off rather than making one
WANT.none = path.join(__dirname, '..', 'build', 'icons', 'slash-circle.svg');
// the disclosure chevron on a group heading: pointing right folded, turned a quarter down while the section is open,
// so the pair (chevron-left.svg is its mirror, kept beside it) needs only the one glyph built in
WANT.chevronRight = path.join(__dirname, '..', 'build', 'icons', 'chevron-right.svg');
// The sidebar's Changes section: one glyph per kind of change. A deletion keeps the trash glyph already built in
// above, so the same art is not carried under two names.
WANT.updated = path.join(__dirname, '..', 'build', 'icons', 'pen-writing.svg');
WANT.created = path.join(__dirname, '..', 'build', 'icons', 'file-plus.svg');
// A saved search folds its pills away behind this, beside back and forward (renderer/pills.js)
WANT.options = path.join(__dirname, '..', 'build', 'icons', 'sliders-vertical.svg');
WANT.openaiKey = path.join(__dirname, '..', 'build', 'icons', 'key-4.svg');
// OpenAI's ChatGPT Blossom from openai/openai-cookbook; the builder maps its supplied black fill to currentColor. Its
// viewBox is cropped to the mark (about 83% of the box, like the Nucleo glyphs): the original drew it at half size.
WANT.chatgpt = path.join(__dirname, '..', 'build', 'icons', 'chatgpt.svg');
// A node pinned to the sidebar or to a date: the tack, distinct from the map-marker 'pin' the meeting rows use
WANT.pinned = path.join(__dirname, '..', 'build', 'icons', 'pin-tack.svg');
WANT.todayTasks = path.join(__dirname, '..', 'build', 'icons', 'tasks-2.svg'); // Timeline's Today's Tasks row
WANT.free = path.join(__dirname, '..', 'build', 'icons', 'face-smile-closed-eyes.svg'); // Timeline's free time before the next meeting: the bliss of no meetings
// What the model suggested, rather than what you typed or what Tana knows (Cmd+K "Discuss with …")
WANT.sparkle = path.join(__dirname, '..', 'build', 'icons', 'orbit-sparkle.svg');
// The "/" menu's Table and Image rows (renderer/nodes.js glyphSvg), from the Nucleo UI 18px outline set
WANT.table = path.join(__dirname, '..', 'build', 'icons', 'table-rows-3-cols-2.svg'); // Nucleo UI at stroke 1, like the header glyphs beside it
WANT.image = path.join(__dirname, '..', 'build', 'icons', 'image.svg');
// A node assigned to someone outside its audience (renderer/tasks.js); the warning colour is set in styles.css
WANT.userAlert = path.join(__dirname, '..', 'build', 'icons', 'user-alert.svg');
// The Proposals page (renderer/proposals.js): the page itself, and approving or rejecting what the AI proposed
WANT.proposals = path.join(__dirname, '..', 'build', 'icons', 'file-sparkle.svg');
WANT.approve = path.join(__dirname, '..', 'build', 'icons', 'circle-check.svg');
WANT.reject = path.join(__dirname, '..', 'build', 'icons', 'circle-xmark.svg');
// The Timeline page (renderer/timeline.js), Nucleo UI 18px outline
WANT.timeline = path.join(__dirname, '..', 'build', 'icons', 'calendar-planning.svg');
// The Timeline's grey markers on its rail: Nucleo UI 18px outline circles, coloured by styles.css .tl-*. Outlines, not
// solid glyphs: the one filled marker is finished work's green circle (and the edit's pen is a line glyph of its own)
WANT.tlAccepted = path.join(__dirname, '..', 'build', 'icons', 'circle-plus-outline.svg');
WANT.tlLater = path.join(__dirname, '..', 'build', 'icons', 'circle-arrow-down-outline.svg');
WANT.tlInbox = path.join(__dirname, '..', 'build', 'icons', 'circle-arrow-left-outline.svg');
WANT.tlNew = path.join(__dirname, '..', 'build', 'icons', 'circle-dotted.svg'); // outline: a new task is the quietest entry
// Cmd+K rows for the keys the outline answers to
// a meeting whose title starts with Travel, on the Timeline (main/timeline.js meetingIcon): a route between two pins
WANT.pinRoute = path.join(__dirname, '..', 'build', 'icons', 'pin-route.svg');
for (const [name, file] of [['expand', 'v-shaped-arrow-down'], ['collapse', 'v-shaped-arrow-up'], ['undo', 'undo'], ['redo', 'redo'], ['textLarger', 'text-size-increase'], ['textSmaller', 'text-size-decrease'], ['textReset', 'text'], ['graph', 'connected-dots'], ['back', 'arrow-left'], ['forward', 'arrow-right'], ['zoomIn', 'magnifier-3'], ['search', 'magnifier'], ['filter', 'filter-2'], ['discuss', 'msg'], ['meetingPin', 'calendar-pin'], ['splitPanes', 'split-view'], ['otherPane', 'layout-move-to-right'], ['swapPanes', 'arrows-opposite-direction-x'], ['closePane', 'xmark']]) WANT[name] = path.join(__dirname, '..', 'build', 'icons', file + '.svg');
WANT.outline = path.join(__dirname, '..', 'build', 'icons', 'unordered-list.svg'); // the header's Outliner/Table switch while a list is a table
WANT.command = path.join(__dirname, '..', 'build', 'icons', 'command.svg'); // the header button that opens Cmd+K
WANT.rename = path.join(__dirname, '..', 'build', 'icons', 'rename.svg'); // Cmd+K Rename, as on the page's tab (renderer/palette.js)
WANT.toMessage = path.join(__dirname, '..', 'build', 'icons', 'arrow-turn-down.svg'); // Add to message on an @Codex answer: down into the message box (renderer/chat.js)
WANT.help = path.join(__dirname, '..', 'build', 'icons', 'circle-question.svg'); // the header button beside it that opens Help (renderer/overlays.js)
WANT.cloudSlash = path.join(__dirname, '..', 'build', 'icons', 'cloud-slash.svg'); // the badge beside an @Codex question and answer: never saved to Tana, kept on this device (renderer/chat.js)
WANT.textPlus = path.join(__dirname, '..', 'build', 'icons', 'text-plus.svg'); // the Create new button in the window's corner (shell.html #create), Nucleo UI 12px outline
WANT.info = path.join(__dirname, '..', 'build', 'icons', 'circle-info.svg'); // Cmd+K About Orbital, beside Help's question mark (renderer/palette.js)
WANT.license = path.join(__dirname, '..', 'build', 'icons', 'license.svg'); // the License link on the About Orbital page
WANT.imageSparkle = path.join(__dirname, '..', 'build', 'icons', 'image-sparkle-3.svg'); // the same button with an image over it: Process image (shell.js createAs)
WANT.language = path.join(__dirname, '..', 'build', 'icons', 'language.svg'); // Cmd+K Replace with translation (renderer/palette.js)
WANT.checklist = path.join(__dirname, '..', 'build', 'icons', 'checkbox-checked.svg'); // the "/" menu's Checklist row (#602), Nucleo UI 18px outline
WANT.filterPlus = path.join(__dirname, '..', 'build', 'icons', 'filter-2-plus.svg'); // the field pills' "Add filter" (renderer/pills.js foldFields, #624): the filter glyph with a plus, Nucleo UI 18px outline
WANT.demo = path.join(__dirname, '..', 'build', 'icons', 'gaming-blocks.svg'); // Demo mode, on the desktop's Cmd+K row and in both phones' Settings: toy blocks, playing with made-up words. Nucleo UI 18px outline
const out = {};
for (const [name, file] of Object.entries(WANT)) {
  if (!SRC && !path.isAbsolute(file)) { if (!current[name]) throw new Error(name + ' needs the icon set: node scripts/build-icons.js <dir>'); out[name] = current[name]; continue; }
  let svg = fs.readFileSync(path.isAbsolute(file) ? file : path.join(SRC, file), 'utf8');
  svg = svg.replace(/<title>.*?<\/title>/, '')
    .replace(/^<svg[^>]*>/, (tag) => tag.replace(/\s(height|width)="[^"]*"/g, ''))
    .replace(/(stroke|fill)="(?:#[0-9a-fA-F]{3,6}|black)"/g, '$1="currentColor"').replace(/>\s+</g, '><').trim();
  out[name] = svg;
}
const js = '// Generated by scripts/build-icons.js from the Tana line icon set (Nucleo). Do not edit by hand.\n'
  + 'window.ICONS = ' + JSON.stringify(out, null, 2) + ';\n';
fs.writeFileSync(path.join(__dirname, '..', 'icons.js'), js);
console.log('wrote icons.js', Object.keys(out).join(', '));
