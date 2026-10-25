'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  globalShortcut,
  ipcMain,
  dialog,
  shell,
  clipboard,
  screen,
  nativeImage,
  safeStorage,
} = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const C = require('../core/constants');
const { BeamNode } = require('../core/node');
const { Discovery } = require('../core/discovery');
const { generateIdentity, exportIdentity, importIdentity, formatFingerprint } = require('../core/identity');
const { sanitizeFileName } = require('../core/files');
const { JsonStore } = require('./store');

// ------------------------------------------------------------------ startup

const argv = process.argv.slice(1);
const argValue = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const profileDir = argValue('beam-profile');
const forcedPort = argValue('beam-port');
const startHidden = argv.includes('--hidden');

// A separate profile lets two instances run side by side on one machine.
if (profileDir) app.setPath('userData', path.resolve(profileDir));
if (!profileDir && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
if (process.platform === 'win32') app.setAppUserModelId('app.beam.lan');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space';

let settings, trustedStore, historyStore, identity, node, discovery;
let tray = null;
let mainWindow = null;
let popupWindow = null;
let listenPort = 0;
let shortcutOk = false;
let quitting = false;
let dialogOpen = false;

const manualDevices = new Map(); // id -> { id, name, address, port }
const transfers = new Map(); // id -> transfer view model
const outgoingAborts = new Map(); // id -> AbortController
const prompts = new Map(); // id -> { resolve, data }

// ---------------------------------------------------------------- identity

// The private identity key is encrypted at rest with the OS keychain
// (DPAPI / Keychain / libsecret) when available.
async function saveIdentity(file, id) {
  const pem = exportIdentity(id);
  const encrypted = await safeStorage.isAsyncEncryptionAvailable().catch(() => false);
  const data = encrypted ? (await safeStorage.encryptStringAsync(pem)).toString('base64') : pem;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ encrypted, data }), { mode: 0o600 });
}

async function loadIdentity() {
  const file = path.join(app.getPath('userData'), 'identity.json');
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!stored.encrypted) return importIdentity(stored.data);
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(stored.data, 'base64'));
    const id = importIdentity(result);
    if (shouldReEncrypt) await saveIdentity(file, id);
    return id;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('Could not load identity, creating a new one:', e.message);
      fs.copyFileSync(file, `${file}.${Date.now()}.bak`);
    }
  }
  const id = generateIdentity();
  await saveIdentity(file, id);
  return id;
}

// ------------------------------------------------------------------- state

function deviceName() {
  return settings.data.deviceName || os.hostname();
}

function listDevices() {
  const out = new Map();
  for (const t of Object.values(trustedStore.data.devices)) {
    out.set(t.id, { id: t.id, name: t.name, platform: t.platform || '', trusted: true, online: false, pairedAt: t.pairedAt });
  }
  for (const m of manualDevices.values()) {
    const d = out.get(m.id) || { id: m.id, trusted: false, platform: '' };
    out.set(m.id, { ...d, name: m.name, online: true, manual: true, address: m.address });
  }
  for (const p of discovery ? discovery.peers.values() : []) {
    const d = out.get(p.id) || { id: p.id, trusted: false };
    out.set(p.id, { ...d, name: p.name, platform: p.platform, online: true, address: p.address });
  }
  return [...out.values()].sort((a, b) => b.online - a.online || b.trusted - a.trusted || a.name.localeCompare(b.name));
}

function targetFor(id) {
  const p = discovery.peers.get(id);
  if (p) return { host: p.address, port: p.port, fp: id };
  const m = manualDevices.get(id);
  if (m) return { host: m.address, port: m.port, fp: id };
  const t = trustedStore.data.devices[id];
  if (t && t.lastAddress) return { host: t.lastAddress, port: t.lastPort, fp: id };
  throw new Error('Device is offline');
}

function publicState() {
  return {
    self: { name: deviceName(), id: identity.fp, fingerprint: formatFingerprint(identity.fp), port: listenPort, platform: process.platform },
    settings: settings.data,
    shortcutOk,
    devices: listDevices(),
    history: historyStore.data.items,
    transfers: [...transfers.values()],
  };
}

function broadcast(channel, payload) {
  for (const w of [mainWindow, popupWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

let stateTimer = null;
const pendingState = new Set();
function pushState(...keys) {
  keys.forEach((k) => pendingState.add(k));
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    const full = publicState();
    const patch = {};
    for (const k of pendingState) patch[k] = full[k];
    pendingState.clear();
    broadcast('state', patch);
  }, 60);
}

function addHistory(entry) {
  const item = { id: crypto.randomUUID(), ts: Date.now(), ...entry };
  historyStore.data.items.unshift(item);
  historyStore.data.items.length = Math.min(historyStore.data.items.length, 500);
  historyStore.save();
  pushState('history');
  return item;
}

function setTransfer(id, patch) {
  const t = { ...(transfers.get(id) || { id }), ...patch };
  transfers.set(id, t);
  if (t.status === 'done' || t.status === 'failed') {
    setTimeout(() => {
      transfers.delete(id);
      pushState('transfers');
    }, 8000);
  }
  pushState('transfers');
}

function notify(title, body, onClick) {
  if (!settings.data.notifications || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(ASSETS, 'icon.png'), silent: false });
  if (onClick) n.on('click', onClick);
  n.show();
}

// ----------------------------------------------------------------- prompts

/** Ask the user something in the main window; resolves with their answer. */
function prompt(kind, data, signal) {
  const id = crypto.randomUUID();
  showMain();
  return new Promise((resolve) => {
    const finish = (answer) => {
      if (!prompts.has(id)) return;
      prompts.delete(id);
      broadcast('prompt-closed', id);
      resolve(answer);
    };
    prompts.set(id, { finish, data: { id, kind, ...data } });
    broadcast('prompt', { id, kind, ...data });
    signal?.addEventListener('abort', () => finish(false), { once: true });
  });
}

// --------------------------------------------------------------- networking

async function startNetwork() {
  node = new BeamNode({
    identity,
    getName: deviceName,
    getDownloadDir: () => settings.data.downloadDir,
    isTrusted: (fp) => !!trustedStore.data.devices[fp],
    onTrust: (peer) => {
      const live = discovery.peers.get(peer.fp) || manualDevices.get(peer.fp);
      trustedStore.data.devices[peer.fp] = {
        id: peer.fp,
        name: peer.name,
        pub: peer.pub.toString('base64'),
        pairedAt: Date.now(),
        platform: live?.platform || '',
        lastAddress: live?.address,
        lastPort: live?.port,
      };
      trustedStore.save();
      pushState('devices');
    },
    onPairRequest: async ({ peer, sas, address, signal }) => {
      notify('Pairing request', `${peer.name} wants to pair. Code ${sas.slice(0, 3)} ${sas.slice(3)}`, showMain);
      return prompt('pair-incoming', { name: peer.name, address, sas, fingerprint: formatFingerprint(peer.fp) }, signal);
    },
    onOffer: async ({ peer, text, files, total, signal }) => {
      if (settings.data.autoAccept) return true;
      notify('Incoming transfer', `${peer.name} wants to send ${describeOffer(text, files)}`, showMain);
      return prompt('offer', { name: peer.name, text, files: files.map((f) => ({ name: f.safeName, size: f.size })), total }, signal);
    },
  });

  node.on('text', ({ peer, text }) => {
    addHistory({ direction: 'in', kind: 'text', peer: { id: peer.fp, name: peer.name }, text });
    if (settings.data.copyText) clipboard.writeText(text);
    const preview = text.length > 120 ? text.slice(0, 117) + '…' : text;
    notify(`Text from ${peer.name}`, settings.data.copyText ? `${preview}\n(copied to clipboard)` : preview, showMain);
  });
  node.on('file', ({ peer, path: p, name, size }) => {
    addHistory({ direction: 'in', kind: 'file', peer: { id: peer.fp, name: peer.name }, path: p, name, size });
  });
  node.on('incoming-start', ({ transferId, peer, files, total }) => {
    if (files.length) setTransfer(transferId, { direction: 'in', peer: peer.name, files, total, done: 0, status: 'active' });
  });
  node.on('incoming-progress', ({ transferId, received, total }) => {
    if (transfers.has(transferId)) setTransfer(transferId, { done: received, total });
  });
  node.on('incoming-done', ({ transferId, peer, files }) => {
    if (!files.length) return;
    setTransfer(transferId, { status: 'done', done: transfers.get(transferId)?.total });
    const label = files.length === 1 ? files[0].name : `${files.length} files`;
    notify(`Received ${label}`, `From ${peer.name} — click to show`, () => shell.showItemInFolder(files[0].path));
  });
  node.on('incoming-error', ({ transferId, error }) => {
    if (transfers.has(transferId)) setTransfer(transferId, { status: 'failed', error });
  });
  node.on('paired', (peer) => {
    notify('Paired', `${peer.name} is now a trusted device`);
    pushState('devices');
  });
  node.on('error', (e) => console.error('server error', e));

  const preferred = forcedPort ? Number(forcedPort) : C.DEFAULT_TCP_PORT;
  try {
    listenPort = await node.listen(preferred);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    listenPort = await node.listen(0);
  }

  discovery = new Discovery();
  discovery.on('peer', (p) => {
    const t = trustedStore.data.devices[p.id];
    if (t && (t.lastAddress !== p.address || t.lastPort !== p.port || t.name !== p.name)) {
      Object.assign(t, { lastAddress: p.address, lastPort: p.port, platform: p.platform });
      trustedStore.save();
    }
    pushState('devices');
  });
  discovery.on('lost', () => pushState('devices'));
  discovery.on('error', (e) => console.error('discovery error', e.message));
  try {
    await discovery.start({ id: identity.fp, name: deviceName(), port: listenPort, platform: process.platform });
  } catch (e) {
    console.error('discovery unavailable', e);
  }
}

function describeOffer(text, files) {
  const parts = [];
  if (text) parts.push('a message');
  if (files.length) parts.push(files.length === 1 ? files[0].safeName : `${files.length} files`);
  return parts.join(' and ');
}

async function sendTo({ deviceId, text, paths }) {
  const device = listDevices().find((d) => d.id === deviceId);
  if (!device) return { ok: false, error: 'Unknown device' };
  if (!device.trusted) return { ok: false, code: 'not_paired', error: 'Pair with this device first' };
  text = typeof text === 'string' && text.trim() ? text : null;
  paths = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : [];

  const files = [];
  for (const p of paths) {
    try {
      if (fs.statSync(p).isFile()) files.push(p);
      else return { ok: false, error: `${path.basename(p)} is a folder — zip it first` };
    } catch {
      return { ok: false, error: `Cannot read ${path.basename(p)}` };
    }
  }
  if (!text && !files.length) return { ok: false, error: 'Nothing to send' };

  const id = crypto.randomUUID();
  const ac = new AbortController();
  outgoingAborts.set(id, ac);
  settings.data.lastDeviceId = deviceId;
  settings.save();
  if (files.length) {
    setTransfer(id, { direction: 'out', peer: device.name, files: files.map((f) => path.basename(f)), total: 0, done: 0, status: 'active' });
  }
  try {
    let lastPush = 0;
    await node.send(targetFor(deviceId), { text, files }, {
      signal: ac.signal,
      onProgress: ({ sent, total }) => {
        const now = Date.now();
        if (files.length && (now - lastPush > 100 || sent === total)) {
          lastPush = now;
          setTransfer(id, { done: sent, total });
        }
      },
    });
    const peer = { id: deviceId, name: device.name };
    if (text) addHistory({ direction: 'out', kind: 'text', peer, text });
    for (const f of files) addHistory({ direction: 'out', kind: 'file', peer, path: f, name: path.basename(f), size: fs.statSync(f).size });
    if (files.length) setTransfer(id, { status: 'done' });
    return { ok: true };
  } catch (e) {
    if (files.length) setTransfer(id, { status: 'failed', error: e.message });
    return { ok: false, code: e.code, error: e.message };
  } finally {
    outgoingAborts.delete(id);
  }
}

async function pairWith(deviceId) {
  try {
    const result = await node.pair(targetFor(deviceId), ({ peer, sas, signal }) =>
      prompt('pair-outgoing', { name: peer.name, sas, fingerprint: formatFingerprint(peer.fp) }, signal)
    );
    pushState('devices');
    return result.paired ? { ok: true } : { ok: false, error: `Pairing ${result.reason}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function addManualDevice(input) {
  const m = String(input || '').trim().match(/^\[?([^\]\s]+?)\]?(?::(\d{1,5}))?$/);
  if (!m) return { ok: false, error: 'Enter an address like 192.168.1.20 or 192.168.1.20:47812' };
  const host = m[1];
  const port = m[2] ? Number(m[2]) : C.DEFAULT_TCP_PORT;
  try {
    const peer = await node.probe({ host, port });
    manualDevices.set(peer.fp, { id: peer.fp, name: peer.name, address: host, port });
    const t = trustedStore.data.devices[peer.fp];
    if (t) {
      Object.assign(t, { lastAddress: host, lastPort: port });
      trustedStore.save();
    }
    pushState('devices');
    return { ok: true, id: peer.fp, name: peer.name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ----------------------------------------------------------------- windows

function secureWebPreferences() {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: true,
  };
}

function hardenContents(win) {
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 660,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Beam',
    backgroundColor: '#0f1117',
    icon: path.join(ASSETS, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences(),
  });
  hardenContents(mainWindow);
  mainWindow.loadFile(path.join(RENDERER, 'main', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (!startHidden) mainWindow.show();
  });
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function showMain() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createPopup() {
  popupWindow = new BrowserWindow({
    width: 580,
    height: 380,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#161a23',
    title: 'Beam Quick Send',
    webPreferences: secureWebPreferences(),
  });
  hardenContents(popupWindow);
  popupWindow.setAlwaysOnTop(true, 'floating');
  popupWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  popupWindow.loadFile(path.join(RENDERER, 'popup', 'popup.html'));
  popupWindow.on('blur', () => {
    if (!dialogOpen && popupWindow.isVisible()) popupWindow.hide();
  });
  popupWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      popupWindow.hide();
    }
  });
}

function togglePopup() {
  if (!popupWindow) return;
  if (popupWindow.isVisible() && popupWindow.isFocused()) {
    popupWindow.hide();
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  const [w, h] = popupWindow.getSize();
  popupWindow.setPosition(Math.round(workArea.x + (workArea.width - w) / 2), Math.round(workArea.y + workArea.height * 0.22));
  popupWindow.show();
  popupWindow.focus();
  popupWindow.webContents.send('popup-shown');
  discovery?.refresh();
}

function registerShortcut(accelerator) {
  globalShortcut.unregisterAll();
  try {
    shortcutOk = globalShortcut.register(accelerator, togglePopup);
  } catch {
    shortcutOk = false;
  }
  updateTray();
  return shortcutOk;
}

function updateTray() {
  if (!tray) return;
  const sc = settings.data.shortcut;
  tray.setToolTip(shortcutOk ? `Beam — ${sc} to quick send` : `Beam — shortcut ${sc} unavailable`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Quick Send…', accelerator: shortcutOk ? sc : undefined, click: togglePopup },
      { label: 'Open Beam', click: showMain },
      { label: 'Open Received Files', click: () => openDownloads() },
      { type: 'separator' },
      { label: 'Quit Beam', click: () => app.quit() },
    ])
  );
}

function createTray() {
  const icon =
    process.platform === 'darwin'
      ? nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'))
      : nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on('click', () => (process.platform === 'darwin' ? tray.popUpContextMenu() : showMain()));
  updateTray();
}

async function openDownloads() {
  fs.mkdirSync(settings.data.downloadDir, { recursive: true });
  return shell.openPath(settings.data.downloadDir);
}

// --------------------------------------------------------------------- IPC

function historyItem(id) {
  return historyStore.data.items.find((i) => i.id === id && i.kind === 'file');
}

function registerIpc() {
  const handle = (ch, fn) => ipcMain.handle(ch, (_e, ...args) => fn(...args));

  handle('get-state', () => publicState());
  handle('send', (payload) => sendTo(payload || {}));
  handle('pair', (deviceId) => pairWith(String(deviceId)));
  handle('add-device', (address) => addManualDevice(address));
  handle('forget-device', (deviceId) => {
    delete trustedStore.data.devices[deviceId];
    manualDevices.delete(deviceId);
    trustedStore.save();
    pushState('devices');
    return { ok: true };
  });
  handle('refresh', () => discovery?.refresh());
  handle('respond-prompt', (id, answer) => {
    prompts.get(id)?.finish(answer === true);
  });
  handle('pending-prompts', () => [...prompts.values()].map((p) => p.data));
  handle('cancel-transfer', (id) => outgoingAborts.get(id)?.abort());

  handle('pick-files', async () => {
    dialogOpen = true;
    try {
      const parent = popupWindow?.isVisible() ? popupWindow : mainWindow;
      const r = await dialog.showOpenDialog(parent, { properties: ['openFile', 'multiSelections'] });
      return r.canceled ? [] : r.filePaths;
    } finally {
      dialogOpen = false;
      if (popupWindow?.isVisible()) popupWindow.focus();
    }
  });
  handle('save-pasted', async (name, bytes) => {
    if (!(bytes instanceof Uint8Array) || bytes.length > 200 * 1024 * 1024) throw new Error('invalid paste');
    const dir = path.join(app.getPath('temp'), 'beam-paste');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${stamp}-${sanitizeFileName(name || 'pasted.png')}`);
    fs.writeFileSync(file, bytes);
    return file;
  });

  handle('update-settings', (patch) => {
    const allowed = ['deviceName', 'autoAccept', 'copyText', 'notifications', 'launchAtLogin', 'shortcut'];
    const next = { ...settings.data };
    for (const k of allowed) if (patch && k in patch) next[k] = patch[k];
    next.deviceName = String(next.deviceName || '').trim().slice(0, 64) || os.hostname();

    let error = null;
    if (next.shortcut !== settings.data.shortcut) {
      if (!registerShortcut(next.shortcut)) {
        error = `Shortcut "${next.shortcut}" is unavailable (invalid or used by another app)`;
        next.shortcut = settings.data.shortcut;
        registerShortcut(next.shortcut);
      }
    }
    if (next.launchAtLogin !== settings.data.launchAtLogin && process.platform !== 'linux') {
      app.setLoginItemSettings({ openAtLogin: !!next.launchAtLogin, args: ['--hidden'] });
    }
    const renamed = next.deviceName !== settings.data.deviceName;
    settings.data = next;
    settings.save();
    if (renamed) discovery?.update({ name: deviceName() });
    pushState('settings', 'self', 'shortcutOk');
    updateTray();
    return { ok: !error, error, shortcutOk };
  });
  handle('choose-download-dir', async () => {
    dialogOpen = true;
    try {
      const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.data.downloadDir });
      if (r.canceled || !r.filePaths[0]) return null;
      settings.data.downloadDir = r.filePaths[0];
      settings.save();
      pushState('settings');
      return r.filePaths[0];
    } finally {
      dialogOpen = false;
    }
  });

  handle('open-item', (id) => {
    const item = historyItem(id);
    if (item && fs.existsSync(item.path)) return shell.openPath(item.path);
    return 'File no longer exists';
  });
  handle('show-item', (id) => {
    const item = historyItem(id);
    if (item && fs.existsSync(item.path)) shell.showItemInFolder(item.path);
  });
  handle('open-downloads', () => openDownloads());
  handle('copy-text', (text) => clipboard.writeText(String(text)));
  handle('clear-history', () => {
    historyStore.data.items = [];
    historyStore.save();
    pushState('history');
  });
  handle('hide-popup', () => popupWindow?.hide());
  handle('open-main', () => {
    popupWindow?.hide();
    showMain();
  });
}

// --------------------------------------------------------------- lifecycle

app.on('second-instance', () => showMain());
app.on('activate', () => showMain());
app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  discovery?.stop();
  node?.close();
  settings?.flush();
  trustedStore?.flush();
  historyStore?.flush();
});
app.on('window-all-closed', (e) => e.preventDefault());

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData');
  settings = new JsonStore(path.join(dataDir, 'settings.json'), {
    deviceName: os.hostname(),
    downloadDir: path.join(app.getPath('downloads'), 'Beam'),
    shortcut: DEFAULT_SHORTCUT,
    autoAccept: true,
    copyText: false,
    notifications: true,
    launchAtLogin: false,
    lastDeviceId: null,
  });
  trustedStore = new JsonStore(path.join(dataDir, 'trusted-devices.json'), (d) => ({ devices: d.devices || {} }));
  historyStore = new JsonStore(path.join(dataDir, 'history.json'), (d) => ({ items: Array.isArray(d.items) ? d.items : [] }));
  identity = await loadIdentity();

  registerIpc();
  await startNetwork();
  createMainWindow();
  createPopup();
  createTray();
  registerShortcut(settings.data.shortcut);
  console.log(`Beam ready: ${deviceName()} (${identity.fp}) listening on ${listenPort}`);
});
