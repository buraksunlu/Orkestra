'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const ALLOWED_EVENTS = new Set(['state', 'pty-data', 'pty-reset', 'command', 'focus-session', 'init']);

contextBridge.exposeInMainWorld('ork', {
  on(channel, fn) {
    if (!ALLOWED_EVENTS.has(channel)) throw new Error(`unknown channel ${channel}`);
    const h = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
  write: (id, data) => ipcRenderer.send('pty-write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty-resize', id, cols, rows),
  ui: (id, type) => ipcRenderer.send('session-ui', id, type),
  view: (v) => ipcRenderer.send('view', v),
  call: (name, ...args) => ipcRenderer.invoke('call', name, ...args),
  clipboardRead: () => ipcRenderer.invoke('call', 'clipboardRead'),
  clipboardWrite: (t) => ipcRenderer.send('clipboard-write', t),
  // Real path of a dropped file ('' when the drag carries no file on disk, e.g. some screenshot thumbnails).
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
});
