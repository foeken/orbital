'use strict';
// The page in a canvas window is Tana's own (main.js canvas:open, #611), and it gets none of window.api. Tana asks
// whether a link should open in its desktop app unless a choice is stored (its deep-link chooser, key
// polaris.deepLinkPreference); this stores "the browser" before Tana's code reads it, so the canvas opens directly.
try { localStorage.setItem('polaris.deepLinkPreference', 'web'); } catch { /* refused: Tana asks, and Continue in browser still works */ }
