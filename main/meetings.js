'use strict';
// A meeting's time, place and people, changed from the outliner (docs/MEETINGS.md, "Editing a meeting"). The writes
// are sdk/events.js; who may make them is access.canEditEvent, Tana's own organizer rule. Not through mut: the
// outliner's editable() keeps an event's title read-only, and a calendar change is not an outline step to undo.
const access = require('../sdk/access');
const calls = require('../sdk/calls');
const events = require('../sdk/events');
const { readNode } = require('../sdk/node');
const { NOT_CONNECTED, S } = require('./state');
const { accessContext, op } = require('./documents');

const EVENT = /^tana:event:[0-9a-z]{26}$/;
const REFUSED = 'Only the event organizer can change this meeting'; // Tana's own words for its refusal
const canEdit = async (doc) => access.canEditEvent(doc, S.me.userUri, await accessContext());
const snapshot = async (doc) => {
  const n = readNode(doc);
  return { id: doc.id, title: n.title || '', editable: await canEdit(doc), start: n.startTime, end: n.endTime, allDay: n.allDay === true, location: n.location || '',
    participants: Object.keys(n.participants || {}), attendees: events.attendees(doc).map(({ key, name, email, identityUri, role, cutype }) => ({ key, name, email, identityUri, role, cutype })),
    syncStatus: n.syncStatus, syncError: n.syncError, timeZone: knownZone(n.timezone) || undefined }; // the zone the meeting keeps, which may not be yours
};
function check(id) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  if (typeof id !== 'string' || !EVENT.test(id)) throw new Error('Not a meeting');
}
const meetingInfo = async (id) => { check(id); return op(id, snapshot); };
// change: { start, end } (epoch ms) | { location } ('' removes it) | { attendees: [{ email?, userUri? }] }
async function editMeeting(id, change) {
  check(id);
  const c = change && typeof change === 'object' ? change : {};
  return op(id, async (doc) => {
    if (!await canEdit(doc)) throw new Error(REFUSED);
    // Tana's updateEvent refuses this too: it has no date-only write path to the calendar, so the change would not arrive
    if (('start' in c || 'end' in c) && readNode(doc).allDay === true) throw new Error('An all-day meeting is rescheduled in its calendar');
    if ('start' in c || 'end' in c) events.setTime(doc, c.start, c.end);
    if ('location' in c) events.setLocation(doc, typeof c.location === 'string' && c.location.trim() ? c.location.trim() : undefined);
    if ('attendees' in c) events.addAttendees(doc, c.attendees, S.me.userUri);
    return snapshot(doc);
  });
}
// Tana's own picker asks once and keeps the answer; it changes as meetings happen, so here each open asks again.
async function attendeeSuggestions() {
  if (!S.client) throw new Error(NOT_CONNECTED);
  return S.client.graph.listAttendeeSuggestions({ limit: 20 });
}

// The meeting this user has joined right now, for ⌘K "Pin to current meeting". Read at every ask, never cached:
// "the meeting I am in" is true for minutes at a time. currentCalls is the only proof of having joined
// (docs/MEETINGS.md); an event merely scheduled now is not it.
async function currentMeeting() {
  if (!S.client || !S.me) throw new Error(NOT_CONNECTED);
  const [live] = await calls.currentCalls(S.client, S.me.userUri, { limit: 5 });
  if (!live || !live.eventUri) return null;
  return { id: live.eventUri, title: live.title || '', joinedAt: live.joinedAt, callUri: live.callUri };
}

// ---- A time read from words (Edit meeting details, "/" Meeting's when page; docs/MEETINGS.md "Reading a time") ----
// The AI writes down what the words say (main/ai.js readMeetingTime); what that comes to is decided here, the same way
// every time, in your time zone (this Mac's), whatever zone the meeting is kept in: a day left out is your today, and
// "tomorrow from 3-5" is 15:00 where you are. A zone the words name ("9am New York time") is used when it is a real one,
// and asked about when it is not; it is never dropped. Then: a clock time whose hour
// the words leave open is in the day (a bare 1 to 6 is the afternoon, 7 to 11 the morning, 12 noon), so "tomorrow from
// 3-5" is 15:00-17:00; an end left open is the first one after the start; a length left out is the meeting's own (half an
// hour for a new one). A time the words fix (3am, 03:00, midnight) is kept as said. Nothing is carried past midnight but
// "until midnight", nothing lasts a day, and a time the clocks skip that day is refused, never moved. Only read: applying
// it is editMeeting, behind Tana's organizer rule, or "/" Meeting's create.
const DAY_MS = 864e5, HALF_HOUR = 18e5, UNREAD = 'The AI did not answer with a time';
const formats = new Map();
function partsIn(timeZone, t) { // the wall clock in a zone: { y, mo, d, h, mi, weekday }
  let f = formats.get(timeZone);
  if (!f) formats.set(timeZone, f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'long' }));
  const p = Object.fromEntries(f.formatToParts(t).map(({ type, value }) => [type, value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, weekday: p.weekday };
}
// epoch ms of a wall-clock time in a zone, or NaN when the clocks skip it that day (the hour summer time starts)
function wallTime(timeZone, y, mo, d, h, mi) {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) { const p = partsIn(timeZone, t); t += want - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi); }
  const p = partsIn(timeZone, t), n = new Date(want);
  return p.y === n.getUTCFullYear() && p.mo === n.getUTCMonth() + 1 && p.d === n.getUTCDate() && p.h === h && p.mi === mi ? t : NaN;
}
// a time zone Intl knows, by its own name for it, or null
const knownZone = (timeZone) => {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return null;
  try { return new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() }).resolvedOptions().timeZone; } catch { return null; }
};
const zoneOf = (timeZone) => knownZone(timeZone) || Intl.DateTimeFormat().resolvedOptions().timeZone; // this Mac's when none is given
function clockOf(c) {
  if (c == null) return null;
  if (typeof c !== 'object' || Array.isArray(c) || !Number.isInteger(c.hour) || !Number.isInteger(c.minute) || typeof c.fixed !== 'boolean' || c.hour < 0 || c.hour > 23 || c.minute < 0 || c.minute > 59) throw new Error(UNREAD);
  return { hour: c.hour, minute: c.minute, fixed: c.fixed || c.hour === 0 || c.hour > 12 }; // 0 or 13-23 can only be a 24-hour time
}
// the AI's { date, start, end, minutes, zone, question } -> { start, end, timeZone } (epoch ms, and the zone the clock
// times were read in) or { question }; anything else in the answer is ignored, and an answer that is not a time is
// refused. timeZone: yours, in which a day left out is today; a zone the words named reads their clock times instead.
function resolveTime(answer, { now, timeZone, start, end }) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error(UNREAD);
  if (typeof answer.question === 'string' && answer.question.trim()) return { question: answer.question.trim().slice(0, 200) };
  let zone = timeZone;
  if (answer.zone != null) {
    if (typeof answer.zone !== 'string') throw new Error(UNREAD);
    zone = knownZone(answer.zone);
    if (!zone) return { question: 'Which time zone is \u201C' + answer.zone.trim().slice(0, 40) + '\u201D? Say a city, such as New York, or UTC' }; // never dropped: asked
  }
  const from = clockOf(answer.start), until = clockOf(answer.end), minutes = answer.minutes ?? null;
  if (minutes !== null && !Number.isInteger(minutes)) throw new Error(UNREAD);
  if (minutes !== null && (minutes <= 0 || minutes >= 1440)) throw new Error('A meeting lasts more than no time and less than a day');
  let day = null;
  if (answer.date != null) {
    const m = typeof answer.date === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(answer.date), u = m && new Date(Date.UTC(+m[1], m[2] - 1, +m[3]));
    if (!m || u.getUTCMonth() !== m[2] - 1 || u.getUTCDate() !== +m[3]) throw new Error('There is no such day');
    day = { y: +m[1], mo: +m[2], d: +m[3] };
  }
  if (!day && !from && !until && minutes === null) throw new Error('No day or time in those words');
  const today = partsIn(timeZone, now), current = partsIn(zone, start); // your today; the meeting's hours on the clock they are read on
  if (day && Math.abs(Date.UTC(day.y, day.mo - 1, day.d) - Date.UTC(today.y, today.mo - 1, today.d)) > 731 * DAY_MS) throw new Error('That day is more than two years away'); // a day named, not one kept
  day = day || (from || until ? today : current); // a time alone is today; a length alone keeps the meeting's day
  const daytime = (h) => (h >= 1 && h <= 6 ? h + 12 : h);
  const s = from ? { h: from.fixed ? from.hour : daytime(from.hour), mi: from.minute } : { h: current.h, mi: current.mi };
  const begins = wallTime(zone, day.y, day.mo, day.d, s.h, s.mi);
  let ends;
  if (until) {
    const after = s.h * 60 + s.mi, h = until.fixed ? until.hour : [until.hour % 12, until.hour % 12 + 12].find((x) => x * 60 + until.minute > after) ?? until.hour;
    if (until.fixed && h === 0 && until.minute === 0 && after > 0) { const n = new Date(Date.UTC(day.y, day.mo - 1, day.d + 1)); ends = wallTime(zone, n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 0, 0); } // "until midnight": the end of that day
    else ends = wallTime(zone, day.y, day.mo, day.d, h, until.minute);
  } else ends = begins + (minutes !== null ? minutes * 6e4 : end - start);
  if (Number.isNaN(begins) || Number.isNaN(ends)) throw new Error('The clocks skip that time that day');
  if (!(ends > begins)) throw new Error('A meeting ends after it starts');
  if (ends - begins >= DAY_MS) throw new Error('A meeting lasts less than a day');
  return { start: begins, end: ends, timeZone: zone };
}
// what the AI is told: today, now, the zone and the meeting as it is, in that zone's own words
function describe({ start, end, timeZone, fresh }, now) {
  const pad = (n) => String(n).padStart(2, '0'), day = (p) => p.weekday + ' ' + p.y + '-' + pad(p.mo) + '-' + pad(p.d), clock = (p) => pad(p.h) + ':' + pad(p.mi);
  const n = partsIn(timeZone, now), s = partsIn(timeZone, start), e = partsIn(timeZone, end);
  return { today: day(n), now: clock(n), timeZone, current: fresh ? '' : day(s) + ' ' + clock(s) + ' to ' + (e.d === s.d ? '' : day(e) + ' ') + clock(e) };
}
// words -> { start, end, timeZone } or { question }, as the AI read them (read: main/ai.js readMeetingTime, which main/ai.js
// sets on S, since this module comes first and does not require it). id: the meeting Edit meeting details is on, refused
// unless this user may change it, as editMeeting refuses; none: a new meeting ("/" Meeting), from now for half an hour, in
// your time zone. Nothing is written.
async function readTime(words, id, read = S.readMeetingTime, now = Date.now()) {
  if (typeof words !== 'string' || !words.trim()) throw new Error('Type when the meeting is');
  if (typeof read !== 'function') throw new Error('No AI here to read a time');
  let ctx;
  if (id == null) { const start = Math.floor(now / 6e4) * 6e4; ctx = { start, end: start + HALF_HOUR, timeZone: zoneOf(), fresh: true }; }
  else {
    check(id);
    ctx = await op(id, async (doc) => {
      if (!await canEdit(doc)) throw new Error(REFUSED);
      const n = readNode(doc);
      if (n.allDay === true) throw new Error('An all-day meeting is rescheduled in its calendar');
      return { start: n.startTime, end: n.endTime, timeZone: zoneOf() }; // your zone, not the meeting's: words mean your clock
    });
    if (!Number.isFinite(ctx.start) || !Number.isFinite(ctx.end) || ctx.end <= ctx.start) throw new Error('This meeting has no time to change');
  }
  return resolveTime(await read(words.trim(), describe(ctx, now)), { now, ...ctx });
}

// What the renderer asks this module (preload.js names each channel for the page; main.js registers the table).
const ipc = {
  'meeting:info': (_e, id) => meetingInfo(id),
  'meeting:edit': (_e, id, change) => editMeeting(id, change),
  'meeting:suggestions': () => attendeeSuggestions(),
  // the meeting this user has joined right now, for the outliner's Pin to current meeting row
  'meeting:current': () => currentMeeting(),
  // Edit meeting details and "/" Meeting's when page: words read into a time to show before anything is written
  'meeting:read': (_e, words, id) => readTime(words, id),
};

module.exports = { meetingInfo, editMeeting, attendeeSuggestions, currentMeeting, readTime, resolveTime, wallTime, partsIn, ipc };
