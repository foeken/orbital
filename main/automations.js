'use strict';
// Automations, the first kind of extension. The shape and the words are n8n's, cut to what one outliner needs:
//
//   automation = { v, id, name, description, enabled, createdAt,
//                  trigger: node,             what starts it: a node added that matches a filter (below)
//                  nodes: [ node ] }          what it does, in order
//   node       = { name, type, typeVersion, parameters, then?, else? }
//   execution  = one run of an automation on one Tana node, with what each of its nodes did
//
// - type is the integration (tana, ai, orbital) or flow (if); parameters.resource + parameters.operation pick what
//   it does, as in n8n. A new integration is one more entry in TYPES.
// - typeVersion is per node: an operation that has to change gets version 2 beside version 1, and automations
//   written against 1 keep running on 1. That is what lets the base grow without breaking what exists.
// - A node's output is read later by its name: { node: 'Who' } (n8n's $('Who')). A value is an expression: a
//   literal, { ref: 'item.title' } for the Tana node that triggered it, { node: name }, or { ai: question }.
// - Every tana operation acts on parameters.target, which defaults to the Tana node that triggered the run.
// - Only AI writes automations (ai.draftAutomation, from a description); invalid() is the gate every draft passes.
// ("node" is n8n's word for a step. The Tana node an automation runs on is called the item here.)
const VERSION = 1;
const STATES = ['proposed', 'open', 'closed', 'not_now'];
const text = (x, max = 500) => typeof x === 'string' && x.length > 0 && x.length <= max;
// An AI question runs on the FAST model unless it says model: 'smart' (main/ai.js FAST/SMART).
const MODELS = ['fast', 'smart'];
const linkOk = (p) => Array.isArray(p.types) && p.types.length > 0 && p.types.length <= 10 && p.types.every((t) => text(t, 100)) && (p.match === undefined || ['exact', 'unique', 'loose'].includes(p.match));
// A value that went through text.link is a list of segments ({ text } or { mention }); where only words make sense
// (a line, a notification) it is read as the words it shows.
const plain = (v) => (Array.isArray(v) ? v.map((s) => (s.mention ? s.mention.label : s.text || '')).join('') : String(v ?? ''));
const modelOk = (m) => m === undefined || MODELS.includes(m);
const expr = (x) => typeof x === 'string' || (x && typeof x === 'object' && (text(x.ref, 100) || text(x.node, 80) || (text(x.ai) && modelOk(x.model))));

// type -> typeVersion -> 'resource.operation' -> { check(parameters), run(ctx, parameters) }. io is the app.
const TYPES = {
  tana: { 1: {
    'item.setState': { check: (p) => STATES.includes(p.state), run: (ctx, p) => ctx.io.setState(target(ctx, p), p.state) },
    'item.setType': { check: (p) => text(p.typeName, 100), run: (ctx, p) => ctx.io.setType(target(ctx, p), p.typeName) },
    'item.addLine': { check: (p) => expr(p.text), run: async (ctx, p) => ctx.io.addLine(target(ctx, p), plain(await value(ctx, p.text))) },
    // writes the value as it is: words, or the segments a text.link step produced
    'field.set': { check: (p) => text(p.field, 100) && expr(p.value) && p.link === undefined, run: async (ctx, p) => { const v = await value(ctx, p.value); return ctx.io.setField(target(ctx, p), p.field, Array.isArray(v) ? v : plain(v)); } },
    // names in a text become references to nodes of these Tana types ("Person" = the people here); the output is the
    // linked text, for a later step to write. match: exact | unique (default) | loose, see documents.linkNames.
    'text.link': { check: (p) => expr(p.text) && linkOk(p), run: async (ctx, p) => ctx.io.link(plain(await value(ctx, p.text)), p.types, p.match || 'unique') },
  } },
  ai: { 1: {
    'text.extract': { check: (p) => text(p.ask) && modelOk(p.model), run: (ctx, p) => ctx.io.extract(p.ask, ctx.item, p.model || 'fast') },
    'text.judge': { check: (p) => text(p.ask) && modelOk(p.model), run: (ctx, p) => ctx.io.judge(p.ask, ctx.item, p.model || 'fast') },
  } },
  orbital: { 1: {
    'user.notify': { check: (p) => expr(p.text), run: async (ctx, p) => ctx.io.notify(ctx.item.id, ctx.automation.name, plain(await value(ctx, p.text))) },
  } },
};
const IF = { check: (p, n) => expr(p.condition) && Array.isArray(n.then) && (!n.else || Array.isArray(n.else)), flow: true };
const operationOf = (n) => {
  if (!n || typeof n !== 'object') return null;
  if (n.type === 'if') return n.typeVersion === 1 ? IF : null;
  const p = n.parameters || {};
  return TYPES[n.type]?.[n.typeVersion]?.[p.resource + '.' + p.operation] || null;
};
const target = (ctx, p) => (p.target ? ctx.outputs[p.target.node] || p.target : ctx.item.id);

// An expression's value. { ai } asks a yes/no question in a condition and extracts a value anywhere else.
async function value(ctx, x, asCondition = false) {
  if (typeof x === 'string') return x;
  if (x.node) return ctx.outputs[x.node];
  if (x.ref) return x.ref.split('.').reduce((o, k) => (o == null ? o : o[k]), { item: ctx.item });
  return asCondition ? ctx.io.judge(x.ai, ctx.item, x.model || 'fast') : ctx.io.extract(x.ai, ctx.item, x.model || 'fast');
}

// ---- the trigger: a node was added that matches a filter ----
//   trigger = { type: 'tana.nodeAdded', typeVersion: 1, parameters: { filter, typeNames? } }
//   filter: live query fields (sdk/livequery.js LISTS/SCALARS) the new node must match; 'me' in assignedTo, createdBy or
//     stateChangedBy is you. Required, and it has to narrow something (it or typeNames), so an automation never runs
//     on every node anyone makes.
//   typeNames: Tana type titles, resolved to entityTypeUris when the query opens.
// Underneath it is a live query with createdAtMin at the automation's creation: Tana pushes every new match, wherever
// it was made. Nothing is polled. When it runs is decided below (schedule): once the node is done.
const LIVE = require('../sdk/livequery');
const narrows = (p) => (p.typeNames || []).length > 0 || Object.values(p.filter || {}).some((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== false));
function badTrigger(t) {
  const p = t && t.parameters || {}, f = p.filter;
  if (!t || t.type !== 'tana.nodeAdded' || t.typeVersion !== 1) return 'trigger must be tana.nodeAdded v1';
  if (!f || typeof f !== 'object' || Array.isArray(f)) return 'trigger needs a filter';
  for (const [key, v] of Object.entries(f)) {
    if (key === 'createdAtMin') return 'createdAtMin is set by the app';
    if (LIVE.LISTS.includes(key)) { if (!Array.isArray(v) || v.length > 50 || !v.every((x) => text(String(x), 200))) return 'bad filter list ' + key; }
    else if (LIVE.SCALARS.includes(key)) { if (!['number', 'boolean'].includes(typeof v)) return 'bad filter value ' + key; }
    else return 'unknown filter field ' + key;
  }
  if (f.stateTypes && !f.stateTypes.every((s) => STATES.includes(s))) return 'unknown state in filter';
  if (p.typeNames !== undefined && (!Array.isArray(p.typeNames) || !p.typeNames.every((n) => text(n, 100)))) return 'bad typeNames';
  if (!narrows(p)) return 'the filter must narrow which nodes it runs on';
  return null;
}
// The live query an automation listens to: its filter, plus the floor that keeps it to nodes made after it.
async function queryOf(a, io) {
  const p = a.trigger.parameters, q = {};
  for (const [key, v] of Object.entries(p.filter)) q[key] = Array.isArray(v) ? v.map((x) => (x === 'me' ? io.me() : x)) : v;
  if (p.typeNames) q.entityTypeUris = [...(q.entityTypeUris || []), ...(await Promise.all(p.typeNames.map(io.typeUri)))];
  q.createdAtMin = Date.parse(a.createdAt || 0) || 0;
  q.orderBy ||= ['-createdAt'];
  q.limit ??= 200; // ponytail: newest 200 since the automation was made; the fired record covers what scrolls out
  return q;
}
// null = valid; else the reason, shown with the draft instead of running it.
function invalid(a) {
  if (!a || a.v !== VERSION) return 'unknown automation version';
  if (!text(a.name, 120)) return 'missing name';
  const why = badTrigger(a.trigger);
  if (why) return why;
  const names = new Set();
  const bad = (nodes, depth) => {
    if (!Array.isArray(nodes) || !nodes.length) return 'no nodes';
    if (depth > 4) return 'nested too deep';
    for (const n of nodes) {
      const op = operationOf(n);
      if (!op || !op.check(n.parameters || {}, n)) return 'bad node ' + JSON.stringify(n);
      if (n.name) { if (names.has(n.name)) return 'two nodes named ' + n.name; names.add(n.name); }
      if (op.flow) { const why = bad(n.then, depth + 1) || (n.else && bad(n.else, depth + 1)); if (why) return why; }
    }
    return null;
  };
  return bad(a.nodes, 0);
}

async function runNodes(ctx, nodes, log) {
  for (const n of nodes) {
    const op = operationOf(n), p = n.parameters || {};
    const entry = { name: n.name || n.type, ok: true };
    log.push(entry);
    let branch = null;
    try {
      if (op.flow) { entry.output = !!(await value(ctx, p.condition, true)); branch = entry.output ? n.then : n.else || []; }
      else { entry.output = (await op.run(ctx, p)) ?? null; if (n.name) ctx.outputs[n.name] = entry.output; }
    } catch (e) {
      entry.ok = false; entry.error = String(e && e.message || e);
      throw e; // a failed node stops its execution, never another automation's
    }
    if (branch) await runNodes(ctx, branch, log); // outside the try: a node failing in a branch is that node's failure
  }
}

const fired = new Set(); // in-memory stand-in when the app hands in no store (tests)
const executions = []; // newest first, the last 100 (n8n's executions list)
const keyOf = (a, row) => a.id + '|' + row.uri + '|added'; // one run per automation and node
const itemOf = (row, io) => ({ id: row.uri, title: row.title || '', stateType: row.state && row.state.type, entityTypeUri: row.entityType,
  typeTitle: row.entityType && io.typeTitle ? io.typeTitle(row.entityType) : undefined, createdAt: row.createdAt });
// A new node runs once it is done, and "done" is two things:
//  1. quiet: no change to its title, state, type or assignees for io.settleMs. This covers a node typed where no
//     presence is shared (Orbital's own editor, today; issue #14).
//  2. nobody has a caret in it (sdk/presence.js editing()): whoever is typing in Tana has left it, or gone idle long
//     enough for their entry to expire. The presence channel opens as soon as the node is seen, so by the time it is
//     quiet the editor's entry has had every keystroke to arrive on.
// io.maxWaitMs caps the wait, so a node left open in someone's tab still runs. A node still untitled when it would run
// is left alone; the change that gives it a title schedules it again.
// ponytail: an editor who sits perfectly still and whose entry the server does not replay to a late subscriber is
// only seen once they refresh it (within the store's 30 s timeout); the quiet period covers the common case.
const pending = new Map(); // key -> { row, since, quiet, timer, cap, room }
function schedule(a, row, io) {
  const key = keyOf(a, row), done = io.fired || fired;
  if (done.has(key)) return;
  let p = pending.get(key);
  if (!p) {
    p = { since: Date.now(), room: null };
    pending.set(key, p);
    if (io.openPresence) io.openPresence(row.uri).then((room) => {
      if (pending.get(key) !== p) return room.close();
      p.room = room;
      room.on('change', () => { if (p.quiet) tryRun(a, key, io); }); // a caret leaving is what it was waiting for
    }, (e) => io.report && io.report(e));
  }
  p.row = row; p.quiet = false;
  clearTimeout(p.timer);
  p.timer = setTimeout(() => { p.quiet = true; tryRun(a, key, io); }, io.settleMs || 0);
}
function tryRun(a, key, io) {
  const p = pending.get(key);
  if (!p) return;
  const cap = p.since + (io.maxWaitMs || 10 * 60000);
  if (p.room && p.room.editing().length && Date.now() < cap) { clearTimeout(p.cap); p.cap = setTimeout(() => tryRun(a, key, io), cap - Date.now()); return; }
  pending.delete(key);
  clearTimeout(p.timer); clearTimeout(p.cap);
  if (p.room) p.room.close().catch(() => {});
  execute(a, p.row, io).catch((e) => io.report && io.report(e));
}
async function execute(a, row, io) {
  const key = keyOf(a, row), done = io.fired || fired, item = itemOf(row, io);
  if (done.has(key) || !item.title.trim()) return;
  done.add(key);
  const execution = { automation: a.id, item: item.id, title: item.title, startedAt: new Date().toISOString(), nodes: [], ok: true };
  executions.unshift(execution); executions.length = Math.min(executions.length, 100);
  if (io.running) io.running(item.id, a.id, true);
  try { await runNodes({ io, automation: a, item, outputs: {} }, a.nodes, execution.nodes); } catch (e) { execution.ok = false; execution.error = String(e && e.message || e); }
  finally { if (io.running) io.running(item.id, a.id, false); }
  if (io.executed) io.executed(execution);
}
// Keeps exactly one live query open per enabled automation, for the current connection. Called whenever the list
// may have changed (a save, the refresh loop for edits from another machine) and cheap when nothing did.
// io adds openLiveQuery(query, label), client(), me(), typeUri(title), typeTitle(uri) to the node operations.
const watching = new Map(); // automation id -> { key, client, handle }
async function watch(io) {
  const want = new Map(io.automations().filter((a) => a.enabled !== false && !invalid(a)).map((a) => [a.id, a]));
  const sig = (a) => JSON.stringify([a.trigger, a.createdAt, a.nodes]);
  for (const [id, w] of watching) {
    // a query the server refused (or lost across a reconnect) is reopened on the next call, i.e. the next refresh
    // ponytail: an errored query stays quiet until then (≤30 s); watch the sync reconnect event if that gap matters
    if (want.has(id) && w.key === sig(want.get(id)) && w.client === io.client() && !w.error) continue;
    watching.delete(id);
    if (w.handle) w.handle.close().catch(() => {});
  }
  for (const [id, a] of want) {
    if (watching.has(id)) continue;
    const w = { key: sig(a), client: io.client(), handle: null };
    watching.set(id, w);
    try {
      const handle = await io.openLiveQuery(await queryOf(a, io), 'automation: ' + a.name);
      if (watching.get(id) !== w) { handle.close().catch(() => {}); continue; } // changed while it opened
      w.handle = handle;
      // added: it started matching; changed: its title or state moved, which is how a row that was still being typed
      // (or had no title yet) comes back once it has one. Rows already run are skipped by their key.
      handle.on('rows', ({ added, changed }) => { for (const row of [...added, ...changed]) schedule(a, row, io); });
      handle.on('error', (e) => { w.error = e.message; if (io.report) io.report(e); });
    } catch (e) {
      watching.delete(id); // tried again on the next call
      if (io.report) io.report(e);
    }
  }
}

// What the page draws under an automation's name: the trigger and each node as a step with its own glyph, so the
// flow reads at a glance. depth is how far inside an if a step sits; output is the name a later step reads it by.
const STATE_WORD = { proposed: 'Inbox', open: 'In progress', closed: 'Done', not_now: 'Later' };
const MATCH_WORD = { exact: 'exact names only', unique: 'unique first names too', loose: 'any first name' };
const quote = (x) => (typeof x === 'string' ? '“' + x + '”' : x.node ? x.node : x.ref ? x.ref : x.ai);
// a value that is an earlier step's output is drawn as that step's pill, anything else as words
const val = (x) => (x && x.node ? { var: x.node } : { text: quote(x) });
// A Tana type is marked #[Title|uri|hue] in the page's words, and the people here #[Person|member]: the page draws
// each as a chip with its own icon (the type's glyph, or the member glyph) and colour. uri and hue are whatever this
// session knows of the type by its title; a type not seen yet is drawn with the generic glyph.
function tag(name) {
  if (/^(persons?|people|members?)$/i.test(name)) return '#[Person|member]';
  const { typeTitles } = require('./state'), low = String(name).toLowerCase();
  const uri = [...typeTitles].find(([, title]) => String(title).toLowerCase() === low)?.[0];
  const hue = uri ? require('./rows').typeHue(uri) : undefined;
  return '#[' + name + (uri ? '|' + uri + (hue != null ? '|' + hue : '') : '') + ']';
}
// An AI condition is written as a statement ("the title asks to discuss something") and reads as "If <statement>"; an
// older one written as a question reads "If yes to <question>". Which model decides is a label beside it (model).
const condition = (ask) => { const s = String(ask).replace(/\s*answer (with )?(yes|no) or (yes|no)\.?\s*$/i, '').trim(); return /\?$/.test(s) ? { title: 'If yes to', text: s } : { title: 'If', text: s }; };
const modelOf = (m) => (m === 'smart' ? 'smart' : 'fast');
function describe(a) {
  const p = a.trigger.parameters || {}, q = p.filter || {}, types = q.types || [], states = q.stateTypes || [];
  const what = (p.typeNames && p.typeNames.length ? p.typeNames.map(tag).join(' or ') : types.includes('event') ? 'meeting' : states.length ? 'task' : types.includes('text') ? 'document' : 'node')
    + ((q.assignedTo || []).includes('me') ? ' assigned to me' : '');
  const when = 'a ' + what + ' is added' + (states.length === 1 ? ' to ' + STATE_WORD[states[0]] : '');
  const triggerIcon = 'created';
  const steps = [];
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      const p = n.parameters || {};
      if (n.type === 'if') {
        const c = p.condition || {};
        steps.push({ depth, icon: 'branch', ...(c.ai ? { ...condition(c.ai), model: modelOf(c.model) } : c.node ? { title: 'If', var: c.node, after: 'is yes' } : { title: 'If', text: quote(c) }) });
        // its steps indented under it, then "Otherwise" and the rest: never a Yes/No label
        walk(n.then, depth + 1);
        if (n.else) { steps.push({ depth: depth + 1, branch: 'Otherwise' }); walk(n.else, depth + 1); }
        continue;
      }
      const step = ({
        'item.setState': () => ({ icon: 'status', title: 'Move to', text: STATE_WORD[p.state] }),
        'item.setType': () => ({ icon: 'type', title: 'Set type', text: tag(p.typeName) }),
        'item.addLine': () => ({ icon: 'doc', title: 'Add line', ...val(p.text) }),
        'field.set': () => ({ icon: 'field', title: 'Set ' + p.field, ...val(p.value) }),
        'text.link': () => ({ icon: 'link', title: 'Link names', ...val(p.text), after: 'to ' + p.types.map(tag).join(' or '), note: MATCH_WORD[p.match || 'unique'] }),
        'text.extract': () => ({ icon: 'sparkle', title: 'Extract', text: p.ask, model: modelOf(p.model) }),
        'text.judge': () => ({ icon: 'sparkle', title: 'Check', text: condition(p.ask).text, model: modelOf(p.model) }),
        'user.notify': () => ({ icon: 'notify', title: 'Notify me', ...val(p.text) }),
      }[p.resource + '.' + p.operation] || (() => ({ icon: 'any', title: n.type, text: p.resource + '.' + p.operation })))();
      steps.push({ depth, ...step, output: n.name || '' });
    }
  };
  walk(a.nodes, 0);
  return { when, triggerIcon, steps };
}

// ---- the store: automations live in the synced settings under 'automations'; only the AI adds or changes one ----
const settings = () => require('./settings');
const stored = () => { const list = settings().get('automations'); return Array.isArray(list) ? list : []; };
const save = (list) => settings().set('automations', list);
// The types the AI may name, with their fields, so "Discuss with" on a Discussion Task is a field it knows about.
async function workspaceTypes() {
  const { S } = require('./state'), { attributeTitles } = require('./related');
  if (!S.client) return [];
  const { nodes = [] } = await S.client.graph.listNodes({ nodeTypes: ['type'], limit: 200 });
  return Promise.all(nodes.filter((t) => t.title).map(async (t) => ({ title: t.title, fields: Object.values(await attributeTitles(t.id)) })));
}
// What the page lists: each automation with its plain-words summary and its latest execution this session.
const list = () => stored().map((a) => ({ id: a.id, name: a.name, description: a.description, enabled: a.enabled !== false, createdAt: a.createdAt, updatedAt: a.updatedAt, ...describe(a),
  runs: executions.filter((e) => e.automation === a.id).length, last: executions.find((e) => e.automation === a.id) || null }));
async function create(description) {
  if (!text(String(description || '').trim(), 1000)) throw new Error('Describe what the automation should do');
  const draft = await require('./ai').draftAutomation(description, await workspaceTypes());
  const now = new Date().toISOString();
  const a = { ...draft, id: require('../sdk/node').ulid(), enabled: true, createdAt: now, updatedAt: now, description: description.trim() };
  save([...stored(), a]);
  return a.id;
}
// A change is the whole description again, edited: the AI rewrites the automation to match it, from the current one.
async function change(id, request) {
  const current = stored().find((a) => a.id === id);
  if (!current) throw new Error('That automation is gone');
  if (!text(String(request || '').trim(), 1000)) throw new Error('Describe what the automation should do');
  const draft = await require('./ai').draftAutomation(request, await workspaceTypes(), current);
  const next = { ...draft, id, enabled: current.enabled, createdAt: current.createdAt, updatedAt: new Date().toISOString(), description: request.trim() };
  save(stored().map((a) => (a.id === id ? next : a)));
  return id;
}
const setEnabled = (id, on) => { save(stored().map((a) => (a.id === id ? { ...a, enabled: !!on } : a))); return !!on; };
const remove = (id) => { save(stored().filter((a) => a.id !== id)); return true; };

module.exports = { VERSION, TYPES, invalid, watch, schedule, keyOf, queryOf, executions, describe, list, create, change, setEnabled, remove };
