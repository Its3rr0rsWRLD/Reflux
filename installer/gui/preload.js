'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('refluxInstaller', {
  checkStatus: ()   => ipcRenderer.invoke('reflux:check-status'),
  install:     ()   => ipcRenderer.send('reflux:install'),
  uninstall:   ()   => ipcRenderer.send('reflux:uninstall'),
  minimize:    ()   => ipcRenderer.send('reflux:minimize'),
  close:       ()   => ipcRenderer.send('reflux:close'),
  onProgress:  (cb) => ipcRenderer.on('reflux:progress', (_e, data) => cb(data)),
  onComplete:  (cb) => ipcRenderer.on('reflux:complete', (_e, data) => cb(data)),
});
