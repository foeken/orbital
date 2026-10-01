'use strict';
// What you marked sensitive in Orbital (the settings document's sensitive ids) is drawn blurred on the phone, as the
// desktop blurs it, until you shake to show it (OrbitalApp.swift). A row is marked when it is such a node, an entry
// about one, or mentions, links to or refers to one; its words still come along, the phone hides them.
function mark(rows, hidden) {
  if (!hidden.size) return rows;
  const touches = (r) => hidden.has(r.id) || hidden.has(r.timeline && r.timeline.uri) || (r.reference && hidden.has(r.reference.uri))
    || (r.segments || []).some((g) => (g.mention && hidden.has(g.mention.uri)) || (g.marks && hidden.has(g.marks.link)));
  return rows.map((r) => ({ ...r, ...(touches(r) ? { sensitive: true } : {}), ...(r.children ? { children: mark(r.children, hidden) } : {}) }));
}

module.exports = { mark };
