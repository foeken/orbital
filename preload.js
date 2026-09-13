const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('api', {
  zoom: (factor) => { webFrame.setZoomFactor(factor); return webFrame.getZoomFactor(); },
  roots: () => ipcRenderer.invoke('outline:roots'),
  children: (docId) => ipcRenderer.invoke('outline:children', docId),
  node: (docId) => ipcRenderer.invoke('doc:info', docId),
  path: (docId) => ipcRenderer.invoke('doc:path', docId),
  chats: (opts) => ipcRenderer.invoke('chats:list', opts), // { includeMcp }
  createDocument: (title, opts) => ipcRenderer.invoke('doc:create', title, opts), // opts: { kind: 'doc' | 'task' | 'meeting' }
  search: (query) => ipcRenderer.invoke('search', query),
  setTitle: (docId, title) => ipcRenderer.invoke('doc:setTitle', docId, title),
  setDone: (docId, done) => ipcRenderer.invoke('doc:setDone', docId, done),
  setText: (docId, nodeId, textOrSegments) => ipcRenderer.invoke('block:setText', docId, nodeId, textOrSegments),
  insertAfter: (docId, nodeId, text) => ipcRenderer.invoke('block:insertAfter', docId, nodeId, text),
  insertChild: (docId, nodeId, text) => ipcRenderer.invoke('block:insertChild', docId, nodeId, text),
  remove: (docId, nodeId) => ipcRenderer.invoke('block:remove', docId, nodeId),
  indent: (docId, nodeId) => ipcRenderer.invoke('block:indent', docId, nodeId),
  outdent: (docId, nodeId) => ipcRenderer.invoke('block:outdent', docId, nodeId),
  move: (docId, nodeId, direction) => ipcRenderer.invoke('block:move', docId, nodeId, direction),
  pins: () => ipcRenderer.invoke('pins:list'),
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
  onChanged: (cb) => ipcRenderer.on('outline:changed', (_e, docId) => cb(docId)),
  onStatus: (cb) => ipcRenderer.on('sync:status', (_e, status) => cb(status)),
});
