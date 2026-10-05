'use strict';
// A meeting's time, place and people from Cmd+K (main/meetings.js, docs/MEETINGS.md "Editing a meeting"). The three
// rows are offered on a meeting only once main has said this user may change it — Tana's organizer rule — so nobody is
// shown a row that would be refused. Each opens a page of its own, like Pin to date: what is typed is read on the spot
// and the one row under it shows exactly what Enter writes.
let meetingCtx = null; // { docId, info } for the meeting Cmd+K was opened on; info is null while main is asked
let attendeePool = null; // the suggestions the Add attendee page lists, null while they are fetched
// A meeting's info for its page's Attendees field (renderer/fields.js attendeesFieldEl), per event: asked once, and
// again when the event changes (renderer/app.js onChanged) with the last answer kept on screen meanwhile.
const meetingInfos = new Map(); // event id -> main's meeting:info answer, null while the first one is on its way
function meetingInfoOf(id, fresh) {
  if ((meetingInfos.has(id) && !fresh) || !connected) return meetingInfos.get(id) || null;
  if (!meetingInfos.has(id)) meetingInfos.set(id, null);
  tana.meetingInfo(id).then((info) => { meetingInfos.set(id, info); renderSoon(); }, () => { if (!meetingInfos.get(id)) meetingInfos.delete(id); }); // refused: the next render asks again
  return meetingInfos.get(id);
}
function loadMeetingCtx(doc) {
  if (meetingCtx && meetingCtx.docId === doc.id) return meetingCtx.loaded;
  const mine = meetingCtx = { docId: doc.id, info: null };
  return mine.loaded = tana.meetingInfo(doc.id).then((info) => { mine.info = info || { editable: false }; }, () => { mine.info = { editable: false }; })
    .then(() => { if (meetingCtx === mine && !palette.hidden && palMode === 'cmd') renderPalette(); });
}
// "Tue 22 Sep 10:00–10:30", spelled out rather than toLocale*: ICU's en-GB has started writing "Sept"
const clock = (t) => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const meetingDay = (t) => { const d = new Date(t), mon = MONTHS[d.getMonth()]; return WD[d.getDay()] + ' ' + d.getDate() + ' ' + mon[0].toUpperCase() + mon.slice(1, 3); };
const meetingSpan = (start, end) => meetingDay(start) + ' ' + clock(start) + '\u2013' + clock(end);
// "From Standup · Tue 22 Sep": the meeting a task (meetingLinkEl) or a page (renderer/rail.js drawMeetingBtn) came from
const fromMeetingLabel = (m) => 'From ' + (m.title ? demoText(m.title, m.id) : 'a meeting') + (m.start ? ' · ' + meetingDay(m.start) : '');
// The meeting a page stands for: the event itself, or the event a write-up lives in — a zoomed meeting opens at its
// write-up (edit.js), and the sidebar already shows that meeting's hub, whose pinHub says this user may write it.
function meetingOf(doc) {
  if (!doc) return null;
  if (doc.icon === 'meeting') return doc;
  const hub = (relatedBy.get(doc.id) || {}).pinHub;
  return typeof hub === 'string' && hub.startsWith('tana:event:') ? { id: hub } : null;
}
function meetingRows(page, group) {
  const doc = meetingOf(page);
  if (!doc || !tana.meetingInfo || !tana.editMeeting) return [];
  // With the palette closed nothing is asked (#274): a key on one of these rows asks for its meeting in runAction (#391).
  if (palette.hidden && !(meetingCtx && meetingCtx.docId === doc.id)) return [];
  loadMeetingCtx(doc);
  const info = meetingCtx.info;
  if (!info || !info.editable) return [];
  const people = (info.attendees || []).length;
  return [
    // not on an all-day meeting: Tana has no date-only write path to the calendar, and its updateEvent refuses the same
    ...(info.allDay ? [] : [{ id: 'meetingTime', group, icon: 'calendar', label: 'Change time \u2026', hint: info.start ? meetingSpan(info.start, info.end) : '', keepOpen: true, run: () => openMeetingPage('meetingTime', 'Move to\u2026') }]),
    { id: 'meetingLocation', group, icon: 'globe', label: 'Change location \u2026', hint: demoText(info.location || '', doc.id), keepOpen: true, run: () => openMeetingPage('meetingLocation', 'Location\u2026') },
    { id: 'meetingAttendee', group, icon: 'member', label: 'Add attendee \u2026', hint: people ? people + (people === 1 ? ' attendee' : ' attendees') : '', keepOpen: true, run: () => openMeetingPage('meetingAttendee', 'Add who? New attendees may get a calendar invite') },
  ];
}
// "14:00", "tomorrow 9:30", "fri 10:00-11:30", "tomorrow": a day in Pin to date's words (parseDay) and/or a clock
// time. A start alone keeps the meeting's length; a day alone keeps its time of day. Anything else reads as none.
function parseMeetingTime(text, start, length, now = new Date()) {
  const s = String(text || '').trim().toLowerCase();
  const m = s.match(/(?:^|\s)(\d{1,2})[:.](\d{2})(?:\s*(?:-|\u2013|to)\s*(\d{1,2})(?:[:.](\d{2}))?)?$/);
  const words = (m ? s.slice(0, m.index) : s).trim(), day = words ? parseDay(words, now) : null;
  if (!s || (words && !day)) return null;
  const from = new Date(start), base = day ? new Date(day + 'T00:00') : from;
  const at = (h, min) => (h > 23 || min > 59 ? NaN : new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, min).getTime());
  const s0 = m ? at(+m[1], +m[2]) : at(from.getHours(), from.getMinutes());
  const e0 = m && m[3] ? at(+m[3], +(m[4] || 0)) : s0 + length;
  return Number.isFinite(s0) && Number.isFinite(e0) && e0 > s0 ? { start: s0, end: e0 } : null;
}
function meetingTimeRows(q, typed) {
  const info = meetingCtx && meetingCtx.info, words = (typed || '').trim(), group = 'Change time';
  if (!info) return [];
  if (!words) return [{ group, icon: 'calendar', label: 'Type a day and/or a time: 14:00, tomorrow 9:30, fri 10:00-11:30', disabled: true }];
  const when = parseMeetingTime(words, info.start, info.end - info.start);
  if (!when) return [{ group, icon: 'calendar', label: 'No time in \u201C' + words + '\u201D', disabled: true }];
  return [{ group, icon: 'calendar', label: meetingSpan(when.start, when.end), hint: '\u21A9', run: () => editMeetingNow({ start: when.start, end: when.end }) }];
}
function meetingLocationRows(q, typed) {
  const info = meetingCtx && meetingCtx.info, words = (typed || '').trim(), group = 'Change location';
  if (!info) return [];
  if (words) return [{ group, icon: 'globe', label: 'Set location to \u201C' + words + '\u201D', hint: '\u21A9', run: () => editMeetingNow({ location: words }) }];
  if (!info.location) return [{ group, icon: 'globe', label: 'Type a room, an address or a link', disabled: true }];
  return [{ group, icon: 'globe', label: demoText(info.location, meetingCtx.docId), hint: 'Current', disabled: true }, { group, icon: 'none', label: 'Remove location', run: () => editMeetingNow({ location: '' }) }];
}
function loadAttendeePool() {
  attendeePool = null;
  const asked = tana.attendeeSuggestions ? tana.attendeeSuggestions().catch(() => []) : Promise.resolve([]);
  Promise.all([asked, membersLoaded().catch(() => {})]).then(([list]) => {
    attendeePool = Array.isArray(list) ? list : [];
    if (palMode === 'meetingAttendee') renderPalette();
  });
}
// Tana's suggestions first (people you meet, with their email), then the org's members they do not already name.
// Whoever is on the meeting already — by grant, by profile or by email — is not offered again, as in Tana's picker.
function meetingAttendeeRows(q, typed) {
  const info = meetingCtx && meetingCtx.info, words = (typed || '').trim(), group = 'Add attendee';
  if (!info) return [];
  if (!attendeePool) return [{ group, label: 'Loading\u2026', disabled: true }];
  const here = new Set([...(info.participants || []), ...(info.attendees || []).flatMap((a) => [a.identityUri, a.email && a.email.toLowerCase()])].filter(Boolean));
  const rows = [], named = new Set();
  const add = (label, hint, person) => rows.push({ group, icon: 'member', label, hint, keepOpen: true, run: () => editMeetingNow({ attendees: [person] }, true) });
  for (const s of attendeePool) {
    const email = String(s.email || '').toLowerCase();
    if (s.identityUri) named.add(s.identityUri);
    if (here.has(s.identityUri) || here.has(email) || !(fuzzyMatch(s.displayName || email, q) || email.includes(q))) continue;
    add(demoMode ? demoPersonName(s.identityUri || s.email) : s.displayName || s.email, demoMode ? '' : s.displayName ? s.email : '', { email: s.email, userUri: s.identityUri });
  }
  for (const m of members || []) if (!m.me && !here.has(m.id) && !named.has(m.id) && fuzzyMatch(m.title || '', q)) add(memberName(m.id), 'Member', { userUri: m.id });
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(words) && !here.has(q) && !rows.some((r) => r.hint.toLowerCase() === q)) rows.unshift({ group, icon: 'member', label: 'Add ' + words, hint: '\u21A9', keepOpen: true, run: () => editMeetingNow({ attendees: [{ email: words }] }, true) });
  if (!rows.length) rows.push({ group, label: q ? 'No one matches \u2014 type an email address to add it' : 'No one to suggest', disabled: true });
  return rows;
}
// One write, then the page's answer is main's: the meeting as it now is. A row that is not keepOpen has already
// closed the palette (runRow); adding someone keeps the page open for the next person.
function editMeetingNow(change, stay) {
  const ctx = meetingCtx;
  run(async () => {
    const info = await tana.editMeeting(ctx.docId, change);
    if (meetingCtx === ctx && info) ctx.info = info;
    if (stay && !palette.hidden) { palInput.value = ''; palIndex = 0; renderPalette(); }
  });
}
function openMeetingPage(mode, placeholder) {
  if (mode === 'meetingAttendee') loadAttendeePool();
  openPage(mode, placeholder, { rows: { meetingTime: meetingTimeRows, meetingLocation: meetingLocationRows, meetingAttendee: meetingAttendeeRows }[mode], back: BACK_TO_COMMANDS, typed: true });
}

// The way back to the meeting a task came from (main/rows.js meetingOf): a grey glyph after the title, there only while
// the row is hovered or has the caret (styles.css .meeting-link), its tooltip naming the meeting and its day. A click
// opens the meeting, which forwards to its write-up (renderer/edit.js); the caret stays in the row.
function meetingLinkEl(meeting, fact = false) { // fact: one of the row's fact icons (.ticon), the size of Pinned beside it
  // icon only, so its name comes from the label
  return addIcon(quietButton(fact ? 'ticon meeting-link' : 'meeting-link', fromMeetingLabel(meeting), (e) => { e.stopPropagation(); run(() => goTo(meeting.id)); }, { tabIndex: -1 }), 'meeting');
}
// ---- Edit meeting details (#758): one field, the words read by the AI into a day, a start and an end ----
// Offered where Change time is (a meeting this user may change, not all-day). The words are read only when ↩ asks
// (api.readMeetingTime: the AI transcribes them, main/meetings.js readTime and resolveTime decide what they come to, on
// this Mac's clock), and what they came to is shown as the row to press, said to be the AI's reading; only that press writes
// it, through the same editMeeting as Change time. The page reads nothing else: no people, no place, no invitation.
let meetingDetailsRead = null; // { words, busy, answer, error } for the page on screen (renderer/toolbar.js readRows)
function meetingDetailsRows(page, group) {
  const doc = meetingOf(page), info = meetingCtx && doc && meetingCtx.docId === doc.id ? meetingCtx.info : null; // meetingRows has asked main already
  if (!info || !info.editable || info.allDay || !tana.readMeetingTime || !tana.editMeeting) return [];
  return [{ id: 'meetingDetails', group, icon: 'sparkle', label: 'Edit meeting details', hint: 'Say when, in your own words', keepOpen: true, run: openMeetingDetails }];
}
function openMeetingDetails() {
  const docId = meetingCtx && meetingCtx.docId;
  meetingDetailsRead = null;
  openPage('meetingDetails', 'When? tomorrow from 3-5, an hour later, for 45 minutes', { back: BACK_TO_COMMANDS, typed: true, rows: (q, typed) => {
    const info = meetingCtx && meetingCtx.docId === docId ? meetingCtx.info : null, words = String(typed || '').trim(), group = 'Edit meeting details';
    if (!info) return [];
    const now = { group, icon: 'calendar', label: meetingSpan(info.start, info.end), hint: 'Now', disabled: true, note: true };
    // a meeting kept in another zone: what this page shows, and what words mean, is your clock
    const kept = info.timeZone && info.timeZone !== localZone() ? [{ group, icon: 'globe', label: 'Your time \u00B7 the meeting keeps ' + zoneName(info.timeZone) + ' time', disabled: true, note: true }] : [];
    if (!words) return [now, ...kept];
    return [...readRows(meetingDetailsRead, words, group, () => readWords(meetingDetailsRead, (r) => { meetingDetailsRead = r; }, words, docId, 'meetingDetails'),
      (t) => ({ group, icon: 'calendar', label: meetingSpan(t.start, t.end), hint: '↩ Apply · read by AI', run: () => { if (meetingCtx && meetingCtx.docId === docId) editMeetingNow({ start: t.start, end: t.end }); } })), now, ...kept];
  } });
}
