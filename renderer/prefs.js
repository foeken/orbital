'use strict';
// The preferences that follow you between machines. Main keeps them in the app's own settings document in Tana
// (main/settings.js); here they are one plain object, read synchronously from preload before anything renders, so
// the first paint is already yours rather than the defaults with your choices arriving a moment later.
//
// What is *not* here is as deliberate: where you were, which page you had open, the width you dragged the sidebar
// to and the window's size stay in localStorage, because they belong to the machine you set them on.
// A copy, not the bridge's own object: contextBridge freezes everything it exposes, so writing a preference
// straight into it threw (silently killing whatever ran after the write — a folded section never redrew, and
// nothing was ever stored).
const prefs = { ...(window.api && window.api.prefs) };
const pref = (key, fallback) => (prefs[key] === undefined ? fallback : prefs[key]);
// Written through: the object answers the next read here, and main stores it and syncs it. A window that is offline
// keeps the choice locally and pushes it up on the next connect.
function setPref(key, value) {
  if (value === undefined) delete prefs[key]; else prefs[key] = value;
  if (window.api && window.api.setPref) window.api.setPref(key, value);
}
// Another machine changed something: replace what we hold, so whoever re-reads a preference gets the new answer.
// Applying it to what is already on screen is app.js's business — it is the file that can see every piece of state
// a preference feeds.
function mergePrefs(next) {
  for (const key of Object.keys(prefs)) delete prefs[key];
  Object.assign(prefs, next && typeof next === 'object' ? next : {});
}
