const { contextBridge, ipcRenderer, webFrame } = require('electron');

// The shell (shell.html): the window's own page, which lays the outliner pages out with Trellis (main.js). It gets only
// what that takes; each outliner page is an iframe of it (nodeIntegrationInSubFrames) and gets window.api below.
if (window.top === window && location.pathname.endsWith('/shell.html')) {
  contextBridge.exposeInMainWorld('shell', {
    state: () => ipcRenderer.sendSync('shell:state'), // { doc: Trellis document | null, theme, signedOut } at its start
    // 'open' { id, where: 'right' | 'tab' | 'float' | 'links', from: the asking page's id, focus } | 'close' id | 'focus' id
    // | 'theme' 'light' | 'dark' | 'auth' { signedOut }
    onCommand: (cb) => ipcRenderer.on('shell:command', (_e, cmd, arg) => cb(cmd, arg)),
    layout: (layout) => ipcRenderer.send('shell:layout', layout), // { doc, pages: [ids in doc] }: every committed change
  });
  return;
}
// An outliner page in the shell: main keys it by its frame (main/state.js pageOf), so it says when it takes the keys
// and when it goes (its panel closed, a reload). The Help tour and Quick Add Task are windows' own pages and say neither.
if (window.top !== window) {
  window.addEventListener('focus', () => ipcRenderer.send('page:focus'));
  window.addEventListener('pagehide', () => ipcRenderer.send('page:gone'));
}
const pane = ipcRenderer.sendSync('window:getSide'); // { side, start? }: this page's id in its window (main.js)
// what the page that opened this one, or the saved view it is part of, has it start on: stored before the page reads it
try {
  for (const [key, value] of Object.entries(pane.start || {})) {
    if (key !== 'view' && key !== 'place') continue;
    const name = key + (pane.side ? ':' + pane.side : '');
    if (value === null) localStorage.removeItem(name); else localStorage.setItem(name, value);
  }
} catch { /* no storage: the page opens where it last was, and still gets window.api below */ }

contextBridge.exposeInMainWorld('api', {
  side: pane.side, // this page's id, fixed for its life: '' the first page, then '2', '3', ... (renderer/state.js SIDE)
  savedAs: pane.start && pane.start.as, // the id it has in the saved view it opened in, when another window had that one (renderer/nodes.js)
  zoom: (factor) => { webFrame.setZoomFactor(factor); return webFrame.getZoomFactor(); },
  systemTheme: () => ipcRenderer.invoke('theme:system'), // 'dark' | 'light' right now
  onSystemTheme: (fn) => ipcRenderer.on('theme:system', (_e, theme) => fn(theme)), // macOS appearance changed
  roots: () => ipcRenderer.invoke('outline:roots'),
  // Native embed blocks keep their id; type:reference, reference:{uri,label?,node?}. Target actions use reference.uri.
  children: (docId) => ipcRenderer.invoke('outline:children', docId),
  node: (docId, patch) => ipcRenderer.invoke('doc:info', docId, patch), // patch: a change read back, which holds nothing (#438)
  related: (docId) => ipcRenderer.invoke('doc:related', docId), // meeting context: {summary,tagline,call?,pinned[],outcomes[],proposals[],notes[],backlinks[]}
  // The page on screen (null: none): main keeps its backlinks and its hub's pins live, and says 'related:changed' when one moves
  relatedWatch: (docId) => ipcRenderer.invoke('doc:watchRelated', docId),
  onRelatedChanged: (cb) => ipcRenderer.on('related:changed', (_e, docId) => cb(docId)),
  // a meeting's time, place and people (main/meetings.js): { editable, start, end, allDay, location, participants[], attendees[], syncStatus }
  meetingInfo: (docId) => ipcRenderer.invoke('meeting:info', docId),
  editMeeting: (docId, change) => ipcRenderer.invoke('meeting:edit', docId, change), // { start, end } | { location } | { attendees: [{ email?, userUri? }] }
  attendeeSuggestions: () => ipcRenderer.invoke('meeting:suggestions'), // [{ email, displayName, eventCount, identityUri }]
  summaryUri: (docId) => ipcRenderer.invoke('doc:summaryUri', docId), // a meeting's write-up document, or null
  todayNode: (offset, findOnly) => ipcRenderer.invoke('doc:todayNode', offset, findOnly === true), // the date-titled node pinned to that day (0 today, 1 tomorrow, or 'YYYY-MM-DD'), created if missing unless findOnly (demo mode)
  checkUpdates: () => ipcRenderer.send('app:checkUpdates'), // the app menu's Check for Updates…: main's dialogs answer (up to date, or Update and Restart)
  setDemoMode: (on) => ipcRenderer.send('app:demoMode', on === true), // demo mode is on in the outliner: main posts no notification banners
  weekNode: (findOnly) => ipcRenderer.invoke('doc:weekNode', findOnly === true), // the "Week 38 (2026)" document (ISO week), created if missing unless findOnly; not linked to the day nodes
  newWindow: (start) => ipcRenderer.invoke('window:new', start), // another outliner window (File › New Window), starting on { view, place }
  // a new page in this window, taking the keys: 'right' of this one (⌘N, the default), a 'tab' beside it, or 'float'.
  // Answers its id (null signed out), for storing its view and place under before it loads.
  splitWindow: (where, start) => ipcRenderer.invoke('window:split', where, start),
  windowLayout: () => ipcRenderer.invoke('window:layout'), // this window's layout (Trellis's document), null for one page never rearranged
  setWindowLayout: (doc, keys) => ipcRenderer.invoke('window:setLayout', doc, keys), // true: the window reloads into it, each page on its keys
  windowTheme: (theme) => ipcRenderer.send('window:theme', theme), // 'light' | 'dark': the shell's Trellis theme and the window behind it follow the page
  openOverlay: (page, theme) => ipcRenderer.invoke('overlay:open', page, theme), // 'help' | 'task' over this whole window (main.js openOverlay), in this page's theme
  closeOverlay: (result) => ipcRenderer.invoke('overlay:close', result), // help.html and task.html: done; { palette?: true, note?: string } for the page that asked
  onOverlayClosed: (cb) => ipcRenderer.on('overlay:closed', (_e, result) => cb(result || {})), // the page that asked hears what the overlay had to say
  openExternal: (url) => ipcRenderer.invoke('shell:open', url), // http(s) link from node text, in the default browser
  exportPdf: (docId) => ipcRenderer.invoke('doc:exportPdf', docId),
  nodeLink: (docId) => ipcRenderer.invoke('doc:link', docId), // the home.tana.inc url for a node
  notifyState: (docId) => ipcRenderer.invoke('notify:state', docId), // { on, default, explicit }: is this node watched for changes
  setNotify: (docId, on) => ipcRenderer.invoke('notify:set', docId, on), // true/false to choose; null forgets the choice
  // Tana's notifications inbox (main/inbox.js). Its rows are children('orbital:notifications'); each write resolves to
  // the unread count after it, and onInbox hears the count again on every change to the inbox, from anywhere.
  inboxUnread: () => ipcRenderer.invoke('inbox:unread'),
  inboxSetRead: (id, read) => ipcRenderer.invoke('inbox:setRead', id, read),
  inboxMarkAll: () => ipcRenderer.invoke('inbox:markAll'),
  onInbox: (cb) => ipcRenderer.on('inbox:changed', (_e, unread) => cb(unread)),
  // Tana AI proposals (main/proposals.js). Its rows are children('orbital:proposals'); approve true accepts one, false
  // rejects it, resolving to the warnings a rejection leaves behind.
  proposalAnswer: (chatUri, proposedUri, approve) => ipcRenderer.invoke('proposals:answer', chatUri, proposedUri, approve),
  timelinePages: (n) => ipcRenderer.invoke('timeline:pages', n), // how many pages of three days back children('orbital:timeline') reads; resolves to the number it took
  onTimelinePart: (cb) => ipcRenderer.on('timeline:part', (_e, rows) => cb(rows)), // the Timeline so far, while children('orbital:timeline') is still reading the rest
  codexIds: () => ipcRenderer.invoke('codex:list'), // nodes handed to the local Codex agent; app-local, not a Tana assignee
  setCodex: (docId, on, prompt, model, host) => ipcRenderer.invoke('codex:set', docId, on, prompt, model, host), // prompt, model and the machine it runs on are per assignment
  codexModels: (host) => ipcRenderer.invoke('codex:models', host), // the models that host offers
  codexHosts: () => ipcRenderer.invoke('codex:hosts'), // [{ id, title }] — names only
  addCodexHost: (title, ssh, bin) => ipcRenderer.invoke('codex:hostAdd', title, ssh, bin), // validated in main; nothing is run here
  removeCodexHost: (id) => ipcRenderer.invoke('codex:hostRemove', id), // the machine is forgotten; its tasks are not touched
  codexTaskHosts: () => ipcRenderer.invoke('codex:taskHosts'), // nodeId -> host, for every linked node
  linkCodexTask: (docId, link) => ipcRenderer.invoke('codex:link', docId, link), // an existing Codex task, pasted as codex://threads/<id>
  openCodexTask: (docId) => ipcRenderer.invoke('codex:open', docId), // open the Codex task this node is linked to
  codexStatus: () => ipcRenderer.invoke('codex:status'), // docId -> pending|working|waiting|done|broken for every linked node
  // Cmd+K "Discuss with …": gives the document the Discussion Task type (created in the Library when the workspace
  // has none) and writes who into its "Discuss with" field. Resolves to { typeUri, key, who }.
  discussWith: (docId, who) => ipcRenderer.invoke('doc:discussWith', docId, who),
  // What the title says that name is, from the model (main/ai.js): a string to offer, or null when there is no key
  // on this machine or the title names nobody. Rejects when the call itself failed.
  suggestDiscussWith: (title) => ipcRenderer.invoke('ai:discussWith', title),
  classifyType: (id) => ipcRenderer.invoke('ai:classifyType', id), // {current, choices:[{uri|null,title,hue?,p}]}, most likely first
  activateWindow: () => ipcRenderer.send('window:activate'), // bring this page's window forward with the keys, as a left click would (a right-click does not)
  processImage: (source) => ipcRenderer.invoke('ai:processImage', source), // { bytes, filename, mimeType } | { clipboard: true } | { uri: tana:image: }: the model makes it a task or a note, the image inside; returns the Node to open
  clipboardHasImage: () => ipcRenderer.invoke('clipboard:hasImage'), // Cmd+K offers Process image from clipboard
  // Presence (main/presence.js): open and close the room of a document on screen (the page, and the rows listed on it),
  // name the page being viewed (it alone gets the viewing heartbeat), say where the caret is ({ blockId, anchor, focus }
  // or null), and hear who else is in each: [{ peer, userHash, name, blockId, editing }], your own tabs left out.
  presenceOpen: (docId) => ipcRenderer.invoke('presence:open', docId),
  presenceClose: (docId) => ipcRenderer.invoke('presence:close', docId),
  presenceView: (docId) => ipcRenderer.invoke('presence:view', docId),
  presenceSet: (docId, at) => ipcRenderer.invoke('presence:set', docId, at),
  onPresence: (cb) => ipcRenderer.on('presence:changed', (_e, docId, peers) => cb(docId, peers)),
  onPresenceAsk: (cb) => ipcRenderer.on('presence:ask', () => cb()), // the viewing heartbeat stopped: say again which page this one views
  viewList: (id, filter) => ipcRenderer.invoke('view:list', id, filter), // { nodes, truncated }
  viewFilter: (id) => ipcRenderer.invoke('view:filter', id),
  setViewFilter: (id, filter) => ipcRenderer.invoke('view:setFilter', id, filter),
  deleteDocument: (id) => ipcRenderer.invoke('doc:delete', id), // native soft delete; undo restores
  restoreDocument: (id) => ipcRenderer.invoke('doc:restore', id), // native restore; undo deletes again
  deletedList: () => ipcRenderer.invoke('deleted:list'), // [{id,title,deletedAt}] newest first: the deletions this app saw
  archiveDocument: (id) => ipcRenderer.invoke('doc:archive', id), // a type only (Tana archives types); undo unarchives
  unarchiveDocument: (id) => ipcRenderer.invoke('doc:unarchive', id),
  archivedTypes: () => ipcRenderer.invoke('types:archived'), // [{id,title,archivedAt}] newest first, from the graph
  creationOptions: () => ipcRenderer.invoke('doc:creationOptions'), // {options:[{id,kind,title,icon?,typeUri?,appliesTo?,ownerUri?,selectable,reason?}],complete}
  docTypes: (id) => ipcRenderer.invoke('doc:types', id), // {current, options:[{uri,title,hue?,selectable,reason?}]} for one document
  setType: (id, typeUri) => ipcRenderer.invoke('doc:setType', id, typeUri ?? null), // null removes the type
  // Fields (issue #33). value: lines as sdk/fields.js setFieldText takes them, refused as Tana would refuse them;
  // change: { type?, cardinality?, options?, to? }; def: { title, type?, cardinality? }, resolves to the new key.
  setField: (docId, key, value) => ipcRenderer.invoke('field:set', docId, key, value),
  defineField: (typeUri, attribute, change) => ipcRenderer.invoke('field:define', typeUri, attribute, change),
  addField: (typeUri, def) => ipcRenderer.invoke('field:add', typeUri, def),
  typeList: () => ipcRenderer.invoke('types:list'), // [{ uri, title, hue }] every type, for a link field's targets
  searchIcons: (query) => ipcRenderer.invoke('icons:search', query), // [{name,label,svg}] from the built-in Nucleo UI set
  typeIcons: () => ipcRenderer.invoke('icons:types'), // [{uri,name,label,svg}] the glyphs types are drawn with now
  setTypeIcon: (typeUri, name) => ipcRenderer.invoke('icons:setType', typeUri, name ?? null), // null goes back to the generic glyph
  setTypeHue: (typeUri, hue) => ipcRenderer.invoke('doc:setTypeHue', typeUri, hue ?? null), // 0-360 on the type in Tana; null clears it
  // The preferences that follow you between machines (main/settings.js), read synchronously so renderer/prefs.js has
  // them before the first paint, and written through one at a time.
  prefs: ipcRenderer.sendSync('prefs:snapshot'),
  claimHelp: (theme) => ipcRenderer.invoke('help:claim', theme), // main opens the Help tour over this window, once, if the settings document says it was never seen; true when it did
  prefsNow: () => ipcRenderer.invoke('prefs:now'), // the same, now: what a settings:changed sent before the page listened carried
  setPref: (key, value) => ipcRenderer.invoke('prefs:set', key, value),
  setOpenAIKey: (key) => ipcRenderer.invoke('openai:setKey', key),
  chatgptStatus: () => ipcRenderer.invoke('chatgpt:status'),
  chatgptLogin: () => ipcRenderer.invoke('chatgpt:login'),
  chatgptCancel: () => ipcRenderer.invoke('chatgpt:cancel'),
  chatgptLogout: () => ipcRenderer.invoke('chatgpt:logout'),
  onChatGPTStatus: (cb) => ipcRenderer.on('ai:chatgptChanged', (_e, status) => cb(status)),
  onSettings: (cb) => ipcRenderer.on('settings:changed', (_e, synced) => cb(synced)),
  createDocument: (title, opts) => ipcRenderer.invoke('doc:create', title, opts), // nonblank title; opts:{kind:doc|task|meeting|chat|custom|search,typeUri?,query?}; a search requires query and nothing else may carry one; a task may carry a workflow typeUri; returns Node to zoom
  sendChat: (id, text, attachments, opts) => ipcRenderer.invoke('chat:send', id, text, attachments, opts), // a message (markdown, mentions as [label](uri)) with attachments (a skill to run); opts.ai true asks Tana to answer, false keeps it for the people in the chat: { messageId, responding, replyError? }
  chatAnswers: (id) => ipcRenderer.invoke('chat:answers', id), // { ai, canWrite }: whether Tana answers there by itself, and whether you may write in it
  newChat: () => ipcRenderer.invoke('chat:new'),
  answerChat: (id, messageId, answers) => ipcRenderer.invoke('chat:answer', id, messageId, answers), // answers { questionId: { selected, custom } }, or null to skip; then Tana goes on: { messageId, responding, replyError? }
  chatAgents: () => ipcRenderer.invoke('chatAgent:list'), // the agents this device can ask from a chat (@Codex): [{ id, label, icon }]
  askAgent: (id, agent, text) => ipcRenderer.invoke('chatAgent:ask', id, agent, text), // starts that agent's task on this device with the question and the chat; nothing is written to Tana: { id }
  agentReplies: (id) => ipcRenderer.invoke('chatAgent:replies', id), // the questions asked in this chat with their answers, local only: [{ id, question, agent, label, at, state: working|done|failed, text }]
  openAgentAsk: (id, askId) => ipcRenderer.invoke('chatAgent:open', id, askId), // open the task that answered this question in its agent's app: true, or false when it is not on this device
  deleteAgentAsk: (id, askId) => ipcRenderer.invoke('chatAgent:delete', id, askId), // forget a question and its answer on this device (they were never in Tana)
  deleteChatMessage: (id, messageId) => ipcRenderer.invoke('chat:delete', id, messageId), // delete one of your own messages from the chat, for everyone, as Tana's Delete message does
  inviteToChat: (id, userUri) => ipcRenderer.invoke('chat:invite', id, userUri), // a workspace member joins the chat as an editor: { name } // a new chat with Tana, yours alone: Node to zoom
  taskTypes: () => ipcRenderer.invoke('doc:taskTypes'), // [{ uri, title, hue }]: the workflow types Quick Add Task offers (task.html)
  search: (query, scope) => ipcRenderer.invoke('search', query, scope), // scope: { types } or { members } for a link field
  searches: () => ipcRenderer.invoke('search:list'), // saved search documents, newest first
  createSearch: (viewId, title) => ipcRenderer.invoke('search:create', viewId, title), // saves that view's current filter as a saved search; returns the Node to zoom
  myTasks: (findOnly) => ipcRenderer.invoke('search:myTasks', findOnly), // the saved search called My Tasks, made the first time it is asked for (findOnly: never made); returns its Node
  searchFilter: (docId) => ipcRenderer.invoke('search:filter', docId), // { filter, sort, group }: the stored query as a filter, plus how its rows are arranged
  setSearchFilter: (docId, filter, sort, group, display) => ipcRenderer.invoke('search:setFilter', docId, filter, sort, group, display), // the query, the arrangement and what rows show, together
  searchPreview: (filter) => ipcRenderer.invoke('search:preview', filter), // the rows that filter would find, without storing it
  setTitle: (docId, title, own) => ipcRenderer.invoke('doc:setTitle', docId, title, own === true), // own: text this page typed and already shows (main.js typed)
  setDone: (docId, done) => ipcRenderer.invoke('doc:setDone', docId, done),
  setState: (docId, state) => ipcRenderer.invoke('doc:setState', docId, state),
  setStateMany: (docIds, state) => ipcRenderer.invoke('doc:setStateMany', docIds, state),
  toggleCheckbox: (docId, nodeId) => ipcRenderer.invoke('block:toggleCheckbox', docId, nodeId), // plain block -> unchecked; checkbox -> toggle; children returns done: 0|1
  accessOptions: (id) => ipcRenderer.invoke('doc:accessOptions', id), // {sharing,move,deletable,archivable,ownerUri,rules,roles,audience,inheritAudience,sharingToken,reason}; unknown disabled
  setSharing: (id, selection) => ipcRenderer.invoke('doc:setSharing', id, selection), // explicit {rule,participants?:[{uri,role}],token?}; inherit requires current sharingToken
  searchSpaces: (query) => ipcRenderer.invoke('spaces:search', query), // Nodes with selectable; rechecked on move
  previewMove: (id, spaceId) => ipcRenderer.invoke('doc:previewMove', id, spaceId), // {allowed,reason,before,after,audienceChanged,requiresConfirmation,token}
  moveToSpace: (id, spaceId, token) => ipcRenderer.invoke('doc:moveToSpace', id, spaceId, token),
  taskMeta: (docId) => ipcRenderer.invoke('doc:taskMeta', docId), // { assignees, restricted, participants, audience, audienceSpace?:{uri,title?}, watched }; participants are Tana's actual sharing data
  setAssignees: (docId, uris) => ipcRenderer.invoke('doc:setAssignees', docId, uris), // unique tana:user-profile:<ulid>[]; [] unassigns
  setAssigneesMany: (docIds, uris) => ipcRenderer.invoke('doc:setAssigneesMany', docIds, uris),
  setText: (docId, nodeId, textOrSegments, own) => ipcRenderer.invoke('block:setText', docId, nodeId, textOrSegments, own === true),
  setCell: (docId, cellId, textOrSegments, own) => ipcRenderer.invoke('block:setCell', docId, cellId, textOrSegments, own === true), // a table cell's text (its first paragraph); the table row itself stays read-only
  tableOp: (docId, cellId, op) => ipcRenderer.invoke('block:tableOp', docId, cellId, op), // rowBefore|rowAfter|deleteRow|columnBefore|columnAfter|deleteColumn|rowUp|rowDown|columnLeft|columnRight; returns the cell for the caret
  // segments carry marks: { text, marks?: { bold, italic, strike, code, link: href } } | { mention: { uri, label } }
  setBlockType: (docId, nodeId, type) => ipcRenderer.invoke('block:setBlockType', docId, nodeId, type), // paragraph|heading1..3|bullet|numbered|code|quote
  insertDivider: (docId, nodeId) => ipcRenderer.invoke('block:insertDivider', docId, nodeId), // horizontal rule after nodeId; returns its block id
  insertImage: (docId, nodeId, file, uploadId) => ipcRenderer.invoke('block:insertImage', docId, nodeId, file, uploadId), // file { bytes: Uint8Array, filename, mimeType }; uploads, then an image row after nodeId; returns its block id
  cancelUpload: (uploadId) => ipcRenderer.invoke('block:cancelUpload', uploadId), // aborts that insertImage's upload; it rejects and writes nothing
  insertTable: (docId, nodeId) => ipcRenderer.invoke('block:insertTable', docId, nodeId), // Tana's "/" Table: 3x3 with a header row, after nodeId; returns its first cell id
  insertAfter: (docId, nodeId, text, block) => ipcRenderer.invoke('block:insertAfter', docId, nodeId, text, block), // block: 'bullet' where the row that has nothing to inherit should still be a list row
  insertBefore: (docId, nodeId, text) => ipcRenderer.invoke('block:insertBefore', docId, nodeId, text),
  split: (docId, nodeId, before, after, asChild) => ipcRenderer.invoke('block:split', docId, nodeId, before, after, asChild), // truncate + insert the rest in one undo step
  join: (docId, nodeId, intoId, value) => ipcRenderer.invoke('block:join', docId, nodeId, intoId, value), // Backspace at a row's start: its words onto the row above, one undo step
  insertChild: (docId, nodeId, text) => ipcRenderer.invoke('block:insertChild', docId, nodeId, text),
  pasteMarkdown: (docId, nodeId, before, after, markdown) => ipcRenderer.invoke('block:pasteMarkdown', docId, nodeId, before, after, markdown), // rows and marks for pasted markdown, replacing the selection between before and after (segments); { id, offset } of the caret
  removeMany: (docId, nodeIds) => ipcRenderer.invoke('block:removeMany', docId, nodeIds),
  moveMany: (docId, nodeIds, direction) => ipcRenderer.invoke('block:moveMany', docId, nodeIds, direction),
  indentMany: (docId, nodeIds) => ipcRenderer.invoke('block:indentMany', docId, nodeIds), // one undo step for a whole selection
  outdentMany: (docId, nodeIds) => ipcRenderer.invoke('block:outdentMany', docId, nodeIds),
  remove: (docId, nodeId) => ipcRenderer.invoke('block:remove', docId, nodeId),
  indent: (docId, nodeId) => ipcRenderer.invoke('block:indent', docId, nodeId),
  outdent: (docId, nodeId) => ipcRenderer.invoke('block:outdent', docId, nodeId),
  move: (docId, nodeId, direction) => ipcRenderer.invoke('block:move', docId, nodeId, direction),
  // drag and drop: the node lands behind afterId, else at the top of parentId, else at the top of toDocId's own
  // rows. toDocId is the outline it lands in — the page, or one of its fields ("<doc>|<type>?attribute=<key>") —
  // and must belong to the same document the node comes from.
  moveTo: (docId, nodeId, toDocId, parentId, afterId) => ipcRenderer.invoke('block:moveTo', docId, nodeId, toDocId, parentId ?? null, afterId ?? null),
  // the same place, with a reference to uri landing in it: a document dragged into an outline, or an Alt-drag
  insertMention: (toDocId, uri, label, parentId, afterId) => ipcRenderer.invoke('block:insertMention', toDocId, uri, label ?? '', parentId ?? null, afterId ?? null),
  pinState: (docId) => ipcRenderer.invoke('pins:state', docId), // { sidebar, dates: ['YYYY-MM-DD'], hubs: [{ id, title, kind }] }: the meetings/spaces it is pinned on come with it
  pinIds: () => ipcRenderer.invoke('pins:ids'), // every pinned document id (sidebar + dates), for the pin mark on a row
  pinDates: () => ipcRenderer.invoke('pins:dates'), // { docId: ['YYYY-MM-DD'] } for every document pinned to a date
  pin: (docId, target, date) => ipcRenderer.invoke('pins:pin', docId, target, date), // date: local YYYY-MM-DD for target 'today'; omitted = today
  unpin: (docId, target, date) => ipcRenderer.invoke('pins:unpin', docId, target, date),
  // items pinned on a meeting or a space (that node's own pinnedItems, docs/PINNING.md section 4); hubId comes from
  // api.related(id).pinHub, which is set only when this user may write that hub. Resolves to the hub's pinned uris.
  pinTo: (hubId, docId) => ipcRenderer.invoke('pins:pinTo', hubId, docId),
  unpinFrom: (hubId, docId) => ipcRenderer.invoke('pins:unpinFrom', hubId, docId),
  // The meeting this user has actually *joined* right now (sdk/calls through main/meetings), or null. Read fresh:
  // "the meeting I am in" is only true for minutes at a time, so nothing caches it across an open.
  currentMeeting: () => ipcRenderer.invoke('meeting:current'), // { id, title, joinedAt, callUri } | null
  sensitiveIds: () => ipcRenderer.invoke('sensitive:list'),
  setSensitive: (docId, on) => ipcRenderer.invoke('sensitive:set', docId, on),
  image: (uri) => ipcRenderer.invoke('image', uri), // tana:image: uri -> data URL (main fetches with the session token and caches)
  members: () => ipcRenderer.invoke('members'),
  // Hidden titles: patterns that keep matching nodes out of every list and search (a node opened directly still opens).
  // Case-insensitive; a pattern matches the whole title, or its start when it ends with '*' ("Block*", "Lunch").
  // All four resolve to the stored list (string[]) after the views have refreshed.
  filters: () => ipcRenderer.invoke('filters:list'),
  addFilter: (pattern) => ipcRenderer.invoke('filters:add', pattern),
  removeFilter: (pattern) => ipcRenderer.invoke('filters:remove', pattern), // matched case-insensitively
  // MCP chats: hidden from every list and search while on (a chat opened directly still opens). Both resolve to the
  // new state after the views have refreshed.
  mcpHidden: () => ipcRenderer.invoke('mcp:hidden'),
  setMcpHidden: (on) => ipcRenderer.invoke('mcp:setHidden', on),
  refresh: () => ipcRenderer.invoke('sync:refresh'),
  undo: () => ipcRenderer.invoke('history:undo'),
  redo: () => ipcRenderer.invoke('history:redo'),
  status: () => ipcRenderer.invoke('sync:status'),
  login: () => ipcRenderer.invoke('sync:login'),
  logout: () => ipcRenderer.invoke('sync:logout'),
  onRemoved: (cb) => ipcRenderer.on('outline:removed', (_e, docId) => cb(docId)), // evict all cached references by id
  onReleased: (cb) => ipcRenderer.on('outline:released', (_e, ids) => cb(ids)), // [docId] main no longer keeps live: forget their outlines
  onChanged: (cb) => ipcRenderer.on('outline:changed', (_e, docId, info) => cb(docId, info)), // info: { meta } for one document; null docId = global
  onStatus: (cb) => ipcRenderer.on('sync:status', (_e, status) => cb(status)),
  onNotifyOpen: (cb) => ipcRenderer.on('notify:open', (_e, docId) => cb(docId)), // a notification was clicked: open that node
});
