'use strict';
// Feature flags: switches for work that is still an experiment, on this Mac only (kept in SQLite beside the OpenAI API
// key: featureFlags matches no SYNCED rule, docs/SETTINGS.md), switched in Cmd+K Enable feature flag and Disable
// feature flag (renderer/flags.js). A flag names its feature; the feature asks on(id).
const settings = require('./settings');
const { send } = require('./state');

const FLAGS = {
  // main/decisions.js: OpenAI's Decisions API for the questions with a fixed set of answers. It takes an API key only.
  decisions: { label: 'Decisions API', hint: () => (settings.get('openaiApiKey') ? 'Auto-pick type, Suggest sensitive marks' : 'Needs an OpenAI API key') },
};
const stored = () => settings.get('featureFlags') || {};
const on = (id) => Object.hasOwn(FLAGS, id) && stored()[id] === true;
const list = () => Object.entries(FLAGS).map(([id, f]) => ({ id, label: f.label, hint: f.hint(), on: on(id) }));
function set(id, value) {
  if (!Object.hasOwn(FLAGS, id) || typeof value !== 'boolean') throw new Error('No feature flag called ' + id);
  settings.set('featureFlags', { ...stored(), [id]: value });
  send('flags:changed', list()); // every page of every window: the rows they offer follow
  return list();
}

const ipc = {
  'flags:list': () => list(),
  'flags:set': (_e, id, value) => set(id, value),
};

module.exports = { FLAGS, on, list, set, ipc };
