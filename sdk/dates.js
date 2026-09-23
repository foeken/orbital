'use strict';
// Date mentions. Tana mentions a day as tana:plaindate:YYYY-MM-DD and a day (with an optional time) in a zone as
// tana:zoneddate:YYYY-MM-DD[THH:MM][Area/City]; a date field's value is one such mention. They are not documents:
// nothing to subscribe, and a mention of one is an ordinary mention map ({ label, tanaUri }) in the text. Read out of
// Tana's web bundle (shared-DY5PxYw3.js, 2026-09-23: Fa/Gie/Ia/Kie/qie, parse La, make za, label Ba); its "@" menu
// always writes a plaindate, labelled like "Sep 30, 2026" in the writer's locale.
// "Which documents mention this day" is the graph's own backlink question asked of the date uri: incoming LINKS_TO /
// ATTRIBUTE_LINKS_TO edges, by listEdges({ toNodeIds: [uri] }) or an edge live query (main/related.js does both).
const PLAIN = 'tana:plaindate:', ZONED = 'tana:zoneddate:';
const DAY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const DAY_TIME = /^(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))(?:T(\d{2}:\d{2}))?$/;
const ZONE = /\[([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\]$/;

// { type: 'plaindate', date } | { type: 'zoneddate', date, time?, timezone } | undefined for anything else
function parseDateUri(uri) {
  if (typeof uri !== 'string') return undefined;
  if (uri.startsWith(PLAIN)) { const date = uri.slice(PLAIN.length); return DAY.test(date) ? { type: 'plaindate', date } : undefined; }
  if (!uri.startsWith(ZONED)) return undefined;
  const rest = uri.slice(ZONED.length), zone = ZONE.exec(rest), m = zone && DAY_TIME.exec(rest.slice(0, zone.index));
  return m ? { type: 'zoneddate', date: m[1], ...(m[2] ? { time: m[2] } : {}), timezone: zone[1] } : undefined;
}
const isDateUri = (uri) => parseDateUri(uri) !== undefined;
function dateUri(date) {
  if (!DAY.test(date)) throw new Error('not a YYYY-MM-DD date: ' + date);
  return PLAIN + date;
}
// The label Tana gives a date mention when it has none of its own: the day, in the locale's short form.
const LABEL = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
function dateLabel(uri) {
  const d = parseDateUri(uri);
  return d ? LABEL.format(new Date(d.date + 'T00:00:00')) : uri;
}

module.exports = { parseDateUri, isDateUri, dateUri, dateLabel };
