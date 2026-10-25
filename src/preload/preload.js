'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = new Set(['state', 'prompt', 'prompt-closed', 'popup-shown']);
const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('beam', {
  getState: () => invoke('get-state'),
  send: (payload) => invoke('send', payload),
  pair: (deviceId) => invoke('pair', deviceId),
  addDevice: (address) => invoke('add-device', address),
  forgetDevice: (deviceId) => invoke('forget-device', deviceId),
  refresh: () => invoke('refresh'),
  respondPrompt: (id, answer) => invoke('respond-prompt', id, answer),
  pendingPrompts: () => invoke('pending-prompts'),
  cancelTransfer: (id) => invoke('cancel-transfer', id),
  pickFiles: () => invoke('pick-files'),
  // File.path was removed from Electron; this is the supported replacement.
  pathForFile: (file) => webUtils.getPathForFile(file),
  savePasted: (name, buffer) => invoke('save-pasted', name, new Uint8Array(buffer)),
  updateSettings: (patch) => invoke('update-settings', patch),
  chooseDownloadDir: () => invoke('choose-download-dir'),
  openItem: (id) => invoke('open-item', id),
  showItem: (id) => invoke('show-item', id),
  openDownloads: () => invoke('open-downloads'),
  copyText: (text) => invoke('copy-text', text),
  clearHistory: () => invoke('clear-history'),
  hidePopup: () => invoke('hide-popup'),
  resizePopup: (height) => invoke('resize-popup', height),
  describeFiles: (paths) => invoke('describe-files', paths),
  openMain: () => invoke('open-main'),
  checkUpdates: () => invoke('check-updates'),
  downloadUpdate: () => invoke('download-update'),
  installUpdate: () => invoke('install-update'),
  on: (channel, cb) => {
    if (!EVENTS.has(channel)) throw new Error(`unknown event ${channel}`);
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
