'use strict';
// Demo mode (Settings), as the desktop's (docs/OUTLINER.md §17), masked by the desktop's own words (renderer/segments.js):
// what came from Tana in made-up words and names, one for one and the same each time, the app's own words and a saved
// search's title kept. Nothing is saved while it is on (index.js refuses every write).
const { demoText, demoSegments, demoPersonName, demoWordCount, setDemo } = require('../../renderer/segments.js');

let on = false;
const person = (name) => demoPersonName(name, demoWordCount(name));
const masked = (r) => ({
  ...r,
  ...(r.title != null ? { title: demoText(r.title, r.id) } : {}),
  ...(r.text != null ? { text: demoText(r.text, (r.chat && r.chat.author) || r.id) } : {}),
  ...(r.segments ? { segments: demoSegments(r.segments, r.id) } : {}),
  ...(r.reference ? { reference: { ...r.reference, label: demoText(r.reference.label, r.reference.uri) } } : {}),
  ...(r.people ? { people: r.people.map((p) => ({ ...p, name: person(p.name) })) } : {}),
  ...(r.timeline ? { timeline: { ...r.timeline, change: r.timeline.change && demoText(r.timeline.change, r.timeline.uri), detail: r.timeline.detail && demoText(r.timeline.detail, r.timeline.uri) } } : {}),
  ...(r.children ? { children: r.children.map(masked) } : {}),
});
const demo = (rows) => (on ? rows.map(masked) : rows);
const demoTitle = (title, id) => (on ? demoText(title, id) : title);
const demoName = (name) => (on ? person(name) : name);
const demoOn = (value) => { on = !!value; setDemo(on); return on; };

module.exports = { demo, demoName, demoTitle, demoOn, isDemo: () => on };
