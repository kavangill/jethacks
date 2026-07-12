const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  generate: (prompt) => ipcRenderer.send('generate-start', prompt),
  onChunk: (cb) => ipcRenderer.on('generate-chunk', (_e, text) => cb(text)),
  onEnd: (cb) => ipcRenderer.on('generate-end', () => cb()),
  onError: (cb) => ipcRenderer.on('generate-error', (_e, msg) => cb(msg)),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  quit: () => ipcRenderer.send('quit-app'),

  haloVoice: (audioArrayBuffer, mimeType) =>
    ipcRenderer.invoke('halo-voice', audioArrayBuffer, mimeType),
  haloTask: (task) => ipcRenderer.invoke('halo-task', task),
  haloAbort: () => ipcRenderer.send('halo-abort'),
  onHaloStatus: (cb) => ipcRenderer.on('halo-status', (_e, s) => cb(s)),
  onHaloTranscript: (cb) => ipcRenderer.on('halo-transcript', (_e, t) => cb(t)),
  onHaloLog: (cb) => ipcRenderer.on('halo-log', (_e, line) => cb(line)),
  onHaloError: (cb) => ipcRenderer.on('halo-error', (_e, msg) => cb(msg)),
  onHaloAudio: (cb) => ipcRenderer.on('halo-audio', (_e, clip) => cb(clip)),

  haloTeach: (audioArrayBuffer, mimeType) =>
    ipcRenderer.invoke('halo-teach', audioArrayBuffer, mimeType),
  onHaloListenStart: (cb) => ipcRenderer.on('halo-listen-start', () => cb()),
  onHaloListenStop: (cb) => ipcRenderer.on('halo-listen-stop', () => cb()),
  onHaloListenCancel: (cb) => ipcRenderer.on('halo-listen-cancel', () => cb()),
  onHaloShot: (cb) => ipcRenderer.on('halo-shot', (_e, b64) => cb(b64)),
  onHaloThinking: (cb) => ipcRenderer.on('halo-thinking', (_e, text) => cb(text)),
  onHaloAudioStop: (cb) => ipcRenderer.on('halo-audio-stop', () => cb()),

  onHaloLoading: (cb) => ipcRenderer.on('halo-loading', (_e, on) => cb(on)),
  onHaloBoard: (cb) => ipcRenderer.on('halo-board', (_e, d) => cb(d)),
  haloAudioDone: () => ipcRenderer.send('halo-audio-done'),
  haloAudioPlaying: (id) => ipcRenderer.send('halo-audio-playing', id),
});
