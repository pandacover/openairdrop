'use strict';

const { el, bytes, fileChip } = window.ui;
const $ = (id) => document.getElementById(id);

const state = { devices: [], transfers: [], settings: {}, selected: null, files: [], sending: false };
let statusTimer = null;
let hideTimer = null;

function pairedDevices() {
  return state.devices.filter((d) => d.trusted);
}

function ensureSelection() {
  const list = pairedDevices();
  if (list.some((d) => d.id === state.selected)) return;
  const last = list.find((d) => d.id === state.settings.lastDeviceId && d.online);
  state.selected = (last || list.find((d) => d.online) || list[0] || {}).id || null;
}

function renderDevices() {
  ensureSelection();
  const list = pairedDevices();
  $('empty').hidden = list.length > 0;
  $('composer').hidden = list.length === 0;
  $('devices').replaceChildren(
    ...list.map((d, i) =>
      el(
        'button',
        {
          class: `device${d.online ? '' : ' offline'}`,
          role: 'radio',
          'aria-checked': String(d.id === state.selected),
          title: `${d.online ? 'Online' : 'Offline'}${i < 9 ? ` · Alt+${i + 1}` : ''}`,
          onclick: () => select(d.id),
        },
        el('span', { class: `dot${d.online ? ' on' : ''}` }),
        d.name
      )
    )
  );
  updateSendButton();
}

function select(id) {
  state.selected = id;
  renderDevices();
  $('text').focus();
}

function renderFiles() {
  $('files').hidden = !state.files.length;
  $('files').replaceChildren(...state.files.map((f, i) => fileChip(f, () => (state.files.splice(i, 1), renderFiles()))));
  updateSendButton();
}

async function addFiles(paths) {
  if (!paths.length) return;
  const described = await window.beam.describeFiles(paths);
  const folders = described.filter((f) => !f.isFile);
  for (const f of described) if (f.isFile && !state.files.some((x) => x.path === f.path)) state.files.push(f);
  renderFiles();
  if (folders.length) setStatus(`${folders[0].name} is a folder. Zip it to send.`, 'error');
  $('text').focus();
}

function updateSendButton() {
  const hasContent = $('text').value.trim() || state.files.length;
  $('send').disabled = state.sending || !state.selected || !hasContent;
}

function autoGrow() {
  const t = $('text');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
}

function hints() {
  return [el('kbd', {}, '↵'), el('span', {}, 'send'), el('kbd', { class: 'hint' }, 'esc'), el('span', {}, 'close')];
}

/** kind: '' (hints), 'busy', 'ok', 'error'. */
function setStatus(msg, kind = '') {
  clearTimeout(statusTimer);
  const s = $('status');
  s.className = `status ${kind}`;
  if (!msg) s.replaceChildren(...hints());
  else s.replaceChildren(kind === 'ok' ? window.ui.icon('check', 14, 2) : '', el('span', { class: 'text' }, msg));
  if (kind === 'error') statusTimer = setTimeout(() => setStatus(), 6000);
}

function renderProgress() {
  const t = state.transfers.find((x) => x.direction === 'out' && x.status === 'active' && x.peerId === state.selected);
  const show = !!(state.sending && t && t.total);
  $('progress').hidden = !show;
  if (show) {
    $('progress').firstElementChild.style.width = `${(t.done / t.total) * 100}%`;
    setStatus(`${bytes(t.done)} of ${bytes(t.total)}`, 'busy');
  }
}

async function send() {
  if ($('send').disabled) return;
  const device = state.devices.find((d) => d.id === state.selected);
  state.sending = true;
  updateSendButton();
  setStatus(`Sending to ${device.name}…`, 'busy');
  const res = await window.beam.send({ deviceId: state.selected, text: $('text').value, paths: state.files.map((f) => f.path) });
  state.sending = false;
  renderProgress();
  if (res.ok) {
    $('text').value = '';
    autoGrow();
    state.files = [];
    renderFiles();
    setStatus(`Sent to ${device.name}`, 'ok');
    hideTimer = setTimeout(() => {
      if (!state.sending) {
        window.beam.hidePopup();
        setStatus();
      }
    }, 650);
  } else {
    setStatus(res.code === 'not_paired' ? `${device.name} no longer trusts this device. Pair again in Beam.` : res.error, 'error');
    updateSendButton();
  }
}

// ------------------------------------------------------------------ events

window.ui.hydrateIcons();
$('send').addEventListener('click', send);
$('open-main').addEventListener('click', () => window.beam.openMain());
$('attach').addEventListener('click', async () => addFiles(await window.beam.pickFiles()));
$('text').addEventListener('input', () => {
  autoGrow();
  updateSendButton();
});

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') {
    e.preventDefault();
    window.beam.hidePopup();
  } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  } else if (mod && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    $('attach').click();
  } else if (e.altKey && /^[1-9]$/.test(e.key)) {
    const d = pairedDevices()[Number(e.key) - 1];
    if (d) {
      e.preventDefault();
      select(d.id);
    }
  }
});

document.addEventListener('paste', async (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(await window.ui.filesFrom(files));
});

let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (++dragDepth === 1) $('drop').hidden = false;
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
  addFiles(await window.ui.filesFrom([...e.dataTransfer.files]));
});

// Size the window to the content (re-applied on show: resizing a hidden window may not stick).
const fitWindow = () => window.beam.resizePopup(Math.ceil($('app').getBoundingClientRect().height));
new ResizeObserver(fitWindow).observe($('app'));

window.beam.on('state', (patch) => {
  Object.assign(state, patch);
  if (patch.devices || patch.settings) renderDevices();
  if (patch.transfers) renderProgress();
});
window.beam.on('popup-shown', async () => {
  clearTimeout(hideTimer);
  Object.assign(state, await window.beam.getState());
  if (!state.sending) setStatus();
  renderDevices();
  fitWindow();
  $('text').focus();
  $('text').select();
});

setStatus();
window.beam.getState().then((s) => {
  Object.assign(state, s);
  renderDevices();
});
