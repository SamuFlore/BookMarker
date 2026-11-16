import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'src', 'icons');

const SIZES = [16, 32, 48, 128];
const SAMPLES = 4; // supersampling per axis

// Palette: deep blue tile, white bookmark ribbon.
const BG = [0x1f, 0x4f, 0xd8];
const FG = [0xff, 0xff, 0xff];

// Shape ratios, all relative to the icon edge so every size stays identical.
const RADIUS = 0.22;
const RIBBON = { left: 0.29, right: 0.71, top: 0.17, bottom: 0.85, notch: 0.2 };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function inRoundedSquare(x, y, size, radius) {
  const r = Math.min(radius, size / 2);
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inRibbon(x, y, size) {
  const left = RIBBON.left * size;
  const right = RIBBON.right * size;
  const top = RIBBON.top * size;
  const bottom = RIBBON.bottom * size;
  if (x < left || x > right || y < top || y > bottom) return false;

  const notch = RIBBON.notch * size;
  if (y > bottom - notch) {
    const half = (right - left) / 2;
    const excludedHalf = (half * (y - bottom + notch)) / notch;
    if (Math.abs(x - (left + right) / 2) < excludedHalf) return false;
  }
  return true;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = RADIUS * size;
  const step = 1 / SAMPLES;
  const total = SAMPLES * SAMPLES;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let tile = 0;
      let ribbon = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = px + (sx + 0.5) * step;
          const y = py + (sy + 0.5) * step;
          if (!inRoundedSquare(x, y, size, radius)) continue;
          tile += 1;
          if (inRibbon(x, y, size)) ribbon += 1;
        }
      }
      const alpha = Math.round((tile / total) * 255);
      if (alpha === 0) continue;
      const mix = tile === 0 ? 0 : ribbon / tile;
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(BG[0] + (FG[0] - BG[0]) * mix);
      rgba[i + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * mix);
      rgba[i + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * mix);
      rgba[i + 3] = alpha;
    }
  }
  return rgba;
}

mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const file = join(outDir, `icon${size}.png`);
  const png = encodePng(size, render(size));
  writeFileSync(file, png);
  console.log(`wrote src/icons/icon${size}.png (${size}x${size}, ${png.length} bytes)`);
}
