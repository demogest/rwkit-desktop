// 生成应用图标与 .rwpack 文件图标（PNG 与 ICO），不依赖任何图像库：按距离场逐像素绘制并抗锯齿
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
fs.mkdirSync(OUT, { recursive: true });

// ---------- PNG / ICO 编码 ----------
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t.push(c >>> 0); } return t; })();
const crc = b => { let c = 0xFFFFFFFF; for (const x of b) c = CRC[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function chunk(type, data) {
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]), len = Buffer.alloc(4), c = Buffer.alloc(4);
  len.writeUInt32BE(data.length); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function ico(pngs) {
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const dirs = pngs.map(({ size, data }) => {
    const d = Buffer.alloc(16);
    d[0] = size >= 256 ? 0 : size; d[1] = size >= 256 ? 0 : size; d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6);
    d.writeUInt32LE(data.length, 8); d.writeUInt32LE(offset, 12); offset += data.length;
    return d;
  });
  return Buffer.concat([head, ...dirs, ...pngs.map(p => p.data)]);
}

// ---------- 距离场图元（坐标单位与 32×32 的 SVG 标志一致） ----------
const roundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r)), cy = Math.max(y0 + r, Math.min(y, y1 - r));
  const inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const d = Math.hypot(x - cx, y - cy) - r;
  if (inside && (x >= x0 + r && x <= x1 - r || y >= y0 + r && y <= y1 - r)) return -Math.min(x - x0, x1 - x, y - y0, y1 - y);
  return d;
};
const segDist = (x, y, a, b) => {
  const vx = b[0] - a[0], vy = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(x - a[0] - t * vx, y - a[1] - t * vy);
};
const polyDist = (x, y, pts, closed) => { let d = Infinity; for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) d = Math.min(d, segDist(x, y, pts[i], pts[(i + 1) % pts.length])); return d; };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
// 立方体线框：与界面左上角的标志相同
function cubeStroke(x, y, cx, cy, s) {
  const P = pts => pts.map(([px, py]) => [cx + (px - 16) * s, cy + (py - 16) * s]);
  const hex = P([[16, 6.5], [24.5, 11.1], [24.5, 20.9], [16, 25.5], [7.5, 20.9], [7.5, 11.1]]);
  const top = P([[7.8, 11.2], [16, 15.6], [24.2, 11.2]]), mid = P([[16, 15.6], [16, 25.2]]);
  return Math.min(polyDist(x, y, hex, true), polyDist(x, y, top, false), polyDist(x, y, mid, false));
}

function render(size, shade) {
  const buf = Buffer.alloc(size * size * 4), SS = 4, k = 32 / size;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const x = (px + (sx + 0.5) / SS) * k, y = (py + (sy + 0.5) / SS) * k;
      const c = shade(x, y, k);
      if (c) { const a = c[3]; acc = [acc[0] + c[0] * a, acc[1] + c[1] * a, acc[2] + c[2] * a, acc[3] + a]; }
    }
    const o = (py * size + px) * 4, n = SS * SS, a = acc[3] / n;
    buf[o] = a ? Math.round(acc[0] / acc[3]) : 0; buf[o + 1] = a ? Math.round(acc[1] / acc[3]) : 0; buf[o + 2] = a ? Math.round(acc[2] / acc[3]) : 0; buf[o + 3] = Math.round(a * 255);
  }
  return buf;
}
const VIOLET_A = [123, 111, 240], VIOLET_B = [75, 63, 196], WHITE = [255, 255, 255];
// 应用图标：紫色渐变圆角方块 + 白色立方体线框
function appShade(x, y) {
  if (roundRect(x, y, 0.5, 0.5, 31.5, 31.5, 7.5) > 0) return null;
  const t = Math.max(0, Math.min(1, (x + y) / 64));
  const glow = Math.exp(-(((x - 11) ** 2 + (y - 8) ** 2) / 120)) * 0.18;
  const base = mix(mix(VIOLET_A, VIOLET_B, t), WHITE, glow);
  const d = cubeStroke(x, y, 16, 16, 1);
  return d < 1.05 ? [...WHITE, 1] : [...base, 1];
}
// .rwpack 文件图标：白色文档 + 折角 + 紫色立方体
function docShade(x, y) {
  const x0 = 6, x1 = 26, y0 = 2.5, y1 = 29.5, fold = 6;
  const inPage = roundRect(x, y, x0, y0, x1, y1, 1.6) <= 0 && !(x > x1 - fold && y < y0 + fold && (x - (x1 - fold)) > (y - y0));
  const edge = inPage && (roundRect(x, y, x0, y0, x1, y1, 1.6) > -0.7);
  const inFold = x > x1 - fold && x <= x1 && y >= y0 && y < y0 + fold && (x - (x1 - fold)) <= (y - y0);
  if (!inPage && !inFold) return null;
  if (inFold) return [...mix(VIOLET_A, WHITE, 0.55), 1];
  const d = cubeStroke(x, y, 16, 18.5, 0.62);
  if (d < 0.95) return [...VIOLET_B, 1];
  return edge ? [208, 212, 224, 1] : [...WHITE, 1];
}

const sizes = [256, 64, 48, 32, 24, 16];
const appPngs = sizes.map(s => ({ size: s, data: png(s, render(s, appShade)) }));
const docPngs = sizes.map(s => ({ size: s, data: png(s, render(s, docShade)) }));
fs.writeFileSync(path.join(OUT, 'icon.png'), png(512, render(512, appShade)));
fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(appPngs));
fs.writeFileSync(path.join(OUT, 'rwpack.ico'), ico(docPngs));
fs.writeFileSync(path.join(OUT, 'rwpack.png'), docPngs[0].data);
console.log('图标已生成：' + OUT);
