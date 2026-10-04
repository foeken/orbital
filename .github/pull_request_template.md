Closes #

**What changed**

**Into**: main (the full gate) / integration/<developer> (a lane: the cheap checks, then a batch into main) <!-- keep one; docs/WORKFLOW.md -->

**How it was checked** (npm run lint, npm run check; npm run flows when the desktop's pages changed; npm run phones when ios/, android/, ios/engine or sdk/ changed)

## Platforms
<!-- One line each: "updated", or why it did not need to be (AGENTS.md, Every platform). The iPhone and Android mirror
each other; when a desktop feature the phones carry changes, they usually follow; a new desktop feature does not come to
the phones by itself. scripts/platform-check.js holds these lines to the diff. -->
- **Desktop**: <!-- updated, or not needed: why -->
- **iOS**: <!-- updated, or not needed: why -->
- **Android**: <!-- updated, or not needed: why -->
- **Manual**: <!-- while a draft: "when ready: <the chapter>"; before gh pr ready: updated (the chapter, scene and pictures: manual/, .agents/skills/orbital-manual); or nothing user-visible -->
