// Auto-translate (#547): notes in another language shown in the language you choose, on screen only. Off until turned
// on in Cmd+K (Settings, "Auto-translate …", a synced preference). The saved words are never touched: the caret going
// into a translated row or title shows its own words first, so what is typed and saved is always the original.
// A page says so once, in a grey line under its title ("Translated from Dutch · Show original", switching the whole
// page); a list row says it as the first fact of its grey line, where a click switches that row (renderer/render.js).
// What is asked: plain text only (a mention, a link or a mark would not survive the round trip), never a sensitive
// node's words (demo mode translates, its words masked where drawn, so the notices still show): a page's title and
// rows, a list row's title. Main decides what is in another language on this Mac (main/ai.js detectLanguages, Apple's
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
function pageTexts(docId, title) {
  const texts = [title];
  const walk = (list) => { for (const n of list || []) { if (texts.length > 200) return; const t = n.kind === 'block' && plainText(segsOf(n)); if (t) texts.push(t); walk(n.children); } };
  walk(kids.get(docId));
  return texts;
}
// renderer/render.js renderOutline: whether the page being drawn is translated, read as a whole
function setTranslatePage(parent) {
  if (translateTo() !== translatingInto) { translatingInto = translateTo(); translations.clear(); translateAsked.clear(); translateWaiting.clear(); shownOriginal.clear(); }
  const page = parent && (parent.node.kind === 'document' || parent.node.kind === 'block') && !parent.node.draft && !appOwned(parent.docId) && !isChatPage(parent) && !isTypeDoc(parent.node);
  const texts = page && maySend(parent.docId) ? pageTexts(parent.docId, parent.node.text || '') : [];
  translatePage = texts.length > 1 ? parent.docId : null; // a page with rows of its own: a title alone (a space listing documents) is a list row's business; each row is judged on its own (main)
}
// A row's translation, { lang, text, original } or null: a block on a translated page, or a document's title in a list;
// { pending: true } for a list row whose title is being asked about (its grey line says so)
function rowTranslation(item, node) {
  const t = translatableOf(item, node), found = t && translationOf(t.src, t.id);
  return found ? { ...found, id: t.id, onPage: t.onPage, original: shownOriginal.has(t.id) } : t && !t.onPage && translationPending(t.src) ? { pending: true } : null;
}
// A row of the app's own that names a node in its one content segment (main/timeline.js: a meeting, "Kevin completed
// <task>"; main/inbox.js: a notification's title): that segment, or null. Only it is translated, the sentence around it stays.
const namedSeg = (node) => { const s = (node.timeline?.uri || node.notification?.sourceUri) && node.segments?.filter((x) => x.content); return s?.length === 1 && s[0].text ? s[0] : null; };
const translateSrc = (node) => namedSeg(node)?.text ?? node.text; // what a row's translation is looked up by (rowSig)
const translateId = (node) => (namedSeg(node) ? node.timeline?.uri || node.notification.sourceUri : node.id); // and switched back by
// a row's segments with its translation in place: the named segment only, or the whole row
const translatedSegs = (node, text) => (namedSeg(node) ? segsOf(node).map((s) => (s.content ? { ...s, text } : s)) : [{ text }]);
// A row whose words could be shown translated: { src, id, onPage } (anything under a translated page — its blocks and the
// documents in it, one line under the title says so for all of them — a document's title, or a named segment), else null
function translatableOf(item, node) {
  const named = namedSeg(node);
  if (named) return { src: named.text, id: translateId(node), onPage: false };
  if (node.timeline || node.notification || node.draft || node.upload || node.chat) return null;
  let onPage = false;
  for (let p = item; translatePage && p && !onPage; p = p.parent) onPage = p.docId === translatePage;
  const src = (onPage || node.kind === 'document') && plainText(segsOf(node));
  return src ? { src, id: onPage ? translatePage : node.id, onPage } : null;
}
// The page's own: its title's translation and the language any of its words were found in, { pending: true } while it
// is being asked about, or null
function pageTranslation(parent) {
  if (!parent || parent.docId !== translatePage) return null;
  const texts = pageTexts(parent.docId, parent.node.text || ''), found = texts.map((t) => translationOf(t, parent.docId)), any = found.find(Boolean);
  return any ? { lang: any.lang, title: found[0], original: shownOriginal.has(parent.docId) } : texts.some(translationPending) ? { pending: true } : null;
}
function toggleOriginal(id) { if (!shownOriginal.delete(id)) shownOriginal.add(id); render(true); }
// A translated row or title shows its own words the moment the caret goes in (before setCaret measures it), so an
// edit is made in, and saves, the original
const originalOf = new WeakMap(); // element -> puts its own words back
function originalOnFocus(el, restore) { if (restore) originalOf.set(el, restore); else originalOf.delete(el); }
document.addEventListener('focusin', (e) => { const restore = originalOf.get(e.target); if (restore) { originalOf.delete(e.target); restore(); } });
// Leaving a translatable row or title shows its translation again: its words may have been edited, so they are what is
// looked up (from the cache at once, or asked, landing when the answer does), after the edit has been saved.
document.addEventListener('focusout', (e) => { const el = e.target; if (el.dataset?.translate == null) return; el.dataset.translate = el.textContent; setTimeout(() => paintTranslation(el)); });
// el marked by markTranslatable: its translation drawn in place, unless it has the caret or was switched back to its own words
function paintTranslation(el) {
  const src = el.dataset.translate, id = el.dataset.translateId;
  if (!el.isConnected || el === document.activeElement || shownOriginal.has(id)) return;
  const found = translationOf(src, id);
  if (!found || el.textContent === found.text) return;
  el.textContent = demoText(found.text, id); originalOf.set(el, () => { el.textContent = demoText(src, id); }); // masked in demo mode, like the row drawn around it
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
function drawTranslatedLine(page, docId) {
  const line = $('translated');
  line.hidden = !page;
  line.classList.toggle('translating', !!page?.pending);
  if (!page) return;
  if (page.pending) return line.replaceChildren(...translatingEls());
  const back = document.createElement('button'); back.type = 'button'; back.textContent = page.original ? 'Show translation' : 'Show original';
  back.onclick = () => toggleOriginal(docId);
  line.replaceChildren(sparkleEl(), (page.original ? 'Original, in ' : 'Translated from ') + page.lang + ' · ', back);
}
// the first fact of a list row's grey line; a click switches the row
function translatedFactEl(found, id, more) { // more: the grey line has facts after it
  const el = document.createElement('span'); el.className = 'translated';
  if (found.pending) { el.classList.add('translating'); el.append(...translatingEls(), ...(more ? [' · '] : [])); return el; } // the separator hides with it until it shows (styles.css)
  el.setAttribute('role', 'button');
  el.title = found.original ? 'Show the translation' : 'Show the original';
  el.append(sparkleEl(), (found.original ? 'Original, in ' : 'Translated from ') + found.lang, ...(more ? [' · '] : []));
  el.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
  el.onclick = (e) => { e.stopPropagation(); toggleOriginal(id); };
  return el;
}
// ---- Cmd+K "Auto-translate …" (Settings): off, or the language notes are shown in ----
function translateRows(q) {
  const on = translateTo();
  return [['Off', null], ...TRANSLATE_LANGS.map((lang) => ['Into ' + lang, lang])].filter(([label]) => fuzzyMatch(label, q))
    .map(([label, lang]) => ({ group: 'Auto-translate', icon: lang ? 'sparkle' : 'none', label, hint: on === lang ? '✓' : '', run: () => setTranslateTo(lang) }));
}
function openTranslatePage() { openPage('translateTo', 'Translate notes into…', { rows: translateRows, back: BACK_TO_COMMANDS }); }
function setTranslateTo(lang) { setPref('translateTo', lang || undefined); closePalette(); render(true); } // the next render starts over (setTranslatePage), in every pane
