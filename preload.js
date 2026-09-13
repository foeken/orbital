const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  updateTask: (id, patch) => ipcRenderer.invoke('tasks:update', id, patch),
  loadContent: (id) => ipcRenderer.invoke('tasks:content', id),
  status: () => ipcRenderer.invoke('sync:status'),
  login: () => ipcRenderer.invoke('sync:login'),
  onTasksChanged: (cb) => ipcRenderer.on('tasks:changed', () => cb()),
  onStatus: (cb) => ipcRenderer.on('sync:status', (_e, status) => cb(status)),
});
