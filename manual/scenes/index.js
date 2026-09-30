#!/usr/bin/env node
'use strict';
// manual/search-index.js from the chapters' headings (what ⌘K in the manual searches), and a coverage report: every
// Cmd+K row label in renderer/ that no chapter mentions. Run after editing a chapter:
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
}

