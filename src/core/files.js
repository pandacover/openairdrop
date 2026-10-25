'use strict';

const fs = require('fs');
const path = require('path');

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Turn an untrusted remote file name into a safe single path component. */
function sanitizeFileName(name) {
  let s = String(name || '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!s || s === '.' || s === '..') s = 'file';
  if (s.startsWith('.')) s = '_' + s.slice(1);
  if (WINDOWS_RESERVED.test(s)) s = '_' + s;
  if (Buffer.byteLength(s) > 200) {
    const ext = path.extname(s).slice(0, 20);
    let base = s.slice(0, s.length - ext.length);
    while (Buffer.byteLength(base + ext) > 200) base = base.slice(0, -1);
    s = base + ext;
  }
  return s;
}

/** Reserve a non-existing path in dir, appending " (n)" as needed. */
async function reserveUniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 10000; i++) {
    const candidate = path.join(dir, i === 0 ? name : `${base} (${i})${ext}`);
    try {
      const fh = await fs.promises.open(candidate, 'wx');
      await fh.close();
      return candidate;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('could not find a free file name');
}

module.exports = { sanitizeFileName, reserveUniquePath };
