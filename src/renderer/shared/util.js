'use strict';

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

  bytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
  },

  time(ts) {
    const d = new Date(ts);
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  },

  platformIcon(p) {
    return { win32: '🪟', darwin: '🍎', linux: '🐧' }[p] || '💻';
  },

  prettyShortcut(acc) {
    const mac = navigator.userAgent.includes('Mac');
    return String(acc || '')
      .replace('CommandOrControl', mac ? '⌘' : 'Ctrl')
      .replace('Command', '⌘')
      .replace('Control', 'Ctrl')
      .replace('Alt', mac ? '⌥' : 'Alt')
      .replace('Shift', mac ? '⇧' : 'Shift');
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
};
