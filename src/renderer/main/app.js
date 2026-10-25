'use strict';

const { el, bytes, time, platformIcon, prettyShortcut } = window.ui;
const $ = (id) => document.getElementById(id);

const state = { self: {}, settings: {}, devices: [], history: [], transfers: [], shortcutOk: true };
const view = { current: 'devices', selected: null, files: [], sending: false, prompts: [], seenHistory: 0 };

// --------------------------------------------------------------- navigation

function showView(name) {
  view.current = name;
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${name}`));
  if (name === 'activity') {
    view.seenHistory = state.history.length ? state.history[0].id : 0;
    renderBadge();
  }
}
document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// ------------------------------------------------------------------ sidebar

function renderSelf() {
  $('me-name').textContent = state.self.name;
  $('me-port').textContent = state.self.port;
  $('shortcut-hint').textContent = prettyShortcut(state.settings.shortcut);
  $('shortcut-warn').classList.toggle('hidden', state.shortcutOk);
}

function renderBadge() {
  let n = 0;
  for (const h of state.history) {
    if (h.id === view.seenHistory) break;
    if (h.direction === 'in') n++;
  }
  const badge = $('activity-badge');
  badge.textContent = n;
  badge.classList.toggle('hidden', !n || view.current === 'activity');
}

// ------------------------------------------------------------------ devices

function renderDevices() {
  const list = $('device-list');
  if (!state.devices.length) {
    list.replaceChildren(
      el(
        'div',
        { class: 'empty-state' },
        el('div', { class: 'pulse' }, '📡'),
        el('p', {}, 'Looking for devices running Beam…'),
        el('p', { class: 'small' }, 'Open Beam on another computer on the same Wi-Fi / LAN. If your network blocks discovery, add it by address below.')
      )
    );
  } else {
    list.replaceChildren(...state.devices.map(deviceCard));
  }
  if (view.selected && !state.devices.some((d) => d.id === view.selected && d.trusted)) view.selected = null;
  renderComposer();
}

function deviceCard(d) {
  const canSend = d.trusted;
  const card = el(
    'div',
    {
      class: `device-card${canSend ? ' selectable' : ''}${view.selected === d.id ? ' selected' : ''}`,
      onclick: (e) => {
        if (!canSend || e.target.closest('button')) return;
        view.selected = d.id;
        renderDevices();
        $('composer-text').focus();
      },
    },
    el(
      'div',
      { class: 'device-top' },
      el('div', { class: 'device-icon' }, platformIcon(d.platform)),
      el(
        'div',
        { class: 'grow' },
        el('div', { class: 'device-name', title: d.name }, d.name),
        el(
          'div',
          { class: 'device-meta' },
          el('span', { class: `dot${d.online ? ' on' : ''}` }),
          d.online ? (d.address ? d.address : 'Online') : 'Offline',
          d.trusted ? el('span', { class: 'tag paired' }, '🔒 Paired') : el('span', { class: 'tag' }, 'Not paired')
        )
      )
    ),
    el(
      'div',
      { class: 'device-actions' },
      d.trusted
        ? [
            el('button', { class: 'ghost danger', title: 'Remove this device from trusted devices', onclick: () => forget(d) }, 'Forget'),
            el('button', { class: 'primary', disabled: !d.online, onclick: () => selectForSend(d.id) }, 'Send…'),
          ]
        : el('button', { class: 'primary', disabled: !d.online, onclick: (e) => pair(d, e.target) }, 'Pair')
    )
  );
  return card;
}

function selectForSend(id) {
  view.selected = id;
  renderDevices();
  $('composer-text').focus();
}

async function pair(d, button) {
  button.disabled = true;
  button.textContent = 'Pairing…';
  const res = await beam.pair(d.id);
  if (!res.ok) toastAdd(res.error, true);
  else toastAdd(`Paired with ${d.name}`);
  renderDevices();
}

async function forget(d) {
  if (!confirm(`Forget ${d.name}? You'll need to pair again to exchange files.`)) return;
  await beam.forgetDevice(d.id);
}

function toastAdd(msg, isError) {
  const s = $('add-status');
  s.textContent = msg;
  s.className = `small ${isError ? 'error' : 'muted'}`;
}

$('refresh').addEventListener('click', () => {
  beam.refresh();
  toastAdd('Searching…');
  setTimeout(() => toastAdd(''), 1500);
});

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = $('add-input').value.trim();
  if (!value) return;
  toastAdd('Connecting…');
  const res = await beam.addDevice(value);
  if (res.ok) {
    $('add-input').value = '';
    toastAdd(`Found ${res.name}. Pair with it to start sending.`);
  } else toastAdd(res.error, true);
});

// ----------------------------------------------------------------- composer

function renderComposer() {
  const d = state.devices.find((x) => x.id === view.selected);
  $('composer').classList.toggle('hidden', !d);
  if (!d) return;
  $('composer-target').textContent = d.name;
  $('composer-files').replaceChildren(
    ...view.files.map((f, i) =>
      el(
        'span',
        { class: 'chip', title: f },
        '📄 ',
        f.split(/[\\/]/).pop(),
        el('button', { class: 'x', onclick: () => (view.files.splice(i, 1), renderComposer()) }, '✕')
      )
    )
  );
  updateComposerButton();
}

function updateComposerButton() {
  $('composer-send').disabled = view.sending || !($('composer-text').value.trim() || view.files.length);
}

function setComposerStatus(msg, kind) {
  const s = $('composer-status');
  s.textContent = msg || '';
  s.className = `small ${kind === 'error' ? 'error' : 'muted'}`;
}

async function composerSend() {
  if ($('composer-send').disabled) return;
  const d = state.devices.find((x) => x.id === view.selected);
  view.sending = true;
  updateComposerButton();
  setComposerStatus('Sending…');
  const res = await beam.send({ deviceId: d.id, text: $('composer-text').value, paths: view.files });
  view.sending = false;
  if (res.ok) {
    $('composer-text').value = '';
    view.files = [];
    setComposerStatus(`Sent to ${d.name} ✓`);
    renderComposer();
  } else {
    setComposerStatus(res.error, 'error');
    updateComposerButton();
  }
}

function addComposerFiles(paths) {
  for (const p of paths) if (!view.files.includes(p)) view.files.push(p);
  renderComposer();
}

$('composer-send').addEventListener('click', composerSend);
$('composer-attach').addEventListener('click', async () => addComposerFiles(await beam.pickFiles()));
$('composer-text').addEventListener('input', updateComposerButton);
$('composer-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    composerSend();
  }
});
$('composer-text').addEventListener('paste', async (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addComposerFiles(await window.ui.filesFrom(files));
});

// Never let a dropped file navigate the window; route drops to the composer.
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (view.selected) $('composer').classList.add('dragging');
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) $('composer').classList.remove('dragging');
});
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  $('composer').classList.remove('dragging');
  if (!view.selected) {
    toastAdd('Select a paired device first, then drop files.', true);
    return;
  }
  addComposerFiles(await window.ui.filesFrom([...e.dataTransfer.files]));
});

// ----------------------------------------------------------------- activity

function renderTransfers() {
  $('transfers').replaceChildren(
    ...state.transfers.map((t) => {
      const pct = t.total ? Math.round((t.done / t.total) * 100) : t.status === 'done' ? 100 : 0;
      const label = t.files.length === 1 ? t.files[0] : `${t.files.length} files`;
      const status = t.status === 'failed' ? `Failed: ${t.error}` : t.status === 'done' ? 'Done ✓' : `${bytes(t.done)} / ${bytes(t.total)} · ${pct}%`;
      return el(
        'div',
        { class: `transfer ${t.status}` },
        el(
          'div',
          { class: 'transfer-head' },
          el('span', {}, `${t.direction === 'in' ? '⬇ From' : '⬆ To'} ${t.peer} — ${label}`),
          el(
            'span',
            { class: 'row' },
            el('span', { class: t.status === 'failed' ? 'error' : 'muted' }, status),
            t.direction === 'out' && t.status === 'active'
              ? el('button', { class: 'ghost small', onclick: () => beam.cancelTransfer(t.id) }, 'Cancel')
              : null
          )
        ),
        el('div', { class: 'progress' }, el('div', { style: null }))
      );
    })
  );
  // Set widths via CSSOM (allowed by the CSP, unlike inline style attributes).
  [...$('transfers').children].forEach((node, i) => {
    const t = state.transfers[i];
    const pct = t.total ? (t.done / t.total) * 100 : t.status === 'done' ? 100 : 0;
    node.querySelector('.progress > div').style.width = `${pct}%`;
  });
}

function renderHistory() {
  const items = state.history;
  if (!items.length) {
    $('history').replaceChildren(el('div', { class: 'empty-state' }, 'Nothing here yet. Sent and received items will appear here.'));
    return;
  }
  $('history').replaceChildren(
    ...items.slice(0, 200).map((h) => {
      const meta = `${h.direction === 'in' ? 'From' : 'To'} ${h.peer.name} · ${time(h.ts)}`;
      const body =
        h.kind === 'text'
          ? el('div', { class: 'text' }, h.text)
          : el('div', { class: 'file' }, `📄 ${h.name} `, el('span', { class: 'muted small' }, bytes(h.size)));
      const actions =
        h.kind === 'text'
          ? [el('button', { class: 'ghost', onclick: (e) => copy(h.text, e.target) }, 'Copy')]
          : h.direction === 'in'
            ? [
                el('button', { class: 'ghost', onclick: () => beam.openItem(h.id) }, 'Open'),
                el('button', { class: 'ghost', onclick: () => beam.showItem(h.id) }, 'Show'),
              ]
            : [el('button', { class: 'ghost', onclick: () => beam.showItem(h.id) }, 'Show')];
      return el(
        'div',
        { class: 'item' },
        el('div', { class: `dir ${h.direction}` }, h.direction === 'in' ? '⬇' : '⬆'),
        el('div', { class: 'body' }, el('div', { class: 'meta' }, meta), body),
        el('div', { class: 'actions' }, actions)
      );
    })
  );
}

async function copy(text, btn) {
  await beam.copyText(text);
  btn.textContent = 'Copied ✓';
  setTimeout(() => (btn.textContent = 'Copy'), 1200);
}

$('open-downloads').addEventListener('click', () => beam.openDownloads());
$('clear-history').addEventListener('click', () => {
  if (confirm('Clear activity history? Received files stay on disk.')) beam.clearHistory();
});

// ----------------------------------------------------------------- settings

function renderSettings() {
  const s = state.settings;
  if (document.activeElement !== $('set-name')) $('set-name').value = s.deviceName || '';
  if (!$('set-shortcut').classList.contains('recording')) $('set-shortcut').value = prettyShortcut(s.shortcut);
  $('set-dir').value = s.downloadDir || '';
  $('set-auto').checked = !!s.autoAccept;
  $('set-copy').checked = !!s.copyText;
  $('set-notify').checked = !!s.notifications;
  $('set-login').checked = !!s.launchAtLogin;
  $('login-row').classList.toggle('hidden', state.self.platform === 'linux');
  $('set-fp').textContent = state.self.fingerprint || '';
}

async function saveSetting(patch) {
  const res = await beam.updateSettings(patch);
  $('shortcut-error').textContent = res.ok ? '' : res.error;
  return res;
}

$('set-name').addEventListener('change', (e) => saveSetting({ deviceName: e.target.value }));
$('set-auto').addEventListener('change', (e) => saveSetting({ autoAccept: e.target.checked }));
$('set-copy').addEventListener('change', (e) => saveSetting({ copyText: e.target.checked }));
$('set-notify').addEventListener('change', (e) => saveSetting({ notifications: e.target.checked }));
$('set-login').addEventListener('change', (e) => saveSetting({ launchAtLogin: e.target.checked }));
$('choose-dir').addEventListener('click', () => beam.chooseDownloadDir());
$('reset-shortcut').addEventListener('click', () => saveSetting({ shortcut: 'CommandOrControl+Shift+Space' }));

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
sc.addEventListener('focus', () => {
  sc.classList.add('recording');
  sc.value = 'Press keys…';
});
sc.addEventListener('blur', () => {
  sc.classList.remove('recording');
  sc.value = prettyShortcut(state.settings.shortcut);
});
sc.addEventListener('keydown', async (e) => {
  e.preventDefault();
  if (e.key === 'Escape') return sc.blur();
  const acc = acceleratorFrom(e);
  if (!acc) return;
  sc.classList.remove('recording');
  sc.value = prettyShortcut(acc);
  sc.blur();
  await saveSetting({ shortcut: acc });
});

// ------------------------------------------------------------------ prompts

function showPrompt() {
  const p = view.prompts[0];
  $('modal').classList.toggle('hidden', !p);
  if (!p) return;
  const answer = (v) => beam.respondPrompt(p.id, v);
  const sas = p.sas ? el('div', { class: 'sas' }, `${p.sas.slice(0, 3)} ${p.sas.slice(3)}`) : null;
  let content;
  if (p.kind === 'pair-incoming') {
    content = [
      el('h2', {}, `Pair with ${p.name}?`),
      el('p', { class: 'muted' }, `${p.name} (${p.address}) wants to pair with this device.`),
      sas,
      el('p', {}, `Only accept if ${p.name} shows exactly the same code.`),
      el('p', { class: 'small muted mono' }, p.fingerprint),
      el('div', { class: 'modal-actions' }, el('button', { onclick: () => answer(false) }, 'Reject'), el('button', { class: 'primary', onclick: () => answer(true) }, 'Codes match — Pair')),
    ];
  } else if (p.kind === 'pair-outgoing') {
    content = [
      el('h2', {}, `Pairing with ${p.name}`),
      el('p', { class: 'muted' }, `Check that ${p.name} shows the same code, then confirm on both devices.`),
      sas,
      el('p', { class: 'small muted mono' }, p.fingerprint),
      el('div', { class: 'modal-actions' }, el('button', { onclick: () => answer(false) }, 'Cancel'), el('button', { class: 'primary', onclick: () => answer(true) }, 'Codes match')),
    ];
  } else if (p.kind === 'offer') {
    content = [
      el('h2', {}, `${p.name} wants to send you`),
      el(
        'ul',
        {},
        p.text ? el('li', {}, 'A text message') : null,
        p.files.map((f) => el('li', {}, `${f.name} (${bytes(f.size)})`))
      ),
      p.files.length ? el('p', { class: 'muted small' }, `Total ${bytes(p.total)}`) : null,
      el('div', { class: 'modal-actions' }, el('button', { onclick: () => answer(false) }, 'Decline'), el('button', { class: 'primary', onclick: () => answer(true) }, 'Accept')),
    ];
  }
  $('modal-card').replaceChildren(...content.filter(Boolean));
  $('modal-card').querySelector('button.primary')?.focus();
}

beam.on('prompt', (p) => {
  if (!view.prompts.some((x) => x.id === p.id)) view.prompts.push(p);
  showPrompt();
});
beam.on('prompt-closed', (id) => {
  view.prompts = view.prompts.filter((p) => p.id !== id);
  showPrompt();
});

// -------------------------------------------------------------------- boot

function render(keys) {
  const all = !keys;
  if (all || keys.includes('self') || keys.includes('settings') || keys.includes('shortcutOk')) {
    renderSelf();
    renderSettings();
  }
  if (all || keys.includes('devices')) renderDevices();
  if (all || keys.includes('transfers')) renderTransfers();
  if (all || keys.includes('history')) {
    renderHistory();
    renderBadge();
  }
}

beam.on('state', (patch) => {
  Object.assign(state, patch);
  render(Object.keys(patch));
});

(async () => {
  Object.assign(state, await beam.getState());
  view.seenHistory = state.history.length ? state.history[0].id : 0;
  render();
  view.prompts = await beam.pendingPrompts();
  showPrompt();
})();
