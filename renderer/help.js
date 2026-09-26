'use strict';
// Help: a few pages of the basics, each with a short loop of the keys at work (styles.css Help), for whoever has not
// met ⌘K yet. Opened from ⌘K "Help", from the ? button after Home and ⌘K (renderCrumbs), and once by itself on a first
// start (helpOnce, renderer/app.js); helpSeen is a synced preference, so that is once per person, not per machine.
// A native modal <dialog>: it keeps the focus, makes the page behind it inert and closes on Esc by itself.
// A page's loop runs only while it has .on: putting the class back restarts it from the top.
const helpEl = $('help'), helpPages = [...helpEl.querySelectorAll('.hpage')];
const helpDots = helpPages.map((_, i) => {
  const d = document.createElement('button');
  d.type = 'button'; d.tabIndex = -1; d.setAttribute('aria-label', 'Page ' + (i + 1));
  d.onclick = () => showHelpPage(i);
  return d;
});
$('helpDots').append(...helpDots);
for (const i of helpEl.querySelectorAll('i[data-icon]')) { const svg = iconNode(i.dataset.icon); if (svg) i.append(svg); }
let helpAt = 0, helpReturn = null;
function showHelpPage(n) {
  helpAt = Math.max(0, Math.min(helpPages.length - 1, n));
  helpPages.forEach((p, i) => { p.classList.toggle('on', i === helpAt); p.classList.toggle('before', i < helpAt); p.inert = i !== helpAt; });
  helpDots.forEach((d, i) => d.classList.toggle('on', i === helpAt));
  $('helpBack').disabled = helpAt === 0;
  $('helpNext').textContent = helpAt === helpPages.length - 1 ? 'Get started' : 'Next';
  $('helpNext').focus(); // Enter keeps going; the arrows go either way
}
function openHelp() {
  if (helpEl.open) return;
  if (!palette.hidden) closePalette();
  helpReturn = focused(); // the row the caret was in gets it back on close, as with the palette
  helpEl.showModal();
  showHelpPage(0);
  if (!pref('helpSeen', false)) setPref('helpSeen', true);
}
// Every way out (Esc, the ×, the scrim, the last Next) ends in close()
helpEl.addEventListener('close', () => {
  for (const p of helpPages) p.classList.remove('on'); // no loop runs behind a closed card
  const r = helpReturn; helpReturn = null;
  if (r && !focused()) placeCaret(r.key, r.offset);
});
function helpStep(dir) { if (helpAt + dir >= helpPages.length) helpEl.close(); else showHelpPage(helpAt + dir); }
// A first start, in the main half: the right half of the Work View opens beside it and is left alone
function helpOnce() { if (!SIDE && !pref('helpSeen', false)) openHelp(); }
$('helpBack').onclick = () => helpStep(-1);
$('helpNext').onclick = () => helpStep(1);
$('helpClose').onclick = () => helpEl.close();
helpEl.addEventListener('mousedown', (e) => { if (e.target === helpEl) helpEl.close(); }); // the scrim, as with the palette
// The page's own key handlers stay out while it is open. ⌘K closes it and goes on to the document handler, so trying
// the key the tour teaches opens the palette; the other ⌘ keys are left to the menu.
helpEl.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') return helpEl.close();
  e.stopPropagation();
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'ArrowRight') helpStep(1);
  else if (e.key === 'ArrowLeft') helpStep(-1);
  else return;
  e.preventDefault();
});
const helpBtn = $('navHelp');
helpBtn.onmousedown = (e) => e.preventDefault(); // the caret stays in its row, so closing puts it back
helpBtn.onclick = openHelp;
{ const svg = iconNode('help'); if (svg) helpBtn.append(svg); }
