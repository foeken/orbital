#!/usr/bin/env node
'use strict';
// What orbital.md/manual still has to take from a release (.agents/skills/orbital-manual/SKILL.md, Publishing). The
// MCP server lists the published manual's files by their SHA-256 at /mcp/health/manual (mcp-server/server.js reads them from
// disk); this holds them against manual/ at a git ref, scenes/ left out as publishing leaves it out.
//   npm run manual-diff [-- <ref>]   (the newest v* tag by default; ORBITAL_MANUAL_HEALTH for another MCP server)
// It prints the files to copy and the ones the site has that the ref does not, and exits 1 while there are any.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { manualDigest } = require('../mcp-server/server');

const git = (args, input) => execFileSync('git', args, { input, maxBuffer: 1 << 30 });
const ref = process.argv[2] || git(['tag', '--list', 'v*', '--sort=-v:refname']).toString().split('\n')[0];
const url = process.env.ORBITAL_MANUAL_HEALTH || 'https://orbital.md/mcp/health/manual';

// manual/ at the ref, by path inside the manual, each blob's bytes read once through one cat-file
function local() {
  const entries = git(['ls-tree', '-r', '-z', ref, '--', 'manual']).toString().split('\0').filter(Boolean)
    .map((line) => { const [meta, file] = line.split('\t'); return { blob: meta.split(' ')[2], name: file.slice('manual/'.length) }; })
    .filter((e) => !e.name.startsWith('scenes/'));
  const out = git(['cat-file', '--batch'], entries.map((e) => e.blob).join('\n') + '\n');
  const files = {};
  let at = 0;
  for (const e of entries) {
    const header = out.indexOf(10, at), size = Number(out.subarray(at, header).toString().split(' ')[2]);
    files[e.name] = crypto.createHash('sha256').update(out.subarray(header + 1, header + 1 + size)).digest('hex');
    at = header + 1 + size + 1;
  }
  return files;
}

(async () => {
  const want = local(), names = Object.keys(want).sort();
  const res = await fetch(url);
  if (!res.ok) { console.error('manual-diff: ' + url + ' answered ' + res.status); process.exit(2); }
  const live = (await res.json()).files;
  const copy = names.filter((n) => live[n] !== want[n]), extra = Object.keys(live).filter((n) => !(n in want)).sort();
  for (const n of copy) console.log((n in live ? 'changed ' : 'missing ') + 'manual/' + n);
  for (const n of extra) console.log('extra   manual/' + n);
  const sha = manualDigest(names.map((n) => [n, want[n]]));
  console.log(copy.length || extra.length
    ? copy.length + ' to copy and ' + extra.length + ' extra against ' + ref + ' (' + sha.slice(0, 12) + ')'
    : 'orbital.md/manual is ' + ref + ': ' + names.length + ' files, ' + sha.slice(0, 12));
  process.exit(copy.length || extra.length ? 1 : 0);
})();
