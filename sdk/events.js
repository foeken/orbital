'use strict';
// Editing a meeting (a 'tana:event:' document) the way Tana's own event wrapper does (shared-*.js, read 2026-09-23).
// Who may call these is access.canEditEvent's answer; these only write. Tana has no origin check: a calendar-synced
// event ('provider') is edited like a Tana-made one ('tana') and the server writes the change back to the calendar,
// reporting it in data.syncStatus ('pending' | 'synced' | 'failed') and data.syncError. No client writes those two.
const { LoroMap } = require('loro-crdt');
const { ulid } = require('./node');

const PROFILE = /^tana:(?:user-profile|contact):[0-9a-z]{26}$/;
// A roster line is keyed by its email, or 'tana:<ulid>' for a person without one. Tana's Yl/xl trims ASCII whitespace
// and lowercases A-Z only, so a key made here is the key Tana makes for the same address.
const lineKey = (email) => {
  const e = typeof email === 'string' ? email.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '').replace(/[A-Z]/g, (c) => c.toLowerCase()) : '';
  return e ? 'email:' + e : undefined;
};
const put = (map, entry) => { for (const [k, v] of Object.entries(entry)) if (v !== undefined) map.set(k, v); };
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

// setStartTime/setEndTime: epoch ms, and a timed event is no longer all-day. Tana's reschedule writes both at once.
function setTime(doc, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('A meeting needs a start before its end');
  doc.transact((loro) => { const d = loro.getMap('data'); d.set('startTime', start); d.set('endTime', end); d.delete('allDay'); });
}
const setter = (key) => (doc, value) => {
  if (value !== undefined && typeof value !== 'string') throw new Error(key + ' must be text');
  doc.transact((loro) => { const d = loro.getMap('data'); if (value === undefined) d.delete(key); else d.set(key, value); });
};
const setTimezone = setter('timezone'), setLocation = setter('location'), setDescription = setter('description');

// The roster is the root 'attendees' map; a calendar-synced event may still list its people only in the older
// data.attendees list and data.organizer. Tana copies those in before its first roster write (seedRosterFromLegacyAttendees),
// so a roster that suddenly exists does not drop the calendar's own attendees from the write-back.
function seedRoster(loro) {
  const roster = loro.getMap('attendees'), data = loro.getMap('data').toJSON(), seen = new Set();
  const add = (key, entry) => { seen.add(key); put(roster.setContainer(key, new LoroMap()), entry); };
  for (const a of Array.isArray(data.attendees) ? data.attendees : []) {
    const key = a && typeof a === 'object' ? lineKey(a.email) : undefined;
    if (key && !seen.has(key) && roster.get(key) === undefined) add(key, { source: 'provider', providerConfirmed: true, ...pick(a, ['email', 'name', 'role', 'cutype', 'partstat']) });
  }
  const o = data.organizer || {}, key = lineKey(o.email);
  if (key && !seen.has(key) && roster.get(key) === undefined) add(key, { source: 'provider', role: 'required', cutype: 'individual', ...pick(o, ['email', 'name']) });
}
// upsertAttendee: merge into the line, or start it as a required individual.
function upsertAttendee(loro, key, entry) {
  const roster = loro.getMap('attendees'), line = roster.get(key);
  if (line instanceof LoroMap) return put(line, entry);
  put(roster.setContainer(key, new LoroMap()), { role: 'required', cutype: 'individual', ...entry });
}
// Tana's add-attendees step: a person with an email becomes that email's line; one without becomes a 'tana:' line
// pointing at their profile; an org member (user profile) is also given access as an attendee, stamped with who added
// them. Tana's picker only offers people not already there; here an existing grant is left as it is rather than
// being turned into 'attendee', which would take an organizer's rights away.
function addAttendees(doc, people, byUri) {
  // checked before the transaction: a throw inside it would leave the ops before it to be committed by the next write
  if (!Array.isArray(people) || people.some((p) => !p || !(lineKey(p.email) || PROFILE.test(p.userUri || '')))) throw new Error('An attendee needs an email or a profile');
  doc.transact((loro) => {
    seedRoster(loro);
    const data = loro.getMap('data');
    for (const p of people) {
      const uri = PROFILE.test(p.userUri || '') ? p.userUri : undefined, key = lineKey(p.email) || (uri && 'tana:' + ulid());
      upsertAttendee(loro, key, lineKey(p.email) ? { source: 'tana', email: p.email.trim() } : { source: 'tana', identityUri: uri });
      if (!uri || !uri.startsWith('tana:user-profile:')) continue;
      const grants = data.get('participants') || data.setContainer('participants', new LoroMap());
      if (grants.get(uri) === undefined) put(grants.setContainer(uri, new LoroMap()), { type: 'user', role: 'attendee', changedBy: byUri });
    }
  });
}
// Who is on the meeting, as Tana lists them: roster lines first, then legacy entries whose email is not already there.
function attendees(doc) {
  const roster = doc.loro.getMap('attendees').toJSON() || {}, legacy = doc.data.toJSON().attendees;
  const out = Object.entries(roster).filter(([, a]) => a && typeof a === 'object').map(([key, a]) => ({ key, ...a }));
  const have = new Set(out.map((a) => lineKey(a.email)).filter(Boolean));
  for (const a of Array.isArray(legacy) ? legacy : []) if (a && typeof a === 'object' && !have.has(lineKey(a.email))) out.push({ key: lineKey(a.email), ...a });
  return out;
}

module.exports = { setTime, setTimezone, setLocation, setDescription, addAttendees, attendees, lineKey };
