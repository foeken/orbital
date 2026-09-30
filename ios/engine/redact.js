'use strict';
// What you marked sensitive in Orbital never crosses to the phone's screens (index.js secret, the settings document's
// sensitive ids): the desktop blurs it until you reveal it, and the phone has no reveal. hidden is the set of ids.
const PRIVATE = 'Private';
// A mention of one or a link to one reads Private too, and a reference to one (a chat's attachment, an embed) is named so.
function redact(rows, hidden) {
  if (!hidden.size) return rows;
  const scrub = (segs) => segs && segs.map((g) => (g.mention && hidden.has(g.mention.uri) ? { ...g, mention: { ...g.mention, label: PRIVATE } }
    : g.marks && hidden.has(g.marks.link) ? { ...g, text: PRIVATE } : g));
  return rows.map((row) => {
    const r = { ...row, segments: scrub(row.segments), ...(row.reference && hidden.has(row.reference.uri) ? { reference: { ...row.reference, label: PRIVATE }, text: PRIVATE } : {}) };
    const children = r.children && redact(r.children, hidden);
    if (!hidden.has(r.id) && !hidden.has(r.timeline && r.timeline.uri)) return { ...r, children };
    const said = r.timeline && !r.timeline.today ? 'A private item changed' : PRIVATE;
    return { ...r, title: said, text: said, segments: [{ text: said }], children, subtext: null, people: [],
      ...(r.timeline ? { timeline: { ...r.timeline, note: null, change: null, detail: null } } : {}) };
  });
}

module.exports = { PRIVATE, redact };
