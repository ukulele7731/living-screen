// Геометрия листа (раздел 4.2): сетка N×N, обрезанная по контуру вида, с
// толщиной — лицо, изнанка и полоска торца по контуру. По краю сетка вдвое
// плотнее: клетки, через которые проходит контур, делятся на четыре, соседние
// внутренние клетки достраиваются веером от центра (без щелей). Вершины
// снаружи контура прижимаются к нему — край ровный.
//
// Геометрия плоская; форма покоя, сухость, изгиб под ветром, флаттер и
// гладкие нормали считаются в вершинном шейдере (leaf-material.ts) по
// координатам жилки. Атрибут aux:
//   aux.x — расстояние до края (0 у края … 1 в глубине), нормировано
//   aux.y — поперечная координата от жилки, −1…1 (знак — сторона)
//   aux.z — положение вдоль жилки, 0 у черешка … 1 у кончика
//   aux.w — сторона: +1 лицо, −1 изнанка, 0 торец
import * as THREE from 'three';
import type { LeafShape } from './leaf-shapes';

export interface LeafGeometryOptions {
  segments?: number;      // сетка по длинной стороне (в центре); по краю — вдвое плотнее
  thickness?: number;     // толщина в единицах листа (длинная сторона = 1)
  noRim?: boolean;        // без торца — для дальних уровней детализации (толщина всё равно не видна)
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

/** Ближайшая точка контура и расстояние до неё. */
function nearestOnPolygon(p: P, poly: P[]): { q: P; d: number } {
  let best = Infinity, bq: P = poly[0];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy || 1e-12;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
    const qx = a[0] + dx * t, qy = a[1] + dy * t;
    const d = Math.hypot(p[0] - qx, p[1] - qy);
    if (d < best) { best = d; bq = [qx, qy]; }
  }
  return { q: bq, d: best };
}

/** Система координат жилки листа — та же, что в шейдере. */
export function veinFrame(shape: LeafShape) {
  const vb = shape.vein[0], vt = shape.vein[1];
  const ax = vt[0] - vb[0], ay = vt[1] - vb[1];
  const len = Math.hypot(ax, ay) || 1;
  const ux = ax / len, uy = ay / len;
  let maxLat = 0;
  for (const c of shape.contour) maxLat = Math.max(maxLat, Math.abs((c[0] - vb[0]) * -uy + (c[1] - vb[1]) * ux));
  return { base: [vb[0], vb[1]] as P, dir: [ux, uy] as P, len, maxLat };
}

export function buildLeafGeometry(shape: LeafShape, opts: LeafGeometryOptions = {}): THREE.BufferGeometry {
  const N = opts.segments ?? 24;
  const thick = opts.thickness ?? 0.004;
  const { bbox } = shape;
  const contour = opts.noRim ? [] as P[] : shape.contour;
  const clipContour = shape.contour;
  const w = bbox.x1 - bbox.x0, h = bbox.y1 - bbox.y0;
  const long = Math.max(w, h);
  const nx = Math.max(4, Math.round(N * w / long)), ny = Math.max(4, Math.round(N * h / long));
  const cw = w / nx, ch = h / ny;

  const frame = veinFrame(shape);
  const [ux, uy] = frame.dir, px = -uy, py = ux;
  const maxEdge = frame.maxLat * 0.9;
  const aux = (p: P, edgeD: number, side: number): [number, number, number, number] => {
    const rx = p[0] - frame.base[0], ry = p[1] - frame.base[1];
    const t = Math.max(0, Math.min(1, (rx * ux + ry * uy) / frame.len));
    const s = Math.max(-1, Math.min(1, (rx * px + ry * py) / frame.maxLat));
    return [Math.min(1, edgeD / maxEdge), s, t, side];
  };

  // ── вершины сетки: углы, середины рёбер, центры клеток — по требованию ──
  interface V { p: P; inside: boolean; edge: number }
  const verts = new Map<string, V>();
  const vertex = (key: string, raw: P): V => {
    let v = verts.get(key);
    if (!v) {
      const inside = pointInPolygon(raw, clipContour);
      const near = nearestOnPolygon(raw, clipContour);
      v = { p: inside ? raw : near.q, inside, edge: inside ? near.d : 0 };
      verts.set(key, v);
    }
    return v;
  };
  const cornerRaw = (i: number, j: number): P => [bbox.x0 + cw * i, bbox.y0 + ch * j];
  const corner = (i: number, j: number) => vertex(`c${i},${j}`, cornerRaw(i, j));
  const midH = (i: number, j: number) => vertex(`h${i},${j}`, [bbox.x0 + cw * (i + 0.5), bbox.y0 + ch * j]);   // ребро (i,j)-(i+1,j)
  const midV = (i: number, j: number) => vertex(`v${i},${j}`, [bbox.x0 + cw * i, bbox.y0 + ch * (j + 0.5)]);   // ребро (i,j)-(i,j+1)
  const center = (i: number, j: number) => vertex(`x${i},${j}`, [bbox.x0 + cw * (i + 0.5), bbox.y0 + ch * (j + 0.5)]);

  const cornersInside = (i: number, j: number) =>
    [corner(i, j), corner(i + 1, j), corner(i + 1, j + 1), corner(i, j + 1)].filter((v) => v.inside).length;
  const isBoundary = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= nx || j >= ny) return false;
    const n = cornersInside(i, j);
    if (n > 0 && n < 4) return true;
    // контур может пересекать клетку, не задев углы (узкий выступ): проверяем центр
    if (n === 4) return !center(i, j).inside;
    return false;
  };

  const tris: [V, V, V][] = [];
  const pushTri = (a: V, b: V, c: V) => {
    if (!a.inside && !b.inside && !c.inside) return;
    const area = (b.p[0] - a.p[0]) * (c.p[1] - a.p[1]) - (c.p[0] - a.p[0]) * (b.p[1] - a.p[1]);
    if (Math.abs(area) < 1e-8) return;
    tris.push(area > 0 ? [a, b, c] : [a, c, b]);
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const n = cornersInside(i, j);
      const boundary = isBoundary(i, j);
      if (n === 0 && !boundary) continue;
      // рёбра клетки уточнены, если сама клетка или сосед через ребро — граничные
      const rB = boundary || isBoundary(i, j - 1), rR = boundary || isBoundary(i + 1, j);
      const rT = boundary || isBoundary(i, j + 1), rL = boundary || isBoundary(i - 1, j);
      const c00 = corner(i, j), c10 = corner(i + 1, j), c11 = corner(i + 1, j + 1), c01 = corner(i, j + 1);
      if (!rB && !rR && !rT && !rL) {
        pushTri(c00, c10, c11);
        pushTri(c00, c11, c01);
        continue;
      }
      const ring: V[] = [c00];
      if (rB) ring.push(midH(i, j));
      ring.push(c10);
      if (rR) ring.push(midV(i + 1, j));
      ring.push(c11);
      if (rT) ring.push(midH(i, j + 1));
      ring.push(c01);
      if (rL) ring.push(midV(i, j));
      const cc = center(i, j);
      for (let k = 0; k < ring.length; k++) pushTri(cc, ring[k], ring[(k + 1) % ring.length]);
    }
  }

  // ── буферы: лицо, изнанка, торец ──
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], auxs: number[] = [];
  const indices: number[] = [];
  const uvOf = (p: P): [number, number] => [(p[0] - bbox.x0) / w, (p[1] - bbox.y0) / h];
  const pushVertex = (p: P, z: number, n: [number, number, number], a: [number, number, number, number]) => {
    positions.push(p[0], p[1], z);
    normals.push(...n);
    const uv = uvOf(p);
    uvs.push(uv[0], uv[1]);
    auxs.push(...a);
    return positions.length / 3 - 1;
  };
  const front = new Map<V, number>(), back = new Map<V, number>();
  for (const t of tris) for (const v of t) {
    if (!front.has(v)) front.set(v, pushVertex(v.p, thick / 2, [0, 0, 1], aux(v.p, v.edge, 1)));
  }
  for (const t of tris) indices.push(front.get(t[0])!, front.get(t[1])!, front.get(t[2])!);
  for (const t of tris) for (const v of t) {
    if (!back.has(v)) back.set(v, pushVertex(v.p, -thick / 2, [0, 0, -1], aux(v.p, v.edge, -1)));
  }
  for (const t of tris) indices.push(back.get(t[0])!, back.get(t[2])!, back.get(t[1])!);

  // торец: контур по часовой (площадь со знаком < 0) → нормаль наружу = (ey, −ex)
  let area = 0;
    for (let i = 0; i < contour.length; i++) {
    const a = contour[i], b = contour[(i + 1) % contour.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sign = area < 0 ? 1 : -1;
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i], b = contour[(i + 1) % contour.length];
    const ex = b[0] - a[0], ey = b[1] - a[1], el = Math.hypot(ex, ey) || 1;
    const n: [number, number, number] = [sign * ey / el, -sign * ex / el, 0];
    const a0 = pushVertex(a, thick / 2, n, aux(a, 0, 0));
    const a1 = pushVertex(a, -thick / 2, n, aux(a, 0, 0));
    const b0 = pushVertex(b, thick / 2, n, aux(b, 0, 0));
    const b1 = pushVertex(b, -thick / 2, n, aux(b, 0, 0));
    if (sign > 0) indices.push(a0, b0, b1, a0, b1, a1); else indices.push(a0, b1, b0, a0, a1, b1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aux', new THREE.Float32BufferAttribute(auxs, 4));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}
