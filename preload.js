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
  todayNode: () => ipcRenderer.invoke('doc:todayNode'), // the date-titled node pinned to today, created if missing
  openExternal: (url) => ipcRenderer.invoke('shell:open', url), // http(s) link from node text, in the default browser
  setField: (docId, key, text) => ipcRenderer.invoke('doc:setField', docId, key, text), // typed field value (plain text)
  chats: (opts) => ipcRenderer.invoke('chats:list', opts), // { includeMcp }
  inbox: () => ipcRenderer.invoke('inbox:list'), // everything in Tana's inbox state (proposed)
  deleteDocument: (id) => ipcRenderer.invoke('doc:delete', id), // native soft delete; undo restores
  restoreDocument: (id) => ipcRenderer.invoke('doc:restore', id), // native restore; undo deletes again
  creationOptions: () => ipcRenderer.invoke('doc:creationOptions'), // {options:[{id,kind,title,icon?,typeUri?,appliesTo?,ownerUri?,selectable,reason?}],complete}
  createDocument: (title, opts) => ipcRenderer.invoke('doc:create', title, opts), // nonblank title; opts:{kind:doc|task|meeting|chat|custom,typeUri?}; returns Node to zoom
  search: (query) => ipcRenderer.invoke('search', query),
  setTitle: (docId, title) => ipcRenderer.invoke('doc:setTitle', docId, title),
  setDone: (docId, done) => ipcRenderer.invoke('doc:setDone', docId, done),
  toggleCheckbox: (docId, nodeId) => ipcRenderer.invoke('block:toggleCheckbox', docId, nodeId), // plain block -> unchecked; checkbox -> toggle; children returns done: 0|1
  accessOptions: (id) => ipcRenderer.invoke('doc:accessOptions', id), // {sharing,move,deletable,ownerUri,rules,roles,audience,inheritAudience,sharingToken,reason}; unknown disabled
  setSharing: (id, selection) => ipcRenderer.invoke('doc:setSharing', id, selection), // explicit {rule,participants?:[{uri,role}],token?}; inherit requires current sharingToken
  searchSpaces: (query) => ipcRenderer.invoke('spaces:search', query), // Nodes with selectable; rechecked on move
  previewMove: (id, spaceId) => ipcRenderer.invoke('doc:previewMove', id, spaceId), // {allowed,reason,before,after,audienceChanged,requiresConfirmation,token}
  moveToSpace: (id, spaceId, token) => ipcRenderer.invoke('doc:moveToSpace', id, spaceId, token),
  taskMeta: (docId) => ipcRenderer.invoke('doc:taskMeta', docId), // { assignees, restricted, participants, audience, audienceSpace?:{uri,title?} }; participants are Tana's actual sharing data
  setAssignees: (docId, uris) => ipcRenderer.invoke('doc:setAssignees', docId, uris), // unique tana:user-profile:<ulid>[]; [] unassigns
  setText: (docId, nodeId, textOrSegments) => ipcRenderer.invoke('block:setText', docId, nodeId, textOrSegments),
  // segments carry marks: { text, marks?: { bold, italic, strike, code, link: href } } | { mention: { uri, label } }
  setBlockType: (docId, nodeId, type) => ipcRenderer.invoke('block:setBlockType', docId, nodeId, type), // paragraph|heading1..3|bullet|numbered|code|quote
  insertDivider: (docId, nodeId) => ipcRenderer.invoke('block:insertDivider', docId, nodeId), // horizontal rule after nodeId; returns its block id
  insertAfter: (docId, nodeId, text) => ipcRenderer.invoke('block:insertAfter', docId, nodeId, text),
  insertChild: (docId, nodeId, text) => ipcRenderer.invoke('block:insertChild', docId, nodeId, text),
  removeMany: (docId, nodeIds) => ipcRenderer.invoke('block:removeMany', docId, nodeIds),
  moveMany: (docId, nodeIds, direction) => ipcRenderer.invoke('block:moveMany', docId, nodeIds, direction),
  remove: (docId, nodeId) => ipcRenderer.invoke('block:remove', docId, nodeId),
  indent: (docId, nodeId) => ipcRenderer.invoke('block:indent', docId, nodeId),
  outdent: (docId, nodeId) => ipcRenderer.invoke('block:outdent', docId, nodeId),
  move: (docId, nodeId, direction) => ipcRenderer.invoke('block:move', docId, nodeId, direction),
  pins: () => ipcRenderer.invoke('pins:list'),
  pinTree: () => ipcRenderer.invoke('pins:tree'), // [{ uri?, label?, node?, children }] preserving sidebar folders and root pins
  pinState: (docId) => ipcRenderer.invoke('pins:state', docId),
  pin: (docId, target) => ipcRenderer.invoke('pins:pin', docId, target),
  unpin: (docId, target) => ipcRenderer.invoke('pins:unpin', docId, target),
  setIcon: (docId, svg) => ipcRenderer.invoke('doc:setIcon', docId, svg),
  image: (uri) => ipcRenderer.invoke('image', uri), // tana:image: uri -> data URL (main fetches with the session token and caches)
  members: () => ipcRenderer.invoke('members'),
  taskFilter: () => ipcRenderer.invoke('tasks:filter'),
  setTaskFilter: (filter) => ipcRenderer.invoke('tasks:setFilter', filter), // { states: string[] | null, assignee: 'me' | 'anyone' | 'unassigned' | uri }; resolves after the Tasks refresh
  library: (filter) => ipcRenderer.invoke('library:list', filter), // { types, states, assignee, text }; missing keys fall back to libraryFilter()
  libraryFilter: () => ipcRenderer.invoke('library:filter'),
  setLibraryFilter: (filter) => ipcRenderer.invoke('library:setFilter', filter),
  refresh: () => ipcRenderer.invoke('sync:refresh'),
  undo: () => ipcRenderer.invoke('history:undo'),
  redo: () => ipcRenderer.invoke('history:redo'),
  status: () => ipcRenderer.invoke('sync:status'),
  login: () => ipcRenderer.invoke('sync:login'),
  onRemoved: (cb) => ipcRenderer.on('outline:removed', (_e, docId) => cb(docId)), // evict all cached references by id
  onChanged: (cb) => ipcRenderer.on('outline:changed', (_e, docId) => cb(docId)),
  onStatus: (cb) => ipcRenderer.on('sync:status', (_e, status) => cb(status)),
});
