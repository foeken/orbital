'use strict';
// The update card (update.html, #667): the release notes of every version newer than this one, newest first, and
// Update and Restart, which turns the buttons into a progress bar: the download, then the signature check, then the
// app quits and comes back as the new version (updater.js). ↩ updates, Esc or a click on the scrim is Later, except
// while it runs: the swap is already on its way.
const updApi = window.api;
if (new URLSearchParams(location.search).get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';
const $ = (id) => document.getElementById(id);
const updCard = $('update'), go = $('updateGo'), later = $('updateLater'), bar = $('updateBar'), statusEl = $('updateStatus');
let running = false;
const closeCard = () => { if (!running && updApi && updApi.closeOverlay) updApi.closeOverlay({}); };
const errorText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const mb = (bytes) => Math.round(bytes / 1e6);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');

// One line of the notes: its marks as elements, a link opened in the browser (never in this overlay)
function inline(segments) {
  return segments.map((s) => {
    const m = s.marks || {};
    if (m.link) { const a = document.createElement('a'); a.href = m.link; a.textContent = s.text; a.onclick = (e) => { e.preventDefault(); updApi.openExternal(m.link); }; return a; }
    const tag = m.bold ? 'b' : m.code ? 'code' : m.italic ? 'i' : m.strike ? 's' : null;
    if (!tag) return document.createTextNode(s.text);
    const el = document.createElement(tag); el.textContent = s.text; return el;
  });
}
const TAGS = { heading1: 'h3', heading2: 'h3', heading3: 'h4', bullet: 'li', numbered: 'li', quote: 'blockquote', code: 'pre', divider: 'hr' };
function release(r) {
  const out = document.createElement('section');
  const head = document.createElement('h2'); head.textContent = r.version;
  const when = document.createElement('span'); when.textContent = day(r.date); head.append(when);
  out.append(head);
  for (const b of r.notes) {
    const el = document.createElement(TAGS[b.block] || 'p');
    if (b.depth) el.style.setProperty('--depth', String(b.depth)); // a sub-bullet keeps its place under its parent
    el.append(...inline(b.segments)); out.append(el);
  }
  return out;
}

function draw(info) {
  if (!info || !info.releases.length) return closeCard();
  const [newest] = info.releases;
  $('updateTitle').textContent = 'Orbital ' + newest.version + ' is available';
  $('updateSub').textContent = 'You have ' + info.current + (info.releases.length > 1 ? ', ' + info.releases.length + ' versions behind' : '') + ' · Orbital restarts to finish';
  $('updateNotes').replaceChildren(...info.releases.map(release));
  go.disabled = false;
}

function progress(p) {
  if (p.verifying) { bar.value = 1; statusEl.textContent = 'Checking the download…'; return; }
  bar.value = p.total ? p.got / p.total : 0;
  statusEl.textContent = 'Downloading… ' + mb(p.got || 0) + (p.total ? ' of ' + mb(p.total) : '') + ' MB';
}

function install() {
  if (running || go.disabled) return;
  running = true; $('updateError').hidden = true;
  go.hidden = later.hidden = true; $('updateProgress').hidden = false;
  progress({ got: 0, total: 0 });
  // success never answers: the app quits. A failure puts the buttons back, so the press can simply be repeated.
  updApi.installUpdate().catch((e) => {
    running = false;
    $('updateError').textContent = errorText(e); $('updateError').hidden = false;
    $('updateProgress').hidden = true; go.hidden = later.hidden = false;
    go.firstChild.textContent = 'Try Again ';
  });
}

if (updApi && updApi.onUpdateProgress) updApi.onUpdateProgress(progress);
go.onclick = install;
later.onclick = closeCard;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') install();
  else if (e.key === 'Escape') closeCard();
  else return;
  e.preventDefault();
});
updCard.addEventListener('mousedown', (e) => { if (e.target === updCard) closeCard(); }); // the scrim, as with the palette
if (updApi && updApi.updateInfo) updApi.updateInfo().then(draw, closeCard);
