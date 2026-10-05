'use strict';
// Settings (issue #672): Cmd+K Open settings and its key ⌘, open Orbital's Settings window (settings.html, a window
// of its own: main.js openSettings), as the app menu's Settings… does. What stays here is Cmd+K's Choose models page.
function openSettings() { if (tana.openSettings) run(() => tana.openSettings()); }
// gpt-6-sol reads Sol 6, gpt-5.6-terra Terra 5.6, gpt-5.5 GPT-5.5: the list holds a name in more than one version.
// The Settings window loads this file for these two (settings.html), so nothing at its top level may reach the outliner.
const aiModelLabel = (id) => id.replace(/^gpt-([\d.]+)-?(.*)$/, (_, version, name) => (name ? name[0].toUpperCase() + name.slice(1) + ' ' : 'GPT-') + version);
const aiEffortLabel = (x) => (x === 'xhigh' ? 'Extra high' : x[0].toUpperCase() + x.slice(1));
// ---- Choose models: the Quick AI and the Regular AI (main/ai.js options), a segment each that ⇥ switches, as the chat
// composer's ⇥ switches who it asks; ↩ on a model or a thinking level stores it, and each answer is the options again ----
let modelsOptions = null, modelsQuick = true;
const MODELS_USE = { quick: 'for translating, Discuss with, types and icons', regular: 'for reading images' };
const modelsPlaceholder = () => (modelsQuick ? 'Quick AI · ⇥ Regular AI' : 'Regular AI · ⇥ Quick AI');
function modelsRows(q) {
  const ai = modelsOptions;
  if (!ai || ai instanceof Error) return [{ group: 'Models', label: ai ? errorText(ai) : 'Loading…', disabled: true, note: true }];
  const k = (w) => (modelsQuick ? 'quick' + w : w.toLowerCase()), use = MODELS_USE[modelsQuick ? 'quick' : 'regular'];
  const rows = [...ai.models.map((m) => ({ group: 'Model · ' + use, icon: 'brain', label: aiModelLabel(m), hint: m === ai[k('Model')] ? '✓' : '', keepOpen: true, run: () => settingsSetAI(k('Model'), m) })),
    ...ai[k('Efforts')].map((x) => ({ group: 'Thinking', icon: 'sparkle', label: aiEffortLabel(x), hint: x === ai[k('Effort')] ? '✓' : '', keepOpen: true, run: () => settingsSetAI(k('Effort'), x) }))];
  return matchRows(rows, q);
}
function settingsSetAI(key, value) {
  run(async () => { modelsOptions = await tana.setAiOption(key, value); renderPalette(); });
}
function openModelsPalette() {
  modelsOptions = null; modelsQuick = true;
  openPage('models', modelsPlaceholder(), { rows: modelsRows, back: BACK_TO_COMMANDS, keys: (e) => {
    if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return false;
    modelsQuick = !modelsQuick; palInput.placeholder = modelsPlaceholder(); palIndex = 0; renderPalette();
    return true;
  } });
  const seq = palSeq, landed = (options) => { if (seq === palSeq) { modelsOptions = options; renderPalette(); } }; // one answer, not a list (loadList)
  tana.aiOptions().then(landed, (e) => landed(e instanceof Error ? e : new Error(String(e))));
}
