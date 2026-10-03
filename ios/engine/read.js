'use strict';
// The Timeline as the phone reads it (index.js timeline). The settings document and the Timeline are asked side by side:
// the Timeline needs only the watch choices from it, which this phone keeps a copy of, while what is sensitive must be
// read first (index.js settled), and one after the other they kept a launch waiting on both. So nothing is shown before
// the settings are read: Today's Tasks and Upcoming meetings, which main/timeline.js has long before the rest at a busy
// hour, go to the app (part) once they are, marked with them; the Timeline is read again when they moved what it follows.
// rows(progress): main/timeline.js rows; settled(): the settings read, which throws when nothing may be shown;
// follows(): what of the settings the Timeline reads, to compare; redact(rows): marked sensitive and masked in demo mode
async function read({ rows, settled, follows, redact, part }) {
  const before = follows();
  let open = false, early = null, landed = false;
  const page = rows((p) => { if (landed) return; if (open) part(redact(p)); else early = p; });
  page.then(() => { landed = true; }, () => {}); // a refusal is answered below, after the settings' own
  await settled();
  open = true;
  if (early && !landed) part(redact(early));
  let got = await page;
  if (follows() !== before) got = await rows();
  return redact(got);
}

module.exports = { read };
