// Generates the Orchestra icon (blue-violet rounded tile with a white diamond) as icon.png (256) and icon.ico.
// Zero dependencies: a tiny PNG encoder (zlib + CRC32) and an ICO wrapper around PNG images.
const zlib = require('zlib'), fs = require('fs'), path = require('path');
const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  let x = 0xffffffff; for (const v of b) x = t[(x ^ v) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
function png(size) {
  const px = Buffer.alloc(size * (size * 4 + 1)), r = size * 0.22;
  for (let y = 0; y < size; y++) {
    px[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      // rounded square mask with 1px anti-aliasing
      const dx = Math.max(r - x - 0.5, 0, x + 0.5 - (size - r)), dy = Math.max(r - y - 0.5, 0, y + 0.5 - (size - r));
      const d = Math.hypot(dx, dy) - r; const a = Math.max(0, Math.min(1, 0.5 - d));
      const t = (x + y) / (2 * size);   // gradient #6d95f0 -> #a68be6
      let R = 0x6d + (0xa6 - 0x6d) * t, G = 0x95 + (0x8b - 0x95) * t, B = 0xf0 + (0xe6 - 0xf0) * t;
      // white diamond in the middle
      const m = Math.abs(x + 0.5 - size / 2) + Math.abs(y + 0.5 - size / 2), dm = m - size * 0.2; const w = Math.max(0, Math.min(1, 0.5 - dm));
      R = R + (255 - R) * w; G = G + (255 - G) * w; B = B + (255 - B) * w;
      px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(px)), chunk('IEND', Buffer.alloc(0))]);
}
const sizes = [16, 32, 48, 256], imgs = sizes.map(png);
fs.writeFileSync(path.join(__dirname, 'icon.png'), imgs[3]);
const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let off = 6 + 16 * sizes.length; const dir = [];
sizes.forEach((s, i) => { const e = Buffer.alloc(16); e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(imgs[i].length, 8); e.writeUInt32LE(off, 12); off += imgs[i].length; dir.push(e); });
fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([head, ...dir, ...imgs]));
// macOS builds need an icon of at least 512 x 512 (electron-builder turns it into the .icns)
fs.writeFileSync(path.join(__dirname, 'icon-mac.png'), png(1024));
console.log('wrote icon.png, icon.ico and icon-mac.png');
