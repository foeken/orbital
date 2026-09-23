const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('api', {
  zoom: (factor) => { webFrame.setZoomFactor(factor); return webFrame.getZoomFactor(); },
  systemTheme: () => ipcRenderer.invoke('theme:system'), // 'dark' | 'light' right now
  onSystemTheme: (fn) => ipcRenderer.on('theme:system', (_e, theme) => fn(theme)), // macOS appearance changed
  roots: () => ipcRenderer.invoke('outline:roots'),
  // Native embed blocks keep their id; type:reference, reference:{uri,label?,node?}. Target actions use reference.uri.
  children: (docId) => ipcRenderer.invoke('outline:children', docId),
  node: (docId) => ipcRenderer.invoke('doc:info', docId),
  path: (docId) => ipcRenderer.invoke('doc:path', docId),
  related: (docId) => ipcRenderer.invoke('doc:related', docId), // meeting context: {summary,tagline,call?:{url,label},pinned[],outcomes[],notes[],backlinks[]}
  // The page on screen (null: none): main keeps its backlinks and its hub's pins live, and says 'related:changed' when one moves
  relatedWatch: (docId) => ipcRenderer.invoke('doc:watchRelated', docId),
  onRelatedChanged: (cb) => ipcRenderer.on('related:changed', (_e, docId) => cb(docId)),
  // a meeting's time, place and people (main/meetings.js): { editable, start, end, allDay, location, participants[], attendees[], syncStatus }
  meetingInfo: (docId) => ipcRenderer.invoke('meeting:info', docId),
  editMeeting: (docId, change) => ipcRenderer.invoke('meeting:edit', docId, change), // { start, end } | { location } | { attendees: [{ email?, userUri? }] }
  attendeeSuggestions: () => ipcRenderer.invoke('meeting:suggestions'), // [{ email, displayName, eventCount, identityUri }]
  summaryUri: (docId) => ipcRenderer.invoke('doc:summaryUri', docId), // a meeting's write-up document, or null
  todayNode: (offset) => ipcRenderer.invoke('doc:todayNode', offset), // the date-titled node pinned to that day (0 today, 1 tomorrow), created if missing
  weekNode: () => ipcRenderer.invoke('doc:weekNode'), // the "Week 38 (2026)" document (ISO week), created if missing; not linked to the day nodes
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
  codexIds: () => ipcRenderer.invoke('codex:list'), // nodes handed to the local Codex agent; app-local, not a Tana assignee
  setCodex: (docId, on, prompt, model, host) => ipcRenderer.invoke('codex:set', docId, on, prompt, model, host), // prompt, model and the machine it runs on are per assignment
  codexModels: (host) => ipcRenderer.invoke('codex:models', host), // the models that host offers
  codexHosts: () => ipcRenderer.invoke('codex:hosts'), // [{ id, title }] — names only
  addCodexHost: (title, ssh, bin) => ipcRenderer.invoke('codex:hostAdd', title, ssh, bin), // validated in main; nothing is run here
  removeCodexHost: (id) => ipcRenderer.invoke('codex:hostRemove', id), // the machine is forgotten; its tasks are not touched
  codexTaskHost: (docId) => ipcRenderer.invoke('codex:taskHost', docId), // which machine this node's task runs on
  codexTaskHosts: () => ipcRenderer.invoke('codex:taskHosts'), // nodeId -> host, for every linked node
  openCodexTask: (docId) => ipcRenderer.invoke('codex:open', docId), // open the Codex task this node is linked to
  codexStatus: () => ipcRenderer.invoke('codex:status'), // docId -> pending|working|waiting|done|broken for every linked node
  // Cmd+K "Discuss with …": gives the document the Discussion Task type (created in the Library when the workspace
  // has none) and writes who into its "Discuss with" field. Resolves to { typeUri, key, who }.
  discussWith: (docId, who) => ipcRenderer.invoke('doc:discussWith', docId, who),
  // What the title says that name is, from the model (main/ai.js): a string to offer, or null when there is no key
  // on this machine or the title names nobody. Rejects when the call itself failed.
  suggestDiscussWith: (title) => ipcRenderer.invoke('ai:discussWith', title),
  // Presence (main/presence.js): open and close the room of a document on screen (the page, and the rows listed on it),
  // name the page being viewed (it alone gets the viewing heartbeat), say where the caret is ({ blockId, anchor, focus }
  // or null), and hear who else is in each: [{ peer, userHash, name, blockId, editing }], your own tabs left out.
  presenceOpen: (docId) => ipcRenderer.invoke('presence:open', docId),
  presenceClose: (docId) => ipcRenderer.invoke('presence:close', docId),
  presenceView: (docId) => ipcRenderer.invoke('presence:view', docId),
  presenceSet: (docId, at) => ipcRenderer.invoke('presence:set', docId, at),
  onPresence: (cb) => ipcRenderer.on('presence:changed', (_e, docId, peers) => cb(docId, peers)),
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
  searchIcons: (query) => ipcRenderer.invoke('icons:search', query), // [{name,label,svg}] from the built-in Nucleo UI set
  typeIcons: () => ipcRenderer.invoke('icons:types'), // [{uri,name,label,svg}] the glyphs types are drawn with now
  setTypeIcon: (typeUri, name) => ipcRenderer.invoke('icons:setType', typeUri, name ?? null), // null goes back to the generic glyph
  setTypeHue: (typeUri, hue) => ipcRenderer.invoke('doc:setTypeHue', typeUri, hue ?? null), // 0-360 on the type in Tana; null clears it
  // The preferences that follow you between machines (main/settings.js), read synchronously so renderer/prefs.js has
  // them before the first paint, and written through one at a time.
  prefs: ipcRenderer.sendSync('prefs:snapshot'),
  setPref: (key, value) => ipcRenderer.invoke('prefs:set', key, value),
  setOpenAIKey: (key) => ipcRenderer.invoke('openai:setKey', key),
  onSettings: (cb) => ipcRenderer.on('settings:changed', (_e, synced) => cb(synced)),
  createDocument: (title, opts) => ipcRenderer.invoke('doc:create', title, opts), // nonblank title; opts:{kind:doc|task|meeting|chat|custom|search,typeUri?,query?}; a search requires query and nothing else may carry one; returns Node to zoom
  search: (query) => ipcRenderer.invoke('search', query),
  searches: () => ipcRenderer.invoke('search:list'), // saved search documents, newest first
  createSearch: (viewId, title) => ipcRenderer.invoke('search:create', viewId, title), // saves that view's current filter as a saved search; returns the Node to zoom
  searchFilter: (docId) => ipcRenderer.invoke('search:filter', docId), // { filter, sort, group }: the stored query as a filter, plus how its rows are arranged
  setSearchFilter: (docId, filter, sort, group, display) => ipcRenderer.invoke('search:setFilter', docId, filter, sort, group, display), // the query, the arrangement and what rows show, together
  searchPreview: (filter) => ipcRenderer.invoke('search:preview', filter), // the rows that filter would find, without storing it
  setTitle: (docId, title) => ipcRenderer.invoke('doc:setTitle', docId, title),
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
  setText: (docId, nodeId, textOrSegments) => ipcRenderer.invoke('block:setText', docId, nodeId, textOrSegments),
  setCell: (docId, cellId, textOrSegments) => ipcRenderer.invoke('block:setCell', docId, cellId, textOrSegments), // a table cell's text (its first paragraph); the table row itself stays read-only
  tableOp: (docId, cellId, op) => ipcRenderer.invoke('block:tableOp', docId, cellId, op), // rowBefore|rowAfter|deleteRow|columnBefore|columnAfter|deleteColumn|rowUp|rowDown|columnLeft|columnRight; returns the cell for the caret
  // segments carry marks: { text, marks?: { bold, italic, strike, code, link: href } } | { mention: { uri, label } }
  setBlockType: (docId, nodeId, type) => ipcRenderer.invoke('block:setBlockType', docId, nodeId, type), // paragraph|heading1..3|bullet|numbered|code|quote
  insertDivider: (docId, nodeId) => ipcRenderer.invoke('block:insertDivider', docId, nodeId), // horizontal rule after nodeId; returns its block id
  insertImage: (docId, nodeId, file) => ipcRenderer.invoke('block:insertImage', docId, nodeId, file), // file { bytes: Uint8Array, filename, mimeType }; uploads, then an image row after nodeId; returns its block id
  insertAfter: (docId, nodeId, text, block) => ipcRenderer.invoke('block:insertAfter', docId, nodeId, text, block), // block: 'bullet' where the row that has nothing to inherit should still be a list row
  insertBefore: (docId, nodeId, text) => ipcRenderer.invoke('block:insertBefore', docId, nodeId, text),
  split: (docId, nodeId, before, after, asChild) => ipcRenderer.invoke('block:split', docId, nodeId, before, after, asChild), // truncate + insert the rest in one undo step
  insertChild: (docId, nodeId, text) => ipcRenderer.invoke('block:insertChild', docId, nodeId, text),
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
  pins: () => ipcRenderer.invoke('pins:list'),
  pinState: (docId) => ipcRenderer.invoke('pins:state', docId), // { sidebar, dates: ['YYYY-MM-DD'], hubs: [{ id, title, kind }] }: the meetings/spaces it is pinned on come with it
  pinIds: () => ipcRenderer.invoke('pins:ids'), // every pinned document id (sidebar + dates), for the pin mark on a row
  pinDates: () => ipcRenderer.invoke('pins:dates'), // { docId: ['YYYY-MM-DD'] } for every document pinned to a date
  pin: (docId, target, date) => ipcRenderer.invoke('pins:pin', docId, target, date), // date: local YYYY-MM-DD for target 'today'; omitted = today
  unpin: (docId, target, date) => ipcRenderer.invoke('pins:unpin', docId, target, date),
  // items pinned on a meeting or a space (that node's own pinnedItems, docs/PINNING.md section 4); hubId comes from
  // api.related(id).pinHub, which is set only when this user may write that hub. Resolves to the hub's pinned uris.
  pinTo: (hubId, docId) => ipcRenderer.invoke('pins:pinTo', hubId, docId),
  unpinFrom: (hubId, docId) => ipcRenderer.invoke('pins:unpinFrom', hubId, docId),
  // The meeting this user has actually *joined* right now (sdk/calls through main/quickadd), or null. Read fresh:
  // "the meeting I am in" is only true for minutes at a time, so nothing caches it across an open.
  currentMeeting: () => ipcRenderer.invoke('meeting:current'), // { id, title, joinedAt, callUri } | null
  sensitiveIds: () => ipcRenderer.invoke('sensitive:list'),
  setSensitive: (docId, on) => ipcRenderer.invoke('sensitive:set', docId, on),
  image: (uri) => ipcRenderer.invoke('image', uri), // tana:image: uri -> data URL (main fetches with the session token and caches)
  members: () => ipcRenderer.invoke('members'),
  // Quick add (docs/QUICK-ADD.md), used by quick-add.html only: what the panel shows when it opens, the one write it
  // makes, and the two ends of its lifecycle.
  quickContext: () => ipcRenderer.invoke('quick:context'), // { meeting:{id,title,joinedAt}|null, meetingError?, members[], membersError?, me }
  quickCreate: (input) => ipcRenderer.invoke('quick:create', input), // { title, assigneeUri?, meetingId?, agent?:{prompt,model?,host?} } -> { node, assigned, linked, agent, assignedError?, linkError?, agentError? }
  quickClose: () => ipcRenderer.invoke('quick:close'),
  onQuickOpen: (fn) => ipcRenderer.on('quick:open', () => fn()), // the shortcut showed the panel again: re-read the meeting
  // Hidden titles: patterns that keep matching nodes out of every list and search (a node opened directly still opens).
  // Case-insensitive; a pattern matches the whole title, or its start when it ends with '*' ("Block*", "Lunch").
  // All four resolve to the stored list (string[]) after the views have refreshed.
  filters: () => ipcRenderer.invoke('filters:list'),
  setFilters: (patterns) => ipcRenderer.invoke('filters:set', patterns), // string[]; replaces the list
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
  onRemoved: (cb) => ipcRenderer.on('outline:removed', (_e, docId) => cb(docId)), // evict all cached references by id
  onChanged: (cb) => ipcRenderer.on('outline:changed', (_e, docId, info) => cb(docId, info)), // info: { meta } for one document; null docId = global
  onStatus: (cb) => ipcRenderer.on('sync:status', (_e, status) => cb(status)),
  onNotifyOpen: (cb) => ipcRenderer.on('notify:open', (_e, docId) => cb(docId)), // a notification was clicked: open that node
});
