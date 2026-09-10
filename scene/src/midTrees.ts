// Средний план: деревья с проработанными ветвями, входящими в кадр сверху.
// Ствол за краем кадра, от него в кадр тянутся крупные сучья, которые
// рекурсивно ветвятся до тонких веточек. Геометрия — сужающиеся цилиндры,
// слитые в один меш на дерево (один draw call, тени).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Season } from './config';
import { rng, makeCanvas, canvasTexture, makeNoise2D, hexToRgb, mixRgb, lerp } from './util';

interface Seg { a: THREE.Vector3; b: THREE.Vector3; ra: number; rb: number }

/** Конец тонкой веточки — точка, куда вешается лист. */
export interface TwigTip { pos: THREE.Vector3; dir: THREE.Vector3 }

type TreeCfg = Season['midTrees']['trees'][number];

const UP = new THREE.Vector3(0, 1, 0);

/** Случайный перпендикуляр к вектору d. */
function perp(d: THREE.Vector3, r: () => number): THREE.Vector3 {
  const helper = Math.abs(d.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0);
  const p1 = new THREE.Vector3().crossVectors(d, helper).normalize();
  const p2 = new THREE.Vector3().crossVectors(d, p1).normalize();
  const a = r() * Math.PI * 2;
  return p1.multiplyScalar(Math.cos(a)).addScaledVector(p2, Math.sin(a)).normalize();
}

function grow(segs: Seg[], pos: THREE.Vector3, dir: THREE.Vector3, len: number, radius: number, depth: number, maxDepth: number, r: () => number) {
  const parts = 4;
  const twig = depth >= maxDepth - 1;
  const endRadius = depth >= maxDepth ? 0.004 : radius * (twig ? 0.5 : 0.66 + r() * 0.08);
  let p = pos.clone();
  const d = dir.clone().normalize();
  // ветка гнётся дугой в одну сторону, а не дрожит случайно
  const bendAxis = perp(d, r);
  const bend = (0.08 + r() * 0.14) * (r() < 0.5 ? 1 : -1);
  const droop = radius < 0.02 ? 0.22 : radius < 0.06 ? 0.1 : radius < 0.12 ? 0.02 : -0.05;
  const sideAt = Math.floor(r() * (parts - 1));
  for (let i = 0; i < parts; i++) {
    d.applyAxisAngle(bendAxis, bend).addScaledVector(UP, -droop / parts).normalize();
    const q = p.clone().addScaledVector(d, len / parts);
    segs.push({ a: p, b: q, ra: lerp(radius, endRadius, i / parts), rb: lerp(radius, endRadius, (i + 1) / parts) });
    // одна боковая ветка на сук (в случайном месте), иначе ветвление растёт экспоненциально
    const pSide = depth < 2 ? 0.7 : 0.6;
    if (depth < maxDepth && i === sideAt && r() < pSide) {
      const side = d.clone().applyAxisAngle(perp(d, r), 0.55 + r() * 0.55);
      if (depth < 2) side.y += 0.25;                       // крупные боковые тянутся вверх
      grow(segs, q, side.normalize(), len * (0.4 + r() * 0.2), lerp(radius, endRadius, (i + 1) / parts) * 0.55, depth + 1, maxDepth, r);
    }
    p = q;
  }
  if (depth >= maxDepth) return;
  const n = twig ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const angle = twig ? 0.3 + r() * 0.5 : 0.3 + r() * 0.4;
    const axis = perp(d, r);
    const cd = d.clone().applyAxisAngle(axis, angle * (i % 2 === 0 ? 1 : -1));
    if (i === 0) cd.lerp(d, 0.5).normalize();           // одна ветка продолжает сук
    grow(segs, p, cd, len * (twig ? 0.55 : 0.64 + r() * 0.14), endRadius * (0.85 + r() * 0.12), depth + 1, maxDepth, r);
  }
}

function buildTree(cfg: TreeCfg, tips: TwigTip[]): THREE.BufferGeometry {
  const r = rng(cfg.seed);
  const segs: Seg[] = [];
  const base = new THREE.Vector3(...(cfg.base as [number, number, number]));
  const top = base.clone().add(new THREE.Vector3(cfg.lean[0], cfg.trunkHeight, cfg.lean[1]));

  // ствол — цепочка сужающихся отрезков (в кадре обычно не виден)
  const trunkParts = 5;
  for (let i = 0; i < trunkParts; i++) {
    const a = base.clone().lerp(top, i / trunkParts), b = base.clone().lerp(top, (i + 1) / trunkParts);
    a.x += (r() - 0.5) * 0.1; b.x += (r() - 0.5) * 0.1;
    segs.push({ a, b, ra: lerp(0.42, 0.14, i / trunkParts), rb: lerp(0.42, 0.14, (i + 1) / trunkParts) });
  }
  for (const limb of cfg.limbs) {
    const start = base.clone().lerp(top, limb.at);
    const dir = new THREE.Vector3(...(limb.dir as [number, number, number])).normalize();
    grow(segs, start, dir, limb.length, limb.radius, 0, 6, r);
  }

  for (const s of segs) {
    if (s.rb <= 0.005) tips.push({ pos: s.b.clone(), dir: s.b.clone().sub(s.a).normalize() });
  }
  const geos: THREE.BufferGeometry[] = [];
  const dir = new THREE.Vector3(), mid = new THREE.Vector3(), quat = new THREE.Quaternion();
  for (const s of segs) {
    dir.subVectors(s.b, s.a);
    const len = dir.length();
    if (len < 1e-4) continue;
    dir.divideScalar(len);
    const radial = s.ra > 0.12 ? 12 : s.ra > 0.05 ? 8 : s.ra > 0.015 ? 6 : 4;
    const g = new THREE.CylinderGeometry(s.rb, s.ra, len * 1.04, radial, 1, false);
    // uv по длине — в метрах, чтобы кора не растягивалась
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.max(1, Math.round(s.ra * 2 * Math.PI / 0.3)), uv.getY(i) * len / 0.3);
    quat.setFromUnitVectors(UP, dir);
    g.applyQuaternion(quat);
    mid.addVectors(s.a, s.b).multiplyScalar(0.5);
    g.translate(mid.x, mid.y, mid.z);
    geos.push(g);
  }
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  return merged!;
}

function makeBarkTexture(dark: string, light: string): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const size = 512;
  const [canvas, ctx] = makeCanvas(size, size);
  const [bcanvas, bctx] = makeCanvas(size, size);
  const noise = makeNoise2D(5, 64);
  const img = ctx.createImageData(size, size), bimg = bctx.createImageData(size, size);
  const cd = hexToRgb(dark), cl = hexToRgb(light);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // вертикальные борозды: шум сильно растянут по y
      const n1 = noise.fbm(x / size * 24, y / size * 3, 4);
      const n2 = noise.fbm(x / size * 90 + 7, y / size * 12 + 3, 3);
      const v = Math.pow(Math.min(1, Math.max(0, n1 * 0.8 + n2 * 0.4 - 0.15)), 1.3);
      const c = mixRgb(cd, cl, v);
      const o = (y * size + x) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
      const b = v * 255;
      bimg.data[o] = bimg.data[o + 1] = bimg.data[o + 2] = b; bimg.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  bctx.putImageData(bimg, 0, 0);
  const map = canvasTexture(canvas);
  const bump = canvasTexture(bcanvas, false);
  return { map, bump };
}

export function makeMidTrees(season: Season): { group: THREE.Group; tips: TwigTip[] } {
  const group = new THREE.Group();
  group.name = 'midTrees';
  const tips: TwigTip[] = [];
  const { map, bump } = makeBarkTexture(season.midTrees.bark, season.midTrees.barkLight);
  const material = new THREE.MeshStandardMaterial({
    map, bumpMap: bump, bumpScale: 0.6, roughness: 0.92, metalness: 0
  });
  for (const cfg of season.midTrees.trees) {
    const mesh = new THREE.Mesh(buildTree(cfg, tips), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
  }
  return { group, tips };
}
