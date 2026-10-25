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

function inRoundRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function distToSegment(x, y, [ax, ay], [bx, by]) {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
}

// The mark: a solid node linked to a hollow node -- one device sending to another.
// Coordinates are in a 0..1 glyph box.
function inMark(x, y, { r, hole, stroke }) {
  const A = [0.22, 0.78];
  const B = [0.78, 0.22];
  const dB = Math.hypot(x - B[0], y - B[1]);
  if (dB < hole) return false;
  if (dB <= r) return true;
  if (Math.hypot(x - A[0], y - A[1]) <= r) return true;
  return distToSegment(x, y, A, B) <= stroke;
}

function render(size, { background, ink, inset, mark }) {
  const out = Buffer.alloc(size * size * 4);
  const ss = 6;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          const gx = (x - inset) / (1 - 2 * inset);
          const gy = (y - inset) / (1 - 2 * inset);
          let c = null;
          if (gx >= 0 && gx <= 1 && gy >= 0 && gy <= 1 && inMark(gx, gy, mark)) c = ink;
          else if (background && inRoundRect(x, y, 0.225)) c = background;
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

const root = path.join(__dirname, '..');
const write = (rel, buf) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), buf);
  console.log('wrote', rel);
};

const BG = [24, 24, 27, 255];
const WHITE = [250, 250, 250, 255];
const BLACK = [0, 0, 0, 255];
const fine = { r: 0.19, hole: 0.085, stroke: 0.062 };
// Small sizes need chunkier strokes to stay legible.
const bold = { r: 0.2, hole: 0.09, stroke: 0.075 };

write('build/icon.png', render(512, { background: BG, ink: WHITE, inset: 0.21, mark: fine }));
write('assets/icon.png', render(256, { background: BG, ink: WHITE, inset: 0.21, mark: fine }));
write('assets/tray.png', render(32, { background: BG, ink: WHITE, inset: 0.2, mark: bold }));
// macOS template images: black + alpha only, the OS tints them.
write('assets/trayTemplate.png', render(16, { background: null, ink: BLACK, inset: 0.06, mark: bold }));
write('assets/trayTemplate@2x.png', render(32, { background: null, ink: BLACK, inset: 0.06, mark: bold }));
