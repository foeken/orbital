// Auto-translate (#547): notes in another language shown in the language you choose, on screen only. Off until turned
// on in Cmd+K (Settings, "Auto-translate …", a synced preference). The saved words are never touched: the caret going
// into a translated row or title shows its own words first, so what is typed and saved is always the original.
// A page says so once, in a grey line under its title ("Translated from Dutch · Show original", switching the whole
// page); a list row says it as the first fact of its grey line, where a click switches that row (renderer/render.js).
// What is asked: plain text only (a mention, a link or a mark would not survive the round trip), never a sensitive
// node's words, nothing in demo mode, and only what does not read as the chosen language — few of its small words: a
// page as a whole (its title and rows), a list row by its title. Main batches the question to the model (main/ai.js
// translate), which answers null for whatever is in that language after all. Main keeps every answer on this machine
// (db.js translations), so a text seen before, in any pane or launch, comes back at once; this page keeps its own copy.
// ponytail: the languages offered are the ones with small words below: add a line to offer another.
const TRANSLATE_WORDS = {
  English: 'the a an and or of to in on at for with from by is are was were be been it its this that these those we you i he she they our your my not no as if but so will can has have had do does did about after before into over than then there what who when how which all any some more new up out',
  Dutch: 'de het een en of van voor met op in aan bij naar niet is zijn was waren dat die dit deze wie wat na als om te er ook maar we je ik hij zij ze ons onze mijn geen wel nog al wordt worden kan moet over tot uit door hoe waar',
  German: 'der die das und oder ist sind war nicht mit für auf ein eine einen zu von den dem des im in auch sich es wir ich du sie er uns unser mein kein noch nach bei wird werden kann muss',
  French: 'le la les des et ou est sont pour avec un une du de dans pas que qui sur au aux ce cette nous vous je il elle ils ne se plus par mais',
  Spanish: 'el la los las y o es son para con un una del de en que por no se lo como pero su sus al nosotros yo tu este esta más',
};
const TRANSLATE_SETS = Object.fromEntries(Object.entries(TRANSLATE_WORDS).map(([lang, words]) => [lang, new Set(words.split(' '))]));
const translateTo = () => (TRANSLATE_SETS[pref('translateTo', null)] ? pref('translateTo', null) : null); // null: off
const translations = new Map(); // this page's copy: text -> { lang, text }, or null: already in the language, or not answered
const translateAsked = new Set(), translateWaiting = new Set();
const TRANSLATE_BUDGET = 20000; // characters per question (main/ai.js keeps 200 texts)
const shownOriginal = new Set(); // a page's document id or a list row's id, switched back to its own words
let translateTimer = null, translatePage = null; // the zoomed page to translate, set at the start of each render
let translatingInto = null; // the language the answers above are in: another (chosen here or in another pane) starts over
// Whether a text may be in another language: another language's small words outnumber the chosen one's, or there are
// none of anyone's to go by (a bare title: the model judges, once, and main keeps its answer). Into English,
// "Terugblik offsite Studio" and "Aanpassing maken aan Orbital" ask; "Plan the automated PR review pilots" does not: one
// "the" and no other language's words, where counting only the chosen language's share asked about every short title.
// ponytail: word lists, crude on short titles; a JEV model (millisecond language analysis) replaces this once OpenAI has a compliant one (#552).
const translationPending = (text) => translateWaiting.has(text) || (translateAsked.has(text) && !translations.has(text));
function readsOther(text) {
  const words = String(text || '').toLowerCase().match(/\p{L}+/gu) || [], to = translateTo();
  if (!to || words.length < 2) return false;
  // only a language's own words count: "in", "of" and "over" are English and Dutch both, and say nothing
  const others = Object.keys(TRANSLATE_SETS).filter((lang) => lang !== to), mine = TRANSLATE_SETS[to];
  const own = words.filter((w) => mine.has(w) && !others.some((lang) => TRANSLATE_SETS[lang].has(w))).length;
  const other = Math.max(...others.map((lang) => words.filter((w) => TRANSLATE_SETS[lang].has(w) && !mine.has(w)).length));
  return other > own || (!own && !other);
}
const plainText = (segs) => (segs.length && segs.every((s) => Object.keys(s).every((k) => k === 'text')) ? segs.map((s) => s.text).join('') : '');
const maySend = (id) => !!translateTo() && !demoMode && !!tana.translate && typeof id === 'string' && sensitiveIds !== null && !sensitiveIds.has(id); // unknown marks count as sensitive
// The translation of a text, or null; asked once, batched with whatever else this render wants, when it may be sent
// and does not read as the chosen language (or its page does not)
function translationOf(text, id, pageOther) {
  if (!text.trim() || !maySend(id)) return null;
  if (translations.has(text)) return translations.get(text);
  if (!translateAsked.has(text) && (pageOther || readsOther(text))) { translateWaiting.add(text); clearTimeout(translateTimer); translateTimer = setTimeout(askTranslations, 50); }
  return null;
}
function askTranslations() {
  // everything this render wants in one question — a whole page at once, not row by row — up to ~20k characters (a long
  // note); only past that is the rest asked next
  let size = 0; const batch = [...translateWaiting].filter((t) => (size += t.length) <= TRANSLATE_BUDGET || size === t.length), to = translateTo();
  for (const t of batch) { translateWaiting.delete(t); translateAsked.add(t); }
  if (!batch.length || !to) return;
  const next = () => { if (translateWaiting.size) translateTimer = setTimeout(askTranslations, 50); };
  tana.translate(batch, to).then((answers) => {
      if (to !== translateTo()) return;
      batch.forEach((t, i) => translations.set(t, (answers || [])[i] || null));
      for (const el of document.querySelectorAll('[data-translate]')) if (batch.includes(el.dataset.translate)) paintTranslation(el); // a row the render is holding back for (the caret is in another) gets it now
      renderSoon(); next();
    },
    () => { for (const t of batch) translations.set(t, null); next(); }); // refused (no sign-in, the model busy): shown as written this session
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
  translatePage = texts.length > 1 && readsOther(texts.join(' ')) ? parent.docId : null; // a page with rows of its own: a title alone (a space listing documents) is a list row's business
}
// A row's translation, { lang, text, original } or null: a block on a translated page, or a document's title in a list;
// { pending: true } for a list row whose title is being asked about (its grey line says so)
function rowTranslation(item, node) {
  const t = translatableOf(item, node), found = t && translationOf(t.src, t.id, t.onPage);
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
  const texts = pageTexts(parent.docId, parent.node.text || ''), found = texts.map((t) => translationOf(t, parent.docId, true)), any = found.find(Boolean);
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
  const found = translationOf(src, id, el.dataset.translatePage === '1');
  if (!found || el.textContent === found.text) return;
  el.textContent = found.text; originalOf.set(el, () => { el.textContent = src; });
}
// a row's text or the page's title whose words are translated: what paintTranslation needs to keep it in step
function markTranslatable(el, src, id, onPage) {
  if (src == null) { delete el.dataset.translate; delete el.dataset.translateId; delete el.dataset.translatePage; return; }
  el.dataset.translate = src; el.dataset.translateId = id; el.dataset.translatePage = onPage ? '1' : '';
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
function translatedFactEl(found, id) {
  const el = document.createElement('span'); el.className = 'translated';
  if (found.pending) { el.classList.add('translating'); el.append(...translatingEls()); return el; }
  el.setAttribute('role', 'button');
  el.title = found.original ? 'Show the translation' : 'Show the original';
  el.append(sparkleEl(), (found.original ? 'Original, in ' : 'Translated from ') + found.lang);
  el.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
  el.onclick = (e) => { e.stopPropagation(); toggleOriginal(id); };
  return el;
}
// ---- Cmd+K "Auto-translate …" (Settings): off, or the language notes are shown in ----
function translateRows(q) {
  const on = translateTo();
  return [['Off', null], ...Object.keys(TRANSLATE_WORDS).map((lang) => ['Into ' + lang, lang])].filter(([label]) => fuzzyMatch(label, q))
    .map(([label, lang]) => ({ group: 'Auto-translate', icon: lang ? 'sparkle' : 'none', label, hint: on === lang ? '✓' : '', run: () => setTranslateTo(lang) }));
}
function openTranslatePage() { openPage('translateTo', 'Translate notes into…', { rows: translateRows, back: BACK_TO_COMMANDS }); }
function setTranslateTo(lang) { setPref('translateTo', lang || undefined); closePalette(); render(true); } // the next render starts over (setTranslatePage), in every pane
