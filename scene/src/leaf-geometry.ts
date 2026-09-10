// Геометрия листа (раздел 4.2): сетка N×N, обрезанная по контуру вида, с
// толщиной — лицо, изнанка и полоска торца по контуру. Геометрия плоская;
// форма покоя, сухость, изгиб под ветром и флаттер считаются в вершинном
// шейдере (leaf-material.ts) по атрибуту aux:
//   aux.x — расстояние до края (0 у края … 1 в глубине), нормировано
//   aux.y — поперечная координата от жилки, −1…1 (знак — сторона)
//   aux.z — положение вдоль жилки, 0 у черешка … 1 у кончика
//   aux.w — сторона: +1 лицо, −1 изнанка, 0 торец
import * as THREE from 'three';
import type { LeafShape } from './leaf-shapes';

export interface LeafGeometryOptions {
  segments?: number;      // сетка по длинной стороне
  thickness?: number;     // толщина в единицах листа (длинная сторона = 1)
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

export function buildLeafGeometry(shape: LeafShape, opts: LeafGeometryOptions = {}): THREE.BufferGeometry {
  const N = opts.segments ?? 24;
  const thick = opts.thickness ?? 0.004;
  const { bbox, contour, vein } = shape;
  const w = bbox.x1 - bbox.x0, h = bbox.y1 - bbox.y0;
  const long = Math.max(w, h);
  const nx = Math.max(4, Math.round(N * w / long)), ny = Math.max(4, Math.round(N * h / long));

  // система жилки
  const vb = vein[0], vt = vein[1];
  const ax = vt[0] - vb[0], ay = vt[1] - vb[1];
  const vl = Math.hypot(ax, ay) || 1;
  const ux = ax / vl, uy = ay / vl;                       // вдоль жилки
  const px = -uy, py = ux;                                 // поперёк
  let maxLat = 0;
  for (const c of contour) maxLat = Math.max(maxLat, Math.abs((c[0] - vb[0]) * px + (c[1] - vb[1]) * py));
  const maxEdge = maxLat * 0.9;                           // нормировка глубины

  const aux = (p: P, edgeD: number, side: number): [number, number, number, number] => {
    const rx = p[0] - vb[0], ry = p[1] - vb[1];
    const t = Math.max(0, Math.min(1, (rx * ux + ry * uy) / vl));
    const s = Math.max(-1, Math.min(1, (rx * px + ry * py) / maxLat));
    return [Math.min(1, edgeD / maxEdge), s, t, side];
  };

  // ── сетка лица ──
  const gridPos: P[] = [], gridIn: boolean[] = [], gridEdge: number[] = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const p: P = [bbox.x0 + w * i / nx, bbox.y0 + h * j / ny];
      const inside = pointInPolygon(p, contour);
      const near = nearestOnPolygon(p, contour);
      // вершины снаружи прижимаем к контуру — край получается ровный
      gridPos.push(inside ? p : near.q);
      gridIn.push(inside);
      gridEdge.push(inside ? near.d : 0);
    }
  }
  const idx = (i: number, j: number) => j * (nx + 1) + i;
  const tris: [number, number, number][] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = idx(i, j), b = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1);
      for (const t of [[a, b, c], [a, c, d]] as [number, number, number][]) {
        const ins = t.filter((v) => gridIn[v]).length;
        if (ins === 0) continue;
        const p0 = gridPos[t[0]], p1 = gridPos[t[1]], p2 = gridPos[t[2]];
        const area = Math.abs((p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]));
        if (area < 1e-7) continue;
        tris.push(t);
      }
    }
  }
  const used = new Map<number, number>();
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

  // лицо
  for (const t of tris) for (const v of t) {
    if (!used.has(v)) used.set(v, pushVertex(gridPos[v], thick / 2, [0, 0, 1], aux(gridPos[v], gridEdge[v], 1)));
  }
  for (const t of tris) indices.push(used.get(t[0])!, used.get(t[1])!, used.get(t[2])!);
  // изнанка — те же точки, обратный обход
  const usedBack = new Map<number, number>();
  for (const t of tris) for (const v of t) {
    if (!usedBack.has(v)) usedBack.set(v, pushVertex(gridPos[v], -thick / 2, [0, 0, -1], aux(gridPos[v], gridEdge[v], -1)));
  }
  for (const t of tris) indices.push(usedBack.get(t[0])!, usedBack.get(t[2])!, usedBack.get(t[1])!);
  // торец по контуру
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i], b = contour[(i + 1) % contour.length];
    const ex = b[0] - a[0], ey = b[1] - a[1], el = Math.hypot(ex, ey) || 1;
    const n: [number, number, number] = [ey / el, -ex / el, 0];       // наружу (контур по часовой)
    const a0 = pushVertex(a, thick / 2, n, aux(a, 0, 0));
    const a1 = pushVertex(a, -thick / 2, n, aux(a, 0, 0));
    const b0 = pushVertex(b, thick / 2, n, aux(b, 0, 0));
    const b1 = pushVertex(b, -thick / 2, n, aux(b, 0, 0));
    indices.push(a0, b0, b1, a0, b1, a1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aux', new THREE.Float32BufferAttribute(auxs, 4));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  // ориентация торца: проверяем обход контура по площади со знаком, при обратном — переворачиваем нормали торца
  let area = 0;
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i], b = contour[(i + 1) % contour.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (area > 0) {                                        // против часовой — нормали торца смотрят внутрь
    const n = geo.attributes.normal as THREE.BufferAttribute;
    const auxA = geo.attributes.aux as THREE.BufferAttribute;
    for (let i = 0; i < n.count; i++) if (auxA.getW(i) === 0) n.setXY(i, -n.getX(i), -n.getY(i));
  }
  return geo;
}
