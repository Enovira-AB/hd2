// Generates PWA icons (no image deps): dark rounded square with three yellow
// chevrons pointing down — the helldive. Writes raw PNGs with zlib.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, draw) {
  const px = Buffer.alloc(size * size * 4);
  draw((x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  });
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  return png(size, (set) => {
    const s = size;
    const corner = s * 0.18;
    // background: very dark navy, rounded corners
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const cx = Math.max(0, Math.max(corner - x, x - (s - 1 - corner)));
        const cy = Math.max(0, Math.max(corner - y, y - (s - 1 - corner)));
        if (cx > 0 && cy > 0 && Math.hypot(cx, cy) > corner) {
          set(x, y, 0, 0, 0, 0);
          continue;
        }
        const grad = 1 - (y / s) * 0.35;
        set(x, y, Math.round(8 * grad), Math.round(11 * grad), Math.round(16 * grad));
      }
    }
    // three downward chevrons in HELLDIVE yellow
    const yellow = [255, 217, 74];
    const cxm = s / 2;
    const w = s * 0.34;
    const th = s * 0.075;
    for (let c = 0; c < 3; c++) {
      const tipY = s * (0.33 + c * 0.2);
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const dx = Math.abs(x - cxm);
          if (dx > w) continue;
          const lineY = tipY - dx * 0.55; // tip at center-bottom: chevrons dive down
          if (Math.abs(y - lineY) < th) set(x, y, yellow[0], yellow[1], yellow[2]);
        }
      }
    }
  });
}

// Wrap one or more PNGs into a single .ico container (ICO supports embedded
// PNG entries, which every modern browser reads). Kills the browser's
// automatic /favicon.ico probe that otherwise 404s.
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(entries.length, 4);
  const dir = [];
  const images = [];
  let offset = 6 + entries.length * 16;
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 means 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette count
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    dir.push(e);
    images.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...dir, ...images]);
}

mkdirSync('web/public', { recursive: true });
writeFileSync('web/public/icon-180.png', drawIcon(180));
writeFileSync('web/public/icon-512.png', drawIcon(512));
writeFileSync('web/public/favicon.ico', ico([
  { size: 32, png: drawIcon(32) },
  { size: 16, png: drawIcon(16) },
]));
console.log('icons written: web/public/icon-180.png, icon-512.png, favicon.ico');
