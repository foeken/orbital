'use strict';
// The glyphs both phones draw, one list for both: the Nucleo line icons of icons.js the desktop draws, built into the
// iPhone's asset catalog (scripts/build-ios-glyphs.js) and the Android app's vectors (scripts/build-android-glyphs.js).
// Only the names a screen uses; add one here when a screen needs it, then run both scripts. A menu's own actions (pin,
// trash, …) are the platform's: SF Symbols on the iPhone, Material icons on Android.
const USED = ['timeline', 'library', 'info', 'chatgpt', 'license', 'task', 'doc', 'space', 'member', 'discuss', 'tlAccepted', 'tlLater', 'tlInbox', 'tlNew', 'updated', 'robot', 'tana', 'calendar', 'free', 'todayTasks', 'search', 'language', 'pinRoute', 'hidden', 'lock', 'userLock', 'houseLock', 'users', 'brain', 'sparkle', 'visible', 'demo'];
// the check inside finished work's green disc, drawn heavier as styles.css .tl-done does (stroke 2.5 at 12px), and the
// side menu's glyphs, weighted like its medium text
const HEAVY = { applyDone: ['apply', 2.5], timelineMenu: ['timeline', 1.6], searchMenu: ['search', 1.6] };

module.exports = { USED, HEAVY };
