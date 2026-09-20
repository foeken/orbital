'use strict';
// Theme preference: light, dark or follow macOS; applied before anything else renders.

// theme preference (renderer/prefs.js "theme"): 'light' | 'dark' | 'system'; 'system' follows the macOS appearance
// (api.systemTheme / api.onSystemTheme). It follows you between machines like the rest of the preferences.
let themePref = ['dark', 'system'].includes(pref('theme')) ? pref('theme') : 'light';
let theme = themePref === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : themePref; // no flash before api.systemTheme answers
function applyTheme(next) {
  theme = next === 'dark' ? 'dark' : 'light';
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  const pal = document.getElementById('palette'); // by id: this also runs before the palette const exists
  if (pal && !pal.hidden) renderPalette();
}
applyTheme(theme);
function setTheme(next) { themePref = next === 'dark' ? 'dark' : 'light'; setPref('theme', themePref); applyTheme(themePref); } // an explicit theme stops following the system
function followSystem(on) {
  themePref = on ? 'system' : theme;
  setPref('theme', themePref);
  if (on && tana.systemTheme) tana.systemTheme().then((t) => applyTheme(themePref === 'system' ? t : theme), showError);
  else applyTheme(theme);
}
