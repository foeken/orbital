'use strict';
// Loading (Ambient): what the content area shows while a view's rows are on their way (render.js toggles #skeleton's
// .gone). A globe of dots turns slowly, the near side bright and the far side sunk into depth; arcs of a knowledge
// graph rise off its surface and join, one after another, each with a bright head as it travels; a tilted ring of dots
// orbits it with two moons, passing behind it; stars twinkle faintly behind. On arrival the globe gathers into shape.
// One colour, at many strengths (styles.css .skeleton canvas), so it is monochrome in either theme. Drawn only while on
// screen; one still frame, graph complete, where motion is not welcome.
// Cmd+K "Preview loading animation" shows it over the page until Esc (body.loading-preview, styles.css): a load is
// usually over before there is anything to see.
let previewLoading = () => {};
(() => {
  const box = document.getElementById('skeleton'), canvas = box && box.querySelector && box.querySelector('canvas');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const TAU = Math.PI * 2, clamp = (v) => Math.max(0, Math.min(1, v)), ease = (v) => 1 - Math.pow(1 - clamp(v), 3);
  // the globe: points spread evenly over a unit sphere (a Fibonacci lattice)
  const N = 1500, GOLD = Math.PI * (3 - Math.sqrt(5));
  const globe = Array.from({ length: N }, (_, i) => { const y = 1 - ((i + 0.5) * 2) / N, r = Math.sqrt(1 - y * y), a = i * GOLD; return [Math.cos(a) * r, y, Math.sin(a) * r]; });
  // the stars: fixed places in the frame, each with its own twinkle
  const STARS = Array.from({ length: 140 }, (_, i) => [((i * 0.6180339887) % 1), ((i * 0.7548776662 + 0.31) % 1), (i * 2.399963) % TAU]);
  // Each cycle grows a different graph, the same one all the way through the cycle: a seeded choice of nodes on the
  // globe, each tied to its nearest earlier node (a tree growing outwards), and a few chords across it.
  const CYCLE = 13, START = 1.2, STEP = 0.5, GROW = 1.1;
  const seeded = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const graphs = new Map();
  function graphFor(n) {
    if (graphs.has(n)) return graphs.get(n);
    const rnd = seeded(n * 7919 + 17), nodes = Array.from({ length: 15 }, () => globe[Math.floor(rnd() * N)]), links = [];
    for (let i = 1; i < nodes.length; i++) { let best = 0; for (let j = 1; j < i; j++) if (dist(nodes[i], nodes[j]) < dist(nodes[i], nodes[best])) best = j; links.push([best, i]); }
    for (let k = 0; k < 6; k++) { const a = Math.floor(rnd() * nodes.length), b = Math.floor(rnd() * nodes.length); if (a !== b && dist(nodes[a], nodes[b]) < 1.1) links.push([a, b]); } // chords between neighbours only: a link round the far side reads as a stray loop
    graphs.clear(); graphs.set(n, { nodes, links });
    return graphs.get(n);
  }
  // a point on the arc between two points of the globe, lifted off it a little more the further apart they are
  function arcPoint(u, v, s) {
    const d = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]))) || 1e-6, k = Math.sin(d);
    const a = Math.sin((1 - s) * d) / k, b = Math.sin(s * d) / k, lift = 1 + 0.16 * Math.min(d, 1.2) * Math.sin(Math.PI * s);
    return [(a * u[0] + b * v[0]) * lift, (a * u[1] + b * v[1]) * lift, (a * u[2] + b * v[2]) * lift];
  }
  let frame = 0, t0 = 0;
  function draw(now) {
    frame = 0;
    if (typeof box.checkVisibility === 'function' && !box.checkVisibility()) return; // gone: the next .gone change starts it again
    const still = typeof stillPreferred === 'function' && stillPreferred();
    if (!t0) t0 = now;
    const t = still ? 9 : (now - t0) / 1000;
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) { frame = requestAnimationFrame(draw); return; }
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = ctx.strokeStyle = getComputedStyle(canvas).color;
    const arrive = still ? 1 : ease(t / 1.6); // the globe gathers from a tighter, fainter cloud on arrival
    const R = Math.min(w, h) * 0.3 * (0.82 + 0.18 * arrive), cx = w / 2, cy = h * 0.5, D = 3.4, px = R / 260; // px: a dot's size follows the globe's
    // the globe turns about its axis, the axis tilted towards you and swaying a little
    const spin = t * 0.11, tilt = 0.38 + Math.sin(t * 0.07) * 0.06, cs = Math.cos(spin), sn = Math.sin(spin), ct = Math.cos(tilt), st = Math.sin(tilt);
    const turn = (p) => { const x = p[0] * cs + p[2] * sn, z = -p[0] * sn + p[2] * cs; return [x, p[1] * ct - z * st, p[1] * st + z * ct]; };
    const project = (q) => { const f = D / (D - q[2]); return { x: cx + q[0] * R * f, y: cy - q[1] * R * f, z: q[2], f }; };
    const hidden = (s) => s.z < 0 && Math.hypot(s.x - cx, s.y - cy) < R * 1.02; // behind the globe
    // the stars
    for (const [sx, sy, ph] of STARS) {
      ctx.globalAlpha = (0.05 + 0.07 * (0.5 + 0.5 * Math.sin(t * 1.3 + ph))) * arrive;
      ctx.fillRect(sx * w, sy * h, 1.2, 1.2);
    }
    // the ring and its moons: behind the globe first, then the globe, then what passes in front of it
    const ringTilt = 1.18, ringRoll = 0.32, rr = 1.62;
    const ringAt = (a) => { const x = Math.cos(a) * rr, z = Math.sin(a) * rr, y1 = -z * Math.sin(ringTilt), z1 = z * Math.cos(ringTilt); return project([x * Math.cos(ringRoll) - y1 * Math.sin(ringRoll), x * Math.sin(ringRoll) + y1 * Math.cos(ringRoll), z1]); };
    const moons = [t * 0.42, t * 0.42 + 2.6].map((a) => a);
    const drawRing = (front) => {
      for (let i = 0; i < 240; i++) {
        const s = ringAt((i / 240) * TAU + t * 0.05);
        if ((s.z >= 0) !== front || hidden(s)) continue;
        ctx.globalAlpha = (0.08 + 0.22 * clamp((s.z + 1.6) / 3.2)) * arrive;
        ctx.fillRect(s.x - 0.6, s.y - 0.6, 1.2, 1.2);
      }
      for (const a of moons) for (let k = 0; k < 9; k++) { // each moon with a short trail behind it
        const s = ringAt(a - k * 0.035);
        if ((s.z >= 0) !== front || hidden(s)) continue;
        ctx.globalAlpha = (k ? 0.35 * (1 - k / 9) : 0.9) * arrive;
        ctx.beginPath(); ctx.arc(s.x, s.y, (k ? 1.6 : 3.2) * px * s.f, 0, TAU); ctx.fill();
      }
    };
    drawRing(false);
    // the globe: far dots small and faint, near ones larger and bright
    for (let i = 0; i < N; i++) {
      const s = project(turn(globe[i])), near = (s.z + 1) / 2;
      const gather = still ? 1 : ease((t - 0.1 - (i % 40) * 0.012) / 1.2); // the dots settle in a sweep, not all at once
      if (!gather) continue;
      ctx.globalAlpha = (0.05 + 0.5 * near * near) * gather;
      const r = (0.5 + 1.25 * near) * px * s.f;
      if (r < 1.1) ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2); else { ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, TAU); ctx.fill(); }
    }
    // the graph: links grow one after another from the nodes they start at, each lifted off the surface, with a bright
    // head while it travels; nodes light as a link reaches them; the whole of it fades at the end of the cycle
    const n = still ? 0 : Math.floor(t / CYCLE), c = still ? CYCLE - 2 : t % CYCLE, fade = still ? 1 : clamp((CYCLE - c) / 1.5) * clamp(c / 0.5);
    const { nodes, links } = graphFor(n), lit = nodes.map(() => 0);
    ctx.lineWidth = Math.max(0.8, 1.1 * px); ctx.lineCap = 'round';
    links.forEach(([a, b], i) => {
      const grow = ease((c - START - i * STEP) / GROW);
      if (!grow) return;
      lit[a] = 1; if (grow > 0.95) lit[b] = 1;
      let prev = null;
      for (let k = 0; k <= 32; k++) {
        const sp = k / 32;
        if (sp > grow) break;
        const s = project(turn(arcPoint(nodes[a], nodes[b], sp)));
        if (prev && !hidden(s) && !hidden(prev)) {
          ctx.globalAlpha = (0.12 + 0.5 * clamp((s.z + 1) / 2)) * fade;
          ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(s.x, s.y); ctx.stroke();
        }
        prev = s;
      }
      if (grow < 1 && prev && !hidden(prev)) { ctx.globalAlpha = fade; ctx.beginPath(); ctx.arc(prev.x, prev.y, 2.4 * px * prev.f, 0, TAU); ctx.fill(); }
    });
    nodes.forEach((p, i) => {
      if (!lit[i]) return;
      const s = project(turn(p));
      if (hidden(s) || s.z < -0.2) return;
      const near = (s.z + 1) / 2, r = (2 + 1.8 * near) * px * s.f;
      ctx.globalAlpha = (0.35 + 0.6 * near) * fade; ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, TAU); ctx.fill();
      ctx.globalAlpha = 0.25 * near * fade; ctx.beginPath(); ctx.arc(s.x, s.y, r * 2.4 + (still ? 0 : Math.sin(t * 2 + i) * px), 0, TAU); ctx.stroke(); // a ring around it
    });
    drawRing(true);
    ctx.globalAlpha = 1;
    if (!still) frame = requestAnimationFrame(draw);
  }
  const previewing = () => document.body.classList.contains('loading-preview');
  const run = () => { if (!frame && (!box.classList.contains('gone') || previewing())) { t0 = 0; frame = requestAnimationFrame(draw); } };
  if (typeof MutationObserver === 'function') new MutationObserver(run).observe(box, { attributes: true, attributeFilter: ['class'] });
  previewLoading = (on) => { document.body.classList.toggle('loading-preview', on); t0 = 0; run(); };
  // Esc ends a preview before anything else hears it
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && previewing()) { e.preventDefault(); e.stopImmediatePropagation(); previewLoading(false); } }, true);
  run();
})();
