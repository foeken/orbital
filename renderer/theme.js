'use strict';
// Theme preference: light, dark or follow macOS; applied before anything else renders.

// theme preference (renderer/prefs.js "theme"): 'light' | 'dark' | 'system'; 'system' follows the macOS appearance
// (api.systemTheme / api.onSystemTheme). It follows you between machines like the rest of the preferences. Until a
// theme is chosen it is 'system' (#632): a fresh install looks like the Mac around it, and Cmd+K's Toggle dark mode pins one.
const themeChoice = (value) => (['light', 'dark', 'system'].includes(value) ? value : 'system');
let themePref = themeChoice(pref('theme'));
let theme = themePref === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : themePref; // no flash before api.systemTheme answers
function applyTheme(next) {
  theme = next === 'dark' ? 'dark' : 'light';
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  // window.api, not tana: this runs at load, before renderer/state.js declares it. Main tells the shell, whose line and panels follow it (shell.js).
  if (typeof window !== 'undefined' && window.api && window.api.windowTheme) window.api.windowTheme(theme);
  const pal = document.getElementById('palette'); // by id: this also runs before the palette const exists
  if (pal && !pal.hidden) renderPalette();
}
applyTheme(theme);
// Classic scrollbars — macOS's own while it takes a mouse to be in use ("Show scroll bars: Automatically") — are drawn as
// the overlay's narrow line instead, hidden until their area is hovered or scrolled (styles.css .classic-scroll). With
// overlay scrollbars nothing is styled: they take no room, and a custom one would. Checked again whenever the window
// comes forward, since a mouse comes and goes; the probe is left unstyled, so it measures what macOS gives.
function checkScrollbars() {
  const probe = document.createElement('div');
  probe.className = 'scroll-probe';
  document.body.append(probe);
  document.documentElement.classList.toggle('classic-scroll', probe.offsetWidth > probe.clientWidth);
  probe.remove();
}
if (typeof document !== 'undefined' && document.body) { checkScrollbars(); addEventListener('focus', checkScrollbars); }
// the line shows while its area scrolls, as the overlay's does
const scrollingTimers = new WeakMap();
if (typeof document !== 'undefined') addEventListener('scroll', (e) => {
  const el = e.target;
  if (!document.documentElement.classList.contains('classic-scroll') || !(el instanceof Element)) return;
  el.classList.add('scrolling');
  clearTimeout(scrollingTimers.get(el));
  scrollingTimers.set(el, setTimeout(() => el.classList.remove('scrolling'), 900));
}, true);
// A theme chosen here crossfades the window (renderer/motion.js crossfade); one following macOS, or set at load, is simply applied.
// showTheme only draws a preference: the one chosen here, or one another page or machine chose (renderer/app.js).
function showTheme(next) {
  themePref = next;
  if (next === 'system' && tana.systemTheme) tana.systemTheme().then((t) => crossfade(() => applyTheme(themePref === 'system' ? t : theme)), showError);
  else crossfade(() => applyTheme(next === 'system' ? theme : next));
}
function setTheme(next) { next = next === 'dark' ? 'dark' : 'light'; setPref('theme', next); showTheme(next); } // an explicit theme stops following the system
function followSystem(on) { const next = on ? 'system' : theme; setPref('theme', next); showTheme(next); }
