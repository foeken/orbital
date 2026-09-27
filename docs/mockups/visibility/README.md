# Visibility mockups (#461)

Mockups for making "who can see this" clear on every content node. Each is the real shell (Trellis panes and
tabs, the palette laid over the window) running the renderer's mock data, with the proposal drawn in on top.

## One vocabulary

Every audience gets a glyph (the ones `AUDIENCES` in renderer/tasks.js already uses), a colour and words, and
the same chip is used on every surface. The colour gets warmer as the audience widens, so a wide audience is
the one you notice:

| Audience | Glyph | Colour | Words |
|---|---|---|---|
| Only me | lock | slate | Only me |
| Selected people | userLock | violet | You, Sam and Priya (faces beside it) |
| Space members | houseLock | the space's hue | Studio LT members |
| Everyone in the org | users | amber | Everyone at Nedap |
| Link sharing (on top of any of these) | globe | red | Anyone with the link |
| Assignee outside the audience | userAlert | crimson | Priya can't see |

The header's eye stays *sensitive items*, a local blur. It is a separate idea, and none of this uses an eye.

## Screens

1. **01-today.png**: what ships now. A grey 14px glyph at the end of a row, and one sidebar line that a pane
   under 720px (`RAIL_ROOM`) drops, so the middle pane shows no visibility at all.
2. **02-document.png**: a line under every page title with the audience in words and faces. It belongs to the
   page, so a narrow Trellis pane keeps it after the sidebar goes. The tab carries the glyph in Trellis's own
   `tab-icon` slot. List rows carry the chip: the glyph alone for narrow audiences in a narrow pane, words for
   the wide ones and for warnings.
3. **03-lists.png**: left, Group by Visibility, widest first, each head saying the audience once. Right, a
   space page says its audience once under the title and marks only the rows that differ from it.
4. **04-content.png**: a zoomed block inherits its page's audience and says so. A mention of something fewer
   people can open than can read the page gets the target's glyph, and hovering it says what the others see.
5. **05-move.png**: dragging a document row from one pane into another page lands a reference
   (renderer/drag.js). The drop line says who can open it compared with who reads the page it lands in.
6. **06-picker.png**: Cmd+K Edit visibility marks the current choice and says, for each option, who gains or
   loses access. Link sharing stays read-only, since Tana owns that switch.

## Open questions

- Counts ("48 people", "6 people") need the org member list and the boundary's participants. `audienceMetadata`
  (sdk/node.js) returns the scope. For the counts, check what `access.js audienceOf` exposes before adding any
  new read.
- Marking narrower mentions needs each on-screen target's audience: one `taskMeta` per mention, lazily, as
  `observeMeta` does for rows.
- Row chips in every list or only as exceptions: 03 shows both rules side by side.

