/**
 * Generates placeholder PWA icons with no image dependencies.
 *
 * Real icons come later; these exist so the manifest is valid and the app can be installed to
 * an iOS home screen — which Sprint 0's capability probe requires, since iOS refuses Web Push
 * until the PWA is installed.
 *
 * Run: node scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public', 'icons');

const BG = [15, 23, 42]; // slate-950, matches theme_color
const FG = [56, 189, 248]; // sky-400

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** Encodes RGB pixels as a PNG. `pixels` is a function (x, y) => [r, g, b]. */
function encodePng(size, pixels) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixels(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A medical cross. `inset` shrinks the glyph so maskable icons keep it inside the safe zone
 * (Android may crop up to 20% on each edge).
 */
function crossIcon(size, inset) {
  const armThickness = size * 0.18;
  const armLength = size * (0.5 - inset);
  const centre = size / 2;

  return (x, y) => {
    const dx = Math.abs(x - centre + 0.5);
    const dy = Math.abs(y - centre + 0.5);
    const onVerticalArm = dx <= armThickness / 2 && dy <= armLength;
    const onHorizontalArm = dy <= armThickness / 2 && dx <= armLength;
    return onVerticalArm || onHorizontalArm ? FG : BG;
  };
}

mkdirSync(OUT_DIR, { recursive: true });

const icons = [
  ['icon-192.png', 192, 0.14],
  ['icon-512.png', 512, 0.14],
  ['icon-512-maskable.png', 512, 0.24],
  ['apple-touch-icon.png', 180, 0.14],
];

for (const [name, size, inset] of icons) {
  writeFileSync(join(OUT_DIR, name), encodePng(size, crossIcon(size, inset)));
  console.log(`wrote ${name} (${size}x${size})`);
}
