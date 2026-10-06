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
// A calendar event that takes whole days: Tana says so now (calendarEvent.allDay); older events only by starting at
// midnight (UTC or local) and spanning whole days. main/rows.js words it, main/timeline.js leaves it off the rail.
function isAllDay(start, end, allDayFlag) {
  const s = new Date(start), e = end ? new Date(end) : null;
  const midnight = s.getUTCHours() + s.getUTCMinutes() === 0 || s.getHours() + s.getMinutes() === 0;
  return allDayFlag === true || !!(e && midnight && (e - s) % 864e5 === 0);
}
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

// ---- a wall clock in a time zone: a time said in words (main/meetings.js), a reminder's due time (sdk/inbox.js) ----
// The wall clock in a zone at t, { y, mo, d, h, mi, s, weekday }; no zone is this machine's own, asked afresh each time
// (it changes when you travel). An unknown zone throws, as Intl does.
const formats = new Map();
function partsIn(timeZone, t) {
  let f = timeZone && formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long' });
    if (timeZone) formats.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(t).map(({ type, value }) => [type, value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, weekday: p.weekday };
}
// Epoch ms of a wall-clock time in a zone, or NaN when the clocks skip it that day (the hour summer time starts); in the
// hour a clock turns back, the later of the two
function wallTime(timeZone, y, mo, d, h, mi) {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) { const p = partsIn(timeZone, t); t += want - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi); }
  const p = partsIn(timeZone, t), n = new Date(want);
  return p.y === n.getUTCFullYear() && p.mo === n.getUTCMonth() + 1 && p.d === n.getUTCDate() && p.h === h && p.mi === mi ? t : NaN;
}

module.exports = { parseDateUri, isDateUri, dateUri, dateLabel, partsIn, wallTime, isAllDay };
