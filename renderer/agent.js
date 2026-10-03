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
  chatgptAuthLoading = Promise.resolve(tana.chatgptStatus()).then((status) => { if (asked === chatgptPushes) chatgptAuth = status; }, (error) => { chatgptAuth = { available: false, signedIn: false, error: error.message }; })
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
  return q ? rows.filter((row) => fuzzyMatch(row.label.toLowerCase(), q)) : rows;
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
// ---- Choose agents, and Set default agent ----
// Every agent the app knows, in one list: Tana always on, Codex and Claude greyed with what to install until this Mac has
// them, then your linked Dot (each linked agent has a page of its own: ↩ opens it), with Connect to your OpenAI Dot under
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
  if (tana.relayLink) {
    const linked = agentList.filter((a) => a.linked);
    for (const a of linked) rows.push({ group: AGENTS_GROUP, icon: a.icon, label: a.label + ' \u2026', keepOpen: true,
      hint: [a.enabled ? 'On' : 'Off', a.app, seenText(a.seenAt)].filter(Boolean).join(' · '), run: () => openLinkedAgent(a.id) });
    rows.push({ group: AGENTS_GROUP, icon: 'chatgpt', label: 'Connect to your OpenAI Dot …', hint: 'Orbital and Tana in ChatGPT, then a code', keepOpen: true, run: () => openLinkPalette(openAgentsPalette) });
  }
  return q ? rows.filter((row) => fuzzyMatch(row.label.toLowerCase(), q)) : rows;
}
function openAgentsPalette() {
  loadAgentList().then(() => { if (palMode === 'agents') renderPalette(); });
  openPage('agents', 'Choose agents', { rows: agentsRows, back: BACK_TO_COMMANDS });
}
function defaultAgentRows(q) {
  const rows = agentsOn().map((a) => ({ group: DEFAULT_GROUP, icon: a.icon, label: a.label, hint: a.isDefault ? '✓' : '', keepOpen: true,
    run: () => agentsApply(() => tana.setDefaultAgent(a.id)) }));
  return q ? rows.filter((row) => fuzzyMatch(row.label.toLowerCase(), q)) : rows;
}
function openDefaultAgentPalette() {
  loadAgentList().then(() => { if (palMode === 'defaultAgent') renderPalette(); });
  openPage('defaultAgent', 'Set default agent', { rows: defaultAgentRows, back: BACK_TO_COMMANDS });
}
// ---- Connect to your OpenAI Dot: orbital.md/mcp and Tana's server added in ChatGPT, then linked with a one-time code ----
// (main/agents/linked.js) ChatGPT has no link to its own "Create custom MCP server" form and a Dot cannot add a server
// itself, so the page says where to go and names both servers as that form wants them, a name and a URL (↩ copies the
// URL). Then one row copies the message for your Dot, which only links. The page asks every two seconds whether that
// happened; once it has, the palette closes on a toast naming the agent. Leaving the page does not stop the code: a Dot
// that uses it later shows up in Choose agents all the same.
const CHATGPT_PLUGINS = 'https://chatgpt.com/plugins';
let relayCtx = null; // { state: asking|waiting|expired|failed, code, prompt, expiresAt, error, back } while the page is up
let relayTimer = null;
const unwrapError = (e) => String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
function openLinkPalette(back = BACK_TO_COMMANDS) {
  const ctx = relayCtx = { state: 'asking', back };
  openPage('linkAgent', 'Connect to your OpenAI Dot', { rows: relayRows, back, typed: true });
  Promise.resolve(tana.relayLink()).then((r) => { if (relayCtx !== ctx) return; Object.assign(ctx, r, { state: 'waiting' }); drawRelay(); pollRelay(ctx); },
    (e) => { if (relayCtx !== ctx) return; ctx.state = 'failed'; ctx.error = unwrapError(e); drawRelay(); });
}
const drawRelay = () => { if (palMode === 'linkAgent' && !palette.hidden) renderPalette(); };
function pollRelay(ctx) {
  clearTimeout(relayTimer);
  relayTimer = setTimeout(async () => {
    if (relayCtx !== ctx || palMode !== 'linkAgent' || palette.hidden) return;
    try {
      const s = await tana.relayLinkStatus(ctx.code);
      if (relayCtx !== ctx) return;
      if (s.state === 'linked') {
        relayCtx = null;
        await loadAgentList();
        closePalette();
        return showNote('Linked ' + s.agent.label + (s.agent.app ? ' · ' + s.agent.app : ''));
      }
      ctx.state = s.state;
    } catch { /* a missed answer: the next one asks again */ }
    drawRelay();
    if (ctx.state === 'waiting') pollRelay(ctx);
  }, 2000);
}
function relayRows() {
  const c = relayCtx || { state: 'asking' }, again = { icon: 'reload', keepOpen: true, run: () => openLinkPalette(c.back) }, title = 'Connect to your OpenAI Dot';
  if (c.state === 'asking') return [{ group: title, label: 'Getting a code…', disabled: true, sweep: true, bare: true, match: [] }];
  if (c.state === 'failed') return [{ group: title, icon: 'link', label: c.error || 'No code', disabled: true, match: [] }, { ...again, group: title, label: 'Try again', match: [] }];
  const left = Math.max(0, (c.expiresAt || 0) - Date.now());
  // first both servers, in ChatGPT: a name and a URL each, as its form asks, the rest left as it is
  const add = 'Add both in ChatGPT · Add, then Create custom MCP server · the rest as it is';
  const server = (icon, label, url) => ({ group: add, icon, label, hint: url + ' · ↩ copies', keepOpen: true, match: [], run: () => run(() => copyText(url, 'Copied ' + label + '\u2019s URL')) });
  const rows = [{ group: add, icon: 'chatgpt', label: 'Open ChatGPT plugins', hint: CHATGPT_PLUGINS.replace('https://', ''), keepOpen: true, match: [], run: () => run(() => tana.openExternal(CHATGPT_PLUGINS)) },
    server('orbital', 'Orbital', c.url), server('tana', 'Tana', c.tana)];
  // then the message, which only links: what goes through orbital.md is in it too, for the Dot to explain
  const group = 'Then ask your Dot to link';
  rows.push({ group, icon: 'prompt', label: 'Copy the message for your Dot', hint: '↩ copies', keepOpen: true, match: [],
    run: () => run(() => copyText(c.prompt, 'Copied: send it to your Dot')) },
  // what crosses orbital.md (main/agents/linked.js send): an event with a node's id, and nothing back
  { group, icon: 'lock', label: 'Only ids go through orbital.md: your words stay in Tana, where your Dot reads them with its own Tana access.', note: true, wrap: true, disabled: true, match: [] });
  // the wait sits in the same group: no heading of its own, and no glyph, only its words with the light passing over them
  if (c.state === 'expired' || !left) return [...rows, { group, label: 'The code expired', hint: 'Nobody used it', disabled: true, bare: true, match: [] }, { ...again, group, label: 'Get a new code', match: [] }];
  return [...rows,
    { group, label: 'Waiting for your Dot to use the code…', hint: 'Works once · ' + Math.floor(left / 60000) + ':' + String(Math.floor(left / 1000) % 60).padStart(2, '0') + ' left', disabled: true, sweep: true, bare: true, match: [] },
    { group, icon: 'reject', label: 'Cancel', hint: 'The code stops working', keepOpen: true, match: [], run: () => { relayCtx = null; run(() => tana.relayLinkCancel(c.code)); (c.back || closePalette)(); } }];
}
// When the relay last heard from an agent, in a few words
function seenText(at) {
  if (!at) return '';
  const min = Math.round((Date.now() - at) / 60000);
  return min < 2 ? 'seen just now' : min < 60 ? 'seen ' + min + ' min ago' : min < 48 * 60 ? 'seen ' + Math.round(min / 60) + ' h ago' : 'not seen for ' + Math.round(min / 1440) + ' days';
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
      run: () => run(async () => { agentList = await tana.relayUnlink(a.id); showNote('Unlinked ' + a.label); openAgentsPalette(); }) },
  ];
  return q ? rows.filter((r) => fuzzyMatch(r.label.toLowerCase(), q)) : rows;
}
function openRenameAgent(a) {
  const group = 'Rename ' + a.label + ' · ↩ saves';
  openPage('renameAgent', 'Its name in Orbital', { typed: true, back: () => openLinkedAgent(a.id), rows: (q, typed) => (typed.trim()
    ? [{ group, icon: 'field', label: 'Rename to “' + typed.trim() + '”', keepOpen: true, match: [], run: () => run(async () => { agentList = await tana.relayRename(a.id, typed.trim()); openLinkedAgent(a.id); }) }]
    : [{ group, icon: 'field', label: 'Type its new name', disabled: true, match: [] }]) }, a.label);
}
// ---- linking a node to a task that already exists in an agent's app (#143) ----
// Pasted rather than picked: Codex's Copy link gives codex://threads/<id>, Claude's session is its id. Main reads the
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
  agentCtx = { id: doc.id, doc }; // the row itself, so the assignment can hold it where it sits
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
  const on = agentsOn();
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
