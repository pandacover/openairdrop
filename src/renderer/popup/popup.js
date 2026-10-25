'use strict';

const { el, bytes, platformIcon } = window.ui;
const $ = (id) => document.getElementById(id);

const state = { devices: [], transfers: [], settings: {}, selected: null, files: [], sending: false };
const DEFAULT_HINT = 'Enter to send · Shift+Enter for new line · Esc to close';

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
  $('empty').classList.toggle('hidden', list.length > 0);
  $('composer').classList.toggle('hidden', list.length === 0);
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
        `${platformIcon(d.platform)} ${d.name}`
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
  $('files').replaceChildren(
    ...state.files.map((f, i) =>
      el(
        'span',
        { class: 'chip', title: f },
        '📄',
        el('span', { class: 'name' }, f.split(/[\\/]/).pop()),
        el('button', { class: 'x', title: 'Remove', onclick: () => (state.files.splice(i, 1), renderFiles()) }, '✕')
      )
    )
  );
  updateSendButton();
}

function addFiles(paths) {
  for (const p of paths) if (!state.files.includes(p)) state.files.push(p);
  renderFiles();
  $('text').focus();
}

function updateSendButton() {
  const hasContent = $('text').value.trim() || state.files.length;
  $('send').disabled = state.sending || !state.selected || !hasContent;
}

function setStatus(msg, kind = '') {
  const s = $('status');
  s.textContent = msg || DEFAULT_HINT;
  s.className = `status small ${kind || 'muted'}`;
}

function renderProgress() {
  const t = state.transfers.find((x) => x.direction === 'out' && x.status === 'active');
  const bar = $('progress');
  bar.classList.toggle('hidden', !(state.sending && t && t.total));
  if (t && t.total) {
    bar.firstElementChild.style.width = `${Math.round((t.done / t.total) * 100)}%`;
    if (state.sending) setStatus(`Sending ${bytes(t.done)} / ${bytes(t.total)}…`);
  }
}

async function send() {
  if ($('send').disabled) return;
  const device = state.devices.find((d) => d.id === state.selected);
  state.sending = true;
  updateSendButton();
  setStatus(`Sending to ${device.name}…`);
  const res = await window.beam.send({ deviceId: state.selected, text: $('text').value, paths: state.files });
  state.sending = false;
  renderProgress();
  if (res.ok) {
    $('text').value = '';
    state.files = [];
    renderFiles();
    setStatus(`Sent to ${device.name} ✓`, 'ok');
    setTimeout(() => {
      if (!state.sending) {
        window.beam.hidePopup();
        setStatus();
      }
    }, 700);
  } else {
    setStatus(res.code === 'not_paired' ? `${device.name} no longer trusts this device — re-pair in Beam` : res.error, 'error');
    updateSendButton();
  }
}

// ------------------------------------------------------------------ events

$('send').addEventListener('click', send);
$('close').addEventListener('click', () => window.beam.hidePopup());
$('open-main').addEventListener('click', () => window.beam.openMain());
$('attach').addEventListener('click', async () => addFiles(await window.beam.pickFiles()));
$('text').addEventListener('input', updateSendButton);

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
  if (++dragDepth === 1) $('drop').classList.remove('hidden');
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('drop').classList.add('hidden');
  }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').classList.add('hidden');
  addFiles(await window.ui.filesFrom([...e.dataTransfer.files]));
});

window.beam.on('state', (patch) => {
  Object.assign(state, patch);
  if (patch.devices || patch.settings) renderDevices();
  if (patch.transfers) renderProgress();
});
window.beam.on('popup-shown', async () => {
  Object.assign(state, await window.beam.getState());
  if (!state.sending) setStatus();
  renderDevices();
  $('text').focus();
  $('text').select();
});

window.beam.getState().then((s) => {
  Object.assign(state, s);
  renderDevices();
});
