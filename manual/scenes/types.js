'use strict';
// Chapter 10, Types & fields: node manual/scenes/run.js manual/scenes/types.js
// The mock's ids are not tana: ids, so the renderer never reads a mock document's fields itself (isRealId, loadRelated):
// FIELDS reads them from the mock once, the way loadRelated would, and draws the page.
const FIELDS = (id) => "tana.related('" + id + "').then((d) => { relatedBy.set('" + id + "', d); render(true); })";
const doc1 = [{ js: "goTo('mockdoc1')" }, { wait: 700 }, { js: FIELDS('mockdoc1') }, { wait: 800 }];
const PILLS_OPEN = "setPref('openPills', { ...pref('openPills', {}), [pillKey()]: true }); renderPills(true)";
const typePage = [{ js: "goTo('tana:type:mock0')" }, { wait: 1200 }, { js: PILLS_OPEN }, { wait: 500 }];
const editFields = [...typePage, { key: '⌘K' }, { type: 'edit fields' }, { wait: 200 }, { key: '↩' }, { wait: 800 }];
const card = { sel: '#palette .card', pad: 24 };
// A mock type's id is not a real ULID and a mock document's is not a tana:text: id, so Cmd+K does not offer Set type,
// Set icon or Set colour on them (TYPE_NODE, TYPED_KIND in renderer/palette.js). These clips press ⌘K, name the row in a
// caption and open the very page that row opens; everything after is typed and pressed for real.
const viaRow = (label, open) => [{ js: "mcKeys(['⌘', 'K'])", page: 'shell' }, { caption: '⌘K → ' + label }, { wait: 500 }, { js: "togglePalette('cmd'); " + open }, { wait: 900 }];
const DOC = (id) => "(docOf('" + id + "') || extra.get('" + id + "'))";
module.exports = [
  // Set type on a document outside the space: the space's types are greyed with the reason
  { name: 'types-settype', video: true, size: '1000x640', setup: [{ js: "goTo('mockdoc3')" }, { wait: 900 }], clip: [0, 30, 1000, 390], steps: [
    { wait: 300 }, ...viaRow('Set type', 'openTypePalette(' + DOC('mockdoc3') + ')'), { wait: 900 }, { caption: '' }, { key: '↓' }, { key: '↓' }, { wait: 400 }, { key: '↩' }, { wait: 1400 }] },
  { name: 'types-classify', setup: [{ js: "goTo('mockdoc3')" }, { wait: 900 }, { js: "togglePalette('cmd'); openClassifyPalette(" + DOC('mockdoc3') + ')' }, { wait: 1500 }], clip: card },
  { name: 'types-view', size: '1000x640', setup: [{ js: "setView('types')" }, { wait: 800 }], clip: [0, 60, 640, 250] },
  { name: 'types-page', size: '1000x640', setup: typePage, clip: [0, 60, 1000, 440] },
  { name: 'types-addfilter', size: '1000x640', setup: [...typePage, { click: '.pill[data-id="morefields"]' }, { wait: 500 }], clip: [0, 60, 640, 460] },
  { name: 'types-table', size: '1000x640', setup: [...typePage, { js: 'setTableView(true)' }, { wait: 800 }], clip: [0, 60, 1000, 440] },
  { name: 'types-define', size: '1000x640', setup: editFields, clip: [0, 60, 1000, 420] },
  // a click on a definition offers what can be changed about it
  { name: 'types-fieldcmds', setup: [...editFields, { click: '.fdef', text: 'High' }, { wait: 700 }], clip: card },
  { name: 'types-choices', video: true, size: '1000x640', setup: editFields, clip: [0, 30, 1000, 600], steps: [
    { wait: 300 }, { click: '.fdef', text: 'High' }, { wait: 800 }, { type: 'edit choices', delay: 70 }, { wait: 300 }, { key: '↩' }, { wait: 900 },
    { type: 'Critical', delay: 110 }, { wait: 400 }, { key: '↩' }, { wait: 1500 }, { key: 'esc' }, { wait: 300 }, { key: 'esc' }, { wait: 800 }] },
  { name: 'types-icon', video: true, size: '1000x640', setup: [{ js: "setView('types')" }, { wait: 800 }], clip: [0, 30, 1000, 330], steps: [
    { wait: 300 }, ...viaRow('Set icon', "openIconPalette(docOf('tana:type:mock0'))"), { caption: '' }, { wait: 700 }, { key: '↩' }, { wait: 900 }, { key: 'esc' }, { wait: 600 }] },
  { name: 'types-colour', video: true, size: '1000x640', setup: [{ js: "setView('types')" }, { wait: 800 }], clip: [0, 30, 1000, 330], steps: [
    { wait: 300 }, ...viaRow('Set colour', "openHuePalette(docOf('tana:type:mock0'))"), { wait: 600 }, { caption: '' }, { key: '↓' }, { key: '↓' }, { key: '↓' }, { wait: 400 }, { key: '↩' }, { wait: 900 }, { key: 'esc' }, { wait: 600 }] },
  { name: 'types-fields', size: '1000x640', setup: doc1, clip: [0, 60, 1000, 380] },
  { name: 'types-pick', video: true, size: '1000x640', setup: doc1, clip: [0, 30, 1000, 400], steps: [
    { wait: 300 }, { click: '.fchoice', text: 'Select value', at: [0.2, 0.5] }, { wait: 900 }, { key: '↓' }, { key: '↓' }, { wait: 300 }, { key: '↩' }, { wait: 1200 }] },
  { name: 'types-archived', setup: [{ js: "setView('types')" }, { wait: 600 }, { key: '⌘K' }, { type: 'archived types' }, { wait: 200 }, { key: '↩' }, { wait: 600 }], clip: card },
];


