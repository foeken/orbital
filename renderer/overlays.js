'use strict';
// The pages main lays over the whole window, both halves of a split included (main.js openOverlay): the Help tour
// (help.html) and Create task (task.html). This page asks for one in its own theme and keeps its caret meanwhile;
// main hands it the keys back when the overlay closes, with what the overlay had to say.
function openOverlay(page) {
  if (!palette.hidden) closePalette();
  if (tana.openOverlay) tana.openOverlay(page, theme);
}
// ⌘K closed it (the key the tour teaches): the palette opens here. A note is the task Create task made.
if (tana.onOverlayClosed) tana.onOverlayClosed((result) => { if (result.palette) togglePalette('cmd'); if (result.note) showNote(result.note); });
// Help: from ⌘K Help, the ? button after Home and ⌘K (renderCrumbs), and once by itself on a first start (helpOnce,
// renderer/app.js); helpSeen is a synced preference, so that is once per person.
function openHelp() {
  if (!pref('helpSeen', false)) setPref('helpSeen', true);
  openOverlay('help');
}
// A first start, from the main half: the right half of the Work View opens beside it and stays quiet
function helpOnce() { if (!SIDE && !pref('helpSeen', false)) openHelp(); }
const helpBtn = $('navHelp');
helpBtn.onmousedown = (e) => e.preventDefault(); // the caret stays in its row
helpBtn.onclick = openHelp;
addIcon(helpBtn, 'help');
// Create task (⇧⌘Space, ⌘K "Create task"; task.js). Its page writes through the bridge itself, past the demo guard
// on `tana` (renderer/state.js), so demo mode refuses it here, in the guard's own words.
function openTask() {
  if (demoMode) return showError(new Error('Demo mode is on: nothing is saved to Tana'));
  openOverlay('task');
}
