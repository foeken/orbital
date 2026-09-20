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
  related: (docId) => ipcRenderer.invoke('doc:related', docId), // meeting context: {summary,tagline,call?:{url,label},pinned[],outcomes[],notes[]}
  summaryUri: (docId) => ipcRenderer.invoke('doc:summaryUri', docId), // a meeting's write-up document, or null
  todayNode: (offset) => ipcRenderer.invoke('doc:todayNode', offset), // the date-titled node pinned to that day (0 today, 1 tomorrow), created if missing
  weekNode: () => ipcRenderer.invoke('doc:weekNode'), // the "Week 38 (2026)" document (ISO week), created if missing; not linked to the day nodes
  openExternal: (url) => ipcRenderer.invoke('shell:open', url), // http(s) link from node text, in the default browser
  nodeLink: (docId) => ipcRenderer.invoke('doc:link', docId), // the home.tana.inc url for a node
  notifyState: (docId) => ipcRenderer.invoke('notify:state', docId), // { on, default, explicit }: is this node watched for changes
  setNotify: (docId, on) => ipcRenderer.invoke('notify:set', docId, on), // true/false to choose; null forgets the choice
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
  setField: (docId, key, text) => ipcRenderer.invoke('doc:setField', docId, key, text), // typed field value (plain text)
  viewList: (id, filter) => ipcRenderer.invoke('view:list', id, filter), // { nodes, truncated }
  viewFilter: (id) => ipcRenderer.invoke('view:filter', id),
  setViewFilter: (id, filter) => ipcRenderer.invoke('view:setFilter', id, filter),
  deleteDocument: (id) => ipcRenderer.invoke('doc:delete', id), // native soft delete; undo restores
  restoreDocument: (id) => ipcRenderer.invoke('doc:restore', id), // native restore; undo deletes again
  creationOptions: () => ipcRenderer.invoke('doc:creationOptions'), // {options:[{id,kind,title,icon?,typeUri?,appliesTo?,ownerUri?,selectable,reason?}],complete}
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
  accessOptions: (id) => ipcRenderer.invoke('doc:accessOptions', id), // {sharing,move,deletable,ownerUri,rules,roles,audience,inheritAudience,sharingToken,reason}; unknown disabled
  setSharing: (id, selection) => ipcRenderer.invoke('doc:setSharing', id, selection), // explicit {rule,participants?:[{uri,role}],token?}; inherit requires current sharingToken
  searchSpaces: (query) => ipcRenderer.invoke('spaces:search', query), // Nodes with selectable; rechecked on move
  previewMove: (id, spaceId) => ipcRenderer.invoke('doc:previewMove', id, spaceId), // {allowed,reason,before,after,audienceChanged,requiresConfirmation,token}
  moveToSpace: (id, spaceId, token) => ipcRenderer.invoke('doc:moveToSpace', id, spaceId, token),
  taskMeta: (docId) => ipcRenderer.invoke('doc:taskMeta', docId), // { assignees, restricted, participants, audience, audienceSpace?:{uri,title?}, watched }; participants are Tana's actual sharing data
  setAssignees: (docId, uris) => ipcRenderer.invoke('doc:setAssignees', docId, uris), // unique tana:user-profile:<ulid>[]; [] unassigns
  setAssigneesMany: (docIds, uris) => ipcRenderer.invoke('doc:setAssigneesMany', docIds, uris),
  setText: (docId, nodeId, textOrSegments) => ipcRenderer.invoke('block:setText', docId, nodeId, textOrSegments),
  // segments carry marks: { text, marks?: { bold, italic, strike, code, link: href } } | { mention: { uri, label } }
  setBlockType: (docId, nodeId, type) => ipcRenderer.invoke('block:setBlockType', docId, nodeId, type), // paragraph|heading1..3|bullet|numbered|code|quote
  insertDivider: (docId, nodeId) => ipcRenderer.invoke('block:insertDivider', docId, nodeId), // horizontal rule after nodeId; returns its block id
  insertAfter: (docId, nodeId, text) => ipcRenderer.invoke('block:insertAfter', docId, nodeId, text),
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
  pins: () => ipcRenderer.invoke('pins:list'),
  pinState: (docId) => ipcRenderer.invoke('pins:state', docId),
  pin: (docId, target) => ipcRenderer.invoke('pins:pin', docId, target),
  unpin: (docId, target) => ipcRenderer.invoke('pins:unpin', docId, target),
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
  quickCreate: (input) => ipcRenderer.invoke('quick:create', input), // { title, assigneeUri?, meetingId? } -> { node, assigned, linked, assignedError?, linkError? }
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
