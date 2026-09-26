'use strict';
// Loading (Build): what the page shows while its first rows are on their way, on a launch or a Reload only
// (render.js: booted); a page opened later waits blank, its rows a moment away. The page builds itself in pixel art
// where the real one will be: the crumbs and the title, then the rows one by one, each marker a small pixel glyph (a
// task's box, a document, a meeting, a bullet) and a bar for its text streaming in left to right, a cursor block at
// its front. Built, a pixel shimmer runs over it until the rows land; then it fades and the real rows build in the
// same way, top to bottom (buildIn). Motion otherwise answers a hand (renderer/motion.js); this is the one page that
// draws itself in, once per launch, because that was asked for.
// One colour at a few strengths (styles.css .skeleton canvas), so it follows the theme. Nothing is drawn for the
// first WAIT, so a quick load never blinks it; one still, built frame where motion is not welcome.
// Cmd+K "Preview loading animation" shows it over the page until Esc, which builds the rows in as a load would.
let previewLoading = () => {};
(() => {
  const box = document.getElementById('skeleton'), canvas = box && box.querySelector && box.querySelector('canvas');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const P = 4, WAIT = 0.3, AMAX = 0.6, LV = 16; // P: one pixel of the art in CSS px, so a 16px glyph is 4×4
  const GLYPHS = [
    ['####', '#..#', '#..#', '####'], // a task
    ['###.', '#.##', '#..#', '####'], // a document, its corner folded
    ['#..#', '####', '#..#', '####'], // a meeting
    ['.##.', '####', '####', '.##.'], // a bullet
  ];
  const seeded = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // the page: the same one on every launch, section headings now and then, some rows a level in, some with meta
  const rnd = seeded(20260926);
  const ROWS = Array.from({ length: 48 }, (_, i) => ({ head: i === 0 || (i > 2 && rnd() < 0.12), glyph: Math.floor(rnd() * 4), depth: rnd() < 0.2 ? 1 : 0, w: 0.25 + 0.5 * rnd(), meta: rnd() < 0.35 ? 0.06 + 0.1 * rnd() : 0 }));
  ROWS.forEach((r, i) => { if (i && ROWS[i - 1].head) r.head = false; });
  const bar = (cols, rows) => Array.from({ length: rows }, (_, j) => (rows > 2 && (j === 0 || j === rows - 1) ? '.' + '#'.repeat(cols - 2) + '.' : '#'.repeat(cols))); // rows > 2: the corners off
  let page = null, key = '';
  // Where each part goes, measured off the real page (its header is laid out while hidden), with every block's
  // strength and the moment it lands: left to right across its part, a little ragged.
  function layout(w, h) {
    const c = canvas.getBoundingClientRect();
    const at = (el, dx, dy) => { const r = el && el.getBoundingClientRect(); return r && r.width + r.height ? [Math.round(r.left - c.left + dx), Math.round(r.top - c.top + dy)] : null; };
    const [cx, cy] = at(document.getElementById('crumbs'), 0, 4) || [32, 52], [tx, ty] = at(document.getElementById('title'), 0, 9) || [32, 84];
    const [sx, sy] = at(document.querySelector('.scroll'), 16, 4) || [16, 140];
    const k = [w, h, cx, cy, tx, ty, sx, sy].join();
    if (k === key) return page;
    const blocks = [], bars = [], jitter = seeded(7);
    const add = (x, y, bitmap, a, start, dur, cursor) => {
      const cols = bitmap[0].length;
      bitmap.forEach((line, j) => { for (let i = 0; i < cols; i++) if (line[i] === '#') blocks.push(x + i * P, y + j * P, a, start + (i / cols) * dur + jitter() * 0.05); });
      if (cursor) bars.push([x, y, cols, bitmap.length, start, dur]);
      return start + dur;
    };
    let end = add(cx, cy, bar(12, 2), 0.1, 0, 0.18);
    end = Math.max(end, add(cx + 15 * P, cy, bar(18, 2), 0.1, 0.08, 0.22));
    end = Math.max(end, add(tx, ty, bar(44, 6), 0.18, 0.05, 0.4, true));
    const avail = Math.max(120, Math.min(w - sx - 47 - 40, 600));
    let y = sy, s = 0.3;
    for (const r of ROWS) {
      if (y > h) break;
      const x = sx + r.depth * 24;
      if (r.head) { y += y > sy ? 18 : 0; end = add(sx + 24, y + 13, bar(14 + Math.round(r.w * 16), 2), 0.1, s, 0.15); y += 35; s += 0.06; continue; }
      add(x + 24, y + 7, GLYPHS[r.glyph], 0.3, s, 0.08);
      const cols = Math.max(8, Math.round((avail * r.w) / P)), dur = 0.1 + cols * 0.002;
      end = add(x + 47, y + 9, bar(cols, 3), 0.13, s + 0.06, dur, true);
      if (r.meta) end = add(x + 47 + (cols + 3) * P, y + 9, bar(Math.round((avail * r.meta) / P), 3), 0.075, end, 0.1);
      y += 30; s += 0.07;
    }
    key = k;
    return (page = { blocks, bars, end });
  }
  // blocks sorted into strengths, one path each
  const buckets = Array.from({ length: LV }, () => []);
  const put = (x, y, a) => { if (a > 0.004) buckets[Math.min(LV - 1, Math.floor((a / AMAX) * LV))].push(x, y); };
  let frame = 0, t0 = 0, on = false;
  function draw(now) {
    frame = 0;
    if (!on) return;
    const still = typeof stillPreferred === 'function' && stillPreferred();
    if (!t0) t0 = now;
    const t = still ? 99 : (now - t0) / 1000 - WAIT;
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (w && h) {
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (t >= 0) {
        const { blocks: B, bars, end } = layout(w, h);
        // a block lands bright and settles; once all have, a band of light runs over them, a block at a time
        const since = t - end - 0.3, band = !still && since > 0 ? ((since % 2.4) / 2.4) * (w + h + 400) - 200 : -1e4;
        for (let i = 0; i < B.length; i += 4) {
          const age = t - B[i + 3];
          if (age < 0) continue;
          const d = (B[i] + B[i + 1] * 0.6 - band) / 80;
          put(B[i], B[i + 1], B[i + 2] * (age < 0.2 ? 3 - age * 10 : 1) + 0.08 * Math.exp(-d * d));
        }
        for (const [x, y, cols, rows, start, dur] of bars) { // the cursor at the front of a bar still being built
          const p = (t - start) / dur;
          if (p >= 0 && p < 1) for (let j = 0; j < rows; j++) put(x + Math.floor(p * cols) * P, y + j * P, 0.4);
        }
        ctx.fillStyle = getComputedStyle(canvas).color;
        buckets.forEach((b, k) => {
          if (!b.length) return;
          ctx.globalAlpha = ((k + 0.5) / LV) * AMAX;
          ctx.beginPath();
          for (let i = 0; i < b.length; i += 2) ctx.rect(b[i], b[i + 1], P, P);
          ctx.fill(); b.length = 0;
        });
        ctx.globalAlpha = 1;
        if (still) return;
      }
    }
    frame = requestAnimationFrame(draw);
  }
  // the real rows arriving: each wipes in left to right in pixel steps, one after another down the page
  function buildIn() {
    const rows = [...document.querySelectorAll('#outline > *')].filter((el) => el.getBoundingClientRect().top < innerHeight).slice(0, 40);
    rows.forEach((el, i) => play(el, [{ clipPath: 'inset(-4px 100% -4px -48px)', opacity: 0.4 }, { clipPath: 'inset(-4px -8px -4px -48px)', opacity: 1 }],
      { duration: 300, easing: 'steps(8, jump-end)', delay: i * 40 }));
  }
  const previewing = () => document.body.classList.contains('loading-preview');
  const sync = () => {
    const now = !box.classList.contains('gone') || previewing();
    if (on && !now) buildIn();
    if (now && !on) t0 = 0;
    on = now;
    if (on && !frame) frame = requestAnimationFrame(draw);
  };
  if (typeof MutationObserver === 'function') {
    new MutationObserver(sync).observe(box, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(() => { if (on && !frame) frame = requestAnimationFrame(draw); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); // the still frame repaints in the new colour
  }
  // (focus leaves the page too: a menu command such as Paste goes to whatever has focus, keys or not)
  previewLoading = (show) => { if (show && document.activeElement && document.activeElement.blur) document.activeElement.blur(); document.body.classList.toggle('loading-preview', show); sync(); };
  // Esc ends a preview before anything else hears it, and no other key reaches the page hidden behind it
  addEventListener('keydown', (e) => { if (!previewing()) return; e.preventDefault(); e.stopImmediatePropagation(); if (e.key === 'Escape') previewLoading(false); }, true);
  sync();
})();
