#!/usr/bin/env node
'use strict';
// manual/search-index.js from the chapters' headings (what ⌘K in the manual searches). With --coverage it also reports
// every Cmd+K row label in renderer/ that no chapter mentions, links to a page or anchor that is not there, pictures a
// page names that are missing in a theme, figures manual.js does not frame, and pictures no page uses; it exits 1 on a
// broken link, a missing picture or an unframed figure.
// Run after editing a chapter:
//   node manual/scenes/index.js [--coverage]
const fs = require('fs'), path = require('path');
const dir = path.resolve(__dirname, '..'), root = path.resolve(dir, '..');
const src = fs.readFileSync(path.join(dir, 'manual.js'), 'utf8');
const chapters = [...src.matchAll(/\['([a-z-]+)', '([^']+)'\]/g)].map((m) => [m[1], m[2]]);
const decode = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, '’').replace(/&hellip;/g, '…').replace(/\s+/g, ' ').trim();
const slug = (s) => s.toLowerCase().replace(/⌘/g, 'cmd').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const index = [], text = {};
for (const [c, ct] of chapters) {
  const f = path.join(dir, c + '.html');
  if (!fs.existsSync(f)) { console.warn('missing chapter', c); continue; }
  const html = fs.readFileSync(f, 'utf8');
  text[c] = decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/g, ''));
  index.push({ c, ct, t: ct, id: '' });
  for (const m of html.matchAll(/<(h2|h3)([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const attrs = m[2], inner = m[3], id = (/\bid="([^"]+)"/.exec(attrs) || [])[1] || slug(decode(inner));
    const key = [...inner.matchAll(/<kbd>([^<]+)<\/kbd>/g)].map((k) => k[1]).join(' ');
    const k = (/\bdata-k="([^"]+)"/.exec(attrs) || [])[1];
    index.push({ c, ct, t: decode(inner.replace(/<kbd>[^<]*<\/kbd>/g, '')), id, ...(key ? { key } : {}), ...(k ? { k } : {}) });
  }
}
fs.writeFileSync(path.join(dir, 'search-index.js'), '// Made by manual/scenes/index.js from the chapters\' headings: what ⌘K in the manual searches.\nwindow.MANUAL_INDEX = ' + JSON.stringify(index) + ';\n');
console.log(index.length + ' entries in manual/search-index.js');
if (process.argv.includes('--coverage')) {
  const all = Object.values(text).join(' ').toLowerCase();
  const labels = new Set();
  for (const f of fs.readdirSync(path.join(root, 'renderer'))) {
    const s = fs.readFileSync(path.join(root, 'renderer', f), 'utf8');
    for (const m of s.matchAll(/label: '([^'\\]{3,})'/g)) if (!/^(Sample|Mock|mock)/.test(m[1])) labels.add(m[1].replace(/ …$/, '').replace(/…$/, ''));
  }
  const missing = [...labels].filter((l) => !all.includes(l.toLowerCase()));
  console.log(missing.length + ' of ' + labels.size + ' Cmd+K labels not mentioned:\n' + missing.join('\n'));
  // links and pictures
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html')), media = new Set(fs.readdirSync(path.join(dir, 'media'))), used = new Set(['app-icon.png']), broken = [];
  for (const f of pages) {
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const [, file, anchor] of html.matchAll(/<a\b[^>]*href="([^"#:]*)(?:#([^"]*))?"/g)) {
      const to = file || f;
      if (!pages.includes(to)) broken.push(f + ': no page ' + to);
      else if (anchor && !index.some((e) => e.c + '.html' === to && e.id === anchor) && !fs.readFileSync(path.join(dir, to), 'utf8').includes('id="' + anchor + '"')) broken.push(f + ': no #' + anchor + ' in ' + to);
    }
    for (const [tag, name] of [...html.matchAll(/<(img|video)[^>]*data-m="([^"]+)"/g)].map((m) => [m[1], m[2]])) for (const theme of ['light', 'dark']) {
      const pic = name + '-' + theme + (tag === 'video' ? '.mp4' : '.webp'); used.add(pic);
      if (!media.has(pic)) broken.push(f + ': no media/' + pic);
    }
    // manual.js frames only figure.shot, .clip and .anno; any other figure draws its picture at full pixel size,
    // twice the page's width and more (start.html #phone did)
    for (const [, attrs, inner] of html.matchAll(/<figure\b([^>]*)>([\s\S]*?)<\/figure>/g)) {
      if (/data-m="/.test(inner) && !/\bclass="[^"]*\b(shot|clip|anno)\b/.test(attrs)) broken.push(f + ': figure ' + /data-m="([^"]+)"/.exec(inner)[1] + ' is not a shot, clip or anno');
    }
  }
  const unused = [...media].filter((m) => !used.has(m));
  console.log((broken.length ? 'broken:\n' + broken.join('\n') : 'no broken links or missing pictures') + '\n' + (unused.length ? 'unused pictures: ' + unused.join(' ') : 'no unused pictures'));
  if (broken.length) process.exitCode = 1;
}
