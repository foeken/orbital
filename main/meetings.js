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
  return { id: doc.id, editable: await canEdit(doc), start: n.startTime, end: n.endTime, allDay: n.allDay === true, location: n.location || '',
    participants: Object.keys(n.participants || {}), attendees: events.attendees(doc).map(({ key, name, email, identityUri, role, cutype }) => ({ key, name, email, identityUri, role, cutype })),
    syncStatus: n.syncStatus, syncError: n.syncError };
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

// What the renderer asks this module (preload.js names each channel for the page; main.js registers the table).
const ipc = {
  'meeting:info': (_e, id) => meetingInfo(id),
  'meeting:edit': (_e, id, change) => editMeeting(id, change),
  'meeting:suggestions': () => attendeeSuggestions(),
  // the meeting this user has joined right now, for the outliner's Pin to current meeting row
  'meeting:current': () => currentMeeting(),
};

module.exports = { meetingInfo, editMeeting, attendeeSuggestions, currentMeeting, ipc };
