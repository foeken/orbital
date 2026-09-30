'use strict';
// The manual's furniture (manual/*.html): theme, the sidebar and its contents, pictures in the reader's theme, clips
// that play while in view, diagrams that start when you reach them, the lightbox, annotated pins, reading progress,
// previous and next, and ⌘K, which searches every heading (search-index.js, made by manual/scenes/index.js).
// Loaded in <head> without defer so the theme is set before the first paint; the rest waits for the document.
const CHAPTERS = [
  ['index', 'Welcome'],
  ['start', 'First steps'],
  ['commands', '⌘K, the command palette'],
  ['writing', 'Writing in the outline'],
  ['navigating', 'Finding your way'],
  ['timeline', 'Timeline, notifications & proposals'],
  ['tasks', 'Tasks'],
  ['views', 'Views & saved searches'],
  ['pins', 'Pins & dates'],
  ['meetings', 'Meetings'],
  ['types', 'Types & fields'],
  ['ai', 'AI & agents'],
  ['chats', 'Chats'],
  ['windows', 'Windows, panes & the Graph'],
  ['sharing', 'Sharing & privacy'],
  ['settings', 'Settings & housekeeping'],
  ['keys', 'Keyboard reference'],
];
const here = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '');
// served from the web at /manual (orbital.md), the chapters' relative links need the folder's trailing slash
if (/^https?:$/.test(location.protocol) && /\/manual$/.test(location.pathname)) location.replace(location.pathname + '/' + location.search + location.hash);
const asked = new URLSearchParams(location.search).get('theme');
try { if (asked) localStorage.setItem('manualTheme', asked); } catch { /* storage off: the theme still applies to this page */ }
let manualTheme = asked || (() => { try { return localStorage.getItem('manualTheme'); } catch { return null; } })() || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.dataset.theme = manualTheme;

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const slug = (s) => s.toLowerCase().replace(/⌘/g, 'cmd').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// pictures follow the theme: data-m="name" is media/name-<theme>.webp (img) or .mp4 (video)
function setMedia() {
  for (const m of document.querySelectorAll('[data-m]')) {
    const src = 'media/' + m.dataset.m + '-' + manualTheme + (m.tagName === 'VIDEO' ? '.mp4' : '.webp');
    if (m.getAttribute('src') !== src) m.src = src;
  }
}
function setTheme(t) {
  manualTheme = t; document.documentElement.dataset.theme = t;
  try { localStorage.setItem('manualTheme', t); } catch { /* this page only */ }
  setMedia();
}

function wrapFigures() {
  for (const fig of document.querySelectorAll('figure.shot, figure.clip, figure.anno')) {
    if (fig.querySelector(':scope > .frame')) continue;
    const frame = el('div', { className: 'frame' });
    for (const kid of [...fig.childNodes]) if (!(kid.tagName === 'FIGCAPTION')) frame.append(kid);
    fig.prepend(frame);
  }
  for (const v of document.querySelectorAll('video[data-m]')) Object.assign(v, { muted: true, loop: true, playsInline: true, preload: 'metadata' });
  document.querySelectorAll('.anno .pin').forEach((p, i) => p.style.setProperty('--i', i));
}

function sidebar() {
  const nav = el('nav');
  CHAPTERS.forEach(([id, title], i) => {
    const a = el('a', { href: id + '.html', className: id === here ? 'on' : '' }, el('span', { className: 'n', textContent: i ? String(i) : '·' }), el('span', { textContent: title }));
    nav.append(a);
    if (id !== here) return;
    const heads = [...document.querySelectorAll('section.topic > h2[id]')];
    if (!heads.length) return;
    const toc = el('div', { className: 'toc' }), mark = el('i', { className: 'mark' });
    toc.append(mark, ...heads.map((h) => el('a', { href: '#' + h.id, textContent: h.dataset.short || h.firstChild.textContent.trim() })));
    nav.append(toc);
    // the section you are reading: the last heading above a third of the window
    const spy = () => {
      let at = 0; heads.forEach((h, j) => { if (h.getBoundingClientRect().top < innerHeight / 3) at = j; });
      const links = toc.querySelectorAll('a');
      links.forEach((l, j) => l.classList.toggle('here', j === at));
      const l = links[at]; mark.style.top = l.offsetTop + 'px'; mark.style.height = l.offsetHeight + 'px';
    };
    addEventListener('scroll', spy, { passive: true }); requestAnimationFrame(spy);
  });
  const find = el('button', { className: 'find', type: 'button' }, el('span', { textContent: 'Search the manual' }), el('kbd', { textContent: '⌘K' }));
  find.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.75"/><path d="m10.5 10.5 3.5 3.5" stroke-linecap="round"/></svg>');
  find.onclick = openSearch;
  const toggle = el('button', { type: 'button', textContent: manualTheme === 'dark' ? 'Light' : 'Dark', title: 'Switch the manual’s theme' });
  toggle.onclick = () => { setTheme(manualTheme === 'dark' ? 'light' : 'dark'); toggle.textContent = manualTheme === 'dark' ? 'Light' : 'Dark'; };
  const brand = el('a', { className: 'brand', href: 'index.html' }, el('img', { src: 'media/app-icon.png', alt: '' }), el('span', {}, 'Orbital', el('small', { textContent: 'The manual' })));
  document.body.prepend(el('div', { className: 'drag' }), el('div', { className: 'progress' }, el('i')),
    el('aside', { className: 'side' }, brand, find, nav, el('div', { className: 'foot' }, el('span', { textContent: '⌘[ ⌘] chapters' }), toggle)));
  const on = nav.querySelector('a.on'); if (on) on.scrollIntoView({ block: 'center' });
}

function headings() {
  for (const h of document.querySelectorAll('section.topic > h2, section.topic h3')) {
    if (!h.id) h.id = slug(h.textContent);
    h.append(el('a', { className: 'anchor', href: '#' + h.id, textContent: '#', ariaHidden: 'true' }));
  }
  // an empty "In this chapter" list fills itself from the chapter's sections
  for (const ul of document.querySelectorAll('ul.learn:empty'))
    for (const h of document.querySelectorAll('section.topic > h2[id]')) ul.append(el('li', {}, el('a', { href: '#' + h.id, textContent: h.dataset.short || h.firstChild.textContent.trim() })));
}

function pager() {
  const i = CHAPTERS.findIndex(([id]) => id === here); if (i < 0) return;
  const p = CHAPTERS[i - 1], n = CHAPTERS[i + 1], page = document.querySelector('.page');
  const nav = el('nav', { className: 'pager' });
  if (p) nav.append(el('a', { href: p[0] + '.html' }, el('small', { textContent: '← Previous' }), p[1]));
  if (n) nav.append(el('a', { className: 'next', href: n[0] + '.html' }, el('small', { textContent: 'Next →' }), n[1]));
  page.append(nav);
  addEventListener('keydown', (e) => {
    if (!e.metaKey || e.shiftKey || e.altKey) return;
    if (e.key === '[' && p) location.href = p[0] + '.html';
    if (e.key === ']' && n) location.href = n[0] + '.html';
  });
}

// things fade up as they arrive (.shown, once); a diagram plays while on screen (.in) and starts over when you come
// back; a clip plays from the top when it scrolls in and stops when it leaves
function motion() {
  const reveal = document.querySelectorAll('.page figure, .page .mg, .page .split, .page .grid, .page .try, .page .tip, .page .note, .page table.keys, .page .legend');
  if (!reduced) for (const r of reveal) r.classList.add('reveal');
  const seen = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { e.target.classList.add('shown'); seen.unobserve(e.target); } }, { rootMargin: '0px 0px -8% 0px' });
  reveal.forEach((r) => seen.observe(r));
  const live = new IntersectionObserver((es) => {
    for (const e of es) {
      const t = e.target;
      if (t.classList.contains('mg')) { t.classList.toggle('in', e.isIntersecting); continue; }
      const fig = t.closest('figure');
      if (e.isIntersecting && !fig.classList.contains('paused')) { if (!reduced) t.play().catch(() => {}); }
      else if (!e.isIntersecting) { t.pause(); t.currentTime = 0; }
    }
  }, { threshold: 0.35 });
  document.querySelectorAll('.mg').forEach((m) => live.observe(m));
  document.querySelectorAll('figure.clip video').forEach((v) => {
    live.observe(v);
    v.closest('.frame').addEventListener('click', () => { const fig = v.closest('figure'); if (v.paused) { fig.classList.remove('paused'); v.play(); } else { fig.classList.add('paused'); v.pause(); } });
  });
  if (reduced) document.querySelectorAll('figure.clip').forEach((f) => f.classList.add('paused'));
  const bar = document.querySelector('.progress i');
  const progress = () => { const max = document.documentElement.scrollHeight - innerHeight; bar.style.setProperty('--p', max > 0 ? Math.min(1, scrollY / max) : 0); };
  addEventListener('scroll', progress, { passive: true }); progress();
}

function lightbox() {
  document.addEventListener('click', (e) => {
    const img = e.target.closest('figure.shot img, figure.anno img'); if (!img) return;
    const box = el('div', { className: 'lightbox' }, el('img', { src: img.src, alt: img.alt }));
    const close = () => { box.remove(); removeEventListener('keydown', esc); };
    const esc = (k) => { if (k.key === 'Escape') close(); };
    box.onclick = close; addEventListener('keydown', esc); document.body.append(box);
  });
}

// hovering a pin lights its line in the legend under the picture, and the other way round
function pins() {
  for (const fig of document.querySelectorAll('figure.anno')) {
    const ps = [...fig.querySelectorAll('.pin')], legend = fig.nextElementSibling && fig.nextElementSibling.matches('ol.legend') ? [...fig.nextElementSibling.children] : [];
    const lit = (i, on) => { if (ps[i]) ps[i].classList.toggle('lit', on); if (legend[i]) legend[i].classList.toggle('lit', on); };
    [ps, legend].forEach((list) => list.forEach((x, i) => { x.addEventListener('mouseenter', () => lit(i, true)); x.addEventListener('mouseleave', () => lit(i, false)); }));
  }
}

// ⌘K: every chapter and heading of the manual, as Orbital's own palette finds commands
function openSearch() {
  if (document.querySelector('.pal')) return;
  const index = (window.MANUAL_INDEX || []);
  const input = el('input', { placeholder: 'Search the manual', spellcheck: false }), list = el('ul');
  const box = el('div', { className: 'pal' }, el('div', { className: 'box' }, input, list));
  let rows = [], at = 0;
  const draw = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (r) => { const hay = (r.t + ' ' + r.ct + ' ' + (r.k || '')).toLowerCase(); return words.every((w) => hay.includes(w)); };
    const found = words.length ? index.filter(hit).sort((a, b) => (b.t.toLowerCase().startsWith(words[0]) - a.t.toLowerCase().startsWith(words[0]))).slice(0, 40)
      : CHAPTERS.map(([c, t]) => ({ c, ct: 'Chapters', t, id: '' }));
    list.replaceChildren(); rows = []; at = Math.min(at, Math.max(0, found.length - 1));
    if (!found.length) { list.append(el('li', { className: 'empty', textContent: 'Nothing about “' + input.value + '” yet' })); return; }
    let group = null;
    for (const r of found) {
      if (r.ct !== group) { group = r.ct; list.append(el('li', { className: 'grp', textContent: group })); }
      const a = el('a', { href: r.c + '.html' + (r.id ? '#' + r.id : '') }, el('span', { textContent: r.t }), r.key ? el('small', { textContent: r.key }) : '');
      rows.push(a); list.append(el('li', {}, a));
    }
    rows.forEach((a, i) => a.classList.toggle('on', i === at));
  };
  const close = () => { box.remove(); };
  input.oninput = () => { at = 0; draw(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); at = (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length; rows.forEach((a, i) => a.classList.toggle('on', i === at)); rows[at].scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter' && rows[at]) { close(); rows[at].click(); }
    else if (e.key === 'Escape' || (e.metaKey && e.key === 'k')) { e.preventDefault(); close(); }
  };
  box.addEventListener('mousedown', (e) => { if (e.target === box) close(); });
  list.addEventListener('click', close);
  document.body.append(box); draw(); input.focus();
}
addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openSearch(); }
  else if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); openSearch(); }
});

document.addEventListener('DOMContentLoaded', () => {
  wrapFigures(); setMedia(); headings(); sidebar(); pager(); pins(); lightbox(); motion();
});
