// «Исходные» листья: нарисованные текстуры по нашим контурам в палитре
// осеннего парка — для листвы на ветке и для тестов, пока нет детских
// рисунков. Текстура покрывает bbox вида (как у capture.js), несколько
// цветовых вариантов сложены столбиком в один атлас: iUvRect выбирает вариант.
// Плюс карта нормалей из яркости — штрихи читаются как рельеф.
import * as THREE from 'three';
import type { LeafShape } from './leaf-shapes';
import { rng, makeCanvas, canvasTexture, makeNoise2D, hexToRgb, mixRgb } from './util';

export interface LeafPalette { base: string; mid: string; tip: string; edge: string; vein: string }

export interface LeafAtlas {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  variants: number;
  /** iUvRect для варианта: смещение и масштаб */
  rect(variant: number): [number, number, number, number];
}

type P = [number, number];

function pointInPolygon(p: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Карта нормалей из яркости (Собель). Строится один раз на текстуру. */
export function normalMapFromCanvas(src: HTMLCanvasElement, strength = 2.0): THREE.CanvasTexture {
  const w = src.width, h = src.height;
  const sctx = src.getContext('2d')!;
  const d = sctx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255;
  const [canvas, ctx] = makeCanvas(w, h);
  const out = ctx.createImageData(w, h);
  const at = (x: number, y: number) => lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -gx * strength, ny = gy * strength, nz = 1;   // ny: canvas y вниз, uv y вверх
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const o = (y * w + x) * 4;
      out.data[o] = (nx * 0.5 + 0.5) * 255; out.data[o + 1] = (ny * 0.5 + 0.5) * 255; out.data[o + 2] = (nz * 0.5 + 0.5) * 255; out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvasTexture(canvas, false);
}

/** Нарисованный лист: градиент от черешка к кончику, пятна, жилки, тёмный край. */
export function paintLeafAtlas(shape: LeafShape, palettes: LeafPalette[], seed: number, cellW = 512): LeafAtlas {
  const cellH = Math.round(cellW / shape.aspect);
  const variants = palettes.length;
  const [canvas, ctx] = makeCanvas(cellW, cellH * variants);
  const noise = makeNoise2D(seed, 64);
  const { bbox, contour, vein } = shape;
  const bw = bbox.x1 - bbox.x0, bh = bbox.y1 - bbox.y0;
  // модель → пиксели ячейки (uv y вверх → canvas y вниз)
  const toPx = (p: P, row: number): P => [(p[0] - bbox.x0) / bw * cellW, row * cellH + (1 - (p[1] - bbox.y0) / bh) * cellH];
  const vb = vein[0], vt = vein[1];
  const ax = vt[0] - vb[0], ay = vt[1] - vb[1], vl = Math.hypot(ax, ay) || 1;
  const ux = ax / vl, uy = ay / vl;

  palettes.forEach((pal, row) => {
    const r = rng(seed + row * 101);
    const img = ctx.createImageData(cellW, cellH);
    const cBase = hexToRgb(pal.base), cMid = hexToRgb(pal.mid), cTip = hexToRgb(pal.tip), cEdge = hexToRgb(pal.edge);
    const off = r() * 50;
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        const mx = bbox.x0 + x / cellW * bw, my = bbox.y1 - y / cellH * bh;
        const t = Math.max(0, Math.min(1, ((mx - vb[0]) * ux + (my - vb[1]) * uy) / vl));
        const blotch = noise.fbm(x / cellW * 6 + off, y / cellH * 6, 4);
        const grain = noise.fbm(x / cellW * 40 + off, y / cellH * 40, 3);
        // градиент вдоль жилки с пятнами
        const k = Math.max(0, Math.min(1, t + (blotch - 0.5) * 0.9));
        let c = k < 0.5 ? mixRgb(cBase, cMid, k * 2) : mixRgb(cMid, cTip, (k - 0.5) * 2);
        // мазки: лёгкая полосатость вдоль жилки
        const stroke = 0.94 + 0.12 * noise.noise(x / cellW * 8 + off, y / cellH * 90);
        c = [c[0] * stroke, c[1] * stroke, c[2] * stroke];
        // край темнее/бурее — по расстоянию до контура считаем грубо через шум + позже обводим
        const shade = 0.93 + grain * 0.14;
        const o = (y * cellW + x) * 4;
        img.data[o] = Math.min(255, c[0] * shade); img.data[o + 1] = Math.min(255, c[1] * shade); img.data[o + 2] = Math.min(255, c[2] * shade); img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, row * cellH);

    // край: тёмная бурая кайма внутри контура (широкая мягкая обводка, обрезанная контуром)
    ctx.save();
    ctx.beginPath();
    contour.forEach((p, i) => { const q = toPx(p, row); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
    ctx.closePath();
    ctx.clip();
    ctx.strokeStyle = `rgba(${cEdge[0] | 0},${cEdge[1] | 0},${cEdge[2] | 0},0.55)`;
    ctx.lineWidth = cellW * 0.05;
    ctx.stroke();
    ctx.strokeStyle = `rgba(${cEdge[0] | 0},${cEdge[1] | 0},${cEdge[2] | 0},0.5)`;
    ctx.lineWidth = cellW * 0.014;
    ctx.stroke();

    // жилки: главная и боковые, к кончику тоньше
    const cv = hexToRgb(pal.vein);
    ctx.strokeStyle = `rgba(${cv[0] | 0},${cv[1] | 0},${cv[2] | 0},0.6)`;
    ctx.lineCap = 'round';
    const b = toPx(vb, row), tp = toPx(vt, row);
    ctx.lineWidth = cellW * 0.007;
    ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(tp[0], tp[1]); ctx.stroke();
    const nSide = 6 + Math.floor(r() * 3);
    for (let i = 1; i <= nSide; i++) {
      const t = i / (nSide + 1);
      const sx = vb[0] + ax * t, sy = vb[1] + ay * t;
      for (const side of [-1, 1]) {
        const ang = (0.55 + r() * 0.25) * side;
        const dx = ux * Math.cos(ang) - uy * Math.sin(ang), dy = ux * Math.sin(ang) + uy * Math.cos(ang);
        // идём до контура
        let len = 0;
        for (let k = 0.01; k < 0.6; k += 0.01) {
          if (!pointInPolygon([sx + dx * k, sy + dy * k], contour)) break;
          len = k;
        }
        if (len < 0.03) continue;
        const e = toPx([sx + dx * len * 0.92, sy + dy * len * 0.92], row);
        const s = toPx([sx, sy], row);
        const c1 = toPx([sx + dx * len * 0.5 + uy * 0.02 * side, sy + dy * len * 0.5 - ux * 0.02 * side], row);
        ctx.lineWidth = cellW * 0.0045 * (1 - t * 0.5);
        ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.quadraticCurveTo(c1[0], c1[1], e[0], e[1]); ctx.stroke();
      }
    }
    ctx.restore();
  });

  const map = canvasTexture(canvas);
  map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
  map.anisotropy = 8;
  const normalMap = normalMapFromCanvas(canvas, 1.6);
  normalMap.wrapS = normalMap.wrapT = THREE.ClampToEdgeWrapping;
  return {
    map, normalMap, variants,
    rect(v) { return [0, 1 - (v + 1) / variants, 1, 1 / variants]; }
  };
}
