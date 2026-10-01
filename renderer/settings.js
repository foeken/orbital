'use strict';
// Settings (issue #672): the app's preferences on one page, an app page opened in a pane beside the one that asked —
// Cmd+K Open settings, ⌘, and the app menu's Settings… (main.js createMenu, through shell.js 'action'). Each control
// shows a setting and changes it the way its Cmd+K row does, mostly by running that row (runAction), so a choice made
// here and one made in ⌘K are the same write. Nothing here is stored by this page: the values are the synced
// preferences, main's settings and this Mac's sign-ins (docs/SETTINGS.md). Only lasting choices are on it: text
// size, the sensitive eye and demo mode keep their keys and rows. docs/OUTLINER.md Settings.
const SETTINGS_PAGE = 'orbital:settings';
extra.set(SETTINGS_PAGE, { id: SETTINGS_PAGE, text: 'Settings', title: 'Settings', kind: 'document', icon: 'options', editable: false, hasChildren: false, appPage: true });
// what main answers asynchronously, read again each time the page is drawn after something may have changed it
// (settingsAsked cleared): the palette closing, a setting arriving from another page or Mac
let settingsAI = null, settingsHidden = null, settingsAsked = false, settingsRead = 0; // settingsRead: the newest read, the only one whose answer lands
function openSettings() {
  if (zoom?.docId === SETTINGS_PAGE) return;
  run(() => openElsewhere('right', SETTINGS_PAGE)); // a pane to the right; one already open in another pane is focused instead
}
function settingsRefresh() { settingsAsked = false; if (zoom?.docId === SETTINGS_PAGE) renderSoon(true); }
// redrawn on the next frame, by when app.js's own handler has applied the new preferences and agent.js stored the new status
if (tana.onSettings) { tana.onSettings(settingsRefresh); }
if (tana.onChatGPTStatus) tana.onChatGPTStatus(settingsRefresh);
if (tana.onChanged) tana.onChanged((docId) => { if (docId == null) settingsRefresh(); }); // a global refresh: hidden titles edited in another pane send one
new MutationObserver(() => { if (palette.hidden) settingsRefresh(); }).observe(palette, { attributes: true, attributeFilter: ['hidden'] }); // a ⌘K page it opened has closed
function settingsLoad() {
  if (settingsAsked) return;
  settingsAsked = true;
  const mine = ++settingsRead; // a refresh while this read is out starts a newer one, and this answer is then stale
  const read = (call) => (call ? Promise.resolve(call()).catch(() => null) : Promise.resolve(null));
  refreshChatGPTStatus();
  return Promise.all([read(tana.aiOptions), read(tana.filters), chatgptAuthLoading]).then(([ai, hidden]) => {
    if (mine !== settingsRead) return;
    settingsAI = ai; settingsHidden = Array.isArray(hidden) ? hidden : null;
    if (zoom?.docId === SETTINGS_PAGE) renderSoon(true);
  });
}
// The page: sections of field rows (styles.css .fields), each a glyph, a grey label and its value in one column
function settingsEl() {
  settingsLoad();
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const button = (cls, text, fn) => { const b = el('button', cls, text); b.type = 'button'; b.onmousedown = (e) => e.preventDefault(); b.onclick = fn; return b; };
  const choices = (list) => list.map(([label, on, fn, title]) => { const b = button('sopt' + (on ? ' on' : ''), label, () => { if (!on) { fn(); renderSoon(true); } }); b.setAttribute('aria-pressed', String(on)); if (title) b.title = title; return b; });
  const chip = (text, fn) => (fn ? button('fchip sbtn', text, fn) : el('span', 'fchip', text));
  const act = (text, fn) => button('sact', text, fn);
  const hint = (text) => el('span', 'fhint', text);
  const action = (id) => () => runAction(id);
  const ai = settingsAI, hidden = settingsHidden || [];
  const signedIn = !!chatgptAuth?.signedIn;
  const sections = [
    ['General', [
      ['darkLight', 'Theme', choices([['Light', themePref === 'light', () => setTheme('light')], ['Dark', themePref === 'dark', () => setTheme('dark')],
        ...(tana.systemTheme ? [['System', themePref === 'system', () => followSystem(true)]] : [])])],
      ['home', 'Home', [chip(homeName() || 'Work View'), hint('⌘K Set as Home changes it')]],
    ]],
    ['Language', tana.translate ? [['language', 'Auto-translate', [chip(translateTo() || 'Off', action('autoTranslate'))]]] : []],
    ['AI', [
      ...(tana.chatgptStatus ? [['chatgpt', 'ChatGPT', [...(chatgptAuth ? [hint(signedIn ? (chatgptAuth.email ? demoText(chatgptAuth.email, 'chatgpt') : 'Signed in') : 'Not signed in')] : []), act(signedIn ? 'Sign out' : 'Sign in', action('chatgpt'))], true]] : []),
      // only for whoever already has a key, as ⌘K offers Set OpenAI API key (renderer/palette.js): ChatGPT is the way in
      ...(tana.setOpenAIKey && chatgptAuth?.apiKey ? [['openaiKey', 'OpenAI API key', [act('Set …', action('openaiKey'))], true]] : []),
      ...(ai ? [
        ['brain', 'Model', choices(ai.models.map((m) => [m.replace(/^gpt-[\d.]+-/, '').replace(/^./, (c) => c.toUpperCase()), m === ai.model, () => settingsSetAI('model', m), m]))],
        ['sparkle', 'Thinking', choices(ai.efforts.map((x) => [x[0].toUpperCase() + x.slice(1), x === ai.effort, () => settingsSetAI('effort', x)]))],
      ] : []),
      // the agents that are on (main/agent.js), changed on the same page as ⌘K Choose agents
      ...(tana.agentList ? [['robot', 'Agents', [...(agentsOn().length ? agentsOn().map((a) => chip(a.label)) : [hint('None')]), act('Choose …', action('agents'))]]] : []),
    ]],
    ['Lists', [
      ...(tana.filters ? [['hiddenItems', 'Hidden titles', [...(hidden.length ? hidden.slice(0, 3).map((p) => chip(demoText(p, 'hidden:' + p))) : [hint('Nothing hidden')]),
        ...(hidden.length > 3 ? [hint('and ' + (hidden.length - 3) + ' more')] : []), act('Edit …', action('hidden'))]]] : []),
      ...(tana.setMcpHidden ? [['robot', 'Show MCP chats', [(() => {
        const b = button('sswitch' + (mcpHidden ? '' : ' on'), '', () => run(async () => { mcpHidden = await tana.setMcpHidden(!mcpHidden); renderSoon(true); }));
        b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(!mcpHidden)); b.setAttribute('aria-label', 'Show MCP chats'); return b;
      })()]]] : []),
    ]],
  ];
  const page = el('div', 'settings');
  page.append(el('p', 'settings-note', 'Kept in your Orbital document, so they follow you to every Mac. This Mac marks the ones that stay here.'));
  for (const [name, rows] of sections) {
    if (!rows.length) continue; // a section with nothing in it is not drawn
    page.append(el('h2', 'settings-head', name));
    const grid = el('div', 'fields');
    for (const [icon, label, values, local] of rows) {
      const row = el('div', 'field'), v = el('div', 'fvalues settings-values');
      v.append(...values);
      // names it again after a redraw (drawSettings): a choice by its own words, which never change; the row's action, chip
      // or switch by its kind, since its words and state do (Sign in becomes Sign out, Off becomes Dutch)
      for (const b of v.querySelectorAll('button')) b.dataset.skey = label + '/' + (b.classList.contains('sopt') ? b.textContent : b.classList[b.classList.contains('fchip') ? 1 : 0]);
      if (local) v.append(el('span', 'settings-local', 'This Mac'));
      row.append(addIcon(el('span', 'ricon'), icon), el('span', 'flabel', label), v);
      grid.append(row);
    }
    page.append(grid);
  }
  return page;
}
function settingsSetAI(key, value) {
  run(async () => { await tana.setAiOption(key, value); settingsRefresh(); }); // read again: a read still out from before the write must not land over it
}
// Every redraw builds the page anew, so a control that had the keyboard (Tab, then Space on High) gets it back
function drawSettings(into) {
  const had = into.contains(document.activeElement) ? document.activeElement.dataset.skey : null;
  into.replaceChildren(settingsEl());
  if (had) [...into.querySelectorAll('button')].find((b) => b.dataset.skey === had)?.focus({ preventScroll: true });
}
