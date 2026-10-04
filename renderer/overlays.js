'use strict';
// The pages main lays over the whole window, above every pane (main.js openOverlay): the Help tour
// (help.html) and Quick Add Task (task.html). This page asks for one in its own theme and keeps its caret meanwhile;
// main hands it the keys back when the overlay closes, with what the overlay had to say.
function openOverlay(page, at) {
  if (!palette.hidden) closePalette();
  if (tana.openOverlay) tana.openOverlay(page, theme, at);
}
// ⌘K closed it (the key the tour teaches): the palette opens here; the tour's last page asks for ChatGPT sign-in. A
// note is the task Quick Add Task made.
if (tana.onOverlayClosed) tana.onOverlayClosed((result) => {
  if (result.palette) togglePalette('cmd');
  if (result.chatgpt) startChatGPTLogin();
  if (result.image) processImage({ clipboard: true }); // Quick Add's Process image from clipboard: here, as Cmd+K's row does it (renderer/upload.js)
  if (result.note) showNote(result.note, false, result.open); // a click on it opens the task it names
});
// Help: from ⌘K Help, the ? in the window's header (shell.js, renderer/app.js), and once by itself on a first start (helpOnce,
// renderer/app.js); helpSeen is a synced preference, so that is once per person. ⌘K Install mobile app opens it on its
// last page (at 'mobile'), the one place the iPhone app is installed from: its TestFlight code and link.
function openHelp(at) {
  if (!pref('helpSeen', false)) setPref('helpSeen', true);
  openOverlay('help', at);
}
// Whether the latest release has the Android app (updater.js androidRelease): the Install mobile app row says so, as the
// tour's phone page does. Asked once as the page loads; main asks GitHub once an hour at most for every page.
let androidDownload = null;
if (tana.androidRelease) tana.androidRelease().then((r) => { androidDownload = r; }, () => {});
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
// Quick Add Task (⇧⌘Space, ⌘K "Quick Add Task"; task.js). Its page writes through the bridge itself, past the demo guard
// on `tana` (renderer/state.js), so demo mode refuses it here, in the guard's own words.
function openTask() {
  if (demoMode) return showError(new Error('Demo mode is on: nothing is saved to Tana'));
  openOverlay('task');
}
