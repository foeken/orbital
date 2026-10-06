// Auto-translate (#547): notes in another language shown in the language you choose, on screen only. Off until turned
// on in Cmd+K (Settings, "Auto-translate …", a synced preference). The saved words are never touched: the caret going
// into a translated row or title shows its own words first, so what is typed and saved is always the original.
// Only titles of top-level nodes, never a node's content: a page says so in a grey line under its title ("Translated
// from Dutch · Show original"); a list row says it as the first fact of its grey line, where a click switches that row (renderer/render.js).
// What is asked: plain text only (a mention, a link or a mark would not survive the round trip), never a sensitive
// node's words (demo mode translates, its words masked where drawn, so the notices still show): a page's title and a
// list row's title. Main decides what is in another language on this Mac (main/ai.js detectLanguages, Apple's
// NaturalLanguage) and sends only that to the model, batched. Main keeps every answer on this machine (db.js
// translations), so a text seen before, in any pane or launch, comes back at once; this page keeps its own copy.
// The languages offered: main/ai.js LANG_CODES names each one's code.
const TRANSLATE_LANGS = ['English', 'Dutch', 'German', 'French', 'Spanish'];
const translateTo = () => (TRANSLATE_LANGS.includes(pref('translateTo', null)) ? pref('translateTo', null) : null); // null: off
const translations = new Map(); // this page's copy: text -> { lang, text }, or null: already in the language, or not answered
const translateAsked = new Set(), translateWaiting = new Set();
const TRANSLATE_BUDGET = 20000; // characters per question (main/ai.js keeps 200 texts)
const shownOriginal = new Set(); // a page's document id or a list row's id, switched back to its own words
let translateTimer = null, translatePage = null; // the zoomed page to translate, set at the start of each render
let translatingInto = null; // the language the answers above are in: another (chosen here or in another pane) starts over
// being translated: only what the model was given, never what this Mac is still looking at (a moment, and mostly
// English), so a row says "Translating…" only when it will change
const translateModel = new Set();
const translationPending = (text) => translateModel.has(text);
const plainText = (segs) => (segs.length && segs.every((s) => Object.keys(s).every((k) => k === 'text')) ? segs.map((s) => s.text).join('') : '');
// demo mode translates too, so its notices show; every translated word is masked where it is drawn (renderSegs, demoText)
const maySend = (id) => !!translateTo() && !!tana.translate && typeof id === 'string' && sensitiveIds !== null && !sensitiveIds.has(id); // unknown marks count as sensitive
// The translation of a text, or null; asked once, batched with whatever else this render wants, when it may be sent
function translationOf(text, id) {
  if (!text.trim() || !maySend(id)) return null;
  if (translations.has(text)) return translations.get(text);
  if (!translateAsked.has(text)) { translateWaiting.add(text); clearTimeout(translateTimer); translateTimer = setTimeout(askTranslations, 50); }
  return null;
}
function askTranslations() {
  // everything this render wants in one question — a whole page at once, not row by row — up to ~20k characters (a long
  // note); only past that is the rest asked next
  let size = 0; const batch = [...translateWaiting].filter((t) => (size += t.length) <= TRANSLATE_BUDGET || size === t.length), to = translateTo();
  for (const t of batch) { translateWaiting.delete(t); translateAsked.add(t); }
  if (!batch.length || !to) return;
  const next = () => { if (translateWaiting.size) translateTimer = setTimeout(askTranslations, 50); };
  const land = (texts, answers) => {
    texts.forEach((t, i) => { translateModel.delete(t); translations.set(t, (answers || [])[i] || null); });
    for (const el of document.querySelectorAll('[data-translate]')) if (texts.includes(el.dataset.translate)) paintTranslation(el); // a row the render is holding back for (the caret is in another) gets it now
    renderSoon();
  };
  const refused = (texts) => { for (const t of texts) { translateModel.delete(t); translations.set(t, null); } renderSoon(); }; // no sign-in, the model busy: shown as written this session
  // Two steps: this Mac first (kept answers, and what it finds already in the language: most of a page, settled at
  // once), then the model for the rest, while the next batch goes on to this Mac (main/ai.js translate, local)
  tana.translate(batch, to, { local: true }).then((first) => {
    if (to !== translateTo()) return;
    const ask = batch.filter((t, i) => first && first[i] && first[i].ask);
    land(batch.filter((t) => !ask.includes(t)), batch.filter((t) => !ask.includes(t)).map((t) => first[batch.indexOf(t)]));
    next();
    if (!ask.length) return;
    for (const t of ask) translateModel.add(t);
    renderSoon();
    tana.translate(ask, to).then((answers) => { if (to === translateTo()) land(ask, answers); }, () => refused(ask));
  }, () => { refused(batch); next(); });
}
// renderer/render.js renderOutline: whether the page being drawn has its title translated. Only titles are: a document's,
// on its page and as a row in a list, never what is in it — its blocks and children stay as written.
function setTranslatePage(parent) {
  if (translateTo() !== translatingInto) { translatingInto = translateTo(); translations.clear(); translateAsked.clear(); translateWaiting.clear(); shownOriginal.clear(); }
  const page = parent && parent.node.kind === 'document' && !parent.node.draft && !appOwned(parent.docId) && !isChatPage(parent) && !isTypeDoc(parent.node);
  translatePage = page && maySend(parent.docId) && (parent.node.text || '').trim() ? parent.docId : null;
}
// A row's translation, { lang, text, original } or null: a document's title in a list, or a named segment;
// { pending: true } for a list row whose title is being asked about (its grey line says so)
function rowTranslation(item, node) {
  const t = translatableOf(item, node), found = t && translationOf(t.src, t.id);
  return found ? { ...found, id: t.id, original: shownOriginal.has(t.id) } : t && translationPending(t.src) ? { pending: true } : null;
}
// A row of the app's own that names a node in its one content segment (main/timeline.js: a meeting, "Kevin completed
// <task>"; main/inbox.js: a notification's title): that segment, or null. Only it is translated, the sentence around it stays.
const namedSeg = (node) => { const s = (node.timeline?.uri || node.notification?.sourceUri) && node.segments?.filter((x) => x.content); return s?.length === 1 && s[0].text ? s[0] : null; };
const translateSrc = (node) => namedSeg(node)?.text ?? node.text; // what a row's translation is looked up by (rowSig)
const translateId = (node) => (namedSeg(node) ? node.timeline?.uri || node.notification.sourceUri : node.id); // and switched back by
// a row's segments with its translation in place: the named segment only, or the whole row
const translatedSegs = (node, text) => (namedSeg(node) ? segsOf(node).map((s) => (s.content ? { ...s, text } : s)) : [{ text }]);
// A row whose words could be shown translated: { src, id } (a document's title, a top-level node, or a named segment),
// else null. A block is a node's content and is never translated.
function translatableOf(item, node) {
  const named = namedSeg(node);
  if (named) return { src: named.text, id: translateId(node) };
  if (node.timeline || node.notification || node.draft || node.upload || node.chat) return null;
  const src = node.kind === 'document' && plainText(segsOf(node));
  return src ? { src, id: node.id } : null;
}
// The page's own: its title's translation, { pending: true } while it is being asked about, or null
function pageTranslation(parent) {
  if (!parent || parent.docId !== translatePage) return null;
  const title = parent.node.text, found = translationOf(title, parent.docId);
  return found ? { lang: found.lang, title: found, original: shownOriginal.has(parent.docId) } : translationPending(title) ? { pending: true } : null;
}
function toggleOriginal(id) { if (!shownOriginal.delete(id)) shownOriginal.add(id); render(true); }
// A translated row or title shows its own words the moment the caret goes in (before setCaret measures it), so an
// edit is made in, and saves, the original
const originalOf = new WeakMap(); // element -> puts its own words back
const translationBack = new WeakMap(); // element -> { restore, back }: a full reference, whose chip no paintTranslation redraws, drawn translated again as the caret leaves
function originalOnFocus(el, restore, back) { if (restore) originalOf.set(el, restore); else originalOf.delete(el); if (restore && back) translationBack.set(el, { restore, back }); else translationBack.delete(el); }
// Only where the caret can type: a read-only row (the Timeline, a notification, a reference) keeps its translation and
// its people, so the click that focused it opens it instead of swapping its words first
const typable = (el) => ['true', 'plaintext-only'].includes(el.getAttribute?.('contenteditable'));
document.addEventListener('focusin', (e) => { const restore = originalOf.get(e.target); if (restore && typable(e.target)) { originalOf.delete(e.target); restore(); } rowNotice(e.target, true); });
// a list row's "Translated from …" says "Original, in …" while the row is typed in, since it shows its own words then
function rowNotice(el, typing) {
  const label = typable(el) && el.parentElement?.querySelector(':scope > .subtext .translated:not(.original) .tlabel');
  if (label) label.textContent = (typing ? 'Original, in ' : 'Translated from ') + label.dataset.lang;
}
// Leaving a translatable row or title shows its translation again: its words may have been edited, so they are what is
// looked up (from the cache at once, or asked, landing when the answer does), after the edit has been saved.
document.addEventListener('focusout', (e) => {
  const el = e.target; rowNotice(el, false);
  const t = translationBack.get(el); // after the save; typed beside, the row is ordinary now and keeps its words
  if (t && !originalOf.has(el)) setTimeout(() => { if (el.isConnected && el !== document.activeElement && chipOnly(el)) { t.back(); originalOf.set(el, t.restore); } });
  if (el.dataset?.translate == null) return; el.dataset.translate = el.textContent; setTimeout(() => paintTranslation(el));
});
// el marked by markTranslatable: its translation drawn in place, unless it has the caret or was switched back to its own words
function paintTranslation(el) {
  const src = el.dataset.translate, id = el.dataset.translateId;
  if (!el.isConnected || el === document.activeElement || shownOriginal.has(id)) return;
  const found = translationOf(src, id);
  if (!found || el.textContent === found.text) return;
  el.textContent = demoText(found.text, id); // masked in demo mode, like the row drawn around it
  originalOf.set(el, () => { el.textContent = demoText(src, id); });
}
// a row's text or the page's title whose words are translated: what paintTranslation needs to keep it in step
function markTranslatable(el, src, id) {
  if (src == null) { delete el.dataset.translate; delete el.dataset.translateId; return; }
  el.dataset.translate = src; el.dataset.translateId = id;
}
const sparkleEl = () => addIcon(document.createElement('span'), 'sparkle');
// while the model is asked: the sparkle at work and "Translating…", shown only once it takes a moment (styles.css), so an
// answer from the cache never flashes it
const translatingEls = () => [sparkleEl(), 'Translating…'];
// under the page's title: what was done, and the way back
// Typed in, the title shows its own words (originalOnFocus), so the line says "Original" too, and its button leaves the
// title, which shows the translation again; drawn again as the caret goes in and out (the listeners below).
let linePage = null, lineDoc = null;
function drawTranslatedLine(page, docId) {
  linePage = page; lineDoc = docId;
  const line = $('translated');
  line.hidden = !page;
  line.classList.toggle('translating', !!page?.pending);
  if (!page) return;
  if (page.pending) return line.replaceChildren(...translatingEls());
  const typing = !page.original && document.activeElement === titleEl, original = page.original || typing;
  // quiet: the caret stays in the title until the click, so the click is not lost to a redraw
  const back = quietButton('', null, () => (typing ? titleEl.blur() : toggleOriginal(docId))); back.textContent = original ? 'Show translation' : 'Show original';
  line.replaceChildren(sparkleEl(), (original ? 'Original, in ' : 'Translated from ') + page.lang + ' · ', back);
}
titleEl.addEventListener('focus', () => { if (linePage) drawTranslatedLine(linePage, lineDoc); });
titleEl.addEventListener('blur', () => { if (linePage) drawTranslatedLine(linePage, lineDoc); });
// the first fact of a list row's grey line; a click switches the row
function translatedFactEl(found, id, more) { // more: the grey line has facts after it
  const el = document.createElement('span'); el.className = 'translated';
  if (found.pending) { el.classList.add('translating'); el.append(...translatingEls(), ...(more ? [' · '] : [])); return el; } // the separator hides with it until it shows (styles.css)
  el.setAttribute('role', 'button');
  if (found.original) el.classList.add('original');
  el.title = found.original ? 'Show the translation' : 'Show the original';
  const label = document.createElement('span'); label.className = 'tlabel'; label.dataset.lang = found.lang; label.textContent = (found.original ? 'Original, in ' : 'Translated from ') + found.lang; // the words alone are underlined on hover, never the separator
  el.append(sparkleEl(), label, ...(more ? [' · '] : []));
  el.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
  el.onclick = (e) => { e.stopPropagation(); const typed = el.closest('.subtext')?.parentElement?.querySelector(':scope > .text'); if (!found.original && typed && typed === document.activeElement) typed.blur(); else toggleOriginal(id); }; // typed in: leaving shows the translation again
  return el;
}
// ---- Cmd+K "Replace with translation": the translation a document's title is shown in, written as its title ----
// Only a title is ever translated, so that is what is replaced; offered where the title may be edited.
const titleTranslation = (doc) => (doc && typeof doc.text === 'string' && maySend(doc.id) ? translations.get(doc.text) || null : null);
function replaceWithTranslation(doc, found) {
  return run(async () => {
    await tana.setTitle(doc.id, found.text);
    doc.text = found.text; shownOriginal.delete(doc.id);
    showNote('Title replaced with its translation from ' + found.lang);
    render(true);
  });
}
// ---- Cmd+K "Translate into …": a selection, or the row or page you are on, written in the auto-translate language
// (English while that is off), for good: a document's title, a block's text. Plain text only, as auto-translate asks
// (a mention, a link or a mark would not survive), and only what may be edited; what is already in the language stays.
function translateTargets() {
  const keys = selKeys().length ? selKeys() : palReturn && palReturn.key ? [palReturn.key] : palDoc ? [palDoc.id] : [];
  return keys.map((key) => items.get(key)).filter((item) => item && !item.node.draft && isRealId(item.docId) && canEditText(item) && !isReference(item.node) && plainText(segsOf(item.node)));
}
function translateNodes(list, to) {
  return run(async () => {
    flushAll();
    const texts = list.map((item) => plainText(segsOf(item.node))), answers = await tana.translate(texts, to);
    let done = 0;
    for (const [i, item] of list.entries()) {
      const found = answers && answers[i];
      if (!found || !found.text || found.text === texts[i]) continue; // already in the language
      if (item.node.kind === 'document') await tana.setTitle(item.docId, found.text);
      else await tana.setText(item.docId, item.node.id, [{ text: found.text }]);
      item.node.text = found.text; item.node.segments = item.node.kind === 'document' ? undefined : [{ text: found.text }];
      done++;
    }
    showNote(done ? 'Translated ' + (list.length > 1 ? done + ' of ' + list.length + ' nodes' : 'it') + ' into ' + to : 'Already in ' + to);
    render(true);
  });
}
// ---- Cmd+K "Auto-translate …" (Settings): off, or the language notes are shown in ----
function translateRows(q) {
  const on = translateTo();
  return [['Off', null], ...TRANSLATE_LANGS.map((lang) => ['Into ' + lang, lang])].filter(([label]) => fuzzyMatch(label, q))
    .map(([label, lang]) => ({ group: 'Auto-translate', icon: lang ? 'sparkle' : 'none', label, hint: on === lang ? '✓' : '', run: () => setTranslateTo(lang) }));
}
function openTranslatePage() { openPage('translateTo', 'Translate notes into…', { rows: translateRows, back: BACK_TO_COMMANDS }); }
function setTranslateTo(lang) { setPref('translateTo', lang || undefined); closePalette(); render(true); } // the next render starts over (setTranslatePage), in every pane
