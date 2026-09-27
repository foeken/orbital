'use strict';
// Loading (Build): what the page shows while its first rows are on their way, on a launch or a Reload only
// (render.js: booted); a page opened later waits blank, its rows a moment away. The page builds itself where the real
// one will be: the crumbs and the title, then the rows one by one, each marker a small outlined glyph (a task's box,
// a document, a meeting, a bullet) and a rounded bar for its text growing in from the left. Built, a soft shimmer runs
// over it until the rows land; then it fades and the real rows rise in, top to bottom (buildIn). Motion otherwise
// answers a hand (renderer/motion.js); this is the one page that draws itself in, once per launch, because that was
// asked for.
// One colour at a few strengths (styles.css .skeleton canvas), so it follows the theme. Nothing is drawn for the
// first WAIT, so a quick load never blinks it; one still, built frame where motion is not welcome.
(() => {
  const box = document.getElementById('skeleton'), canvas = box && box.querySelector && box.querySelector('canvas');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const WAIT = 0.3, clamp = (v) => Math.max(0, Math.min(1, v)), ease = (v) => 1 - Math.pow(1 - clamp(v), 3);
  const seeded = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // the page: the same one on every launch, section headings now and then, some rows a level in, some with meta
  const rnd = seeded(20260926);
  const ROWS = Array.from({ length: 48 }, (_, i) => ({ head: i === 0 || (i > 2 && rnd() < 0.12), glyph: Math.floor(rnd() * 4), depth: rnd() < 0.2 ? 1 : 0, w: 0.25 + 0.5 * rnd(), meta: rnd() < 0.35 ? 0.06 + 0.1 * rnd() : 0 }));
  ROWS.forEach((r, i) => { if (i && ROWS[i - 1].head) r.head = false; });
  let page = null, key = '';
  // Where each part goes, measured off the real page (its header is laid out while hidden), and when it comes in. Under
  // a page landing in parts (.tail, the Timeline) only rows are drawn, from below the last real one, built from `from` on.
  function layout(w, h, from) {
    const c = canvas.getBoundingClientRect();
    const at = (el, dx, dy) => { const r = el && el.getBoundingClientRect(); return r && r.width + r.height ? [Math.round(r.left - c.left + dx), Math.round(r.top - c.top + dy)] : null; };
    // a crumb line or a title that is not on the page (a list under a tab bar, a chat) gets no bar: drawn at a guessed
    // spot instead, it lay across the first rows
    const crumbAt = at(document.getElementById('crumbs'), 0, 4), titleAt = at(document.getElementById('title'), 0, 9);
    const [cx, cy] = crumbAt || [32, 52], [tx, ty] = titleAt || [32, 84];
    const tail = box.classList.contains('tail'), last = tail && document.getElementById('outline').lastElementChild;
    let [sx, sy] = at(document.querySelector('.scroll'), 16, 4) || [16, 140];
    if (last) sy = Math.round(last.getBoundingClientRect().bottom - c.top + 16);
    const k = [w, h, cx, cy, tx, ty, !!crumbAt, !!titleAt, sx, sy, tail].join();
    if (k === key) return page;
    const items = [], bar = (x, y, bw, bh, a, start, dur) => { items.push({ x, y, w: bw, h: bh, a, start, dur }); return start + dur; };
    let end = 0;
    if (!tail && crumbAt) { bar(cx, cy, 48, 8, 0.1, 0, 0.5); bar(cx + 58, cy, 72, 8, 0.1, 0.12, 0.5); }
    if (!tail && titleAt) end = bar(tx, ty, 176, 24, 0.14, 0.1, 0.8);
    const avail = Math.max(120, Math.min(w - sx - 47 - 40, 600));
    let y = sy, s = tail ? from : 0.6;
    for (const r of ROWS) {
      if (y > h) break;
      const x = sx + r.depth * 24;
      if (r.head) { y += y > sy ? 18 : 0; end = bar(sx + 24, y + 14, 56 + r.w * 64, 8, 0.08, s, 0.5); y += 35; s += 0.08; continue; }
      items.push({ glyph: r.glyph, x: x + 24, y: y + 7, a: 0.26, start: s, dur: 0.4 });
      const bw = Math.max(40, avail * r.w);
      end = bar(x + 47, y + 10, bw, 10, 0.11, s + 0.08, 0.8);
      if (r.meta) end = bar(x + 47 + bw + 10, y + 10, avail * r.meta, 10, 0.065, s + 0.4, 0.5);
      y += 30; s += 0.09;
    }
    key = k;
    return (page = { items, end });
  }
  function glyph(g, x, y) { // 16px, the size of a row's icon
    ctx.beginPath();
    if (g === 0) ctx.roundRect(x + 2, y + 2, 12, 12, 3); // a task
    else if (g === 1) { ctx.roundRect(x + 3, y + 1.5, 10, 13, 2); ctx.moveTo(x + 6, y + 6); ctx.lineTo(x + 10, y + 6); ctx.moveTo(x + 6, y + 9.5); ctx.lineTo(x + 10, y + 9.5); } // a document
    else if (g === 2) { ctx.roundRect(x + 1.5, y + 2.5, 13, 12, 3); ctx.moveTo(x + 1.5, y + 6.5); ctx.lineTo(x + 14.5, y + 6.5); } // a meeting
    else { ctx.arc(x + 8, y + 8, 3, 0, Math.PI * 2); ctx.fill(); return; } // a bullet
    ctx.stroke();
  }
  let frame = 0, t0 = 0, on = false;
  function draw(now) {
    frame = 0;
    if (!on) return;
    const still = typeof stillPreferred === 'function' && stillPreferred();
    if (!t0) t0 = now;
    const t = still ? 99 : (now - t0) / 1000 - WAIT;
    // the Timeline builds at its own slow pace; every other page builds in less than half the time (the sweep does not change)
    const bt = t * (zoom && zoom.docId === TIMELINE_PAGE ? 1 : 2.2);
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (w && h) {
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (t >= 0) {
        const { items } = layout(w, h, bt);
        // every bar carries a band of light running left to right through it, the rows lower down a step behind the
        // ones above, so the page reads as still loading; the glyphs keep a steady strength
        const col = (getComputedStyle(canvas).color.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).join(','), base = 'rgba(' + col + ',0.55)';
        const sweep = (it) => {
          if (still) return base;
          const ph = (((t / 1.8 - it.y / 900) % 1) + 1) % 1, bx = it.x - 160 + ph * (it.w + 320), g = ctx.createLinearGradient(bx - 120, 0, bx + 120, 0);
          g.addColorStop(0, base); g.addColorStop(0.5, 'rgba(' + col + ',1)'); g.addColorStop(1, base);
          return g;
        };
        ctx.strokeStyle = base; ctx.lineWidth = 1.5;
        for (const it of items) {
          const p = (bt - it.start) / it.dur;
          if (p <= 0) continue;
          ctx.globalAlpha = (it.a / 0.55) * clamp(p * 2.5);
          if (it.glyph != null) { ctx.fillStyle = base; glyph(it.glyph, it.x, it.y + 3 * (1 - ease(p))); continue; }
          ctx.fillStyle = sweep(it);
          ctx.beginPath(); ctx.roundRect(it.x, it.y, Math.max(it.h, it.w * ease(p)), it.h, it.h / 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
        if (still) return;
      }
    }
    frame = requestAnimationFrame(draw);
  }
  // the real rows arriving: each rises in a little after the one above it, once — a page landing in parts brings new
  // rows between old ones, and a render rebuilds rows it cannot reuse, so a row is known by its key rather than its element
  const risen = new Set(), keyOf = (el) => el.dataset.key || el.dataset.group;
  function buildIn() {
    const rows = [...document.querySelectorAll('#outline > *')].filter((el) => keyOf(el) && !risen.has(keyOf(el)));
    rows.filter((el) => el.getBoundingClientRect().top < innerHeight).slice(0, 40)
      .forEach((el, i) => play(el, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: MOTION.slow, easing: MOTION.out, delay: i * 35 }));
    for (const el of rows) risen.add(keyOf(el));
  }
  const sync = () => {
    const now = !box.classList.contains('gone');
    if (on && !now) buildIn();
    if (now && !on) t0 = 0;
    on = now;
    if (on && !frame) frame = requestAnimationFrame(draw);
  };
  if (typeof MutationObserver === 'function') {
    new MutationObserver(sync).observe(box, { attributes: true, attributeFilter: ['class'] });
    // a part of the page landing under the loader (.tail): its new rows rise in now, not when the last part is in
    new MutationObserver(() => { if (on && box.classList.contains('tail')) buildIn(); }).observe(document.getElementById('outline'), { childList: true });
    new MutationObserver(() => { if (on && !frame) frame = requestAnimationFrame(draw); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); // the still frame repaints in the new colour
  }
  // after the last renderer script: a frame drawn earlier reads the page state (zoom) before it exists and dies
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', sync); else sync();
})();
