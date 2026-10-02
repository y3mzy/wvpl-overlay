const { contextBridge, ipcRenderer } = require('electron');

window.addEventListener('message', (event) => {
  const d = event && event.data;
  if (!d || !d.type) return;
  if (d.type === 'wv-resize-start') {
    ipcRenderer.send('resize-start', {
      mode: d.mode || 'right',
      screenX: d.x,
      screenY: d.y
    });
  } else if (d.type === 'wv-resize-move') {
    ipcRenderer.send('resize-move', { screenX: d.x, screenY: d.y });
  } else if (d.type === 'wv-resize-end') {
    ipcRenderer.send('resize-end');
  }
});

contextBridge.exposeInMainWorld('overlay', {
  onInit: (cb) => ipcRenderer.on('init-panel', (_e, data) => cb(data)),
  onAuthDone: (cb) => ipcRenderer.on('auth-done', () => cb()),
  closePanel: (kind) => ipcRenderer.send('panel-close', kind),
  minPanel: (kind) => ipcRenderer.send('panel-minimize', kind),
  openAuth: (url) => ipcRenderer.send('open-auth-url', url),
  zoom: (delta) => ipcRenderer.send('set-zoom', delta),
  resizeStart: (payload) => ipcRenderer.send('resize-start', payload),
  resizeMove: (payload) => ipcRenderer.send('resize-move', payload),
  resizeEnd: () => ipcRenderer.send('resize-end'),
  phonePeekNotify: () => ipcRenderer.send('phone-peek-notify'),
  phonePeekExpand: () => ipcRenderer.send('phone-peek-expand'),
  onCharacterInfo: (cb) => ipcRenderer.on('character-info', (_e, data) => cb(data)),
  requestCharacterInfo: () => ipcRenderer.send('character-info-request'),
  reportCharacter: (data) => ipcRenderer.send('character-info-data', data)
});

contextBridge.exposeInMainWorld('control', {
  getConfig: () => ipcRenderer.invoke('control-get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('control-save-config', cfg),
  getStatus: () => ipcRenderer.invoke('control-get-status'),
  getUpdateInfo: () => ipcRenderer.invoke('control-get-update'),
  checkUpdate: () => ipcRenderer.invoke('control-check-update'),
  openReleases: () => ipcRenderer.send('control-open-releases'),
  togglePhone: () => ipcRenderer.send('control-toggle-phone'),
  toggleMdt: () => ipcRenderer.send('control-toggle-mdt'),
  minimize: () => ipcRenderer.send('control-minimize'),
  quit: () => ipcRenderer.send('control-quit'),
  onStatus: (cb) => ipcRenderer.on('control-status', (_e, data) => cb(data)),
  onUpdateInfo: (cb) => ipcRenderer.on('control-update-info', (_e, data) => cb(data))
});
