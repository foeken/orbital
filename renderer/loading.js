'use strict';
// Loading (Gravity): what the content area shows while a view's rows are on their way (render.js toggles #skeleton's
// .gone). A knowledge system with gravity. It opens with a singularity that bursts outwards; everything spirals out,
// overshoots and settles into orbit. At the centre a dotted core turns inside a disk of dust in two spiral arms.
// Knowledge nodes circle it on tilted orbits, the inner ones faster, each leaving a comet trail. Where two nodes pass
// near each other a link forms, carries signals and breaks again as they drift apart. Every few seconds the core sends
// out a sync wave, and whatever it passes lights up. Stars drift behind at their own depths. The camera leans after the
// pointer, and the nodes near it light up.
// One colour at many strengths (styles.css .skeleton canvas), so it stays monochrome in either theme; in dark mode
// light adds up, so what crowds together glows. Drawn only while on screen, as one still frame where motion is not
// welcome. Dots and lines are sorted by strength and drawn in a few batches: one draw call per dot was the cost.
// Cmd+K "Preview loading animation" shows it over the page until Esc (body.loading-preview, styles.css): a load is
// usually over before there is anything to see.
let previewLoading = () => {};
(() => {
  const box = document.getElementById('skeleton'), canvas = box && box.querySelector && box.querySelector('canvas');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const TAU = Math.PI * 2, D = 4, clamp = (v) => Math.max(0, Math.min(1, v)), ease = (v) => 1 - Math.pow(1 - clamp(v), 3);
  const spring = (x) => (x <= 0 ? 0 : 1 - Math.exp(-6 * x) * Math.cos(7 * x)); // out past its place and back
  const seeded = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rnd = seeded(20260926);
  // the core: points spread evenly over a sphere (a Fibonacci lattice)
  const CORE = 0.34, NG = 1100, GOLD = Math.PI * (3 - Math.sqrt(5));
  const globe = Array.from({ length: NG }, (_, i) => { const y = 1 - ((i + 0.5) * 2) / NG, r = Math.sqrt(1 - y * y), a = i * GOLD; return [Math.cos(a) * r, y, Math.sin(a) * r]; });
  // the disk: two thirds of the dust in two spiral arms that turn as one, the rest a haze that shears, inner faster
  const DUST = Array.from({ length: 1800 }, (_, i) => {
    const u = rnd(), r = 0.55 + 1.55 * Math.pow(u, 0.8), arm = i % 3 !== 0;
    return { r, arm, a: arm ? (i % 2) * Math.PI + 2.4 * Math.log(r) + (rnd() - 0.5) * (rnd() - 0.5) * (1.5 - 0.6 * u) : rnd() * TAU, y: (rnd() - 0.5) * 0.06 * r, s: rnd() };
  });
  // the nodes: circular orbits in a few tilted planes, some of them hubs
  const PLANES = [0.2, 1.05, -1.05, 0.55];
  const NODES = Array.from({ length: 56 }, (_, i) => {
    const r = 0.62 + 1.05 * rnd();
    return { r, inc: PLANES[i % 4] + (rnd() - 0.5) * 0.3, node: rnd() * TAU, ph: rnd() * TAU, w: 0.55 * Math.pow(r, -1.5), hub: i < 7 };
  });
  const GUIDES = [[1.2, PLANES[1], 0.4], [1.55, PLANES[2], 2.1]]; // two dotted orbits drawn in full, for the eye to hold on to
  const STARS = Array.from({ length: 220 }, () => [rnd(), rnd(), rnd() * TAU, 0.2 + 0.8 * rnd()]);
  const inPlane = (x, z, inc, node) => { const y1 = z * Math.sin(inc), z1 = z * Math.cos(inc); return [x * Math.cos(node) + z1 * Math.sin(node), y1, -x * Math.sin(node) + z1 * Math.cos(node)]; };
  // batches: dots and line pieces sorted into strengths, one path each
  const LV = 24, dots = Array.from({ length: LV }, () => []), segs = Array.from({ length: LV }, () => []);
  const level = (a) => Math.min(LV - 1, Math.floor(Math.sqrt(Math.min(a, 1)) * LV));
  const dot = (x, y, r, a) => { if (a > 0.004) dots[level(a)].push(x, y, r); };
  const seg = (x1, y1, x2, y2, a) => { if (a > 0.004) segs[level(a)].push(x1, y1, x2, y2); };
  function drawBatches(lw) {
    ctx.lineWidth = lw; ctx.lineCap = 'round';
    for (let k = 0; k < LV; k++) {
      ctx.globalAlpha = ((k + 0.5) / LV) ** 2;
      const d = dots[k], s = segs[k];
      if (d.length) {
        ctx.beginPath();
        for (let i = 0; i < d.length; i += 3) { const r = d[i + 2]; if (r < 1) ctx.rect(d[i] - r, d[i + 1] - r, 2 * r, 2 * r); else { ctx.moveTo(d[i] + r, d[i + 1]); ctx.arc(d[i], d[i + 1], r, 0, TAU); } }
        ctx.fill(); d.length = 0;
      }
      if (s.length) {
        ctx.beginPath();
        for (let i = 0; i < s.length; i += 4) { ctx.moveTo(s[i], s[i + 1]); ctx.lineTo(s[i + 2], s[i + 3]); }
        ctx.stroke(); s.length = 0;
      }
    }
  }
  let frame = 0, t0 = 0, last = 0;
  // the pointer: the camera leans after it, eased so it drifts rather than follows, and nodes near it light up
  let mx = 0, my = 0, ex = 0, ey = 0, px0 = -1e4, py0 = -1e4;
  addEventListener('pointermove', (e) => { mx = (e.clientX / innerWidth) * 2 - 1; my = (e.clientY / innerHeight) * 2 - 1; px0 = e.clientX; py0 = e.clientY; }, { passive: true });
  document.addEventListener('pointerleave', () => { mx = my = 0; px0 = py0 = -1e4; });
  function draw(now) {
    frame = 0;
    if (typeof box.checkVisibility === 'function' && !box.checkVisibility()) return; // gone: the next .gone change starts it again
    const still = typeof stillPreferred === 'function' && stillPreferred();
    if (!t0) t0 = now;
    const t = still ? 9 : (now - t0) / 1000;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0, lean = 1 - Math.exp(-dt * 2.5);
    last = now;
    if (!still) { ex += (mx - ex) * lean; ey += (my - ey) * lean; }
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) { frame = requestAnimationFrame(draw); return; }
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    const col = getComputedStyle(canvas).color, rgba = 'rgba(' + (col.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).join(',') + ',';
    const dark = document.documentElement.dataset.theme === 'dark';
    ctx.fillStyle = ctx.strokeStyle = col;
    if (dark) ctx.globalCompositeOperation = 'lighter';
    // a little above the middle: the title and the pills weigh down the top of the page
    const R = Math.min(w * 0.27, h * 0.34), cx = w / 2, cy = h * 0.44, px = R / 260;
    // the camera circles slowly, looking down onto the disk, and nods a little
    const yaw = still ? 0.6 : t * 0.045 + ex * 0.35, pitch = 0.42 + Math.sin(t * 0.06) * 0.07 + ey * 0.15;
    const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const project = (p) => {
      const x = p[0] * cyw + p[2] * syw, z0 = -p[0] * syw + p[2] * cyw, y = p[1] * cp - z0 * sp, z = p[1] * sp + z0 * cp, f = D / (D - z);
      return { x: cx + x * R * f, y: cy - y * R * f, z, f };
    };
    const depth = (s) => clamp((s.z + 1.8) / 3.6);
    // the bang: nothing but a point of light for a moment, then everything bursts out, the inner parts first
    const age = t - 0.35;
    const B = (tau, delay) => (still ? 1 : spring(tau - 0.35 - delay));
    const fadeIn = (delay) => (still ? 1 : clamp((age - delay) * 3));
    const gb = B(t, 0), coreR = CORE * R * gb * 1.03;
    const hidden = (s) => s.z < 0 && Math.hypot(s.x - cx, s.y - cy) < coreR; // behind the core
    // the sync wave: every five seconds a ring leaves the core, and what it passes flares
    const since = t < 3.2 ? -1 : (t - 3.2) % 5, wave = since >= 0 && since < 2.6 ? since / 2.6 : -1;
    const front = wave < 0 ? -9 : CORE + ease(wave) * 2.2;
    const boost = (r) => (wave < 0 ? 0 : Math.exp(-(((r - front) / 0.13) ** 2)) * (1 - wave));
    const flare = since >= 0 && since < 0.7 ? 1 - since / 0.7 : 0;
    const glow = (x, y, r, a) => {
      if (r < 1 || a < 0.005) return;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba + a + ')'); g.addColorStop(0.3, rgba + a * 0.35 + ')'); g.addColorStop(1, rgba + '0)');
      ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2); ctx.fillStyle = col;
    };
    const ring = (rr, a) => { // a circle in the plane of the disk
      let prev = null;
      for (let i = 0; i <= 120; i++) {
        const q = (i / 120) * TAU, s = project([Math.cos(q) * rr, 0, Math.sin(q) * rr]);
        if (prev && !hidden(s) && !hidden(prev)) seg(prev.x, prev.y, s.x, s.y, a * (0.3 + 0.7 * depth(s)));
        prev = s;
      }
    };
    // light behind everything: the core's halo, the flash of the bang, the singularity before it
    const soft = dark ? 1 : 0.45;
    glow(cx, cy, CORE * R * gb * 2.6, (0.07 + 0.14 * flare) * soft);
    if (!still && age < 0) { const k = t / 0.35; glow(cx, cy, R * 0.22 * k, 0.9 * k * soft); dot(cx, cy, 2.5 * px * k, k); }
    if (!still && age >= 0 && age < 2) glow(cx, cy, R * (0.2 + age * 1.6), 0.8 * Math.exp(-3 * age) * soft);
    // the stars, three depths drifting at their own speeds as the camera turns
    for (const [sx, sy, ph, z] of STARS) {
      const x = (((sx - yaw * z * 0.08) % 1) + 1) % 1;
      dot(x * w, sy * h - ey * z * 14, 0.4 + 0.5 * z, (0.03 + 0.09 * z * (0.5 + 0.5 * Math.sin(t * (0.8 + z) + ph))) * fadeIn(0.2));
    }
    // the waves: the bang's shock, and the sync wave doubled for a soft edge
    if (!still && age >= 0 && age < 1.4) ring(ease(age / 1.4) * 2.8, 0.7 * (1 - age / 1.4) ** 2);
    if (wave >= 0) { ring(front, 0.55 * (1 - wave) ** 1.5); ring(front * 0.96, 0.25 * (1 - wave) ** 1.5); }
    // the dotted orbits
    for (const [rr, inc, nd] of GUIDES) {
      const b = B(t, 0.15), fi = fadeIn(0.15);
      for (let i = 0; i < 200; i++) {
        const q = (i / 200) * TAU + t * 0.03, s = project(inPlane(Math.cos(q) * rr * b, Math.sin(q) * rr * b, inc, nd));
        if (!hidden(s)) dot(s.x, s.y, 0.6 * px * s.f, (0.04 + 0.14 * depth(s)) * fi + boost(rr) * 0.4);
      }
    }
    // the core: far dots small and faint, near ones larger and bright; it flares as a wave leaves
    const spin = t * 0.16, cs = Math.cos(spin), sn = Math.sin(spin), k0 = CORE * gb, gfi = fadeIn(0);
    for (let i = 0; i < NG; i++) {
      const p = globe[i], s = project([(p[0] * cs + p[2] * sn) * k0, p[1] * k0, (-p[0] * sn + p[2] * cs) * k0]);
      const near = k0 ? clamp((s.z / k0 + 1) / 2) : 1;
      dot(s.x, s.y, (0.4 + 1.05 * near) * px * s.f, (0.05 + 0.5 * near * near) * gfi * (1 + flare));
    }
    // the dust, each grain drawn from where it was a moment ago: a short streak in orbit, a long one in the bang
    const dustAt = (d, tau) => {
      const b = B(tau, d.r * 0.12), rr = d.r * b, a = d.a + (d.arm ? 0.07 : 0.3 * Math.pow(d.r, -1.5)) * tau + (1 - b) * 3.2;
      return [Math.cos(a) * rr, d.y * b, Math.sin(a) * rr];
    };
    for (const d of DUST) {
      const s = project(dustAt(d, t));
      if (hidden(s)) continue;
      const e = project(dustAt(d, t - 0.07));
      const a = (0.05 + 0.2 * depth(s)) * (d.arm ? 1.7 : 0.5) * (0.5 + d.s) * fadeIn(d.r * 0.12) + boost(d.r) * 0.45;
      if (Math.abs(s.x - e.x) + Math.abs(s.y - e.y) > 1.5) seg(e.x, e.y, s.x, s.y, a); else dot(s.x, s.y, 0.5 * px * s.f, a);
    }
    // the nodes and their trails
    const nodeAt = (n, tau) => {
      const b = B(tau, n.r * 0.1 + 0.05), th = n.ph + n.w * tau + (1 - b) * 2.4, rr = n.r * b * (1 + 0.05 * Math.sin(th * 2 + n.ph));
      return inPlane(Math.cos(th) * rr, Math.sin(th) * rr, n.inc, n.node);
    };
    const P = NODES.map((n) => nodeAt(n, t)), S = P.map(project), F = NODES.map((n) => fadeIn(n.r * 0.1 + 0.05)), BO = NODES.map((n) => boost(n.r));
    NODES.forEach((n, i) => {
      let prev = S[i];
      for (let k = 1; k <= 16; k++) {
        const s = project(nodeAt(n, t - k * 0.05));
        if (!hidden(s) && !hidden(prev)) seg(prev.x, prev.y, s.x, s.y, Math.pow(1 - k / 17, 1.8) * (0.08 + 0.35 * depth(s)) * F[i]);
        prev = s;
      }
    });
    // the links: formed while two nodes are close, strongest when closest; signals run along the strong ones, and a
    // spark shows where two nodes all but touch
    const L = 0.62, sparks = [];
    for (let i = 0; i < NODES.length; i++) for (let j = i + 1; j < NODES.length; j++) {
      const d = Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1], P[i][2] - P[j][2]);
      if (d >= L) continue;
      const a = S[i], b = S[j];
      if (hidden(a) || hidden(b)) continue;
      const k = 1 - d / L, f = Math.min(F[i], F[j]), dz = (depth(a) + depth(b)) / 2;
      seg(a.x, a.y, b.x, b.y, k * k * (0.12 + 0.5 * dz) * f * (1 + 2 * Math.min(BO[i], BO[j])));
      if (k > 0.3) {
        const u = (t * 0.45 + ((i * 7 + j * 13) % 17) / 17) % 1;
        dot(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, 1.3 * px * (a.f + b.f) / 2, (k - 0.3) * 1.3 * f * Math.sin(Math.PI * u));
      }
      if (k > 0.85) sparks.push([(a.x + b.x) / 2, (a.y + b.y) / 2, (k - 0.85) / 0.15 * f]);
    }
    const halos = [], rect = canvas.getBoundingClientRect(), hx = px0 - rect.left, hy = py0 - rect.top, reach = 70 * px;
    NODES.forEach((n, i) => {
      const s = S[i];
      if (hidden(s)) return;
      const bo = BO[i] + (still ? 0 : 0.7 * Math.exp(-(((s.x - hx) ** 2 + (s.y - hy) ** 2) / (reach * reach)))), r = (n.hub ? 3 : 1.7) * px * s.f * (1 + 0.9 * bo);
      dot(s.x, s.y, r, (0.35 + 0.6 * depth(s)) * F[i] + bo);
      if (n.hub) halos.push([s.x, s.y, r * (2.5 + 0.35 * Math.sin(t * 1.6 + i)), (0.1 + 0.3 * depth(s)) * F[i] + bo * 0.5]);
      if (bo > 0.2) sparks.push([s.x, s.y, bo * 0.8]);
    });
    for (const [x, y, a] of sparks) glow(x, y, 14 * px, 0.35 * a * soft);
    drawBatches(Math.max(0.7, 0.9 * px));
    for (const [x, y, r, a] of halos) { ctx.globalAlpha = Math.min(1, a); ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke(); }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if (!still) frame = requestAnimationFrame(draw);
  }
  const previewing = () => document.body.classList.contains('loading-preview');
  const run = () => { if (!frame && (!box.classList.contains('gone') || previewing())) { t0 = last = 0; frame = requestAnimationFrame(draw); } };
  if (typeof MutationObserver === 'function') new MutationObserver(run).observe(box, { attributes: true, attributeFilter: ['class'] });
  previewLoading = (on) => { document.body.classList.toggle('loading-preview', on); t0 = last = 0; run(); };
  // Esc ends a preview before anything else hears it
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && previewing()) { e.preventDefault(); e.stopImmediatePropagation(); previewLoading(false); } }, true);
  run();
})();
