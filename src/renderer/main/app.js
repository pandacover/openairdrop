'use strict';

const { el, icon, bytes, clock, day, platformName, kbds, fileChip } = window.ui;
const $ = (id) => document.getElementById(id);

const state = { self: {}, settings: {}, devices: [], history: [], transfers: [], shortcutOk: true };
const view = {
  pane: 'device', // 'device' | 'settings'
  selected: null,
  drafts: new Map(), // deviceId -> { text, files }
  sending: false,
  prompts: [],
  lastRead: new Map(), // deviceId -> timestamp
  openedAt: Date.now(),
};

const device = (id) => state.devices.find((d) => d.id === id);
const draft = (id) => {
  if (!view.drafts.has(id)) view.drafts.set(id, { text: '', files: [] });
  return view.drafts.get(id);
};

// ------------------------------------------------------------------ sidebar

function unreadCount(id) {
  const since = view.lastRead.get(id) || view.openedAt;
  return state.history.filter((h) => h.peer.id === id && h.direction === 'in' && h.ts > since).length;
}

function deviceRow(d) {
  const unread = view.selected === d.id && view.pane === 'device' ? 0 : unreadCount(d.id);
  return el(
    'button',
    {
      class: `device-row${d.online ? '' : ' offline'}${view.pane === 'device' && view.selected === d.id ? ' selected' : ''}`,
      title: d.online ? `${d.name} · online` : `${d.name} · offline`,
      onclick: () => selectDevice(d.id),
    },
    icon('monitor', 15),
    el('span', { class: 'name' }, d.name),
    unread ? el('span', { class: 'unread' }, unread) : el('span', { class: `dot${d.online ? ' on' : ''}` })
  );
}

function renderSidebar() {
  const paired = state.devices.filter((d) => d.trusted);
  const nearby = state.devices.filter((d) => !d.trusted);
  const nodes = [];
  if (paired.length) nodes.push(el('div', { class: 'section-label' }, 'Paired'), ...paired.map(deviceRow));
  nodes.push(el('div', { class: 'section-label' }, 'Nearby'));
  if (nearby.length) nodes.push(...nearby.map(deviceRow));
  else nodes.push(el('div', { class: 'searching' }, 'Looking for devices…'));
  $('device-list').replaceChildren(...nodes);

  const hint = $('shortcut-hint');
  hint.classList.toggle('unavailable', !state.shortcutOk);
  hint.replaceChildren(...kbds(state.settings.shortcut), el('span', {}, state.shortcutOk ? 'Quick send' : 'unavailable'));
}

function selectDevice(id) {
  saveDraft();
  view.pane = 'device';
  view.selected = id;
  view.lastRead.set(id, Date.now());
  renderSidebar();
  renderPane(true);
}

// --------------------------------------------------------------------- pane

function showSection(name) {
  for (const s of ['thread', 'pair', 'empty', 'settings']) $(`pane-${s}`).hidden = s !== name;
}

function ensureSelection() {
  if (view.selected && device(view.selected)) return;
  const d = state.devices.find((x) => x.trusted) || state.devices[0];
  view.selected = d ? d.id : null;
}

function renderPane(switched = false) {
  if (view.pane === 'settings') {
    showSection('settings');
    return;
  }
  ensureSelection();
  const d = device(view.selected);
  // Treat a change of device or of section (e.g. just paired) like a fresh switch.
  const key = d ? `${d.id}:${d.trusted}` : '';
  if (key !== view.paneKey) switched = true;
  view.paneKey = key;
  if (!d) return showSection('empty');
  if (!d.trusted) {
    showSection('pair');
    $('pair-name').textContent = d.name;
    $('pair-name-2').textContent = d.name;
    $('pair-sub').textContent = [d.address, platformName(d.platform)].filter(Boolean).join(' · ');
    $('pair-fp').textContent = d.id.match(/.{4}/g).join(' ');
    if (switched) $('pair-error').textContent = '';
    return;
  }
  showSection('thread');
  $('thread-name').textContent = d.name;
  $('thread-sub').textContent = [d.online ? d.address || 'Online' : 'Offline', platformName(d.platform)].filter(Boolean).join(' · ');
  const text = $('composer-text');
  text.disabled = !d.online;
  text.placeholder = d.online ? `Message ${d.name}` : `${d.name} is offline`;
  if (switched) {
    const dr = draft(d.id);
    text.value = dr.text;
    autoGrow();
    setComposerStatus('');
    renderComposerFiles();
    if (d.online) text.focus();
  }
  updateSendButton();
  renderThread(switched);
}

// ------------------------------------------------------------------- thread

function renderThread(scrollToEnd) {
  const box = $('thread');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const id = view.selected;
  const items = state.history.filter((h) => h.peer.id === id).reverse();
  const active = state.transfers.filter((t) => t.peerId === id && t.status !== 'done');

  const nodes = [];
  let prev = null;
  for (const h of items) {
    if (!prev || day(prev.ts) !== day(h.ts)) nodes.push(el('div', { class: 'day' }, day(h.ts)));
    nodes.push(h.kind === 'text' ? textMessage(h) : fileMessage(h));
    const next = items[items.indexOf(h) + 1];
    // One timestamp per burst of messages in the same direction.
    if (!next || next.direction !== h.direction || next.ts - h.ts > 5 * 60e3) {
      nodes.push(el('div', { class: `stamp ${h.direction}` }, clock(h.ts)));
    }
    prev = h;
  }
  for (const t of active) nodes.push(transferMessage(t));
  if (!nodes.length) {
    nodes.push(el('div', { class: 'thread-empty' }, 'No messages yet. Type below or drop files here.'));
  }
  box.replaceChildren(...nodes);
  box.querySelectorAll('.bar > div[data-pct]').forEach((b) => (b.style.width = `${b.dataset.pct}%`));
  if (scrollToEnd || nearBottom) box.scrollTop = box.scrollHeight;
}

function textMessage(h) {
  return el(
    'div',
    { class: `msg ${h.direction}` },
    el('div', { class: 'bubble' }, h.text),
    el('div', { class: 'actions' }, el('button', { class: 'icon-btn', title: 'Copy', onclick: (e) => copy(h.text, e.currentTarget) }, icon('copy', 14)))
  );
}

function fileMessage(h) {
  const actions =
    h.direction === 'in'
      ? [
          el('button', { class: 'icon-btn', title: 'Open', onclick: () => window.beam.openItem(h.id) }, icon('open', 15)),
          el('button', { class: 'icon-btn', title: 'Show in folder', onclick: () => window.beam.showItem(h.id) }, icon('folder', 15)),
        ]
      : [el('button', { class: 'icon-btn', title: 'Show in folder', onclick: () => window.beam.showItem(h.id) }, icon('folder', 15))];
  return el(
    'div',
    { class: `msg ${h.direction}` },
    el(
      'div',
      { class: 'file' },
      icon('file', 16),
      el('div', { class: 'file-body' }, el('div', { class: 'file-name', title: h.name }, h.name), el('div', { class: 'file-meta num' }, bytes(h.size))),
      el('div', { class: 'file-actions' }, actions)
    )
  );
}

function transferMessage(t) {
  const failed = t.status === 'failed';
  const label = t.files.length === 1 ? t.files[0] : `${t.files.length} files`;
  const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
  return el(
    'div',
    { class: `msg ${t.direction}` },
    el(
      'div',
      { class: 'file' },
      icon('file', 16),
      el(
        'div',
        { class: 'file-body' },
        el('div', { class: 'file-name' }, label),
        failed
          ? el('div', { class: 'file-meta error' }, t.error || 'Failed')
          : [el('div', { class: 'file-meta num' }, `${bytes(t.done)} of ${bytes(t.total)}`), el('div', { class: 'bar' }, el('div', { 'data-pct': pct }))]
      ),
      t.direction === 'out' && !failed
        ? el('div', { class: 'file-actions' }, el('button', { class: 'icon-btn', title: 'Cancel', onclick: () => window.beam.cancelTransfer(t.id) }, icon('x', 15)))
        : null
    )
  );
}

async function copy(text, btn) {
  await window.beam.copyText(text);
  btn.replaceChildren(icon('check', 14));
  setTimeout(() => btn.replaceChildren(icon('copy', 14)), 1200);
}

// ----------------------------------------------------------------- composer

function saveDraft() {
  if (!view.selected) return;
  draft(view.selected).text = $('composer-text').value;
}

function renderComposerFiles() {
  const files = view.selected ? draft(view.selected).files : [];
  $('composer-files').hidden = !files.length;
  $('composer-files').replaceChildren(
    ...files.map((f, i) =>
      fileChip(f, () => {
        files.splice(i, 1);
        renderComposerFiles();
      })
    )
  );
  updateSendButton();
}

async function addFiles(paths) {
  if (!paths.length || !view.selected) return;
  const files = draft(view.selected).files;
  const described = await window.beam.describeFiles(paths);
  for (const f of described) if (f.isFile && !files.some((x) => x.path === f.path)) files.push(f);
  const folder = described.find((f) => !f.isFile);
  if (folder) setComposerStatus(`${folder.name} is a folder. Zip it to send.`, true);
  renderComposerFiles();
  $('composer-text').focus();
}

function updateSendButton() {
  const d = device(view.selected);
  const files = view.selected ? draft(view.selected).files : [];
  $('composer-send').disabled = view.sending || !d?.online || !($('composer-text').value.trim() || files.length);
  $('composer-attach').disabled = !d?.online;
}

function setComposerStatus(msg, isError) {
  const s = $('composer-status');
  s.hidden = !msg;
  s.textContent = msg || '';
  s.className = `composer-status${isError ? ' error' : ''}`;
}

function autoGrow() {
  const t = $('composer-text');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 180)}px`;
}

async function send() {
  if ($('composer-send').disabled) return;
  const id = view.selected;
  const dr = draft(id);
  dr.text = $('composer-text').value;
  view.sending = true;
  updateSendButton();
  setComposerStatus('');
  const res = await window.beam.send({ deviceId: id, text: dr.text, paths: dr.files.map((f) => f.path) });
  view.sending = false;
  if (res.ok) {
    dr.text = '';
    dr.files = [];
    if (view.selected === id) {
      $('composer-text').value = '';
      autoGrow();
      renderComposerFiles();
    }
  } else if (view.selected === id) {
    setComposerStatus(res.code === 'not_paired' ? 'This device no longer trusts you. Unpair and pair again.' : res.error, true);
  }
  updateSendButton();
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});
$('composer-attach').addEventListener('click', async () => addFiles(await window.beam.pickFiles()));
$('composer-text').addEventListener('input', () => {
  autoGrow();
  updateSendButton();
});
$('composer-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
$('composer-text').addEventListener('paste', async (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(await window.ui.filesFrom(files));
});

// Never let a dropped file navigate the window; drops go to the open thread.
let dragDepth = 0;
const canDrop = () => view.pane === 'device' && device(view.selected)?.trusted && device(view.selected)?.online;
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (++dragDepth === 1 && canDrop()) $('drop').hidden = false;
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('drop').hidden = true;
  }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  if (canDrop()) addFiles(await window.ui.filesFrom([...e.dataTransfer.files]));
});

$('unpair').addEventListener('click', async () => {
  const d = device(view.selected);
  const ok = await localConfirm({
    title: `Unpair ${d.name}?`,
    body: 'You will need to pair again before exchanging messages or files.',
    confirm: 'Unpair',
    danger: true,
  });
  if (ok) await window.beam.forgetDevice(d.id);
});

// --------------------------------------------------------------------- pair

$('pair-btn').addEventListener('click', async () => {
  const d = device(view.selected);
  const btn = $('pair-btn');
  btn.disabled = true;
  btn.textContent = 'Waiting for the other device…';
  $('pair-error').textContent = '';
  const res = await window.beam.pair(d.id);
  btn.disabled = false;
  btn.textContent = 'Pair';
  if (!res.ok) $('pair-error').textContent = res.error;
});

// ---------------------------------------------------------- add by address

$('add-toggle').addEventListener('click', () => {
  const form = $('add-form');
  form.hidden = !form.hidden;
  $('add-toggle').hidden = !form.hidden;
  if (!form.hidden) $('add-input').focus();
});
$('add-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('add-form').hidden = true;
    $('add-toggle').hidden = false;
    $('add-status').textContent = '';
  }
});
$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = $('add-input').value.trim();
  if (!value) return;
  const status = $('add-status');
  status.className = 'add-status';
  status.textContent = 'Connecting…';
  const res = await window.beam.addDevice(value);
  if (res.ok) {
    $('add-input').value = '';
    status.textContent = '';
    $('add-form').hidden = true;
    $('add-toggle').hidden = false;
    selectDevice(res.id);
  } else {
    status.className = 'add-status error';
    status.textContent = res.error;
  }
});

// ----------------------------------------------------------------- settings

$('open-settings').addEventListener('click', () => {
  saveDraft();
  view.pane = view.pane === 'settings' ? 'device' : 'settings';
  renderSidebar();
  renderPane(true);
});

function renderSettings() {
  const s = state.settings;
  if (document.activeElement !== $('set-name')) $('set-name').value = s.deviceName || '';
  const field = $('set-shortcut');
  if (!field.classList.contains('recording')) field.replaceChildren(...kbds(s.shortcut));
  $('set-dir').textContent = s.downloadDir || '';
  $('set-dir').title = s.downloadDir || '';
  $('set-auto').checked = !!s.autoAccept;
  $('set-copy').checked = !!s.copyText;
  $('set-notify').checked = !!s.notifications;
  $('set-login').checked = !!s.launchAtLogin;
  $('login-row').hidden = state.self.platform === 'linux';
  $('set-fp').textContent = state.self.fingerprint || '';
  if (!state.shortcutOk) setShortcutHelp('In use by another app. Choose a different one.', true);
}

function setShortcutHelp(msg, isError) {
  const h = $('shortcut-help');
  h.textContent = msg || 'Click, then press a new combination';
  h.classList.toggle('error', !!isError);
}

async function saveSetting(patch) {
  const res = await window.beam.updateSettings(patch);
  if ('shortcut' in patch) setShortcutHelp(res.ok ? '' : res.error, !res.ok);
  return res;
}

$('set-name').addEventListener('change', (e) => saveSetting({ deviceName: e.target.value }));
$('set-name').addEventListener('keydown', (e) => e.key === 'Enter' && e.target.blur());
$('set-auto').addEventListener('change', (e) => saveSetting({ autoAccept: e.target.checked }));
$('set-copy').addEventListener('change', (e) => saveSetting({ copyText: e.target.checked }));
$('set-notify').addEventListener('change', (e) => saveSetting({ notifications: e.target.checked }));
$('set-login').addEventListener('change', (e) => saveSetting({ launchAtLogin: e.target.checked }));
$('choose-dir').addEventListener('click', () => window.beam.chooseDownloadDir());
$('clear-history').addEventListener('click', async () => {
  const ok = await localConfirm({
    title: 'Clear history?',
    body: 'Messages are removed from this device. Received files stay where they are.',
    confirm: 'Clear',
    danger: true,
  });
  if (ok) window.beam.clearHistory();
});

const CODE_KEYS = {
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};
function acceleratorFrom(e) {
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code;
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  // Require a modifier unless it's a function key, so normal typing isn't hijacked.
  if (!mods.length && !/^F\d+$/.test(key)) return null;
  return [...mods, key].join('+');
}

const sc = $('set-shortcut');
const stopRecording = () => {
  sc.classList.remove('recording');
  sc.replaceChildren(...kbds(state.settings.shortcut));
};
sc.addEventListener('click', () => {
  sc.classList.add('recording');
  sc.textContent = 'Press keys…';
});
sc.addEventListener('blur', stopRecording);
sc.addEventListener('keydown', async (e) => {
  if (!sc.classList.contains('recording')) return;
  e.preventDefault();
  if (e.key === 'Escape') return stopRecording();
  const acc = acceleratorFrom(e);
  if (!acc) return;
  sc.classList.remove('recording');
  sc.replaceChildren(...kbds(acc));
  await saveSetting({ shortcut: acc });
  sc.replaceChildren(...kbds(state.settings.shortcut));
});

// ------------------------------------------------------------------ updates

function updateView(u, autoUpdate) {
  const v = u.version;
  switch (u.status) {
    case 'disabled':
      return { text: 'Updates are off for development builds' };
    case 'checking':
      return { text: 'Checking for updates…', button: 'Check for updates', busy: true };
    case 'up-to-date':
      return { text: `Up to date · checked ${clock(u.lastChecked)}`, button: 'Check for updates', action: 'check' };
    case 'available':
      if (!u.canAutoInstall) return { text: `Version ${v} is available`, button: 'Download…', action: 'download', pill: `Beam ${v} available` };
      return autoUpdate
        ? { text: `Downloading ${v}…`, button: 'Check for updates', busy: true }
        : { text: `Version ${v} is available`, button: 'Download', action: 'download' };
    case 'downloading':
      return { text: `Downloading ${v} · ${u.percent}%`, button: 'Check for updates', busy: true };
    case 'ready':
      return { text: `Version ${v} is ready to install`, button: 'Restart to update', action: 'install', primary: true, pill: `Restart to update to ${v}` };
    case 'error':
      return { text: "Couldn't check for updates", title: u.error, button: 'Try again', action: 'check' };
    default:
      return { text: 'Checks automatically in the background', button: 'Check for updates', action: 'check' };
  }
}

function renderUpdate() {
  const u = state.update || { status: 'disabled' };
  const v = updateView(u, state.settings.autoUpdate);
  $('app-version').textContent = state.version || '';
  $('update-status').textContent = v.text;
  $('update-status').title = v.title || '';
  const btn = $('update-action');
  btn.hidden = !v.button;
  btn.textContent = v.button || '';
  btn.disabled = !!v.busy;
  btn.className = `btn${v.primary ? ' primary' : ''}`;
  btn.dataset.action = v.action || '';
  $('set-autoupdate').checked = !!state.settings.autoUpdate;
  $('set-autoupdate').disabled = u.status === 'disabled' || !u.canAutoInstall;

  const pill = $('update-pill');
  pill.hidden = !v.pill;
  pill.dataset.action = v.action || '';
  if (v.pill) pill.replaceChildren(el('span', { class: 'dot' }), v.pill);
}

async function runUpdateAction(action) {
  if (action === 'check') window.beam.checkUpdates();
  else if (action === 'download') window.beam.downloadUpdate();
  else if (action === 'install') {
    const res = await window.beam.installUpdate();
    if (res && !res.ok && res.error) $('update-status').textContent = res.error;
  }
}

$('update-action').addEventListener('click', (e) => runUpdateAction(e.currentTarget.dataset.action));
$('update-pill').addEventListener('click', (e) => runUpdateAction(e.currentTarget.dataset.action));
$('set-autoupdate').addEventListener('change', (e) => saveSetting({ autoUpdate: e.target.checked }));

// ------------------------------------------------------------------ dialogs

function codeBoxes(sas) {
  return el('div', { class: 'code' }, [...sas.slice(0, 3)].map((c) => el('span', {}, c)), el('span', { class: 'gap' }), [...sas.slice(3)].map((c) => el('span', {}, c)));
}

function localConfirm({ title, body, confirm, danger }) {
  return new Promise((resolve) => {
    view.prompts.unshift({ id: `local-${Date.now()}`, kind: 'confirm', title, body, confirm, danger, resolve });
    showPrompt();
  });
}

function answerPrompt(p, value) {
  if (p.resolve) {
    view.prompts = view.prompts.filter((x) => x !== p);
    p.resolve(value);
    showPrompt();
  } else {
    window.beam.respondPrompt(p.id, value);
  }
}

function showPrompt() {
  const p = view.prompts[0];
  $('modal').hidden = !p;
  if (!p) return;
  const actions = (cancel, ok, danger) =>
    el(
      'div',
      { class: 'modal-actions' },
      el('button', { class: 'btn', onclick: () => answerPrompt(p, false) }, cancel),
      el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, 'data-default': true, onclick: () => answerPrompt(p, true) }, ok)
    );
  let content;
  if (p.kind === 'pair-incoming') {
    content = [
      el('h2', {}, `Pair with ${p.name}?`),
      el('p', {}, `Accept only if ${p.name} shows the same code.`),
      codeBoxes(p.sas),
      el('div', { class: 'fp mono' }, p.fingerprint),
      actions('Decline', 'Codes match'),
    ];
  } else if (p.kind === 'pair-outgoing') {
    content = [
      el('h2', {}, `Pairing with ${p.name}`),
      el('p', {}, `Check that ${p.name} shows the same code, then confirm on both devices.`),
      codeBoxes(p.sas),
      el('div', { class: 'fp mono' }, p.fingerprint),
      actions('Cancel', 'Codes match'),
    ];
  } else if (p.kind === 'offer') {
    content = [
      el('h2', {}, `${p.name} wants to send`),
      el(
        'ul',
        {},
        p.text ? el('li', {}, el('span', { class: 'name' }, 'A message')) : null,
        p.files.map((f) => el('li', {}, el('span', { class: 'name' }, f.name), el('span', { class: 'muted num' }, bytes(f.size))))
      ),
      actions('Decline', 'Accept'),
    ];
  } else {
    content = [el('h2', {}, p.title), el('p', {}, p.body), actions('Cancel', p.confirm, p.danger)];
  }
  $('modal-card').replaceChildren(...content.filter(Boolean));
  $('modal-card').querySelector('[data-default]')?.focus();
}

document.addEventListener('keydown', (e) => {
  const p = view.prompts[0];
  if (p && e.key === 'Escape') answerPrompt(p, false);
});

window.beam.on('prompt', (p) => {
  if (!view.prompts.some((x) => x.id === p.id)) view.prompts.push(p);
  showPrompt();
});
window.beam.on('prompt-closed', (id) => {
  view.prompts = view.prompts.filter((p) => p.id !== id);
  showPrompt();
});

// --------------------------------------------------------------------- boot

window.addEventListener('focus', () => {
  if (view.pane === 'device' && view.selected) {
    view.lastRead.set(view.selected, Date.now());
    renderSidebar();
  }
});

function render(keys) {
  const has = (k) => !keys || keys.includes(k);
  if (has('settings') || has('self') || has('shortcutOk')) renderSettings();
  if (has('update') || has('settings') || has('version')) renderUpdate();
  if (has('devices') || has('history') || has('settings') || has('shortcutOk')) renderSidebar();
  if (has('devices') || has('history') || has('transfers')) {
    if (view.selected && !device(view.selected)) view.paneKey = null;
    if (view.pane === 'device' && document.hasFocus() && view.selected) view.lastRead.set(view.selected, Date.now());
    renderPane();
  }
}

window.beam.on('state', (patch) => {
  Object.assign(state, patch);
  render(Object.keys(patch));
});

window.ui.hydrateIcons();
(async () => {
  Object.assign(state, await window.beam.getState());
  render();
  renderPane(true);
  view.prompts = await window.beam.pendingPrompts();
  showPrompt();
})();
