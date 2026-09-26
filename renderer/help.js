'use strict';
// Help (help.html): the tour is a page of its own that main lays over the whole window, both halves of a split
// included (main.js openHelp). Asked for from ⌘K Help, the ? button after Home and ⌘K (renderCrumbs), and once by
// itself on a first start (helpOnce, renderer/app.js); helpSeen is a synced preference, so that is once per person.
// This page keeps its caret while the tour is up: main hands it the keys back when the tour closes.
function openHelp() {
  if (!palette.hidden) closePalette();
  if (!pref('helpSeen', false)) setPref('helpSeen', true);
  if (tana.openHelp) tana.openHelp(theme);
}
// A first start, from the main half: the right half of the Work View opens beside it and stays quiet
function helpOnce() { if (!SIDE && !pref('helpSeen', false)) openHelp(); }
if (tana.onHelpPalette) tana.onHelpPalette(() => togglePalette('cmd')); // ⌘K closed the tour: the key it teaches
const helpBtn = $('navHelp');
helpBtn.onmousedown = (e) => e.preventDefault(); // the caret stays in its row
helpBtn.onclick = openHelp;
{ const svg = iconNode('help'); if (svg) helpBtn.append(svg); }
