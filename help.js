'use strict';
// The Help tour (help.html; issue #230): a few pages of the basics, each with a short loop of the keys at work
// (styles.css Help). Its own page and its own scope: main lays it over the whole window, both
// halves of a split, and takes it away again when it closes (main.js openOverlay). The page that asked gave its theme in
// the query, gets the keys back on close, and the palette too when ⌘K is what closed it.
// A native modal <dialog>: it keeps the focus and closes on Esc by itself. A page's loop runs only while it has .on:
// putting the class back restarts it from the top.
const helpApi = window.api;
if (new URLSearchParams(location.search).get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';
const helpEl = document.getElementById('help'), helpPages = [...helpEl.querySelectorAll('.hpage')];
const helpBack = document.getElementById('helpBack'), helpNext = document.getElementById('helpNext');
for (const i of helpEl.querySelectorAll('i[data-icon]')) i.innerHTML = (window.ICONS && window.ICONS[i.dataset.icon]) || ''; // icons.js: our own markup
const helpDots = helpPages.map((_, i) => {
  const d = document.createElement('button');
  d.type = 'button'; d.tabIndex = -1; d.setAttribute('aria-label', 'Page ' + (i + 1));
  d.onclick = () => showHelpPage(i);
  return d;
});
document.getElementById('helpDots').append(...helpDots);
let helpAt = 0, helpPalette = false, helpChatGPT = false;
function showHelpPage(n) {
  helpAt = Math.max(0, Math.min(helpPages.length - 1, n));
  helpPages.forEach((p, i) => { p.classList.toggle('on', i === helpAt); p.classList.toggle('before', i < helpAt); p.inert = i !== helpAt; });
  helpDots.forEach((d, i) => d.classList.toggle('on', i === helpAt));
  helpBack.disabled = helpAt === 0;
  helpNext.textContent = helpAt === helpPages.length - 1 ? 'Get started' : 'Next';
  helpNext.focus(); // Enter keeps going; the arrows go either way
}
function helpStep(dir) { if (helpAt + dir >= helpPages.length) helpEl.close(); else showHelpPage(helpAt + dir); }
// Every way out (Esc, the ×, the scrim, the last Next, ⌘K) ends here
helpEl.addEventListener('close', () => { if (helpApi && helpApi.closeOverlay) helpApi.closeOverlay({ palette: helpPalette, chatgpt: helpChatGPT }); });
helpBack.onclick = () => helpStep(-1);
helpNext.onclick = () => helpStep(1);
// The last page: sign in with ChatGPT happens on its ⌘K page in the page that asked (renderer/agent.js startChatGPTLogin).
// Signed in already, the line says so instead, at the button's height: the card is as tall as its tallest page, so a
// line that came or went would move it after it had opened.
document.getElementById('helpChatGPT').onclick = () => { helpChatGPT = true; helpEl.close(); };
if (helpApi && helpApi.chatgptStatus) helpApi.chatgptStatus().then((s) => {
  if (s && s.signedIn) document.getElementById('helpAI').textContent = 'Signed in with ChatGPT' + (s.email ? ' as ' + s.email : '');
}, () => {});
document.getElementById('helpClose').onclick = () => helpEl.close();
helpEl.addEventListener('mousedown', (e) => { if (e.target === helpEl) helpEl.close(); }); // the scrim, as with the palette
// ⌘K, the key the tour teaches, closes it and opens the palette in the page that asked
helpEl.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { helpPalette = true; helpEl.close(); }
  else if (e.metaKey || e.ctrlKey || e.altKey) return;
  else if (e.key === 'ArrowRight') helpStep(1);
  else if (e.key === 'ArrowLeft') helpStep(-1);
  else return;
  e.preventDefault();
});
helpEl.showModal();
showHelpPage(0);
