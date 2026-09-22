'use strict';
// Automations in the outliner: ⌘K "Create automation" (a description, nothing else: the AI writes the automation)
// and the Automations page, which lists them in the outline's own row and field style. The page lets you switch
// one on or off and delete it; changing what one does is another description, handed to the AI (main/automations.js).
let automationList = null;    // what main last listed; null until the page has asked
let automationCtx = null;     // the automation being changed on the prompt page, null when creating one
let automationBusy = false;   // the AI is writing: the prompt row breathes and ⌘↩ waits
let automationError = '';     // why the last attempt was refused, shown on the prompt page
let automationArrive = false;  // the one build after the AI answered: its sparkle settles, as Discuss with's does
const automationOpen = new Set(); // ids whose When/Then are unfolded on the page
const AUTOMATION_GROUP = 'Describe what should happen · ⌘↩ creates, Esc cancels';

// ---- the prompt page, one level down in ⌘K ----
function openAutomationPrompt(current) {
  palMode = 'automation'; palRows = []; palIndex = 0; palette.hidden = false;
  promptEditor(true);
  palInput.value = '';
  automationCtx = current || null; automationBusy = false; automationError = '';
  // Editing starts from the description it was made from: change the words, and the AI rewrites the automation.
  palText.value = current ? current.description || '' : '';
  palText.placeholder = current ? 'Describe what “' + current.name + '” should do' : 'When a task is added that says it should be discussed with someone, make it a Discussion Task and fill in Discuss with';
  renderPalette(); palText.focus(); palText.setSelectionRange(palText.value.length, palText.value.length);
}
function automationPromptRows() {
  const text = palText.value.trim();
  const group = automationCtx ? 'Edit “' + automationCtx.name + '” · ⌘↩ saves, Esc cancels' : AUTOMATION_GROUP;
  const label = automationBusy ? (automationCtx ? 'Rewriting automation…' : 'Writing automation…') : automationCtx ? 'Save automation' : 'Create automation';
  // While the AI writes, the row wears the same breathing sparkle Discuss with shows while it reads a title
  // (styles.css .ricon.thinking animates the sparkle's own parts), and a refusal settles in the way its answer does.
  const arrive = automationArrive; automationArrive = false;
  const rows = [{ group, icon: automationBusy ? 'sparkle' : 'automation', label, spin: automationBusy, hint: automationBusy ? '' : text ? '⌘↩' : 'Nothing described yet',
    disabled: !text || automationBusy, keepOpen: true, run: submitAutomation }];
  if (automationError) rows.push({ group, icon: 'sparkle', arrive, label: automationError, disabled: true });
  return rows;
}
function submitAutomation() {
  const text = palText.value.trim();
  if (!text || automationBusy) return;
  automationBusy = true; automationError = ''; renderPalette();
  (automationCtx ? tana.changeAutomation(automationCtx.id, text) : tana.createAutomation(text)).then((id) => {
    automationBusy = false;
    if (palMode !== 'automation') return; // the page was left while the AI wrote; the list still picks it up
    closePalette();
    automationOpen.add(id);
    showAutomations();
  }, (e) => {
    automationBusy = false; automationArrive = true; automationError = String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    if (palMode === 'automation') { renderPalette(); palText.focus(); }
  });
}

// ---- the page ----
function showAutomations() {
  flushAll(); dropDrafts(); releaseHeld();
  zoom = null; sel = null; automationsShown = true; automationsView = view;
  loadAutomations();
  render(true);
}
function loadAutomations() {
  if (!tana.automations) return;
  tana.automations().then((list) => { automationList = Array.isArray(list) ? list : []; if (automationsShown) renderSoon(); }, showError);
}
// Called at the end of every render: the page stands in for the outline while it is shown, and gives it back after.
function drawAutomationsPage() {
  if (automationsShown && (zoom || view !== automationsView)) automationsShown = false; // any navigation leaves the page
  const page = $('automations');
  page.hidden = !automationsShown;
  outline.hidden = automationsShown;
  if (!automationsShown) return;
  $('filtered').textContent = ''; filterRow.hidden = true; renderPills(false);
  titleEl.removeAttribute('contenteditable'); titleEl.dataset.key = ''; titleEl.textContent = 'Automations'; titleEl.classList.remove('done');
  titleCheck.hidden = true; taskInfoEl.hidden = true; $('fields').hidden = true; $('skeleton').classList.add('gone');
  const rows = [];
  for (const a of automationList || []) rows.push(automationRow(a));
  if (!rows.length) {
    const note = document.createElement('div'); note.className = 'empty-note';
    note.textContent = automationList ? 'No automations yet. ⌘K, Create automation.' : 'Loading…';
    rows.push(note);
  }
  page.replaceChildren(...rows);
}
// The page's words mark a Tana type as #[Title|uri|hue] and the people as #[Person|member] (main/automations.js
// describe): a chip with the type's own glyph (typeGlyphs, else the generic one) or the member glyph, in the type's
// colour; plain text (the folded row's grey line) keeps only the title.
const TAG_MARK = /#\[([^\]|]+)(?:\|([^\]|]*))?(?:\|([^\]|]*))?\]/g;
const tagText = (s) => String(s || '').replace(TAG_MARK, '$1');
function appendTagged(el, s) {
  let at = 0;
  for (const m of String(s || '').matchAll(TAG_MARK)) {
    if (m.index > at) el.append(s.slice(at, m.index));
    const [, label, uri, hue] = m, chip = document.createElement('span');
    chip.className = 'ftag' + (hue ? ' hue' : '');
    if (hue) chip.style.setProperty('--hue', hue);
    const icon = iconNode(uri === 'member' ? 'member' : typeGlyphs.get(uri) || 'type');
    if (icon) chip.append(icon);
    chip.append(label);
    el.append(chip); at = m.index + m[0].length;
  }
  if (at < String(s || '').length) el.append(s.slice(at));
}
function automationRow(a) {
  const isOpen = automationOpen.has(a.id);
  const el = document.createElement('div');
  el.dataset.id = a.id;
  el.className = 'node automation' + (a.enabled ? '' : ' off') + (isOpen ? '' : ' collapsed');
  const line = document.createElement('div'); line.className = 'line';
  const chev = document.createElement('button'); chev.className = 'chev' + (isOpen ? '' : ' closed'); chev.tabIndex = -1;
  const bullet = document.createElement('span'); bullet.className = 'bullet icon still'; bullet.append(iconNode('automation'));
  const body = document.createElement('div'); body.className = 'body';
  const name = document.createElement('span'); name.className = 'text'; name.textContent = a.name;
  const meta = document.createElement('span'); meta.className = 'meta';
  // folded, the grey line says when it runs; unfolded the flow below says it, so the line keeps only the counts
  meta.textContent = [isOpen ? '' : 'When ' + tagText(a.when), a.runs ? 'ran ' + a.runs + '×' : '', a.last && !a.last.ok ? 'last run failed' : ''].filter(Boolean).join(' · ');
  body.append(name, meta);
  // Edit and delete show on hover (and on the open row); the switch is always there, since it is the state.
  const tools = document.createElement('span'); tools.className = 'automation-tools';
  const tool = (icon, title, fn) => { const b = document.createElement('button'); b.className = 'navbtn'; b.title = title; b.tabIndex = -1; b.append(iconNode(icon)); b.onclick = (e) => { e.stopPropagation(); fn(); }; tools.append(b); };
  tool('updated', 'Edit', () => { palReturn = null; openAutomationPrompt(a); });
  tool('trash', 'Delete', () => run(async () => { await tana.removeAutomation(a.id); automationOpen.delete(a.id); loadAutomations(); }));
  const toggle = document.createElement('button');
  toggle.className = 'automation-switch' + (a.enabled ? ' on' : ''); toggle.tabIndex = -1;
  toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(a.enabled)); toggle.title = a.enabled ? 'On · click to turn off' : 'Off · click to turn on';
  toggle.onclick = (e) => { e.stopPropagation(); run(async () => { await tana.setAutomationEnabled(a.id, !a.enabled); loadAutomations(); }); };
  line.append(chev, bullet, body, tools, toggle);
  line.onclick = () => { if (isOpen) automationOpen.delete(a.id); else automationOpen.add(a.id); render(true); };
  el.append(line);
  if (isOpen) el.append(automationFlow(a));
  if (isOpen && a.last) el.append(automationFacts(a));
  return el;
}
// The flow: the trigger, then every node as a step with its glyph on one vertical line; an if's branches hang off
// it, indented, under a Yes or No. The dots sit in the row's own icon column and the words start where its name
// does, so the flow reads as the row's content. What a step produces is a named pill under it, and a later step
// that reads it shows the same pill, so where each value comes from can be followed by eye.
function automationFlow(a) {
  const flow = document.createElement('div'); flow.className = 'automation-flow';
  const pill = (name) => { const p = document.createElement('span'); p.className = 'fvar'; p.textContent = name; return p; };
  const step = (s) => {
    const row = document.createElement('div');
    row.className = 'fstep' + (s.branch ? ' fbranch' : '');
    row.style.setProperty('--depth', String(s.depth || 0));
    if (s.branch) { row.textContent = s.branch; return flow.append(row); }
    const dot = document.createElement('span'); dot.className = 'fdot'; dot.append(iconNode(s.icon));
    const words = document.createElement('div'); words.className = 'fwords';
    const title = document.createElement('span'); title.className = 'ftitle';
    title.textContent = s.title;
    words.append(title);
    if (s.text) { const text = document.createElement('span'); text.className = 'ftext'; appendTagged(text, s.text); words.append(text); }
    if (s.var) words.append(pill(s.var));
    if (s.after) { const after = document.createElement('span'); after.className = 'ftext'; appendTagged(after, s.after); words.append(after); }
    // which model answers an AI step: a label at the end of its line
    if (s.model) { const m = document.createElement('span'); m.className = 'fmodel' + (s.model === 'smart' ? ' smart' : ''); m.textContent = s.model === 'smart' ? 'Smart AI' : 'Fast AI'; m.title = s.model === 'smart' ? 'Answered by the SMART model: slower, for real judgement' : 'Answered by the FAST model'; words.append(m); }
    if (s.note) { const n = document.createElement('span'); n.className = 'fnote'; n.textContent = s.note; words.append(n); }
    if (s.output) { const out = document.createElement('span'); out.className = 'fout'; out.append('Saved as ', pill(s.output)); words.append(out); }
    row.append(dot, words);
    flow.append(row);
  };
  step({ icon: a.triggerIcon || 'created', title: 'When', text: a.when });
  for (const s of a.steps || []) step(s);
  return flow;
}
// Below the flow, in the fields grid typed documents use: how it last went, when it has run this session.
function automationFacts(a) {
  const grid = document.createElement('div'); grid.className = 'fields inline-fields';
  const f = document.createElement('div'); f.className = 'field';
  const icon = document.createElement('span'); icon.className = 'ricon';
  const l = document.createElement('span'); l.className = 'flabel'; l.textContent = 'Last run';
  const values = document.createElement('div'); values.className = 'fvalues';
  const v = document.createElement('div'); v.className = 'fvalue ' + (a.last.ok ? 'quiet' : 'err');
  v.textContent = (a.last.ok ? 'Worked on “' : 'Failed on “') + (a.last.title || 'Untitled') + '”' + (a.last.ok ? '' : ': ' + a.last.error);
  values.append(v); f.append(icon, l, values); grid.append(f);
  return grid;
}
if (tana.onAutomations) tana.onAutomations(() => { if (automationsShown) loadAutomations(); });

// ---- what is running now: an amber bolt that draws itself on the node's row and on its page title, and the
// automation's own bolt on the Automations page doing the same. Main holds each for at least a moment. ----
let automationRuns = { items: [], automations: [] };
function automationRunEl() {
  const el = document.createElement('span'); el.className = 'arun'; el.setAttribute('role', 'img');
  el.title = el.ariaLabel = 'An automation is running on this';
  const svg = iconNode('automation');
  if (svg) { svg.querySelectorAll('path').forEach((p) => p.setAttribute('pathLength', '1')); el.append(svg); }
  return el;
}
// Patched onto whatever is on screen, after every render and whenever the set changes, rather than built into the row:
// a row reused unchanged (rowSig) would otherwise never get or lose the badge.
function paintAutomationRuns() {
  for (const el of document.querySelectorAll('.arun')) el.remove();
  for (const id of automationRuns.items) {
    for (const line of eachRow('.node[data-key="' + CSS.escape(id) + '"] > .line')) line.append(automationRunEl());
    if (zoom && !zoom.nodeId && zoom.docId === id && titleEl.parentElement) titleEl.parentElement.append(automationRunEl());
  }
  for (const row of document.querySelectorAll('#automations .node.automation')) {
    const on = automationRuns.automations.includes(row.dataset.id);
    row.classList.toggle('running', on);
    if (on) row.querySelectorAll(':scope > .line > .bullet path').forEach((p) => p.setAttribute('pathLength', '1'));
  }
}
if (tana.onAutomationRuns) tana.onAutomationRuns((runs) => { automationRuns = runs || { items: [], automations: [] }; paintAutomationRuns(); });
