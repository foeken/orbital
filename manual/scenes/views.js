'use strict';
// Chapter 7, Views & saved searches: node manual/scenes/run.js manual/scenes/views.js
// The mock's ids are not tana: ids, so the renderer never asks it for a row's task metadata (isRealId); SEED asks it
// here, so rows show who has them.
const SEED = "Promise.all(shownDocs().map(async (d) => { try { taskMetaById.set(d.id, await tana.taskMeta(d.id)); } catch { /* not a task */ } })).then(() => render(true))";
const library = (group = 'status') => [{ js: "setView('library')" }, { wait: 600 }, { js: "setGroupBy('" + group + "')" }, { js: SEED }, { wait: 500 }];
const card = { sel: '#palette .card', pad: 24 };
module.exports = [
  // the pills over the Library, for the annotated picture
  { name: 'views-pills', setup: library(), clip: [0, 96, 1200, 84] },
  // the three presets, through Cmd+K
  { name: 'views-presets', video: true, size: '1000x640', setup: library(), clip: [0, 30, 1000, 520], steps: [
    { wait: 500 }, { key: '⌘K' }, { type: 'Types', delay: 90 }, { wait: 300 }, { key: '↩' }, { wait: 1200 },
    { key: '⌘K' }, { type: 'Inbox', delay: 90 }, { wait: 300 }, { key: '↩' }, { wait: 800 }] },
  // a pill's menu: Status loses Completed, and the Completed pill goes with it
  { name: 'views-pill', video: true, size: '1000x640', setup: library(), clip: [0, 30, 1000, 560], steps: [
    { wait: 400 }, { click: '.pill[data-id="status"]' }, { wait: 700 }, { click: '.menu .mrow', text: 'Completed' }, { wait: 900 }, { key: 'esc' }] },
  // every pill is a Cmd+K row too
  { name: 'views-cmdk', setup: [...library(), { key: '⌘K' }, { type: 'filter by status' }, { wait: 400 }], clip: card },
  // the filter row
  { name: 'views-find', video: true, size: '1000x640', setup: library(), clip: [0, 30, 1000, 560], steps: [
    { wait: 400 }, { key: '⌘F' }, { type: 'studio', delay: 110 }, { wait: 1400 }, { key: 'esc' }, { wait: 600 }] },
  // Group's menu over the Library grouped by Status
  { name: 'views-group', setup: [...library(), { click: '.pill[data-id="group"]' }, { wait: 500 }], clip: [280, 120, 400, 380] },
  { name: 'views-display', setup: [...library(), { click: '.pill[data-id="display"]' }, { wait: 500 }], clip: [440, 120, 400, 380] },
  // folding a section by its heading
  { name: 'views-fold', video: true, size: '1000x640', setup: library(), clip: [0, 30, 1000, 560], steps: [
    { wait: 400 }, { click: '.ghead', text: 'In Progress' }, { wait: 1200 }, { click: '.ghead', text: 'In Progress' }, { wait: 600 }] },
  // Outliner or Table
  { name: 'views-table', video: true, size: '1000x640', setup: library(), clip: [0, 30, 1000, 560], steps: [
    { wait: 400 }, { key: '⌘K' }, { type: 'switch to table', delay: 60 }, { wait: 300 }, { key: '↩' }, { wait: 1400 }] },
  { name: 'views-widths', setup: [...library(), { js: 'setTableView(true)' }, { wait: 500 }, { key: '⌘K' }, { type: 'column widths' }, { key: '↩' }, { wait: 500 }], clip: card },
  // Save as search: the query becomes a document, opened at once
  { name: 'views-save', video: true, size: '1000x640', setup: [...library(), { js: "setViewF({ states: ['open'] })" }, { wait: 600 }], clip: [0, 30, 1000, 560], steps: [
    { wait: 400 }, { click: '.pill.savesearch' }, { wait: 1800 }] },
  // an edit on a saved search waits for Save
  { name: 'views-unsaved', size: '1000x640', setup: [...library(), { js: "setViewF({ states: ['open'] })" }, { wait: 600 }, { click: '.pill.savesearch' }, { wait: 1400 }, { key: '⌘K' }, { type: 'sort by title' }, { wait: 300 }, { key: '↩' }, { wait: 600 }, { key: 'esc' }, { wait: 700 }], clip: [0, 60, 1000, 380] },
  // an empty page
  { name: 'views-empty', size: '700x500', setup: [{ js: "setView('inbox')" }, { wait: 500 }, { js: "setViewF({ states: ['not_now'] })" }, { wait: 800 }], clip: [0, 60, 700, 260] },
  // saved window views
  { name: 'views-savedview', setup: [...library(), { key: '⌘K' }, { type: 'save view' }, { key: '↩' }, { type: 'Planning' }, { wait: 400 }], clip: card },
];



