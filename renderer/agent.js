'use strict';
// The agents' pages in Cmd+K: signing in with ChatGPT, the OpenAI API key (kept for whoever already has one),
// Choose agents, linking a task that already exists in an agent's app, and the prompt page Assign to Agent opens.
// renderer/palette.js lists their rows and draws every page; the agent's badge and state are renderer/render.js and
// renderer/nodes.js. Which agents there are is main's (main/agent.js), drawn from agentList (renderer/state.js).

// ---- ChatGPT sign-in and the OpenAI API key ----
let chatgptAuth = null, chatgptAuthLoading = null, chatgptPushes = 0; // pushes: main's announcements, newer than any read asked for before them
function openOpenAIKeyPalette() {
  openPage('openaiKey', 'Paste OpenAI API key', { rows: openAIKeyRows, back: BACK_TO_COMMANDS }); palInput.type = 'password';
}
function refreshChatGPTStatus() {
  if (!tana.chatgptStatus || chatgptAuthLoading) return;
  const asked = chatgptPushes; // a read that answers after main announced a change is older than it, and must not undo it
  chatgptAuthLoading = Promise.resolve(tana.chatgptStatus()).then((status) => { if (asked === chatgptPushes) chatgptAuth = status; }, (error) => { chatgptAuth = { available: false, signedIn: false, error: errorText(error) }; })
    .then(() => { chatgptAuthLoading = null; if (!palette.hidden && (palMode === 'cmd' || palMode === 'chatgpt')) renderPalette(); });
}
function startChatGPTLogin() {
  openPage('chatgpt', 'ChatGPT account', { rows: chatgptRows, back: BACK_TO_COMMANDS });
  run(async () => {
    const result = await tana.chatgptLogin();
    if (result.userCode) chatgptAuth = { ...(chatgptAuth || {}), available: true, signedIn: false, loggingIn: true, userCode: result.userCode, error: null };
    else { chatgptAuth = result; if (palMode === 'chatgpt' && !palette.hidden) return openCommandPalette(); }
    renderPalette();
  });
}
function chatgptCommand() {
  if (!chatgptAuth?.signedIn) return startChatGPTLogin();
  run(async () => { chatgptAuth = await tana.chatgptLogout(); renderPalette(); });
}
function chatgptRows(q) {
  let rows;
  if (!chatgptAuth) rows = [{ group: 'ChatGPT', icon: 'chatgpt', label: 'Checking sign-in status…', disabled: true }];
  else if (chatgptAuth.installing) rows = [{ group: 'ChatGPT', icon: 'chatgpt', label: 'Getting ChatGPT sign-in ready…', hint: 'One-time download', disabled: true }];
  else if (chatgptAuth.loggingIn) rows = [
    { group: 'ChatGPT', icon: 'chatgpt', label: 'Enter ' + chatgptAuth.userCode + ' in your browser', hint: 'Waiting for sign-in', disabled: true },
    // the page stays: the sign-in is still waiting for the browser, where the code is pasted
    { group: 'Actions', icon: 'chatgpt', label: 'Copy code', hint: chatgptAuth.userCode, keepOpen: true, run: () => run(() => copyText(chatgptAuth.userCode, 'Code copied')) },
    { group: 'Actions', icon: 'chatgpt', label: 'Cancel ChatGPT sign-in', run: () => run(async () => { chatgptAuth = await tana.chatgptCancel(); renderPalette(); }) },
  ];
  else if (chatgptAuth.signedIn) rows = [
    { group: 'ChatGPT', icon: 'chatgpt', label: 'Signed in as ' + (chatgptAuth.email || 'ChatGPT'), hint: chatgptAuth.apiKey ? 'Preferred over API key' : '', disabled: true },
    { group: 'Actions', icon: 'chatgpt', label: 'Sign out of ChatGPT', run: () => run(async () => { chatgptAuth = await tana.chatgptLogout(); renderPalette(); }) },
  ];
  else rows = [
    { group: 'ChatGPT', icon: 'chatgpt', label: chatgptAuth.available === false ? 'Sign-in unavailable' : 'Not signed in', hint: chatgptAuth.available === false ? (chatgptAuth.error || 'Codex CLI unavailable') : (chatgptAuth.apiKey ? 'Preferred over API key' : ''), disabled: true },
    { group: 'Actions', icon: 'chatgpt', label: 'Sign in with ChatGPT', run: startChatGPTLogin },
  ];
  return matchRows(rows, q);
}
if (tana.onChatGPTStatus) tana.onChatGPTStatus((status) => {
  chatgptPushes++;
  chatgptAuth = status;
  if (!palette.hidden && (palMode === 'cmd' || palMode === 'chatgpt')) renderPalette();
});
// Sign in with ChatGPT is the way in; a key already stored keeps working, and this page is where it can be cleared.
// Once it is, Cmd+K stops offering the page (renderer/palette.js).
function openAIKeyRows() {
  const key = palInput.value.trim();
  if (!key) return [{ group: 'OpenAI API key', icon: 'openaiKey', label: 'Clear OpenAI API key', hint: 'Sign in with ChatGPT instead', keepOpen: true,
    run: () => run(async () => { await tana.setOpenAIKey(''); chatgptAuth = { ...(chatgptAuth || {}), apiKey: false }; closePalette(); }) }];
  return [{ group: 'OpenAI API key', icon: 'openaiKey', label: 'Save OpenAI API key', hint: '↩ saves locally', keepOpen: true,
    run: () => run(async () => { await tana.setOpenAIKey(key); closePalette(); }) }];
}
// Where the key is sent (main/ai.js REGIONS): the region of the OpenAI project the key belongs to. Europe until chosen.
const OPENAI_REGIONS = [['europe', 'Europe'], ['us', 'United States'], ['global', 'Global']];
const openaiRegionName = () => (OPENAI_REGIONS.find(([id]) => id === chatgptAuth?.region) || OPENAI_REGIONS[0])[1];
const openaiRegionRows = () => OPENAI_REGIONS.map(([id, label]) => ({ group: 'OpenAI region · where your key\'s project keeps its data', icon: 'globe', label,
  hint: label === openaiRegionName() ? 'Current' : '', keepOpen: true,
  run: () => run(async () => { chatgptAuth = { ...(chatgptAuth || {}), region: await tana.setOpenAIRegion(id) }; closePalette(); showNote('OpenAI region: ' + label); }) }));
function openOpenAIRegionPalette() { openPage('openaiRegion', 'OpenAI region…', { rows: (q) => matchRows(openaiRegionRows(), q), back: BACK_TO_COMMANDS }); }
// ---- Choose agents, and Set default agent ----
// Every agent the app knows, in one list: Tana always on, Codex greyed with what to install until this Mac has
// it, Claude coming soon, then your linked agents (each has a page of its own: ↩ opens it), with Connect your personal agent under
// them (Reset agent link key is in Cmd+K itself). ↩ on a built-in one switches it on or off. The default, the agent Assign to Agent
// starts on, is picked on a page of its own (Set default agent …). The lists are main's, and each answer is the new
// list, so the page redraws from what was stored.
const AGENTS_GROUP = 'Agents', DEFAULT_GROUP = 'Default agent · ↩ makes it the default';
// the chat's @agents follow the same switches: read again here, since this page is left out of its own settings:changed
const agentsApply = (call) => run(async () => {
  const list = await call();
  if (Array.isArray(list)) agentList = list;
  if (tana.chatAgents) chatAgents = await tana.chatAgents().catch(() => chatAgents);
  renderPalette(); renderSoon();
});
function agentsRows(q) {
  const rows = agentList.filter((a) => !a.linked).map((a) => ({ group: AGENTS_GROUP, icon: a.icon, label: a.label, keepOpen: true,
    hint: a.id === 'tana' ? 'Always on' : !a.installed ? a.missing || 'Not installed' : a.enabled ? 'On' : 'Off',
    // not installed here only stops switching it on: one switched on at another Mac (the choice follows you) can be switched off here
    disabled: a.id === 'tana' || (!a.installed && !a.enabled), run: () => agentsApply(() => tana.enableAgent(a.id, !a.enabled)) }));
  rows.push({ group: AGENTS_GROUP, icon: 'robot', label: 'Claude', hint: 'Coming soon', disabled: true }); // to come back properly; settings.js says the same
  if (tana.mcpLink) {
    const linked = agentList.filter((a) => a.linked);
    for (const a of linked) rows.push({ group: AGENTS_GROUP, icon: a.icon, label: a.label, keepOpen: true,
      hint: [a.enabled ? 'On' : 'Off', a.app, seenText(a.seenAt)].filter(Boolean).join(' · '), run: () => openLinkedAgent(a.id) });
    rows.push({ group: AGENTS_GROUP, icon: 'mcp', label: 'Connect your personal agent …', hint: 'Your Dot in ChatGPT, or another agent', keepOpen: true, run: () => openLinkPalette(openAgentsPalette) });
  }
  return matchRows(rows, q);
}
function openAgentsPalette() {
  loadAgentList().then(() => { if (palMode === 'agents') renderPalette(); });
  openPage('agents', 'Choose agents', { rows: agentsRows, back: BACK_TO_COMMANDS });
}
function defaultAgentRows(q) {
  const rows = agentsOn().map((a) => ({ group: DEFAULT_GROUP, icon: a.icon, label: a.label, hint: a.isDefault ? '✓' : '', keepOpen: true,
    run: () => agentsApply(() => tana.setDefaultAgent(a.id)) }));
  return matchRows(rows, q);
}
function openDefaultAgentPalette() {
  loadAgentList().then(() => { if (palMode === 'defaultAgent') renderPalette(); });
  openPage('defaultAgent', 'Set default agent', { rows: defaultAgentRows, back: BACK_TO_COMMANDS });
}
// ---- Connect your personal agent: first which agent, then only its steps, then one code that links it ----
// (main/agents/linked.js) The first page asks which agent: your OpenAI Dot in ChatGPT, or any other agent that speaks MCP.
// Both get the two servers as a "custom MCP server" form wants them, a name and a URL (↩ copies the URL): Orbital's is the
// workspace's own when an admin set one in Tana, else orbital.md; your Dot also gets where ChatGPT adds them. Both end with
// the same code: one row copies the instructions, which only link, another the code alone, and the page
// asks every two seconds whether that happened; once it has, the palette closes on a toast naming the agent. Leaving the
// page does not stop the code: an agent that uses it later shows up in Choose agents all the same, and opening the page
// again goes straight back to it.
const CHATGPT_PLUGINS = 'https://chatgpt.com/plugins';
const LINK_TITLE = 'Connect your personal agent';
const AGENT_KINDS = [['chatgpt', 'Your OpenAI Dot', 'In ChatGPT · two servers', 'chatgpt'], ['other', 'Another agent', 'Any agent that speaks MCP · two servers', 'mcp']];
let connectCtx = null; // { state: asking|waiting|expired|failed, kind, code, prompt, expiresAt, error, back } while the page is up
let connectTimer = null;
const codeWaiting = () => (connectCtx && connectCtx.state === 'waiting' && connectCtx.expiresAt > Date.now() ? connectCtx : null);
// kind: 'chatgpt' or 'other'; none asks which first, unless a code is still waiting, whose page it reopens ('' always asks)
function openLinkPalette(back = BACK_TO_COMMANDS, kind = codeWaiting() ? codeWaiting().kind : null) {
  if (!kind) {
    const rows = (q) => matchRows(AGENT_KINDS.map(([id, label, hint, icon]) => ({ group: 'Which agent?', icon, label, hint, keepOpen: true, run: () => openLinkPalette(back, id) })), q);
    return openPage('linkKind', LINK_TITLE, { rows, back });
  }
  const title = AGENT_KINDS.find(([id]) => id === kind)[1], pageBack = () => openLinkPalette(back, '');
  // a code still waiting is the page you left, whichever agent it is for now: shown again, rather than another code (the
  // MCP server holds five at most)
  const open = codeWaiting();
  if (open) { Object.assign(open, { back, kind }); openPage('linkAgent', title, { rows: connectRows, back: pageBack, typed: true }); pollConnect(open); return; }
  const ctx = connectCtx = { state: 'asking', back, kind };
  openPage('linkAgent', title, { rows: connectRows, back: pageBack, typed: true });
  Promise.resolve(tana.mcpLink()).then((r) => { if (connectCtx !== ctx) return; Object.assign(ctx, r, { state: 'waiting' }); drawConnect(); pollConnect(ctx); },
    (e) => { if (connectCtx !== ctx) return; ctx.state = 'failed'; ctx.error = errorText(e); drawConnect(); });
}
const drawConnect = () => { if (palMode === 'linkAgent' && !palette.hidden) renderPalette(); };
function pollConnect(ctx) {
  clearTimeout(connectTimer);
  connectTimer = setTimeout(async () => {
    if (connectCtx !== ctx || palMode !== 'linkAgent' || palette.hidden) return;
    try {
      const s = await tana.mcpLinkStatus(ctx.code);
      if (connectCtx !== ctx) return;
      if (s.state === 'linked') {
        connectCtx = null;
        await loadAgentList();
        closePalette();
        return showNote('Linked ' + s.agent.label + (s.agent.app ? ' · ' + s.agent.app : ''));
      }
      ctx.state = s.state;
    } catch { /* a missed answer: the next one asks again */ }
    drawConnect();
    if (ctx.state === 'waiting') pollConnect(ctx);
  }, 2000);
}
function connectRows() {
  const c = connectCtx || { state: 'asking' }, again = { icon: 'reload', keepOpen: true, run: () => openLinkPalette(c.back, c.kind) }, title = LINK_TITLE;
  if (c.state === 'asking') return [{ group: title, label: 'Getting a code…', disabled: true, sweep: true, bare: true, match: [] }];
  if (c.state === 'failed') return [{ group: title, icon: 'link', label: c.error || 'No code', disabled: true, match: [] }, { ...again, group: title, label: 'Try again', match: [] }];
  const left = Math.max(0, (c.expiresAt || 0) - Date.now());
  const note = (group, icon, label) => ({ group, icon, label, note: true, wrap: true, disabled: true, match: [] });
  let rows, setup;
  const server = (icon, label, url) => ({ group: setup, icon, label, hint: url + ' · ↩ copies', keepOpen: true, match: [], run: () => run(() => copyText(url, 'Copied ' + label + '\u2019s URL')) });
  if (c.kind === 'chatgpt') {
    // your Dot: with the workspace's Orbital plugin, the instructions ask it to add that (main/mcp-server.js linkCode) and there
    // is nothing to do by hand; without, both servers added in ChatGPT, where Add then Create custom MCP server takes a name
    // and a URL (the phones' steps)
    setup = 'Add both in ChatGPT · a custom MCP server each, a name and a URL';
    rows = c.plugin ? [] : [{ group: setup, icon: 'chatgpt', label: 'Open ChatGPT plugins', hint: 'Add, then Create custom MCP server', keepOpen: true, match: [], run: () => run(() => tana.openExternal(CHATGPT_PLUGINS)) },
      server('orbital', 'Orbital', c.url), server('tana', 'Tana', c.tana)];
  } else {
    // any other agent: the two servers, a name and a URL each
    setup = 'Add both to your agent · a custom MCP server each, a name and a URL';
    rows = [server('orbital', 'Orbital', c.url), server('tana', 'Tana', c.tana), note(setup, 'help', 'Your agent needs MCP events to hear about the tasks you hand it.')];
  }
  // which Orbital MCP server the agents use: orbital.md, or one your workspace hosts itself (main/mcp-server.js);
  // only an admin may change it, so only an admin gets its page, everyone else the one in use
  if (rows.length) rows.push(c.admin ? { group: setup, icon: 'mcp', label: 'Use a self-hosted Orbital MCP server …', hint: serverHost(c.url), keepOpen: true, match: [], run: () => openServerPage(() => openLinkPalette(c.back, c.kind)) }
    : { group: setup, icon: 'mcp', label: 'Orbital MCP server', hint: serverHost(c.url) + (c.workspace ? ' · your workspace\'s' : ' · the default'), disabled: true, match: [] });
  // then the instructions, which only link: what goes through orbital.md is in them too, for the agent to explain; or the
  // code alone, for an agent whose setup asks for it
  const group = rows.length ? 'Then ask your agent to link' : 'Ask your Dot to link';
  rows.push({ group, icon: 'prompt', label: 'Copy the instructions', hint: rows.length ? '↩ copies' : 'They add your workspace\'s Orbital plugin · ↩ copies', keepOpen: true, match: [],
    run: () => run(() => copyText(c.prompt, 'Copied: send them to your agent')) },
  { group, icon: 'link', label: 'Copy the code', hint: 'Only the code · works once', keepOpen: true, match: [], run: () => run(() => copyText(c.code, 'Code copied')) },
  // what crosses orbital.md (main/agents/linked.js send): with each event the node's id, the request and how to handle it, kept nowhere
  { group, label: 'Only the node\'s id and your request go through ' + serverHost(c.url) + ', and it keeps neither: the node\'s words stay in Tana, where your agent reads them with its own Tana access.', note: true, wrap: true, disabled: true, match: [] });
  // the wait sits in the same group: no heading of its own, and no glyph, only its words with the light passing over them
  if (c.state === 'expired' || !left) return [...rows, { group, label: 'The code expired', hint: 'Nobody used it', disabled: true, bare: true, match: [] }, { ...again, group, label: 'Get a new code', match: [] }];
  return [...rows,
    { group, label: 'Waiting for your agent to use the code…', hint: 'Works once · ' + Math.floor(left / 60000) + ':' + String(Math.floor(left / 1000) % 60).padStart(2, '0') + ' left', disabled: true, sweep: true, bare: true, match: [] },
    { group, icon: 'reject', label: 'Cancel', hint: 'The code stops working', keepOpen: true, match: [], run: () => { connectCtx = null; run(() => tana.mcpLinkCancel(c.code)); (c.back || closePalette)(); } }];
}
// When the MCP server last heard from an agent, in a few words
function seenText(at) {
  if (!at) return '';
  const min = Math.round((Date.now() - at) / 60000);
  return min < 2 ? 'seen just now' : min < 60 ? 'seen ' + min + ' min ago' : min < 48 * 60 ? 'seen ' + Math.round(min / 60) + ' h ago' : 'not seen for ' + Math.round(min / 1440) + ' days';
}
// ---- Open Orbital Settings for Tana Workspace: what is the same for everyone in the Tana workspace (issue #814) ----
// Kept on Tana's own workspace document, written by an admin only (main/settings.js setWorkspace): the Orbital MCP server
// everyone hands over through (orbital.md unless the workspace hosts its own). A member sees it, and who set it, and changes nothing.
let serverNow = null; // what main said last: { url, workspace, admin, deploy, fallback, changedBy, … }
const serverHost = (url) => String(url || 'orbital.md/mcp').replace(/^https?:\/\//, '');
const ORG_TITLE = 'Orbital Settings for Tana Workspace';
const asking = (group) => [{ group, label: 'Asking…', disabled: true, sweep: true, bare: true, match: [] }];
const noteRow = (group, icon, label) => ({ group, icon, label, note: true, wrap: true, disabled: true, match: [] });
const setBy = (w) => w.changedBy && w.changedBy.name; // the admin who changed them last
function orgRows(q) {
  const w = serverNow, group = 'For everyone in your Tana workspace';
  if (!w) return asking(group);
  const row = (icon, label, hint, open) => ({ group, icon, label, hint, keepOpen: true, match: [], ...(w.admin ? { run: open } : { disabled: true }) });
  const rows = [row('mcp', 'Set custom MCP server URL …', serverHost(w.url) + (w.workspace ? '' : ' · the default'), () => openServerPage(openOrgPalette)),
    row('link', 'Set Orbital ChatGPT plugin URL …', w.plugin ? 'Set' : 'None', openPluginPage)]; // its link is long: the page it opens shows it
  const who = setBy(w);
  if (who) rows.push(noteRow(group, 'member', 'Set by ' + who + (w.changedBy.at ? ', ' + new Date(w.changedBy.at).toLocaleDateString() : '') + '.'));
  if (!w.admin) rows.push(noteRow(group, 'lock', 'Only an admin of your workspace can change these' + (who ? ', like ' + who : '') + '.'));
  return matchRows(rows, q);
}
function openOrgPalette() {
  openPage('orgSettings', ORG_TITLE, { rows: orgRows, back: BACK_TO_COMMANDS });
  tana.mcpWhere().then((w) => { serverNow = w; if (palMode === 'orgSettings' && !palette.hidden) renderPalette(); }, showError);
}
// The Orbital plugin an admin installed in ChatGPT for everyone: its chatgpt.com link pasted in, which the linking
// instructions then ask a Dot to add (main/mcp-server.js linkCode)
function pluginRows(q, typed) {
  const w = serverNow, group = 'Orbital ChatGPT plugin URL', text = String(typed || '').trim(), link = /^https:\/\/([\w-]+\.)*chatgpt\.com\/\S+$/.test(text) && text;
  const rows = [];
  if (link) rows.push({ group, icon: 'link', label: 'Use ' + serverHost(link), hint: 'For everyone', keepOpen: true, match: [], run: () => usePlugin(link) });
  else if (text) rows.push({ group, icon: 'info', label: 'A link on chatgpt.com', disabled: true, match: [] });
  if (w.plugin && !text) rows.push({ group, icon: 'link', label: serverHost(w.plugin), hint: 'Now', disabled: true, match: [] },
    { group, icon: 'reject', label: 'Clear it', hint: 'Back to adding the two servers by hand', keepOpen: true, match: [], run: () => usePlugin('') });
  return [...rows, noteRow(group, 'help', 'Once the Orbital plugin is installed in ChatGPT for everyone in your workspace, Connect your personal agent\u2019s instructions ask your Dot to add it, then link with the code.')];
}
const usePlugin = (v) => run(async () => { serverNow = await tana.mcpUsePlugin(v); showNote(v ? 'Orbital plugin set for everyone' : 'Orbital plugin cleared'); openOrgPalette(); });
const openPluginPage = () => openPage('orgField', 'Paste your Orbital plugin\'s ChatGPT link', { rows: pluginRows, back: openOrgPalette, typed: true });
// The Orbital MCP server: from Orbital Settings for Tana Workspace, or Connect your personal agent's Use a self-hosted Orbital MCP
// server … An admin hosts one by sending ChatGPT the instructions copied here (it deploys mcp-server/ on ChatGPT Sites and
// gives back its URL), then pastes that URL into this page's field. Agents are linked on one server, so after a change they
// are linked again.
// A URL typed into the page is asked what it is (main/mcp-server.js probeServer) a moment after the typing stops; the page
// then speaks of that one, not of the server in use. Only the answer for what is typed now is kept.
let serverProbe = { text: '', answer: null }, probeTimer = 0;
function probeTyped(url) {
  if (serverProbe.text === url) return serverProbe.answer;
  serverProbe = { text: url, answer: null };
  clearTimeout(probeTimer);
  const land = (answer) => { if (serverProbe.text !== url) return; serverProbe.answer = answer; if (palMode === 'mcpServer' && !palette.hidden) renderPalette(); };
  if (url && tana.mcpCheck) probeTimer = setTimeout(() => tana.mcpCheck(url).then((a) => land(a || { error: 'No answer' }), (e) => land({ error: errorText(e) })), 400);
  return null;
}
function serverPageRows(q, typed) {
  const w = serverNow;
  if (!w) return asking('Orbital MCP server');
  const group = 'Orbital MCP server · ' + (w.workspace ? 'your workspace\'s own' : 'orbital.md, until your workspace hosts its own');
  const who = setBy(w), url = String(typed || '').trim();
  // An admin on the default (orbital.md) is here to set the workspace's own: the default is not shown, nor its version.
  // A server of the workspace's own is, and so is whatever a member is told they cannot change.
  const current = !!w.workspace || !w.admin;
  const rows = current ? [{ group, icon: 'mcp', label: serverHost(w.url), hint: 'All handovers go here', disabled: true, match: [] }] : [];
  // older than this Orbital needs (main/mcp-server.js SERVER_VERSION): an admin has ChatGPT put the latest code in the same Site.
  // Said of the server in use only while nothing is typed: a typed URL gets its own answer below.
  if (current && w.outdated && !(url && w.admin)) rows.push(noteRow(group, 'info', 'Out of date: it is version ' + w.version + ', and this Orbital needs ' + w.needed + '. '
    + (w.admin ? 'Have ChatGPT update it: its address stays, so nobody links again.' : 'Ask ' + (who || 'an admin of your workspace') + ' to update it.')));
  if (w.outdated && w.admin && w.workspace && !url) rows.push({ group, icon: 'prompt', label: 'Copy the update instructions for ChatGPT', hint: 'The latest, in the same Site', keepOpen: true, match: [],
    run: () => run(() => copyText(w.update, 'Copied: send them to ChatGPT')) });
  if (!w.admin) return [...rows, noteRow(group, 'lock', 'Only an admin of your workspace can change it' + (who ? ', like ' + who : '') + '.')];
  // with a URL typed, the page is about using it: the hosting rows wait until the field is empty again
  const own = url ? 'Your own MCP server · for everyone' : 'Host your own · paste its URL above', probe = url ? probeTyped(url) : null;
  // a pasted URL first, so ↩ uses it once it answers as an MCP server this Orbital works with
  if (url && !probe) rows.push({ group: own, icon: 'link', label: 'Use ' + serverHost(url) + ' for everyone', hint: 'Checking…', disabled: true, match: [] });
  else if (probe && probe.error) rows.push(noteRow(own, 'info', probe.error));
  else if (probe && probe.outdated) rows.push(noteRow(own, 'info', 'Out of date: ' + serverHost(probe.url) + ' is version ' + probe.version + ', and this Orbital needs ' + probe.needed + '. Have ChatGPT update it, then paste it again.'));
  else if (probe) rows.push({ group: own, icon: 'link', label: 'Use ' + serverHost(probe.url) + ' for everyone', hint: 'Version ' + probe.version, keepOpen: true, match: [], run: () => useServer(probe.url) });
  if (!url) rows.push({ group: own, icon: 'prompt', label: 'Copy instructions to host your own for ChatGPT', hint: 'It deploys one on Sites', keepOpen: true, match: [],
    run: () => run(() => copyText(w.deploy, 'Copied: send them to ChatGPT')) });
  if (w.workspace && !url) rows.push({ group: own, icon: 'reload', label: 'Back to orbital.md for everyone', keepOpen: true, match: [], run: () => useServer('') });
  return [...rows, noteRow(own, 'link', 'Agents are linked on one server: after a change, everyone links theirs again.')];
}
let serverBack = BACK_TO_COMMANDS;
const useServer = (url) => run(async () => { serverNow = await tana.mcpUse(url); await loadAgentList(); showNote('Orbital MCP server: ' + serverHost(serverNow.url)); openServerPage(); });
function openServerPage(back = serverBack) {
  serverBack = back;
  openPage('mcpServer', 'Paste your Orbital MCP server\'s URL', { rows: serverPageRows, back, typed: true });
  tana.mcpWhere().then((w) => { serverNow = w; if (palMode === 'mcpServer' && !palette.hidden) renderPalette(); }, showError);
}
// Said once a session, by the first page to ask (main/agents/linked.js oldServer): the workspace's MCP server is out of date
function noteOldServer() {
  if (tana.mcpOld) tana.mcpOld().then((w) => { if (w) showNote('Your workspace\'s Orbital MCP server is out of date' + (w.admin ? ': ⌘K, Connect your personal agent, to update it' : ': ask ' + ((w.changedBy && w.changedBy.name) || 'an admin') + ' to update it')); }, () => {});
}
// A linked agent's own page: its name and where it runs, then rename, switch off and unlink
let linkedCtx = null; // the agent's id while its page or its rename page is up
function openLinkedAgent(id) {
  linkedCtx = id;
  openPage('linkedAgent', (agentNamed(id) || { label: 'Agent' }).label, { rows: linkedAgentRows, back: openAgentsPalette });
}
function linkedAgentRows(q) {
  const a = agentNamed(linkedCtx);
  if (!a) return [{ group: 'Linked agent', icon: 'link', label: 'Not linked any more', disabled: true }];
  const group = [a.label, a.app ? 'through ' + a.app : '', seenText(a.seenAt) || 'not seen yet'].filter(Boolean).join(' · ');
  const rows = [
    { group, icon: 'field', label: 'Rename …', keepOpen: true, run: () => openRenameAgent(a) },
    { group, icon: a.enabled ? 'hidden' : 'visible', label: a.enabled ? 'Switch off' : 'Switch on', hint: a.enabled ? 'Stays linked, left out of Assign to Agent' : 'Back in Assign to Agent', keepOpen: true,
      run: () => agentsApply(() => tana.enableAgent(a.id, !a.enabled)) },
    { group, icon: 'trash', label: 'Unlink', hint: 'It can no longer take tasks from Orbital', keepOpen: true,
      run: () => run(async () => { agentList = await tana.mcpUnlink(a.id); loadAgentIds(); showNote('Unlinked ' + a.label); openAgentsPalette(); }) }, // its nodes were unassigned too
  ];
  return matchRows(rows, q);
}
function openRenameAgent(a) {
  namePage('renameAgent', 'Its name in Orbital', { group: 'Rename ' + a.label + ' · ↩ saves', icon: 'field', back: () => openLinkedAgent(a.id), empty: 'Type its new name' },
    (name) => ({ label: 'Rename to “' + name + '”', keepOpen: true, match: [], run: () => run(async () => { agentList = await tana.mcpRename(a.id, name); openLinkedAgent(a.id); }) }), a.label);
}
// ---- linking a node to a task that already exists in an agent's app (#143) ----
// Pasted rather than picked: Codex's Copy link gives codex://threads/<id>. Main reads the
// paste (each agent knows its own shape) and stores the link; the badge and Go to task then work as for an assignment.
let agentLinkCtx = null; // { doc, agent } the pasted link is for, while this page is up
function agentLinkRows(q, typed) {
  const { doc, agent } = agentLinkCtx || {}, group = 'Link ' + agent.label + ' task · paste its link or id';
  if (!typed.trim()) return [{ group, icon: agent.icon, label: 'Paste the task link from ' + agent.label, disabled: true }];
  return [{ group, icon: agent.icon, label: 'Link to this ' + agent.label + ' task', keepOpen: true, run: () => run(async () => {
    await tana.linkAgentTask(doc.id, agent.id, typed.trim()); // main refuses what is not one of this agent's links, and says so
    agentIds.add(doc.id);
    closePalette(); patchAgent(doc.id); loadAgentStates();
  }) }];
}
function openAgentLink(doc, agent) {
  agentLinkCtx = { doc, agent };
  openPage('agentLink', agent.id === 'codex' ? 'codex://threads/…' : agent.label + ' session id', { rows: agentLinkRows, back: BACK_TO_COMMANDS, typed: true });
}
// ---- assigning a node to an agent: the prompt page, one level down in Cmd+K ----
// "Assign to Agent" does not assign: it advances to this page, where the palette's single-line field is swapped for a
// few lines of text. The node is the context, so the page asks only what to do with it. ↩ is an ordinary newline
// here, ⌘↩ assigns, Esc cancels the assignment and closes the palette without writing anything. The row below the
// editor is the same action as ⌘↩, so it can be clicked, and it reports why a blank prompt cannot be sent. Under it,
// the agents that are on, the default ticked: the agent's own default model does the work, so there is nothing else
// to choose.
let agentCtx = null; // { id } of the node the prompt being typed belongs to, while this page is up
const AGENT_GROUP = 'Assign to Agent · ↩ adds a line, ⌘↩ assigns, Esc cancels';
const PICK_GROUP = 'Agent';
function promptEditor(on) {
  palText.hidden = !on; palInput.hidden = !!on;
  if (!on) { palText.value = ''; agentCtx = null; palInput.type = 'text'; }
}
function openAgentPrompt(doc, pick) {
  // No back: Escape cancels the whole thing rather than stepping back a level. The page was opened to answer one
  // question, and abandoning that question is abandoning the assignment. Nothing is written either way.
  showPage('agentPrompt', '', { rows: agentPromptRows, typed: true }); // the query that found "Assign to Agent" is not a query here, and would bold letters in the row
  promptEditor(true); // shows the editor, empty; leaving the page clears it and the context with it
  agentCtx = { id: doc.id, doc, fixed: !!pick }; // the row itself, so the assignment can hold it where it sits; fixed: its row named the agent
  // it starts on the agent its row named (Assign to Echo …), or else on the default
  agentPick = (agentsOn().find((a) => a.id === pick) || agentsOn().find((a) => a.isDefault) || agentsOn()[0] || { id: 'tana' }).id;
  renderPalette(); palText.focus();
}
function agentPromptRows() {
  const prompt = palText.value.trim(), label = (agentNamed(agentPick) || {}).label || 'Agent';
  // The agent it goes to is named on the row that sends it: the tick sits in a list you have to Tab into, so ⌘↩ from
  // the editor is the only thing most assignments see.
  const rows = [{ group: AGENT_GROUP, icon: 'robot', label: prompt ? 'Assign to ' + label : 'What should ' + label + ' do?',
    hint: prompt ? '⌘↩' : 'Nothing to send yet', disabled: !prompt, keepOpen: true, run: submitAgentPrompt }];
  // Only with a choice to make: Tana alone needs no list. Choosing keeps the keyboard where it was: picked from the
  // list, the list keeps it so another can be tried; clicked or reached from the editor, the caret goes back.
  // Not when the row that opened the page already named the agent (Assign to Echo …): the choice is made
  const on = agentCtx && agentCtx.fixed ? [] : agentsOn();
  if (on.length > 1) for (const a of on) rows.push({ group: PICK_GROUP, icon: a.icon, label: a.label, hint: agentPick === a.id ? '✓' : '', keepOpen: true,
    run: () => { const onList = document.activeElement === palList; agentPick = a.id; renderPalette(); (onList ? palList : palText).focus(); } });
  return rows;
}
// The prompt is written with the assignment, so a node is never marked as the agent's with no idea of what it was handed.
function submitAgentPrompt() {
  const prompt = palText.value.trim(), id = agentCtx && agentCtx.id, doc = agentCtx && agentCtx.doc;
  if (!prompt || !id) return; // ⌘↩ on a blank page is not a press to answer
  run(async () => {
    // Under Group by Responsibility the row belongs in Agent the moment this is written, and under any grouping it
    // may now sort elsewhere. Held, it keeps the place it had — nothing jumps away from the pointer — and the Clean
    // up pill appears to redraw the list where the row now belongs, exactly as a status change behaves.
    if (doc) holdRow(doc);
    await tana.setAgent(id, true, prompt, agentPick);
    // Only now: an agent that could not take it leaves the page exactly as it was, so the press can simply be repeated.
    closePalette();
    agentIds.add(id);
    patchAgent(id);
    loadAgentStates(); // the task exists now: ask what it is doing rather than waiting for the next refresh
    renderPills(true); // the row is held above, so this is what puts Clean up in front of it (renderer/pills.js)
    // The context block is content main wrote on its own, so the open page has to be told: the live change does say
    // so, but the palette hands the caret back to the row it came from and a render with a caret in a row is
    // deferred until it leaves — which left the block invisible until the page was reopened. Re-asked and drawn
    // here, forced, the way the Refresh pill draws its own answer. render() puts the caret back where it was.
    if (kids.has(id)) { await reload(id); render(true); }
  });
}
function agentPromptKey(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); backPalette(); return true; }
  if (e.key === 'Enter' && mod) { e.preventDefault(); e.stopPropagation(); submitAgentPrompt(); return true; }
  // ⇥ crosses to the agent list and back, so the choice is reachable without leaving the keyboard. The editor eats
  // Tab either way — a tab character in a prompt is not what anyone means by pressing it here.
  if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); focusAgentRows(); return true; }
  return false; // a plain ↩ is a newline, which the textarea does by itself
}
// The agent rows take the keyboard as a group: the list itself holds the focus, and the highlighted row is the one
// the palette already draws, so this borrows the navigation every other level uses rather than inventing one.
function focusAgentRows() {
  const first = palRows.findIndex((r) => r.group === PICK_GROUP);
  if (first < 0) return;
  palIndex = first;
  palList.tabIndex = -1;
  renderPalette();
  palList.focus();
}
function agentRowsKey(e) {
  if (palMode !== 'agentPrompt') return false;
  if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); palText.focus(); return true; } // back to what you were writing
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); backPalette(); return true; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); movePalIndex(e.key === 'ArrowDown' ? 1 : -1); palList.focus(); return true; }
  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); runRow(palRows[palIndex]); return true; }
  return false;
}
palList.addEventListener('keydown', agentRowsKey);
palText.addEventListener('input', () => { if (palMode === 'agentPrompt') renderPalette(); });
palText.addEventListener('keydown', agentPromptKey);
