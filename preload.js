const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  generate: (prompt) => ipcRenderer.send('generate-start', prompt),
  onChunk: (cb) => ipcRenderer.on('generate-chunk', (_e, text) => cb(text)),
  onEnd: (cb) => ipcRenderer.on('generate-end', () => cb()),
  onError: (cb) => ipcRenderer.on('generate-error', (_e, msg) => cb(msg)),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  quit: () => ipcRenderer.send('quit-app'),
});
