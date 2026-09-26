'use strict';
// The agent's pages in Cmd+K: signing in with ChatGPT, the OpenAI API key, the machines a Codex task can run on,
// linking a task that already exists in Codex, and the prompt page Assign to Agent opens. renderer/palette.js lists
// their rows and draws every page; the agent's badge and state are renderer/render.js and renderer/nodes.js.

// ---- ChatGPT sign-in and the OpenAI API key ----
let chatgptAuth = null, chatgptAuthLoading = null;
function openOpenAIKeyPalette() {
  openPage('openaiKey', 'Paste OpenAI API key', { rows: openAIKeyRows, back: BACK_TO_COMMANDS }); palInput.type = 'password';
}
function refreshChatGPTStatus() {
  if (!tana.chatgptStatus || chatgptAuthLoading) return;
  chatgptAuthLoading = Promise.resolve(tana.chatgptStatus()).then((status) => { chatgptAuth = status; }, (error) => { chatgptAuth = { available: false, signedIn: false, error: error.message }; })
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
    { group: 'Actions', icon: 'chatgpt', label: 'Cancel ChatGPT sign-in', run: () => run(async () => { chatgptAuth = await tana.chatgptCancel(); renderPalette(); }) },
  ];
  else if (chatgptAuth.signedIn) rows = [
    { group: 'ChatGPT', icon: 'chatgpt', label: 'Signed in as ' + (chatgptAuth.email || 'ChatGPT'), hint: 'Preferred over API key', disabled: true },
    { group: 'Actions', icon: 'chatgpt', label: 'Sign out of ChatGPT', run: () => run(async () => { chatgptAuth = await tana.chatgptLogout(); renderPalette(); }) },
  ];
  else rows = [
    { group: 'ChatGPT', icon: 'chatgpt', label: chatgptAuth.available === false ? 'Sign-in unavailable' : 'Not signed in', hint: chatgptAuth.available === false ? (chatgptAuth.error || 'Codex CLI unavailable') : 'Preferred over API key', disabled: true },
    { group: 'Actions', icon: 'chatgpt', label: 'Sign in with ChatGPT', run: startChatGPTLogin },
  ];
  return q ? rows.filter((row) => fuzzyMatch(row.label.toLowerCase(), q)) : rows;
}
if (tana.onChatGPTStatus) tana.onChatGPTStatus((status) => {
  chatgptAuth = status;
  if (!palette.hidden && (palMode === 'cmd' || palMode === 'chatgpt')) renderPalette();
});
function openAIKeyRows() {
  const key = palInput.value.trim();
  return [{ group: 'OpenAI API key', icon: 'openaiKey', label: key ? 'Save OpenAI API key' : 'Enter OpenAI API key',
    hint: key ? '↩ saves locally' : 'Nothing to save yet', disabled: !key, keepOpen: true,
    run: () => run(async () => { await tana.setOpenAIKey(key); closePalette(); }) }];
}
// ---- the machines a task can run on, managed from Cmd+K ----
// One page: what is configured, and a line to add another. The form is the palette's own field — "Name, address,
// path to codex", three values separated by spaces — because a page of three inputs is more machinery than this
// needs and the palette already knows how to take one line. Main validates and stores; nothing is run here.
const HOSTS_GROUP = 'Codex hosts · type "Name ssh-address /path/to/codex" to add one, ↩ on a host removes it';
let hostList = null; // null while the list is in flight
const hostsApply = (call) => run(async () => { hostList = await call(); agentHosts = hostList; renderPalette(); });
function hostRows(q, typed) {
  const rows = (hostList || []).filter((h) => h.id !== 'local').map((h) => ({ group: HOSTS_GROUP, icon: 'host', label: h.title,
    hint: '↩ removes it · its tasks stay', keepOpen: true, run: () => hostsApply(() => tana.removeCodexHost(h.id)) }));
  const parts = typed.trim().split(/\s+/);
  if (parts.length >= 3) {
    const [title, ssh, bin] = [parts.slice(0, parts.length - 2).join(' '), parts[parts.length - 2], parts[parts.length - 1]];
    rows.unshift({ group: HOSTS_GROUP, icon: 'createNew', label: 'Add "' + title + '" on ' + ssh, hint: bin, keepOpen: true,
      run: () => run(async () => { await tana.addCodexHost(title, ssh, bin); palInput.value = ''; hostsApply(() => tana.codexHosts()); }) });
  }
  if (!rows.length) rows.push({ group: HOSTS_GROUP, label: hostList ? 'No other machines yet' : 'Loading…', disabled: true });
  return rows;
}
function openHostsPalette() {
  hostList = null; openPage('hosts', 'Name  ssh-address  /path/to/codex', { rows: hostRows, back: BACK_TO_COMMANDS });
  hostsApply(() => tana.codexHosts());
}
// ---- linking a node to a Codex task that already exists (#143) ----
// Pasted rather than picked: Codex's Copy link gives codex://threads/<id>, and a bare id works too. Main checks it
// again and stores it as a task on this machine; the badge and Go to Agent task then work as for any assignment.
const CODEX_LINK = /^(?:codex:\/\/threads\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
let agentLinkDoc = null; // the node the pasted link is for, while this page is up
function agentLinkRows(q, typed) {
  const group = 'Link Agent task · paste a codex://threads/… link', m = typed.trim().match(CODEX_LINK), doc = agentLinkDoc;
  if (!m) return [{ group, icon: 'robot', label: typed.trim() ? 'Not a Codex task link' : 'Paste the task link from Codex', disabled: true }];
  return [{ group, icon: 'robot', label: 'Link to Codex task ' + m[1].slice(0, 8) + '…', keepOpen: true, run: () => run(async () => {
    await tana.linkCodexTask(doc.id, m[1]);
    codexIds.add(doc.id); agentTaskHosts.set(doc.id, 'local');
    closePalette(); patchCodex(doc.id); loadAgentStates();
  }) }];
}
function openAgentLink(doc) {
  agentLinkDoc = doc; openPage('agentLink', 'codex://threads/…', { rows: agentLinkRows, back: BACK_TO_COMMANDS });
}
// ---- assigning a node to the local agent: the prompt page, one level down in Cmd+K ----
// "Assign to Agent" does not assign: it advances to this page, where the palette's single-line field is swapped for a
// few lines of text. The node is the context, so the page asks only what to do with it. ↩ is an ordinary newline
// here, ⌘↩ assigns, Esc cancels the assignment and closes the palette without writing anything. The one row below
// the editor is the same action as ⌘↩, so it can be clicked, and it reports why a blank prompt cannot be sent.
let agentCtx = null; // { id } of the node the prompt being typed belongs to, while this page is up
const AGENT_GROUP = 'Assign to Agent · ↩ adds a line, ⌘↩ assigns, Esc cancels';
const MODEL_GROUP = 'Model for this task';
const HOST_GROUP = 'Where it runs';
function promptEditor(on) {
  palText.hidden = !on; palInput.hidden = !!on;
  if (!on) { palText.value = ''; agentCtx = null; palInput.type = 'text'; }
}
function openAgentPrompt(doc) {
  // No back: Escape cancels the whole thing rather than stepping back a level. The page was opened to answer one
  // question, and abandoning that question is abandoning the assignment. Nothing is written either way.
  showPage('agentPrompt', '', { rows: agentPromptRows, typed: true }); // the query that found "Assign to Agent" is not a query here, and would bold letters in the row
  promptEditor(true); // shows the editor, empty; leaving the page clears it and the context with it
  agentCtx = { id: doc.id, doc }; // the row itself, so the assignment can hold it where it sits
  agentModel = ''; // every assignment chooses again; Codex's own default until it does
  agentHost = 'local'; // this machine unless the page says otherwise
  if (tana.codexHosts && !agentHosts.length) tana.codexHosts().then((list) => { agentHosts = Array.isArray(list) ? list : []; if (palMode === 'agentPrompt') renderPalette(); }, () => {});
  if (tana.codexModels && !agentModels.length) tana.codexModels().then((list) => { agentModels = Array.isArray(list) ? list : []; if (palMode === 'agentPrompt') renderPalette(); }, () => {});
  renderPalette(); palText.focus();
}
function agentPromptRows() {
  const prompt = palText.value.trim();
  // Where it will run is named on the row that sends it: the tick sits in a list you have to Tab into, so ⌘↩ from
  // the editor was the only thing most assignments ever saw, and a task meant for another machine ran here silently.
  const runsOn = (agentHosts.find((h) => h.id === agentHost) || {}).title || 'This Mac';
  const rows = [{ group: AGENT_GROUP, icon: 'robot', label: prompt ? 'Assign to Agent on ' + runsOn : 'What should the agent do?',
    hint: prompt ? '⌘↩' : 'Nothing to send yet', disabled: !prompt, keepOpen: true, run: submitAgentPrompt }];
  // The model for this one assignment, chosen with the same keys as any other palette row. The list is Codex's own
  // (model/list), so nothing here goes stale; with no list the default stands alone rather than a guessed menu.
  // Choosing keeps the keyboard where it already was: picked from the list, the list keeps it so another can be
  // tried; clicked or reached from the editor, the caret goes back to what you were writing.
  const pick = (id) => ({ group: MODEL_GROUP, icon: 'brain', label: id || 'Codex default', hint: agentModel === id ? '✓' : '',
    keepOpen: true, run: () => { const onList = document.activeElement === palList; agentModel = id; renderPalette(); (onList ? palList : palText).focus(); } });
  rows.push(pick(''));
  for (const id of agentModels) rows.push(pick(id));
  // And which machine runs it, chosen the same way. Only names: the address and the command live in main.
  const host = (h) => ({ group: HOST_GROUP, icon: 'host', label: h.title, hint: agentHost === h.id ? '✓' : '',
    keepOpen: true, run: () => { const onList = document.activeElement === palList; agentHost = h.id; renderPalette(); (onList ? palList : palText).focus(); } });
  for (const h of agentHosts) rows.push(host(h));
  return rows;
}
// Saving the prompt is all "send" means in this slice: nothing is run, nothing is dispatched. The prompt is written
// with the assignment, so a node is never marked as the agent's with no idea of what it was handed.
function submitAgentPrompt() {
  const prompt = palText.value.trim(), id = agentCtx && agentCtx.id, doc = agentCtx && agentCtx.doc;
  if (!prompt || !id) return; // ⌘↩ on a blank page is not a press to answer
  run(async () => {
    // Under Group by Responsibility the row belongs in Agent the moment this is written, and under any grouping it
    // may now sort elsewhere. Held, it keeps the place it had — nothing jumps away from the pointer — and the Clean
    // up pill appears to redraw the list where the row now belongs, exactly as a status change behaves.
    if (doc) holdRow(doc);
    await tana.setCodex(id, true, prompt, agentModel || undefined, agentHost); // '' model means Codex's own default
    // Only now: a machine that could not be reached leaves the page exactly as it was — prompt, model and host still
    // chosen — so the press can simply be repeated once it wakes up.
    closePalette();
    codexIds.add(id);
    patchCodex(id);
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
  // ⇥ crosses to the model list and back, so the picker is reachable without leaving the keyboard. The editor eats
  // Tab either way — a tab character in a prompt is not what anyone means by pressing it here.
  if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); focusModelRows(); return true; }
  return false; // a plain ↩ is a newline, which the textarea does by itself
}
// The model rows take the keyboard as a group: the list itself holds the focus, and the highlighted row is the one
// the palette already draws, so this borrows the navigation every other level uses rather than inventing one.
function focusModelRows() {
  const first = palRows.findIndex((r) => r.group === MODEL_GROUP);
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
