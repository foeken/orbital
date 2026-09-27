'use strict';
// node scripts/tana-log.js [name.js ...]: a log of Tana's web client, to see what a deploy changed.
// It fetches every JS file home.tana.inc's index.html reaches (or, given names like shared-rlpSpfd9.js, what those
// reach: an older build stays served under its old names) and compares the build with the last one logged.
// The log is .tana-log/ in the main checkout, whichever worktree runs this. It is gitignored, and
// scripts/package.js's ignore keeps it out of the app:
//   assets/<name>    every file once: the names are content hashes, so a name never changes content
//   snapshots.jsonl  one line per build seen: { at, build, files }
//   CHANGELOG.md     per new build: chunk names that came or went, protobuf descriptor changes, and the string
//                    literals and property names that came or went (minifying renames variables, never these)
// Nothing is written when the build is the one logged last.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const acorn = require('acorn'); // eslint's parser, already installed
const { fromBinary } = require('@bufbuild/protobuf');
const { FileDescriptorProtoSchema } = require('@bufbuild/protobuf/wkt');

const ORIGIN = 'https://home.tana.inc/';
const main = (() => {
  try { return path.dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: __dirname, encoding: 'utf8' }).trim()); } catch { return path.join(__dirname, '..'); }
})();
const LOG = path.join(main, '.tana-log'), ASSETS = path.join(LOG, 'assets');
const SNAPSHOTS = path.join(LOG, 'snapshots.jsonl'), CHANGELOG = path.join(LOG, 'CHANGELOG.md');
const REF = /(?:assets\/|\.\/)([\w~.-]+-[\w-]{8}\.js)(?=["'`])/g; // "/assets/x-hash.js" in the html, "./x-hash.js" in a chunk
// What changes with every build and says nothing: chunk names, css module classes, Sentry's per-build debug ids.
const NOISE = /^(?:\.\/|assets\/)[\w~.-]+\.(?:js|css)$|^_[\w-]+_[a-z0-9]{5}_\d+$|^(?:sentry-dbid-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const base = (name) => name.replace(/-[\w-]{8}\.js$/, '');

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status + ' ' + url);
  return res.text();
}

// Every JS file the roots reach, fetched once per name.
async function crawl(roots) {
  const seen = new Set(), failed = new Set();
  let queue = roots;
  while (queue.length) {
    const batch = queue.filter((n) => !seen.has(n) && seen.add(n));
    queue = [];
    await Promise.all(batch.map(async (name) => {
      const file = path.join(ASSETS, name);
      let src;
      if (fs.existsSync(file)) src = fs.readFileSync(file, 'utf8');
      else {
        try { src = await get(ORIGIN + 'assets/' + name); } catch (e) { failed.add(name); console.warn('skipped', e.message); return; }
        fs.writeFileSync(file, src);
      }
      for (const m of src.matchAll(REF)) queue.push(m[1]);
    }));
  }
  return [...seen].filter((n) => !failed.has(n)).sort();
}

const TYPES = ['', 'double', 'float', 'int64', 'uint64', 'int32', 'fixed64', 'fixed32', 'bool', 'string', 'group', 'message', 'bytes', 'uint32', 'enum', 'sfixed32', 'sfixed64', 'sint32', 'sint64'];
// A descriptor as flat "kind name" → shape entries, so two builds compare key by key.
function flatProto(d, out) {
  const msg = (m, at) => {
    const n = at + '.' + m.name;
    out['message ' + n] = '';
    for (const f of m.field) {
      // protobuf-es fills an unset oneofIndex with 0, so only an index actually on the wire marks a oneof member.
      const oneof = Object.hasOwn(f, 'oneofIndex') && !f.proto3Optional ? ' oneof ' + m.oneofDecl[f.oneofIndex].name : '';
      out['field ' + n + '.' + f.name] = '#' + f.number + ' ' + (f.label === 3 ? 'repeated ' : f.proto3Optional ? 'optional ' : '') + (f.typeName || TYPES[f.type]) + oneof;
    }
    m.enumType.forEach((e) => en(e, n));
    m.nestedType.forEach((x) => msg(x, n));
  };
  const en = (e, at) => {
    out['enum ' + at + '.' + e.name] = '';
    for (const v of e.value) out['value ' + at + '.' + e.name + '.' + v.name] = '= ' + v.number;
  };
  d.messageType.forEach((m) => msg(m, d.package));
  d.enumType.forEach((e) => en(e, d.package));
  for (const s of d.service) {
    out['service ' + d.package + '.' + s.name] = '';
    for (const m of s.method) out['rpc ' + d.package + '.' + s.name + '.' + m.name] = m.inputType + ' -> ' + m.outputType + (m.serverStreaming ? ' (stream)' : '');
  }
}

// What minifying leaves alone: string literals, property names and the embedded protobuf descriptors.
function facts(files) {
  const strings = new Set(), props = new Set(), proto = {};
  for (const name of files) {
    let ast;
    try { ast = acorn.parse(fs.readFileSync(path.join(ASSETS, name), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' }); } catch (e) { console.warn('unparsed', name, e.message); continue; }
    const stack = [ast];
    while (stack.length) {
      const n = stack.pop();
      if (n.type === 'Literal' && typeof n.value === 'string') strings.add(n.value);
      else if (n.type === 'TemplateElement' && n.value.cooked) strings.add(n.value.cooked);
      else if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier') props.add(n.property.name);
      else if (/^(Property|PropertyDefinition|MethodDefinition)$/.test(n.type) && !n.computed) props.add(String(n.key.name ?? n.key.value));
      for (const k in n) {
        const v = n[k];
        if (Array.isArray(v)) { for (const c of v) if (c && c.type) stack.push(c); } else if (v && typeof v.type === 'string') stack.push(v);
      }
    }
  }
  for (const s of strings) {
    if (!/^C[A-Za-z0-9+/=]{80,}$/.test(s)) continue; // a serialized FileDescriptorProto starts with field 1, its name
    try {
      const d = fromBinary(FileDescriptorProtoSchema, Buffer.from(s, 'base64'));
      if (d.name.endsWith('.proto')) { flatProto(d, proto); strings.delete(s); }
    } catch { /* base64 that is not a descriptor */ }
  }
  return { strings, props, proto };
}

const minus = (a, b) => [...a].filter((x) => !b.has(x)).sort();
const clip = (s) => JSON.stringify(s.length > 200 ? s.slice(0, 200) + '…' : s);
const block = (title, lines) => lines.length ? `${title} (${lines.length}):\n\n\`\`\`text\n${lines.join('\n')}\n\`\`\`\n\n` : '';

function entry(prev, cur) {
  const a = facts(prev.files), b = facts(cur.files);
  const names = (x) => new Set(x.files.map(base)), added = minus(names(cur), names(prev)), gone = minus(names(prev), names(cur));
  const proto = [...new Set([...Object.keys(a.proto), ...Object.keys(b.proto)])].sort().flatMap((k) =>
    !(k in a.proto) ? ['+ ' + k + ' ' + b.proto[k]] : !(k in b.proto) ? ['- ' + k + ' ' + a.proto[k]] : a.proto[k] !== b.proto[k] ? ['~ ' + k + ' ' + a.proto[k] + ' => ' + b.proto[k]] : []);
  const strings = (x, y) => minus(x.strings, y.strings).filter((s) => !NOISE.test(s)).map(clip);
  const plus = strings(b, a), less = strings(a, b), propsPlus = minus(b.props, a.props), propsLess = minus(a.props, b.props);
  const md = `## ${new Date(cur.at).toLocaleString('sv-SE')} · ${prev.build} → ${cur.build}\n\n` +
    `${cur.files.length} files, ${cur.files.filter((f) => !prev.files.includes(f)).length} of them new.` +
    (added.length ? ` Chunks added: ${added.join(', ')}.` : '') + (gone.length ? ` Chunks gone: ${gone.join(', ')}.` : '') + '\n\n' +
    (proto.length ? block('Protobuf', proto) : 'Protobuf: no change.\n\n') +
    block('Strings added', plus) + block('Strings removed', less) +
    (propsPlus.length ? `Properties added: ${propsPlus.join(' ')}\n\n` : '') + (propsLess.length ? `Properties removed: ${propsLess.join(' ')}\n\n` : '');
  return { md, summary: `protobuf ${proto.length ? proto.length + ' changes' : 'unchanged'}, strings +${plus.length} -${less.length}, properties +${propsPlus.length} -${propsLess.length}` };
}

(async () => {
  fs.mkdirSync(ASSETS, { recursive: true });
  const args = process.argv.slice(2);
  const roots = args.length ? args : [...(await get(ORIGIN)).matchAll(REF)].map((m) => m[1]);
  const files = await crawl(roots);
  if (!files.length) throw new Error('no JS found from ' + (args.join(' ') || ORIGIN));
  const cur = { at: new Date().toISOString(), build: files.find((f) => f.startsWith('shared-')) || files[0], files };
  const last = fs.existsSync(SNAPSHOTS) ? fs.readFileSync(SNAPSHOTS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).pop() : null;
  if (last && last.files.join() === files.join()) return console.log(`unchanged since ${last.at}: ${last.build}`);
  const { md, summary } = last ? entry(last, cur) : { md: `## ${new Date(cur.at).toLocaleString('sv-SE')} · ${cur.build}\n\nFirst snapshot: ${files.length} files.\n\n`, summary: 'first snapshot' };
  fs.appendFileSync(SNAPSHOTS, JSON.stringify(cur) + '\n');
  fs.appendFileSync(CHANGELOG, md);
  console.log(`${cur.build}: ${files.length} files, ${summary} → ${CHANGELOG}`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
