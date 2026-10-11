'use strict';
// Test-only background memory survives fixture navigations. No app/vault API.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('labMemory', {
  read: id => ipcRenderer.sendSync('lab-memory-read', id),
  write: (id, value) => ipcRenderer.sendSync('lab-memory-write', id, value)
});
