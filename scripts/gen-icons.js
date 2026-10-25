'use strict';

// Generates the app and tray icons as PNGs with no external dependencies.
// Run: npm run icons

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function png(width, height, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// Paper plane, normalised coordinates.
const PLANE = [
  [0.2, 0.47],
  [0.8, 0.22],
  [0.6, 0.8],
  [0.47, 0.57],
];
const FOLD = [
  [0.47, 0.57],
  [0.8, 0.22],
  [0.42, 0.72],
];

function render(size, { background, planeColor, foldColor }) {
  const out = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          let c = null;
          if (inPolygon(x, y, FOLD) && foldColor) c = foldColor;
          else if (inPolygon(x, y, PLANE)) c = planeColor;
          else if (background && inRoundRect(x, y, 0.22)) c = background(x, y);
          if (c) {
            const ca = c[3] ?? 255;
            r += (c[0] * ca) / 255;
            g += (c[1] * ca) / 255;
            b += (c[2] * ca) / 255;
            a += ca;
          }
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      // Samples were accumulated premultiplied; PNG wants straight alpha.
      const k = a ? 255 / a : 0;
      out[i] = Math.round(r * k);
      out[i + 1] = Math.round(g * k);
      out[i + 2] = Math.round(b * k);
      out[i + 3] = Math.round(a / n);
    }
  }
  return png(size, size, out);
}

const gradient = (x, y) => {
  const t = Math.min(1, Math.max(0, (x + y) / 2));
  const from = [99, 102, 241];
  const to = [6, 182, 212];
  return [0, 1, 2].map((i) => Math.round(from[i] + (to[i] - from[i]) * t)).concat(255);
};

const root = path.join(__dirname, '..');
const write = (rel, buf) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), buf);
  console.log('wrote', rel);
};

const appIcon = { background: gradient, planeColor: [255, 255, 255, 255], foldColor: [214, 222, 255, 255] };
write('build/icon.png', render(512, appIcon));
write('assets/icon.png', render(256, appIcon));
write('assets/tray.png', render(32, appIcon));
// macOS template images: black + alpha only, the OS tints them.
const template = { background: null, planeColor: [0, 0, 0, 255], foldColor: [0, 0, 0, 150] };
write('assets/trayTemplate.png', render(16, template));
write('assets/trayTemplate@2x.png', render(32, template));
