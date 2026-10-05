'use strict';
/* global demoText, demoMode:writable, aiModelLabel, aiEffortLabel */
// Orbital's Settings window (settings.html; issue #672): a Mac app's settings, in a window of its own, opened by
// ⌘, (Cmd+K Open settings) and the app menu's Settings… (main.js openSettings), one at a time. Toolbar tabs over grouped
// rows, each a label and its control, and the window takes the height of the tab it shows (settingsSize). Nothing is
// kept here: every control makes the same call its Cmd+K row does (the synced preferences, main's AI options, the
// agents, the hidden titles, this Mac's ChatGPT sign-in), and main tells this window when any of them changes
// elsewhere (main/state.js send, main/settings.js tellOthers). renderer/segments.js lends demo mode's masks (the email,
// the hidden titles), on while the outliner's demo mode is (localStorage, shared with it), and renderer/settings.js the
// models' and thinking levels' names, as Cmd+K Choose models writes them.
// Without window.api (the manual's scenes, flow-check) the window is empty until start() is handed one.
const TABS = [['general', 'General', 'options'], ['ai', 'AI', 'brain'], ['agents', 'Agents', 'robot'], ['lists', 'Lists', 'hiddenItems']];
const LANGS = ['English', 'Dutch', 'German', 'French', 'Spanish']; // renderer/translate.js TRANSLATE_LANGS
const GLYPHS = window.ICONS || {}; // icons.js: our own markup
const $ = (id) => document.getElementById(id);
const st = { prefs: {}, ai: null, chatgpt: null, agents: null, hidden: null, mcpHidden: null };
const asked = {};
let host = null, tab = TABS.some(([id]) => id === localStorage.getItem('settingsTab')) ? localStorage.getItem('settingsTab') : 'general';
let failure = null, hiddenPick = null, adding = null, sized = 0; // the last call that failed; the hidden title − removes; the + field's words while it shows
demoMode = localStorage.getItem('demoMode') === '1';
addEventListener('storage', (e) => { if (e.key === 'demoMode') { demoMode = e.newValue === '1'; draw(); } });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => draw());

// Each part of st has one call that counts, the newest: an older answer landing after it (a read still out when a
// write answered) is dropped rather than put back over it.
function load(part, call) {
  const n = asked[part] = (asked[part] || 0) + 1;
  failure = null;
  return Promise.resolve().then(call).then((value) => { if (asked[part] === n) { st[part] = value; draw(); } },
    (e) => { if (asked[part] === n) { failure = String(e?.message || e); draw(); } }); // as main said it (preload.js unwraps it)
}
function reload() {
  for (const [part, call] of [['ai', 'aiOptions'], ['chatgpt', 'chatgptStatus'], ['agents', 'agentList'], ['hidden', 'filters'], ['mcpHidden', 'mcpHidden']]) if (host[call]) load(part, host[call]);
}
function start(handed) {
  host = handed;
  st.prefs = { ...(host.prefs || {}) };
  host.onSettings?.((prefs) => { st.prefs = { ...prefs }; reload(); draw(); }); // another page, window or Mac changed one
  host.onChatGPTStatus?.((status) => { asked.chatgpt = (asked.chatgpt || 0) + 1; st.chatgpt = status; draw(); }); // a sign-in finishing in the browser
  reload(); draw();
}
function setPref(key, value) {
  if (value === undefined) delete st.prefs[key]; else st.prefs[key] = value;
  Promise.resolve(host.setPref(key, value)).catch((e) => { failure = String(e?.message || e); draw(); });
  draw();
}

// ---- the controls: each carries a key naming it, so a redraw gives the keyboard back to the one that had it ----
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function button(key, text, fn, cls = 'btn') { const b = el('button', cls, text); b.type = 'button'; b.dataset.key = key; b.onclick = fn; return b; }
function toggle(key, label, on, fn, disabled) {
  const b = button(key, null, fn, 'switch');
  b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(!!on)); b.setAttribute('aria-label', label); b.disabled = !!disabled;
  return b;
}
// a pop-up button: the menu that opens is macOS's own
function popup(key, label, value, options, fn) {
  const s = el('select', 'popup');
  s.dataset.key = key; s.setAttribute('aria-label', label);
  if (value != null && !options.some(([v]) => v === value)) options = [[value, value], ...options]; // a stored choice the list no longer offers still shows
  for (const [v, text] of options) s.append(new Option(text, v, false, v === value));
  s.onchange = () => fn(s.value);
  return s;
}
function segmented(key, label, value, options, fn) {
  const g = el('div', 'seg');
  g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', label);
  for (const [v, text] of options) {
    const b = button(key + '/' + v, text, () => { if (v !== value) fn(v); }, v === value ? 'on' : '');
    b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(v === value));
    g.append(b);
  }
  return g;
}
function row(icon, label, controls, sub, dim) {
  const r = el('div', 'row' + (dim ? ' dim' : '')), glyph = el('span', 'icon'), text = el('div', 'label', label);
  glyph.innerHTML = GLYPHS[icon] || '';
  if (sub) text.append(el('div', 'sub', sub));
  r.append(glyph, text, ...[].concat(controls || []));
  return r;
}
function group(head, note, rows) {
  if (!rows.length) return []; // a section with nothing in it is not drawn
  const out = [];
  if (head) { const h = el('h2', 'head', head); if (note) h.append(el('span', 'note', ' · ' + note)); out.push(h); }
  const box = el('div', 'box'); box.append(...rows); out.push(box);
  return out;
}

// ---- the tabs ----
const HERE = 'On this Mac';
function chatgptRow(c) {
  const at = (controls, sub, dim) => row('chatgpt', 'ChatGPT', controls, sub, dim);
  if (!c) return at(null, 'Checking…');
  if (c.installing) return at(null, 'Getting ChatGPT sign-in ready…');
  if (c.loggingIn) return at([button('copyCode', 'Copy Code', () => navigator.clipboard.writeText(c.userCode)), button('cancelLogin', 'Cancel', () => load('chatgpt', host.chatgptCancel))], 'Enter ' + c.userCode + ' in your browser');
  if (c.signedIn) return at(button('chatgpt', 'Sign Out', () => load('chatgpt', host.chatgptLogout)), (c.email ? demoText(c.email, 'chatgpt') : 'Signed in') + ' · ' + HERE);
  if (c.available === false) return at(null, c.error || 'Codex CLI unavailable', true);
  return at(button('chatgpt', 'Sign In…', () => load('chatgpt', async () => {
    const r = await host.chatgptLogin(); // opens the browser; the code to enter there shows on this row
    return r.userCode ? { ...st.chatgpt, available: true, signedIn: false, loggingIn: true, userCode: r.userCode, error: null } : r;
  })), 'Not signed in · ' + HERE);
}
function hiddenList() {
  const list = st.hidden || [], items = el('div', 'items'), bar = el('div', 'bar'), wrap = el('div', 'listbox');
  items.setAttribute('role', 'listbox'); items.setAttribute('aria-label', 'Hidden titles');
  if (!list.length && adding == null) items.append(el('div', 'empty', st.hidden ? 'Nothing is hidden' : 'Loading…'));
  for (const p of list) {
    const b = button('hidden/' + p, demoText(p, 'hidden:' + p), () => { hiddenPick = p; draw(); }, 'item' + (p === hiddenPick ? ' on' : ''));
    b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(p === hiddenPick));
    b.onkeydown = (e) => { if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); unhide(p); } };
    items.append(b);
  }
  if (adding != null) {
    const f = el('input', 'add');
    f.dataset.key = 'hidden/+'; f.value = adding; f.placeholder = 'A title, or the start of one*'; f.setAttribute('aria-label', 'Title to hide');
    f.oninput = () => { adding = f.value; };
    f.onkeydown = (e) => {
      if (e.key === 'Enter' && f.value.trim()) { const pattern = f.value.trim(); adding = null; load('hidden', () => host.addFilter(pattern)); }
      else if (e.key === 'Escape') { adding = null; draw(); }
    };
    f.onblur = () => { if (f.isConnected && adding != null && !adding.trim()) { adding = null; draw(); } };
    items.append(f);
  }
  const add = button('hidden+', '+', () => { adding = adding ?? ''; draw(); $('pane').querySelector('input.add').focus(); }, 'tool');
  const remove = button('hidden-', '−', () => unhide(hiddenPick), 'tool');
  add.setAttribute('aria-label', 'Hide a title'); remove.setAttribute('aria-label', 'Unhide the selected title');
  remove.disabled = !list.includes(hiddenPick);
  bar.append(add, remove); wrap.append(items, bar);
  const r = el('div', 'row block');
  r.append(wrap, el('div', 'sub', 'Left out of every list. The whole title, in any case; end with * to match the start of titles.'));
  return r;
}
function unhide(pattern) { if (pattern == null) return; hiddenPick = null; load('hidden', () => host.removeFilter(pattern)); }
function agentRows(a) {
  const flip = () => load('agents', () => host.enableAgent(a.id, !a.enabled));
  // not installed here only stops switching it on: one switched on at another Mac (the choice follows you) can be switched off here
  return [row(a.icon, a.label, toggle('agent/' + a.id, a.label, a.enabled, flip, a.id === 'tana' || (!a.installed && !a.enabled)),
    a.id === 'tana' ? 'Always on' : !a.installed ? a.missing || 'Not installed' : null, !a.installed)];
}
const SECTIONS = {
  general: () => [
    ...group('Appearance', null, [row('darkLight', 'Theme', segmented('theme', 'Theme', ['light', 'dark'].includes(st.prefs.theme) ? st.prefs.theme : 'system',
      [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']], (v) => setPref('theme', v)))]),
    ...group('Language', null, host.translate ? [row('language', 'Auto-translate notes into', popup('translateTo', 'Auto-translate notes into', LANGS.includes(st.prefs.translateTo) ? st.prefs.translateTo : '',
      [['', 'Off'], ...LANGS.map((l) => [l, l])], (v) => setPref('translateTo', v || undefined)), 'Shown translated on screen, never saved')] : []),
    el('p', 'foot', 'Settings follow you to every Mac through your Orbital document in Tana, except those marked ' + HERE + '.'),
  ],
  ai: () => {
    const c = st.chatgpt, ai = st.ai, out = [];
    out.push(...group('Account', null, host.chatgptStatus ? [chatgptRow(c),
      // only for whoever already has a key, as ⌘K offers Set OpenAI API key: ChatGPT is the way in
      ...(c?.apiKey && host.setOpenAIKey ? [row('openaiKey', 'OpenAI API key', button('removeKey', 'Remove', () => load('chatgpt', async () => { await host.setOpenAIKey(''); return { ...st.chatgpt, apiKey: false }; })),
        (c.signedIn ? 'ChatGPT is asked first' : 'Asked for every AI answer') + ' · ' + HERE)] : [])] : []));
    if (ai) for (const [head, note, k] of [['Quick AI', 'translating, Discuss with, types and icons', (w) => 'quick' + w], ['Regular AI', 'reading images', (w) => w.toLowerCase()]]) {
      const set = (key) => (v) => load('ai', () => host.setAiOption(key, v));
      out.push(...group(head, note, [
        row('brain', 'Model', popup(k('Model'), head + ' model', ai[k('Model')], ai.models.map((m) => [m, aiModelLabel(m)]), set(k('Model')))),
        row('sparkle', 'Thinking', popup(k('Effort'), head + ' thinking', ai[k('Effort')], ai[k('Efforts')].map((x) => [x, aiEffortLabel(x)]), set(k('Effort')))),
      ]));
    }
    return out;
  },
  agents: () => {
    const list = st.agents || [], on = list.filter((a) => a.enabled && a.installed), pick = (on.find((a) => a.isDefault) || on[0])?.id;
    const choose = popup('defaultAgent', 'Default agent', pick, on.map((a) => [a.id, a.label]), (v) => load('agents', () => host.setDefaultAgent(v)));
    choose.disabled = on.length < 2;
    return [
      ...group('Agents', 'who a node can be handed to', list.flatMap(agentRows)),
      ...group(null, null, list.length ? [row('robot', 'Default agent', choose, 'Assign to Agent starts with it')] : []),
    ];
  },
  lists: () => [
    ...group('Hidden titles', null, host.filters ? [hiddenList()] : []),
    ...group('Chats', null, host.setMcpHidden ? [row('robot', 'Show MCP chats', toggle('mcp', 'Show MCP chats', !st.mcpHidden, () => load('mcpHidden', () => host.setMcpHidden(!st.mcpHidden)), st.mcpHidden == null), 'Chats an MCP client started')] : []),
  ],
};

// Every draw builds the window anew from st, the theme with it; the window then takes the page's height
function draw() {
  if (!host) return;
  const t = st.prefs.theme === 'dark' || st.prefs.theme === 'light' ? st.prefs.theme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  const had = document.activeElement?.dataset?.key, name = TABS.find(([id]) => id === tab)[1];
  document.title = name; $('title').textContent = name;
  $('tabs').replaceChildren(...TABS.map(([id, label, icon]) => {
    const b = button('tab/' + id, null, () => { if (id !== tab) { tab = id; hiddenPick = null; adding = null; localStorage.setItem('settingsTab', id); draw(); } }, 'tab' + (id === tab ? ' on' : ''));
    b.innerHTML = GLYPHS[icon] || ''; b.append(el('span', null, label));
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(id === tab));
    return b;
  }));
  $('pane').replaceChildren(...SECTIONS[tab](), ...(failure ? [el('p', 'error', failure)] : []));
  if (had) document.querySelector('[data-key="' + CSS.escape(had) + '"]')?.focus({ preventScroll: true });
  const height = Math.ceil(document.body.getBoundingClientRect().height);
  if (height !== sized && host.settingsSize) { sized = height; host.settingsSize(height); }
}
if (window.api) start(window.api);
