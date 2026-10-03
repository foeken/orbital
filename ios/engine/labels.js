'use strict';
// What a Timeline row says of its time, worked out once here with the desktop's own formatting (renderer/timeline.js
// timelineTime, dayKey, timelineDay) in this phone's time zone and language (the web view's), so both phones show what
// the Mac shows and neither formats a time of its own: the time on the rail (the blocks above the days keep the 'Now'
// and '' main/timeline.js gave them), the day an entry is under (YYYY-MM-DD) and that day in words. Today and
// Yesterday the phone says itself (Timeline.swift day, Times.kt day), so a heading is right past midnight before the
// next read. A meeting to come with no end has no "13:10–13:40" (main/timeline.js meetingNote): its start instead.
const time = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); // a column of times: 24-hour, so they line up
const dayKey = (at) => new Date(at).toLocaleDateString('sv-SE');
const dayTitle = (key) => new Date(key + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

function times(rows) {
  return rows.map((r) => {
    const t = r.timeline;
    if (!t || t.today || t.free) return r;
    if (t.upcoming) return { ...r, children: (r.children || []).map((m) => (m.subtext || !m.start ? m : { ...m, subtext: time(m.start) })) };
    if (!r.createdAt) return r;
    const day = dayKey(r.createdAt);
    return { ...r, timeline: { ...t, time: t.time ?? time(r.createdAt), day, dayTitle: dayTitle(day) } };
  });
}

module.exports = { times, time, dayKey, dayTitle };
