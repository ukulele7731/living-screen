// Обработка текстуры листа при загрузке (раздел 5.1 server-spec.md):
//   1. PNG от телефона — кадр по bboxModel вида, непрозрачный, снаружи контура «вытянутые» цвета
//   2. маска по contourModel с эрозией 2 px внутрь и мягким краем 1 px → альфа
//   3. tex 512 px WebP — БЕЗ альфы: сцена режет лист по контуру сама, а альфа на краю даёт тёмную
//      кайму при фильтрации текстуры; thumb 128 px — с альфой (для списков, бота, гербария)
//   4. карта нормалей из яркости (Собель, сила 0.6), карта толщины: 1 у жилки → 0.4 у края
// Всё в памяти, sharp; ~200–400 мс на лист.
import sharp from 'sharp';
import type { Fish } from './manifests.js';

export interface ProcessedLeaf {
  tex: Buffer; thumb: Buffer; normal: Buffer; thick: Buffer;
  width: number; height: number;
}

export const TEX_SIZE = 512;
export const THUMB_SIZE = 128;

type P = [number, number];

/** Контур в пикселях кадра w×h: модель z — вправо, y — вверх; картинка y — вниз. */
function contourPx(fish: Fish, w: number, h: number): P[] {
  const [z0, z1] = fish.bboxModel.z, [y0, y1] = fish.bboxModel.y;
  return fish.contourModel.map(([z, y]) => [(z - z0) / (z1 - z0) * w, (1 - (y - y0) / (y1 - y0)) * h]);
}

/** Маска 0..255: заливка многоугольника, эрозия на erodePx, мягкий край softPx. */
export function contourMask(fish: Fish, w: number, h: number, erodePx = 2, softPx = 1): Uint8Array {
  const poly = contourPx(fish, w, h);
  const inside = new Uint8Array(w * h);
  // построчная заливка (чёт-нечет)
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > yc) !== (b[1] > yc)) xs.push(a[0] + (yc - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5)), x1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = x0; x <= x1; x++) inside[y * w + x] = 1;
    }
  }
  // эрозия: пиксель остаётся, если весь квадрат (2r+1)² внутри
  let cur = inside;
  for (let pass = 0; pass < erodePx; pass++) {
    const next = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const o = y * w + x;
      if (cur[o] && cur[o - 1] && cur[o + 1] && cur[o - w] && cur[o + w] && cur[o - w - 1] && cur[o - w + 1] && cur[o + w - 1] && cur[o + w + 1]) next[o] = 1;
    }
    cur = next;
  }
  // мягкий край: усреднение 3×3, softPx раз
  let mask = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = cur[i] ? 1 : 0;
  for (let pass = 0; pass < softPx; pass++) {
    const out = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const o = y * w + x;
      out[o] = (mask[o] * 4 + mask[o - 1] + mask[o + 1] + mask[o - w] + mask[o + w]) / 8;
    }
    mask = out;
  }
  const bytes = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bytes[i] = Math.round(mask[i] * 255);
  return bytes;
}

/** Карта нормалей из яркости: Собель, сила strength (0.6 — раздел 5.1). RGB, канал z всегда вверх. */
function normalFromLuma(luma: Float32Array, w: number, h: number, strength: number): Uint8Array {
  const out = new Uint8Array(w * h * 3);
  const at = (x: number, y: number) => luma[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) / 8;
    const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) / 8;
    let nx = -gx * strength, ny = gy * strength, nz = 1;          // y картинки вниз → y карты вверх
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const o = (y * w + x) * 3;
    out[o] = (nx * 0.5 + 0.5) * 255; out[o + 1] = (ny * 0.5 + 0.5) * 255; out[o + 2] = (nz * 0.5 + 0.5) * 255;
  }
  return out;
}

/** Карта толщины: 1 у главной жилки → 0.4 у края (по поперечному расстоянию до жилки). */
function thicknessMap(fish: Fish, w: number, h: number, mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(w * h);
  const poly = contourPx(fish, w, h);
  const [z0, z1] = fish.bboxModel.z, [y0, y1] = fish.bboxModel.y;
  const toPx = (p: [number, number]): P => [(p[0] - z0) / (z1 - z0) * w, (1 - (p[1] - y0) / (y1 - y0)) * h];
  const vb = fish.vein ? toPx(fish.vein[0]) : [w / 2, h] as P;
  const vt = fish.vein ? toPx(fish.vein[1]) : [w / 2, 0] as P;
  const ax = vt[0] - vb[0], ay = vt[1] - vb[1], vl = Math.hypot(ax, ay) || 1;
  const px = -ay / vl, py = ax / vl;
  let maxLat = 1;
  for (const c of poly) maxLat = Math.max(maxLat, Math.abs((c[0] - vb[0]) * px + (c[1] - vb[1]) * py));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.abs((x + 0.5 - vb[0]) * px + (y + 0.5 - vb[1]) * py) / maxLat;
    const t = 1 - 0.6 * Math.min(1, d);
    out[y * w + x] = mask[y * w + x] ? Math.round(t * 255) : 0;
  }
  return out;
}

export async function processLeafImage(input: Buffer, fish: Fish): Promise<ProcessedLeaf> {
  const src = sharp(input, { limitInputPixels: 4096 * 4096 }).rotate();      // EXIF не ждём, но не помешает
  const meta = await src.metadata();
  if (!meta.width || !meta.height) throw new Error('не удалось прочитать картинку');
  const aspect = meta.width / meta.height;
  const [z0, z1] = fish.bboxModel.z, [y0, y1] = fish.bboxModel.y;
  const wantAspect = (z1 - z0) / (y1 - y0);
  if (Math.abs(aspect / wantAspect - 1) > 0.08) throw new Error(`пропорции кадра ${aspect.toFixed(2)} не совпадают с bbox вида ${wantAspect.toFixed(2)}`);

  const w = TEX_SIZE, h = Math.round(TEX_SIZE / wantAspect);
  const rgb = await src.clone().resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const mask = contourMask(fish, w, h);

  // tex — без альфы; thumb — с альфой по маске
  const tex = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).webp({ quality: 88 }).toBuffer();
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = mask[i]; }
  const thumb = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .resize(THUMB_SIZE, Math.round(THUMB_SIZE / wantAspect), { fit: 'fill' }).webp({ quality: 80 }).toBuffer();

  const luma = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) luma[i] = (rgb[i * 3] * 0.299 + rgb[i * 3 + 1] * 0.587 + rgb[i * 3 + 2] * 0.114) / 255;
  const normal = await sharp(Buffer.from(normalFromLuma(luma, w, h, 0.6)), { raw: { width: w, height: h, channels: 3 } }).webp({ quality: 85 }).toBuffer();
  const thick = await sharp(Buffer.from(thicknessMap(fish, w, h, mask)), { raw: { width: w, height: h, channels: 1 } }).webp({ quality: 85 }).toBuffer();
  return { tex, thumb, normal, thick, width: w, height: h };
}
