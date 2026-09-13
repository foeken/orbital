const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  roots: () => ipcRenderer.invoke('outline:roots'),
  children: (docId) => ipcRenderer.invoke('outline:children', docId),
  node: (docId) => ipcRenderer.invoke('doc:info', docId),
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
  refresh: () => ipcRenderer.invoke('sync:refresh'),
  undo: () => ipcRenderer.invoke('history:undo'),
  redo: () => ipcRenderer.invoke('history:redo'),
  status: () => ipcRenderer.invoke('sync:status'),
  login: () => ipcRenderer.invoke('sync:login'),
  onChanged: (cb) => ipcRenderer.on('outline:changed', (_e, docId) => cb(docId)),
  onStatus: (cb) => ipcRenderer.on('sync:status', (_e, status) => cb(status)),
});
