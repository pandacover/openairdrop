'use strict';

// 24x24 stroke icons, drawn with currentColor.
const ICONS = {
  paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  send: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  settings: '<path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h2"/><path d="M10 17h10"/><circle cx="8" cy="17" r="2"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  open: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6"/><path d="M12 16v4"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
};

window.ui = {
  el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  },

  icon(name, size = 16, stroke = 1.75) {
    const span = document.createElement('span');
    span.className = 'icon';
    span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return span;
  },

  /** Fill every <span data-icon="name"> in the document. */
  hydrateIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach((n) => {
      n.replaceWith(window.ui.icon(n.dataset.icon, Number(n.dataset.size) || 16));
    });
  },

  bytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
  },

  clock(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  },

  day(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date(Date.now() - 864e5);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  },

  platformName(p) {
    return { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[p] || '';
  },

  /** Accelerator -> array of key labels, e.g. ['Ctrl', 'Shift', 'Space']. */
  shortcutKeys(acc) {
    const mac = navigator.userAgent.includes('Mac');
    const map = { CommandOrControl: mac ? '⌘' : 'Ctrl', Command: '⌘', Control: 'Ctrl', Alt: mac ? '⌥' : 'Alt', Shift: mac ? '⇧' : 'Shift' };
    return String(acc || '').split('+').filter(Boolean).map((k) => map[k] || k);
  },

  kbds(acc) {
    return window.ui.shortcutKeys(acc).map((k) => window.ui.el('kbd', {}, k));
  },

  /** Collect real file paths from a drop / paste; pasted images become temp files. */
  async filesFrom(fileList) {
    const paths = [];
    for (const f of fileList) {
      const p = window.beam.pathForFile(f);
      if (p) paths.push(p);
      else if (f.size) paths.push(await window.beam.savePasted(f.name || 'pasted.png', await f.arrayBuffer()));
    }
    return paths;
  },

  /** Attachment chip with name, size and a remove button. */
  fileChip(file, onRemove) {
    const { el, icon, bytes } = window.ui;
    return el(
      'span',
      { class: 'chip', title: file.path },
      icon('file', 13),
      el('span', { class: 'name' }, file.name),
      el('span', { class: 'size num' }, bytes(file.size)),
      el('button', { title: 'Remove', onclick: onRemove }, icon('x', 12, 2))
    );
  },
};
