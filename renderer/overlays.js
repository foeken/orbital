'use strict';
// The pages main lays over the whole window, above every pane (main.js openOverlay): the Help tour
// (help.html) and Create task (task.html). This page asks for one in its own theme and keeps its caret meanwhile;
// main hands it the keys back when the overlay closes, with what the overlay had to say.
function openOverlay(page) {
  if (!palette.hidden) closePalette();
  if (tana.openOverlay) tana.openOverlay(page, theme);
}
// ⌘K closed it (the key the tour teaches): the palette opens here; the tour's last page asks for ChatGPT sign-in. A
// note is the task Create task made.
if (tana.onOverlayClosed) tana.onOverlayClosed((result) => {
  if (result.palette) togglePalette('cmd');
  if (result.chatgpt) startChatGPTLogin();
  if (result.note) showNote(result.note);
});
// Help: from ⌘K Help, the ? in the window's header (shell.js, renderer/app.js), and once by itself on a first start (helpOnce,
// renderer/app.js); helpSeen is a synced preference, so that is once per person.
function openHelp() {
  if (!pref('helpSeen', false)) setPref('helpSeen', true);
  openOverlay('help');
}
// A first start, from the first page: the Work View's second pane opens beside it and stays quiet. Only once signed
// in and connected (renderer/app.js), and only if main says so (help:claim): it answers once the settings document has
// been read, and yes to one page only. Over the login the tour taught a window nobody could use yet, a new machine went
// by its own empty copy and showed it to you again, and every open window showed it at once.
async function helpOnce() {
  if (SIDE || !connected || pref('helpSeen', false)) return;
  if (!tana.claimHelp) return openHelp(); // the in-file mock: nobody to ask
  if (!(await tana.claimHelp(theme).catch(() => false))) return;
  setPref('helpSeen', true); // main opened it and marked it; this page's copy follows
  if (!palette.hidden) closePalette(); // what openOverlay does when the page opens it: no palette left under the tour
}
// Create task (⇧⌘Space, ⌘K "Create task"; task.js). Its page writes through the bridge itself, past the demo guard
// on `tana` (renderer/state.js), so demo mode refuses it here, in the guard's own words.
function openTask() {
  if (demoMode) return showError(new Error('Demo mode is on: nothing is saved to Tana'));
  openOverlay('task');
}
