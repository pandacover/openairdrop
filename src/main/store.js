'use strict';

const fs = require('fs');
const path = require('path');

/** Small JSON file store with atomic writes and debounced saving. */
class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.timer = null;
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    this.data = typeof defaults === 'function' ? defaults(data) : { ...defaults, ...data };
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { JsonStore };
