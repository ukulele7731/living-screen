// Дальний план: силуэты голых деревьев на билбордах. Силуэты рисуются на canvas
// рекурсивным ветвлением (сужающиеся штрихи до тонких веточек), цвет и дымка
// делают их почти монохромными. Аллея — два ряда вдоль дорожки.
import * as THREE from 'three';
import type { Season } from './config';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng, makeCanvas, canvasTexture } from './util';

function drawSilhouette(seed: number, size: number): HTMLCanvasElement {
  const [canvas, ctx] = makeCanvas(size, size);
  const r = rng(seed);
  ctx.strokeStyle = '#000';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const branch = (x: number, y: number, angle: number, len: number, width: number, depth: number) => {
    const ex = x + Math.sin(angle) * len, ey = y - Math.cos(angle) * len;
    const cx = (x + ex) / 2 + (r() - 0.5) * len * 0.35, cy = (y + ey) / 2 + (r() - 0.5) * len * 0.2;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(cx, cy, ex, ey);
    ctx.stroke();
    if (depth >= 11 || width < 0.35 || len < 2.5) return;
    const n = depth < 3 ? 3 : r() < 0.55 ? 2 : 3;
    const spread = depth < 2 ? 0.5 : 0.58;
    for (let i = 0; i < n; i++) {
      let a = angle + (i - (n - 1) / 2) * spread + (r() - 0.5) * 0.4;
      a *= 0.88;                                      // тянемся вверх
      branch(ex, ey, a, len * (0.66 + r() * 0.16), width * (0.64 + r() * 0.1), depth + 1);
    }
    // боковые веточки по длине — дают «щётку» тонких веток
    if (depth >= 1 && r() < 0.8) {
      const t = 0.35 + r() * 0.4;
      const px = x + (ex - x) * t, py = y + (ey - y) * t;
      const a = angle + (r() < 0.5 ? -1 : 1) * (0.6 + r() * 0.6);
      branch(px, py, a, len * 0.5, width * 0.45, depth + 2);
    }
  };

  const trunkLen = size * (0.19 + r() * 0.05);
  branch(size / 2, size * 0.985, (r() - 0.5) * 0.12, trunkLen, size * 0.03, 0);
  return canvas;
}

export function makeFarTrees(season: Season): THREE.Group {
  const cfg = season.farTrees;
  const group = new THREE.Group();
  group.name = 'farTrees';

  const variants = 6;
  const materials: THREE.MeshBasicMaterial[] = [];
  for (let i = 0; i < variants; i++) {
    const tex = canvasTexture(drawSilhouette(100 + i * 13, 1024));
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    // alpha-to-coverage + MSAA: мягкие края без сортировки прозрачности, глубина пишется
    materials.push(new THREE.MeshBasicMaterial({
      map: tex, alphaToCoverage: true, color: new THREE.Color(cfg.color), fog: true
    }));
  }
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.translate(0, 0.5, 0);                            // якорь — у корня
  const byVariant: THREE.BufferGeometry[][] = materials.map(() => []);
  const mat = new THREE.Matrix4();

  const place = (x: number, z: number, h: number, r: () => number) => {
    const v = Math.floor(r() * variants);
    const flip = r() < 0.5 ? -1 : 1;                    // зеркалим для разнообразия
    mat.makeScale(h * flip, h, 1).setPosition(x, -0.05, z);
    byVariant[v].push(geo.clone().applyMatrix4(mat));
  };

  // аллея вдоль дорожки; x берётся из кривизны дорожки, чтобы ряды шли вдоль неё
  const r = rng(cfg.scatter.seed);
  const curve = season.ground.pathCurve;
  const halfW = season.ground.pathWidth / 2;
  for (let z = cfg.alley.from; z > cfg.alley.to; z -= cfg.alley.step) {
    const cx = curve * z * z;
    const h = cfg.alley.height[0] + r() * (cfg.alley.height[1] - cfg.alley.height[0]);
    place(cx - halfW - cfg.alley.offset - r() * 1.5, z + (r() - 0.5) * 3, h, r);
    place(cx + halfW + cfg.alley.offset + r() * 1.5, z + (r() - 0.5) * 3, h * (0.9 + r() * 0.2), r);
  }
  // разбросанные деревья парка за аллеей
  const sc = cfg.scatter;
  for (let i = 0; i < sc.count; i++) {
    const z = sc.zFrom + r() * (sc.zTo - sc.zFrom);
    const side = r() < 0.5 ? -1 : 1;
    const x = side * (sc.xFrom + r() * (sc.xTo - sc.xFrom)) + curve * z * z;
    const h = sc.height[0] + r() * (sc.height[1] - sc.height[0]);
    place(x, z, h, r);
  }
  // один меш на вариант силуэта — 6 draw calls вместо ~80
  byVariant.forEach((list, v) => {
    if (!list.length) return;
    const merged = mergeGeometries(list, false)!;
    list.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(merged, materials[v]);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    group.add(mesh);
  });
  return group;
}
