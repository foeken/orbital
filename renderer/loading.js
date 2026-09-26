'use strict';
// Loading (Ambient): what the empty outline shows while a view's rows are on their way (render.js toggles #skeleton's
// .gone). A dotted surface rolls slowly in perspective, the camera swaying around it as if in orbit, and a few of its
// dots light up as nodes and are joined, one link at a time, into a small graph — the knowledge being gathered. Drawn on
// a canvas, only while it is on screen; one still frame, graph complete, where motion is not welcome. The colours are
// styles.css's (.skeleton canvas), so the theme reaches it.
(() => {
  const box = document.getElementById('skeleton'), canvas = box && box.querySelector && box.querySelector('canvas');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const COLS = 48, ROWS = 26, SPREAD = 0.9; // the field, in grid steps, and the step
  // grid points (column from the middle, row from the front) that become the graph, and the links between them, in
  // the order they light: each link grows from its first node to its second
  const NODES = [[-3, 7], [3, 5], [8, 9], [-8, 11], [1, 12], [11, 15], [-4, 17], [5, 19]];
  const LINKS = [[0, 1], [1, 2], [0, 3], [1, 4], [2, 5], [4, 6], [4, 7], [3, 6]];
  const STEP = 0.7, GROW = 0.6, CYCLE = 11; // seconds between links, for one to grow, and for the whole graph to form and go
  const wave = (x, z, t) => Math.sin(x * 0.3 + t * 0.8) * 0.5 + Math.sin(z * 0.38 - t * 1.1) * 0.45 + Math.sin((x + z) * 0.15 + t * 0.5) * 0.25;
  const clamp = (v) => Math.max(0, Math.min(1, v));
  let frame = 0, t0 = 0;
  function draw(now) {
    frame = 0;
    if (typeof box.checkVisibility === 'function' && !box.checkVisibility()) return; // gone: the next .gone change starts it again
    const still = typeof stillPreferred === 'function' && stillPreferred();
    if (!t0) t0 = now;
    const t = still ? 7 : (now - t0) / 1000;
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cs = getComputedStyle(canvas), dot = cs.color, node = cs.getPropertyValue('--node').trim() || '#5b9bd5';
    // the camera orbits: the field turns under it about its middle, a slow sway either way
    const turn = Math.sin(t * 0.13) * 0.45, c = Math.cos(turn), s = Math.sin(turn), mid = (ROWS * SPREAD) / 2;
    const focal = h * 0.95, horizon = h * 0.1, height = 3.6;
    const at = (col, row) => {
      const x = col * SPREAD, z = row * SPREAD, y = wave(x, z, t) * 0.55;
      const rx = x * c - (z - mid) * s, rz = x * s + (z - mid) * c + mid;
      const depth = rz + 3.2, f = focal / depth;
      return { x: w / 2 + rx * f, y: horizon + (height - y) * f, near: clamp(1 - rz / (ROWS * SPREAD)), f };
    };
    ctx.fillStyle = dot;
    for (let row = ROWS - 1; row >= 0; row--) for (let col = -COLS / 2; col <= COLS / 2; col++) {
      const p = at(col, row);
      if (p.x < -4 || p.x > w + 4 || p.y > h + 4) continue;
      ctx.globalAlpha = 0.12 + p.near * 0.55;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.5, p.f * 0.028), 0, Math.PI * 2); ctx.fill();
    }
    // the graph: node i lights as the link that reaches it starts, a link grows from its first node to its second,
    // and at the end of the cycle all of it fades together before it forms again
    const cycle = still ? LINKS.length * STEP + GROW : t % CYCLE, fade = still ? 1 : clamp((CYCLE - cycle) / 1.2) * clamp(cycle / 0.6);
    const lit = NODES.map(() => 0);
    lit[LINKS[0][0]] = clamp(cycle / 0.4);
    const pts = NODES.map(([col, row]) => at(col, row));
    ctx.strokeStyle = node; ctx.lineWidth = 1.2; ctx.lineCap = 'round';
    LINKS.forEach(([a, b], i) => {
      const grow = clamp((cycle - i * STEP) / GROW);
      if (!grow) return;
      lit[a] = Math.max(lit[a], 1);
      lit[b] = Math.max(lit[b], clamp((cycle - i * STEP - GROW * 0.8) / 0.3));
      const pa = pts[a], pb = pts[b], ex = pa.x + (pb.x - pa.x) * grow, ey = pa.y + (pb.y - pa.y) * grow;
      ctx.globalAlpha = 0.55 * fade;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(ex, ey); ctx.stroke();
      if (grow < 1) { ctx.globalAlpha = fade; ctx.fillStyle = node; ctx.beginPath(); ctx.arc(ex, ey, 2, 0, Math.PI * 2); ctx.fill(); } // what travels the link as it forms
    });
    ctx.fillStyle = node;
    pts.forEach((p, i) => {
      if (!lit[i]) return;
      const r = 2.2 + p.near * 2.2, pulse = still ? 0 : Math.sin(t * 2.4 + i) * 0.4;
      ctx.globalAlpha = 0.16 * lit[i] * fade; ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.6 + pulse, 0, Math.PI * 2); ctx.fill(); // its glow
      ctx.globalAlpha = lit[i] * fade; ctx.beginPath(); ctx.arc(p.x, p.y, r * (0.6 + 0.4 * lit[i]), 0, Math.PI * 2); ctx.fill();
    });
    ctx.globalAlpha = 1;
    if (!still) frame = requestAnimationFrame(draw);
  }
  const run = () => { if (!frame && !box.classList.contains('gone')) { t0 = 0; frame = requestAnimationFrame(draw); } };
  if (typeof MutationObserver === 'function') new MutationObserver(run).observe(box, { attributes: true, attributeFilter: ['class'] });
  run();
})();
