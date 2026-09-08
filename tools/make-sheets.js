#!/usr/bin/env node
'use strict';
/* Генератор листов раскраски «Живого листопада».

   Читает leaves/*.svg (один замкнутый path на файл + необязательная line#vein),
   подбирает коды угловых меток и пишет:
     assets/coloring/<вид>.svg      — лист A4 альбомный для печати
     assets/coloring/manifest.json  — манифест для vendor/paper-aquarium/capture.js
     assets/coloring/sheets.js      — то же плюс SVG-строки, для tools/test-capture.html
                                      (страница должна работать с file://, где fetch запрещён)

   Node 20+, без зависимостей.  Запуск: node tools/make-sheets.js

   Геометрия листа и формат манифеста — ровно как у автора paper-aquarium,
   потому что его capture.js читает именно эти поля (см. CLAUDE.md). */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LEAVES_DIR = path.join(ROOT, 'leaves');
const OUT_DIR = path.join(ROOT, 'assets', 'coloring');

// ── Геометрия листа A4 (мм). Значения автора paper-aquarium — не менять,
//    под них проверена точность распознавания. ────────────────────────────
const SHEET = {
  w: 297, h: 210,
  marker: { size: 18, margin: 8, cells: 6 },
  markerPositions: { tl: [8, 8], tr: [271, 8], bl: [8, 184], br: [271, 184] },
  work: { x0: 36, x1: 261, y0: 36, y1: 166 }
};
const STROKE = 1.6;               // мм, толщина печатного контура (capture.js срезает 1.8 мм с каждой стороны)
const STROKE_COLOR = '#8a8a8a';
const VEIN_COLOR = '#b8b8b8';
const MIN_DIST = 4;               // минимум различий (клеток) между любыми двумя кодами меток с учётом поворотов
const MIN_SIZE_MM = 60;           // предупреждать, если рисунок после укладки уже этого по любой стороне
const TARGET_POINTS = 100;        // сколько точек хотим в contourModel
const MAX_POINTS = 150;           // потолок: зубчатым листьям нужно больше точек

// ── Виды. rotate — поворот листа на странице от вертикального положения
//    (кончик вверх), градусы по часовой стрелке; fit — доля рабочего поля
//    под габарит рисунка. Узкие виды кладём почти горизонтально: рабочее
//    поле 225×130 мм, и диагональная укладка длинного листа упирается в
//    высоту раньше, чем в ширину (см. подсказку «лучший угол» в выводе). ──
const SPECIES = [
  { name: 'maple',    title: 'Клён',    rotate: 0,  fit: 0.94 },
  { name: 'oak',      title: 'Дуб',     rotate: 80, fit: 0.94 },
  { name: 'birch',    title: 'Берёза',  rotate: 0,  fit: 0.94 },
  { name: 'aspen',    title: 'Осина',   rotate: 0,  fit: 0.94 },
  { name: 'linden',   title: 'Липа',    rotate: 0,  fit: 0.94 },
  { name: 'chestnut', title: 'Каштан',  rotate: 80, fit: 0.90 },
  { name: 'rowan',    title: 'Рябина',  rotate: 80, fit: 0.90 },
  { name: 'willow',   title: 'Ива',     rotate: 80, fit: 0.90 }
];

// ══════════════════════════════════════════════════════════════════════════
// SVG → точки
// ══════════════════════════════════════════════════════════════════════════

function readLeafSvg(file) {
  const svg = fs.readFileSync(file, 'utf8');
  const paths = [...svg.matchAll(/<path\b[^>]*>/g)].map((m) => m[0]);
  if (paths.length !== 1) {
    throw new Error(`${path.basename(file)}: ожидается ровно один <path>, найдено ${paths.length}`);
  }
  if (/\btransform=/.test(paths[0])) {
    throw new Error(`${path.basename(file)}: атрибут transform на path не поддерживается — примени его к координатам`);
  }
  const d = /\bd="([^"]+)"/.exec(paths[0]);
  if (!d) throw new Error(`${path.basename(file)}: у path нет атрибута d`);

  let vein = null;
  const line = /<line\b[^>]*\bid="vein"[^>]*>/.exec(svg);
  if (line) {
    const num = (attr) => {
      const m = new RegExp(`\\b${attr}="([^"]+)"`).exec(line[0]);
      return m ? parseFloat(m[1]) : NaN;
    };
    vein = [[num('x1'), num('y1')], [num('x2'), num('y2')]];
    if (vein.flat().some((v) => Number.isNaN(v))) throw new Error(`${path.basename(file)}: line#vein без x1/y1/x2/y2`);
  }
  return { svg, d: d[1], vein };
}

// Разбор атрибута d: M L H V C S Q T Z (абсолютные и относительные). Дуги (A) не
// поддерживаем — контуры рисуем кубическими Безье. Кривые дискретизируются густо,
// прореживание — отдельным шагом.
function flattenPathD(d, stepsPerCurve) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtZzAa]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
  const pts = [];
  let cmd = null, i = 0, cur = [0, 0], start = [0, 0], prevCtrl = null, prevCmd = '';
  const next = () => parseFloat(tokens[i++]);
  const push = (p) => { pts.push([p[0], p[1]]); cur = p; };
  const cubic = (p0, c1, c2, p1) => {
    for (let s = 1; s <= stepsPerCurve; s++) {
      const t = s / stepsPerCurve, u = 1 - t;
      pts.push([
        u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
        u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1]
      ]);
    }
    cur = p1;
  };
  const quad = (p0, c, p1) => cubic(p0,
    [p0[0] + 2 / 3 * (c[0] - p0[0]), p0[1] + 2 / 3 * (c[1] - p0[1])],
    [p1[0] + 2 / 3 * (c[0] - p1[0]), p1[1] + 2 / 3 * (c[1] - p1[1])], p1);
  const rel = (x, y) => [cur[0] + x, cur[1] + y];

  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
    else if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
    let c1, c2, p;
    switch (cmd) {
      case 'M': p = [next(), next()]; push(p); start = p; prevCtrl = null; break;
      case 'm': p = rel(next(), next()); push(p); start = p; prevCtrl = null; break;
      case 'L': push([next(), next()]); prevCtrl = null; break;
      case 'l': push(rel(next(), next())); prevCtrl = null; break;
      case 'H': push([next(), cur[1]]); prevCtrl = null; break;
      case 'h': push([cur[0] + next(), cur[1]]); prevCtrl = null; break;
      case 'V': push([cur[0], next()]); prevCtrl = null; break;
      case 'v': push([cur[0], cur[1] + next()]); prevCtrl = null; break;
      case 'C': c1 = [next(), next()]; c2 = [next(), next()]; p = [next(), next()]; cubic(cur, c1, c2, p); prevCtrl = c2; break;
      case 'c': c1 = rel(next(), next()); c2 = rel(next(), next()); p = rel(next(), next()); cubic(cur, c1, c2, p); prevCtrl = c2; break;
      case 'S': case 's': {
        c1 = /[CcSs]/.test(prevCmd) && prevCtrl ? [2 * cur[0] - prevCtrl[0], 2 * cur[1] - prevCtrl[1]] : cur;
        c2 = cmd === 'S' ? [next(), next()] : rel(next(), next());
        p = cmd === 'S' ? [next(), next()] : rel(next(), next());
        cubic(cur, c1, c2, p); prevCtrl = c2; break;
      }
      case 'Q': c1 = [next(), next()]; p = [next(), next()]; quad(cur, c1, p); prevCtrl = c1; break;
      case 'q': c1 = rel(next(), next()); p = rel(next(), next()); quad(cur, c1, p); prevCtrl = c1; break;
      case 'T': case 't': {
        c1 = /[QqTt]/.test(prevCmd) && prevCtrl ? [2 * cur[0] - prevCtrl[0], 2 * cur[1] - prevCtrl[1]] : cur;
        p = cmd === 'T' ? [next(), next()] : rel(next(), next());
        quad(cur, c1, p); prevCtrl = c1; break;
      }
      case 'Z': case 'z': cur = start; prevCtrl = null; break;
      case 'A': case 'a': throw new Error('дуги (A) в path не поддерживаются — перерисуй контур кубическими Безье');
      default: throw new Error('неизвестная команда path: ' + cmd);
    }
    prevCmd = cmd;
  }
  // убираем повтор замыкающей точки и дубликаты подряд
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) out.push(p);
  }
  const f = out[0], l = out[out.length - 1];
  if (out.length > 1 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-6) out.pop();
  return out;
}

// Дуглас–Пекер для замкнутого полигона: режем по двум самым далёким точкам.
function simplifyClosed(pts, tol) {
  let a = 0, b = 0, best = -1;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = (pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2;
      if (d > best) { best = d; a = i; b = j; }
    }
  }
  const arc1 = pts.slice(a, b + 1);
  const arc2 = pts.slice(b).concat(pts.slice(0, a + 1));
  return dp(arc1, tol).slice(0, -1).concat(dp(arc2, tol).slice(0, -1));
}

function dp(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const A = pts[0], B = pts[pts.length - 1];
  const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1e-9;
  let worst = -1, idx = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i][0] - A[0]) * dy - (pts[i][1] - A[1]) * dx) / L;
    if (d > worst) { worst = d; idx = i; }
  }
  if (worst <= tol) return [A, B];
  return dp(pts.slice(0, idx + 1), tol).slice(0, -1).concat(dp(pts.slice(idx), tol));
}

function selfIntersects(poly) {
  const n = poly.length;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;          // соседние рёбра
      const c = poly[j], d = poly[(j + 1) % n];
      const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
      if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
    }
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════════════
// Модельные координаты и укладка на лист
// ══════════════════════════════════════════════════════════════════════════

// Строит преобразование SVG → модель для данного контура:
//   1) инверсия y (см. ниже), 2) поворот, 3) центрирование и нормировка
//   в bbox [-0.5, 0.5] по длинной стороне.
function buildModelTransform(svgPts, rotateDeg) {
  const th = rotateDeg * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
  const raw = (p) => {
    // В SVG ось y направлена вниз. В модели capture.js y растёт вверх — это видно из
    // sheetTransform: y_mm = oy − scale·y. Инвертируем y ровно один раз здесь;
    // дальше по всему генератору координаты модельные (y вверх).
    const x = p[0], y = -p[1];
    // поворот по часовой стрелке на rotate° (в координатах с y вверх)
    return [x * cs + y * sn, -x * sn + y * cs];
  };
  const r = svgPts.map(raw);
  const xs = r.map((p) => p[0]), ys = r.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const long = Math.max(maxX - minX, maxY - minY);
  return (p) => {
    const q = raw(p);
    return [(q[0] - cx) / long, (q[1] - cy) / long];
  };
}

function bboxOf(pts) {
  const zs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { z: [Math.min(...zs), Math.max(...zs)], y: [Math.min(...ys), Math.max(...ys)] };
}

// Тот же смысл, что у автора: габарит рисунка занимает fit рабочего поля,
// центр — в центре рабочего поля.
function sheetTransform(bbox, fit) {
  const spanZ = bbox.z[1] - bbox.z[0], spanY = bbox.y[1] - bbox.y[0];
  const workW = SHEET.work.x1 - SHEET.work.x0, workH = SHEET.work.y1 - SHEET.work.y0;
  return {
    scale: +(fit * Math.min(workW / spanZ, workH / spanY)).toFixed(4),
    ox: (SHEET.work.x0 + SHEET.work.x1) / 2,
    oy: (SHEET.work.y0 + SHEET.work.y1) / 2
  };
}

// модель → мм листа; ровно та формула, по которой capture.js кладёт контур на лист
function modelToMM(st, p) {
  return [st.ox + st.scale * p[0], st.oy - st.scale * p[1]];
}

// Собственные длина (вдоль оси черешок→кончик) и ширина листа в мм при данном
// повороте и fit. Габарит повёрнутого листа для этого не годится: у длинного
// листа по диагонали bbox широкий, а сам лист узкий.
function leafSizeAt(svgPts, rotate, fit) {
  const T = buildModelTransform(svgPts, rotate);
  const bb = bboxOf(svgPts.map(T));
  const st = sheetTransform(bb, fit);
  const xs = svgPts.map((p) => p[0]), ys = svgPts.map((p) => p[1]);
  const ownW = Math.max(...xs) - Math.min(...xs), ownL = Math.max(...ys) - Math.min(...ys);
  // масштаб «SVG-единица → мм»: нормировка делит на длинную сторону повёрнутого bbox в SVG-единицах
  const th = rotate * Math.PI / 180;
  const rotW = ownL * Math.abs(Math.sin(th)) + ownW * Math.abs(Math.cos(th));
  const rotH = ownL * Math.abs(Math.cos(th)) + ownW * Math.abs(Math.sin(th));
  const unit = st.scale / Math.max(rotW, rotH);
  return { length: ownL * unit, width: ownW * unit, boxW: st.scale * (bb.z[1] - bb.z[0]), boxH: st.scale * (bb.y[1] - bb.y[0]) };
}

// ══════════════════════════════════════════════════════════════════════════
// Коды меток: 16 бит внутренних клеток 4×4 (0 — чёрная, 1 — белая), внешнее
// кольцо 6×6 всегда чёрное. capture.js ищет код точным совпадением по всем
// четырём поворотам, поэтому любые два кода (всех видов и всех углов) должны
// отличаться минимум на MIN_DIST клеток в любом взаимном повороте.
// ══════════════════════════════════════════════════════════════════════════

function rotateBits(bits) {          // поворот 4×4 на 90° — та же формула, что в capture.js
  const o = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + (3 - r)] = bits[r * 4 + c];
  return o;
}
const numToBits = (n) => Array.from({ length: 16 }, (_, i) => (n >> (15 - i)) & 1);
const bitsToNum = (b) => b.reduce((n, v) => (n << 1) | v, 0);
function popcount(n) { let c = 0; while (n) { n &= n - 1; c++; } return c; }
function rotationsOf(n) {
  const out = [];
  let b = numToBits(n);
  for (let r = 0; r < 4; r++) { out.push(bitsToNum(b)); b = rotateBits(b); }
  return out;
}

function pickMarkerCodes(count) {
  // кандидаты: 4..12 белых клеток — есть контраст внутри метки и достаточно чёрного
  const pool = [];
  for (let n = 0; n < 65536; n++) {
    const w = popcount(n);
    if (w >= 4 && w <= 12) pool.push(n);
  }
  for (let dist = 7; dist >= MIN_DIST; dist--) {
    for (let seed = 1; seed <= 6; seed++) {
      const got = greedy(shuffled(pool, seed), count, dist);
      if (got) return { codes: got, dist };
    }
  }
  throw new Error(`не удалось подобрать ${count} кодов меток с расстоянием ≥ ${MIN_DIST}`);
}

function greedy(pool, count, dist) {
  const chosen = [];                       // [{n, rots}]
  for (const n of pool) {
    const rots = rotationsOf(n);
    let ok = true;
    for (const c of chosen) {
      for (const a of rots) {
        for (const b of c.rots) if (popcount(a ^ b) < dist) { ok = false; break; }
        if (!ok) break;
      }
      if (!ok) break;
    }
    if (ok) {
      chosen.push({ n, rots });
      if (chosen.length === count) return chosen.map((c) => c.n);
    }
  }
  return null;
}

function shuffled(arr, seed) {           // детерминированная перестановка (LCG), чтобы коды не менялись между запусками
  const a = arr.slice();
  let s = seed * 2654435761 >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ══════════════════════════════════════════════════════════════════════════
// SVG листа раскраски
// ══════════════════════════════════════════════════════════════════════════

const f2 = (v) => (+v.toFixed(2)).toString();

function markerSvg(bits, pos) {
  const size = SHEET.marker.size, cell = size / SHEET.marker.cells;
  let out = `<rect x="${pos[0]}" y="${pos[1]}" width="${size}" height="${size}" fill="#000"/>`;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (!bits[r * 4 + c]) continue;
      out += `<rect x="${f2(pos[0] + (c + 1) * cell)}" y="${f2(pos[1] + (r + 1) * cell)}" width="${f2(cell)}" height="${f2(cell)}" fill="#fff"/>`;
    }
  }
  return out;
}

function sheetSvg(sp, printPts, veinMM) {
  const d = 'M ' + printPts.map((p) => `${f2(p[0])} ${f2(p[1])}`).join(' L ') + ' Z';
  const parts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!-- Лист раскраски «${sp.title}» — сгенерирован tools/make-sheets.js, не редактировать вручную.`,
    `     Печатать в масштабе 100% (без «по размеру страницы»): метки должны остаться 18 мм. -->`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SHEET.w} ${SHEET.h}" width="${SHEET.w}mm" height="${SHEET.h}mm">`,
    `  <rect width="${SHEET.w}" height="${SHEET.h}" fill="#fff"/>`
  ];
  for (const corner of ['tl', 'tr', 'bl', 'br']) parts.push('  ' + markerSvg(sp.markers[corner], SHEET.markerPositions[corner]));
  parts.push(`  <path id="contour" d="${d}" fill="#fff" stroke="${STROKE_COLOR}" stroke-width="${STROKE}" stroke-linejoin="round"/>`);
  if (veinMM) {
    parts.push(`  <path id="vein" d="M ${f2(veinMM[0][0])} ${f2(veinMM[0][1])} L ${f2(veinMM[1][0])} ${f2(veinMM[1][1])}" ` +
      `fill="none" stroke="${VEIN_COLOR}" stroke-width="0.5" stroke-dasharray="3 2" stroke-linecap="round"/>`);
  }
  const font = 'font-family="Arial, Helvetica, sans-serif"';
  parts.push(`  <text x="${SHEET.work.x0}" y="181" ${font} font-size="8" fill="#555">${sp.title}</text>`);
  parts.push(`  <text x="${SHEET.work.x1}" y="181" ${font} font-size="6" fill="#555" text-anchor="end">Имя: ________________</text>`);
  parts.push(`  <text x="${SHEET.w / 2}" y="199" ${font} font-size="3.6" fill="#999" text-anchor="middle">` +
    `Живой листопад · раскрась лист, сфотографируй по QR с экрана — и он полетит</text>`);
  parts.push('</svg>', '');
  return parts.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════
// Главное
// ══════════════════════════════════════════════════════════════════════════

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { codes, dist } = pickMarkerCodes(SPECIES.length * 4);
  console.log(`Коды меток: ${codes.length}, минимальное расстояние Хэмминга с учётом поворотов: ${dist}`);

  const fish = [];
  const svgs = {};
  const rows = [];
  let warnings = 0;

  SPECIES.forEach((sp, si) => {
    const file = path.join(LEAVES_DIR, sp.name + '.svg');
    if (!fs.existsSync(file)) throw new Error(`нет файла ${file}`);
    const leaf = readLeafSvg(file);
    const dense = flattenPathD(leaf.d, 32);
    if (dense.length < 8) throw new Error(`${sp.name}: слишком мало точек в контуре`);
    if (selfIntersects(dense)) throw new Error(`${sp.name}: контур самопересекается`);

    const T = buildModelTransform(dense, sp.rotate);
    const denseModel = dense.map(T);

    // прореживаем до ~TARGET_POINTS (но не грубее, чем нужно зубчатым листьям)
    let tol = 0.002, model;
    for (;;) {
      model = simplifyClosed(denseModel, tol);
      if (model.length <= MAX_POINTS || tol > 0.02) break;
      tol *= 1.25;
    }
    // если получилось заметно меньше цели — вернём точности
    while (model.length < TARGET_POINTS * 0.8 && tol > 0.0005) {
      tol *= 0.8;
      model = simplifyClosed(denseModel, tol);
    }
    if (selfIntersects(model)) throw new Error(`${sp.name}: упрощённый контур самопересекается — уменьши tol`);
    model = model.map((p) => [+p[0].toFixed(4), +p[1].toFixed(4)]);

    const bbox = bboxOf(denseModel);
    const bboxR = { z: bbox.z.map((v) => +v.toFixed(4)), y: bbox.y.map((v) => +v.toFixed(4)) };
    const st = sheetTransform(bbox, sp.fit);
    const size = leafSizeAt(dense, sp.rotate, sp.fit);

    // жилка: из SVG, иначе от самой нижней точки к самой дальней от неё
    let veinSvg = leaf.vein;
    if (!veinSvg) {
      const base = dense.reduce((a, b) => (b[1] > a[1] ? b : a));
      const tip = dense.reduce((a, b) => (Math.hypot(b[0] - base[0], b[1] - base[1]) > Math.hypot(a[0] - base[0], a[1] - base[1]) ? b : a));
      veinSvg = [base, tip];
    }
    const veinModel = veinSvg.map(T).map((p) => [+p[0].toFixed(4), +p[1].toFixed(4)]);

    const markers = {};
    ['tl', 'tr', 'bl', 'br'].forEach((corner, ci) => { markers[corner] = numToBits(codes[si * 4 + ci]); });

    const entry = {
      name: sp.name,
      title: sp.title,
      markers,
      contourModel: model,
      bboxModel: bboxR,
      sheetTransform: st,
      eye: null,                       // capture.js не читает; у автора — глаз рыбы
      vein: veinModel,                 // наше поле: центральная жилка в модельных координатах (для сцены)
      rotate: sp.rotate,
      fit: sp.fit
    };
    fish.push(entry);

    // печатный контур — плотный (гладкие кривые), манифестный — прореженный
    const printPts = simplifyClosed(denseModel, 0.0003).map((p) => modelToMM(st, p));
    const veinMM = veinModel.map((p) => modelToMM(st, p));
    // жилку укорачиваем на 6 мм с концов, чтобы не упиралась в контур
    const vx = veinMM[1][0] - veinMM[0][0], vy = veinMM[1][1] - veinMM[0][1], vl = Math.hypot(vx, vy);
    const veinShort = vl > 20 ? [
      [veinMM[0][0] + vx / vl * 6, veinMM[0][1] + vy / vl * 6],
      [veinMM[1][0] - vx / vl * 6, veinMM[1][1] - vy / vl * 6]
    ] : null;
    const svg = sheetSvg({ ...sp, markers }, printPts, veinShort);
    fs.writeFileSync(path.join(OUT_DIR, sp.name + '.svg'), svg);
    svgs[sp.name] = svg;

    let note = '';
    if (size.width < MIN_SIZE_MM) {
      warnings++;
      let best = null;
      for (let a = 0; a <= 90; a += 5) {
        const s = leafSizeAt(dense, a, sp.fit);
        if (!best || s.width > best.width) best = { a, ...s };
      }
      note = `⚠ уже ${MIN_SIZE_MM} мм; лучший угол ${best.a}° → ${best.length.toFixed(0)}×${best.width.toFixed(0)} мм`;
    }
    rows.push([sp.name, sp.title, `${sp.rotate}°`, sp.fit, `${dense.length}→${model.length}`,
      `${size.length.toFixed(0)}×${size.width.toFixed(0)} мм`, `${size.boxW.toFixed(0)}×${size.boxH.toFixed(0)} мм`, note]);
  });

  const manifest = {
    version: 1,
    generator: 'tools/make-sheets.js',
    generatedAt: new Date().toISOString(),
    sheet: SHEET,
    fish                                   // имя поля диктует capture.js: для него это «виды»
  };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'sheets.js'),
    '/* Сгенерировано tools/make-sheets.js для tools/test-capture.html. Не редактировать. */\n' +
    'window.LEAF_SHEETS = ' + JSON.stringify({ manifest, svg: svgs }) + ';\n');

  const head = ['вид', 'подпись', 'поворот', 'fit', 'точек', 'лист Д×Ш', 'габарит', ''];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  console.log('\n' + line(head));
  rows.forEach((r) => console.log(line(r)));
  console.log(`\nЗаписано: ${OUT_DIR}/{${SPECIES.map((s) => s.name + '.svg').join(',')},manifest.json,sheets.js}`);
  if (warnings) console.log(`Предупреждений: ${warnings} — поправь rotate/fit в SPECIES или перерисуй контур шире.`);
}

main();
