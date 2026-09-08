// Земля: трава (плоскость с процедурной текстурой и крупнопятнистой раскраской
// по вершинам), дорожка (лента с гравием и мягкими краями), пучки травы у
// дорожки ближе к камере. Место под ковёр из листьев перед камерой пустое.
import * as THREE from 'three';
import type { Season } from './config';
import { rng, makeCanvas, canvasTexture, makeNoise2D, hexToRgb, mixRgb, smoothstep } from './util';

function grassTexture(g: Season['ground']): THREE.CanvasTexture {
  const size = 1024;
  const [canvas, ctx] = makeCanvas(size, size);
  const noise = makeNoise2D(21, 128);
  const img = ctx.createImageData(size, size);
  const dark = hexToRgb(g.grassDark), light = hexToRgb(g.grassLight), dry = hexToRgb(g.grassDry);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size * 128, v = y / size * 128;
      const blotch = noise.fbm(u * 0.06, v * 0.06, 4);                // крупные пятна
      const fine = noise.fbm(u * 0.9, v * 1.6, 3);                    // мелкая «щетина», вытянутая по y
      const grain = noise.noise(u * 6, v * 6);
      let c = mixRgb(dark, light, smoothstep(0.3, 0.75, fine * 0.7 + grain * 0.3));
      c = mixRgb(c, dry, smoothstep(0.55, 0.8, blotch) * 0.7);
      const shade = 0.9 + grain * 0.3;
      const o = (y * size + x) * 4;
      img.data[o] = Math.min(255, c[0] * shade); img.data[o + 1] = Math.min(255, c[1] * shade); img.data[o + 2] = Math.min(255, c[2] * shade); img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvasTexture(canvas);
}

function pathTexture(g: Season['ground']): THREE.CanvasTexture {
  const w = 512, h = 1024;
  const [canvas, ctx] = makeCanvas(w, h);
  const noise = makeNoise2D(33, 128);
  const img = ctx.createImageData(w, h);
  const light = hexToRgb(g.pathLight), dark = hexToRgb(g.pathDark);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w, v = y / h;
      const pebble = noise.noise(u * 140, v * 280);
      const patch = noise.fbm(u * 6, v * 12, 4);
      const wear = 1 - Math.abs(u - 0.5) * 2;                          // середина утоптана светлее
      let c = mixRgb(dark, light, smoothstep(0.25, 0.8, pebble * 0.55 + patch * 0.45 + wear * 0.15));
      const shade = 0.85 + noise.noise(u * 300, v * 600) * 0.25;
      // мягкие края дорожки — альфа
      const edge = smoothstep(0, 0.14, u) * smoothstep(1, 0.86, u);
      const ragged = 0.75 + 0.25 * noise.fbm(u * 3, v * 40, 3);
      const o = (y * w + x) * 4;
      img.data[o] = c[0] * shade; img.data[o + 1] = c[1] * shade; img.data[o + 2] = c[2] * shade;
      img.data[o + 3] = 255 * smoothstep(0.15, 0.6, edge * ragged);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = canvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  return tex;
}

function tuftTexture(g: Season['ground']): THREE.CanvasTexture {
  const w = 256, h = 256;
  const [canvas, ctx] = makeCanvas(w, h);
  const r = rng(9);
  const light = hexToRgb(g.grassLight), dry = hexToRgb(g.grassDry), dark = hexToRgb(g.grassDark);
  ctx.lineCap = 'round';
  // тонкие травинки веером из основания; на просвет — светлее к кончику
  for (let i = 0; i < 44; i++) {
    const x0 = w / 2 + (r() - 0.5) * 70, y0 = h - r() * 6;
    const spread = (r() - 0.5) * 1.3;
    const len = h * (0.35 + r() * 0.55);
    const x1 = x0 + Math.sin(spread) * len, y1 = y0 - Math.cos(spread) * len * (0.8 + r() * 0.2);
    const cx = x0 + Math.sin(spread) * len * 0.35, cy = y0 - len * 0.6;
    const base = mixRgb(mixRgb(dark, light, 0.3 + r() * 0.5), dry, r() * 0.6);
    const tip = mixRgb(base, [255, 240, 190], 0.45);
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, `rgb(${base[0] | 0},${base[1] | 0},${base[2] | 0})`);
    grad.addColorStop(1, `rgb(${tip[0] | 0},${tip[1] | 0},${tip[2] | 0})`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.6 + r() * 2.6;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(cx, cy, x1, y1);
    ctx.stroke();
  }
  const tex = canvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

export function makeGround(season: Season, maxAnisotropy: number): THREE.Group {
  const g = season.ground;
  const group = new THREE.Group();
  group.name = 'ground';

  // ── трава ──
  const size = 900, segs = 160;
  const grassGeo = new THREE.PlaneGeometry(size, size, segs, segs);
  grassGeo.rotateX(-Math.PI / 2);
  const noise = makeNoise2D(44, 256);
  const pos = grassGeo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const cDark = new THREE.Color(g.grassDark), cLight = new THREE.Color(g.grassLight), cDry = new THREE.Color(g.grassDry);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const n = noise.fbm(x * 0.02 + 50, z * 0.02 + 50, 4);
    const n2 = noise.fbm(x * 0.07, z * 0.07, 3);
    tmp.copy(cDark).lerp(cLight, smoothstep(0.35, 0.7, n)).lerp(cDry, smoothstep(0.55, 0.85, n2) * 0.6);
    // текстура уже несёт свой цвет — по вершинам задаём только его отклонение вокруг 1
    const k = 1.3;
    colors[i * 3] = tmp.r * k; colors[i * 3 + 1] = tmp.g * k; colors[i * 3 + 2] = tmp.b * k;
  }
  grassGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const grassTex = grassTexture(g);
  grassTex.repeat.set(size / 3.2, size / 3.2);
  grassTex.anisotropy = maxAnisotropy;
  const grass = new THREE.Mesh(grassGeo, new THREE.MeshStandardMaterial({
    map: grassTex, vertexColors: true, roughness: 1, metalness: 0, color: new THREE.Color(1.6, 1.6, 1.6)
  }));
  grass.receiveShadow = true;
  grass.matrixAutoUpdate = false;
  group.add(grass);

  // ── дорожка: лента вдоль z с плавным уводом влево ──
  const zs: number[] = [];
  for (let z = 4; z > -500; z -= z > -40 ? 1.5 : z > -150 ? 4 : 12) zs.push(z);
  const centerX = (z: number) => g.pathCurve * z * z;
  const verts: number[] = [], uvs: number[] = [], idx: number[] = [], normals: number[] = [];
  let along = 0;
  zs.forEach((z, i) => {
    const cx = centerX(z);
    const dx = (centerX(z - 1) - centerX(z + 1)) / 2;        // наклон центральной линии
    const nx = 1 / Math.hypot(1, dx), nz = dx / Math.hypot(1, dx);
    const hw = g.pathWidth / 2 * (1 + 0.06 * Math.sin(z * 0.15));
    verts.push(cx - nx * hw, 0, z - nz * hw, cx + nx * hw, 0, z + nz * hw);
    normals.push(0, 1, 0, 0, 1, 0);
    if (i > 0) along += Math.abs(zs[i - 1] - z);
    uvs.push(0, along / 4, 1, along / 4);
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  });
  const pathGeo = new THREE.BufferGeometry();
  pathGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  pathGeo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  pathGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  pathGeo.setIndex(idx);
  const pathTex = pathTexture(g);
  pathTex.anisotropy = maxAnisotropy;
  const path = new THREE.Mesh(pathGeo, new THREE.MeshStandardMaterial({
    map: pathTex, transparent: true, depthWrite: false, roughness: 1, metalness: 0
  }));
  path.position.y = 0.02;
  path.renderOrder = -1;
  path.receiveShadow = true;
  group.add(path);

  // ── пучки травы вдоль дорожки, плотнее ближе к камере ──
  const t = g.tufts;
  const r = rng(t.seed);
  const blade = new THREE.PlaneGeometry(0.5, 0.42);
  blade.translate(0, 0.2, 0);
  const cross = blade.clone().rotateY(Math.PI / 2);
  const tuftGeo = new THREE.BufferGeometry();
  {
    // сливаем два скрещённых квада вручную
    const p1 = blade.attributes.position.array, p2 = cross.attributes.position.array;
    const u1 = blade.attributes.uv.array, u2 = cross.attributes.uv.array;
    const n1 = blade.attributes.normal.array, n2 = cross.attributes.normal.array;
    tuftGeo.setAttribute('position', new THREE.Float32BufferAttribute([...p1, ...p2], 3));
    tuftGeo.setAttribute('uv', new THREE.Float32BufferAttribute([...u1, ...u2], 2));
    tuftGeo.setAttribute('normal', new THREE.Float32BufferAttribute([...n1, ...n2], 3));
    const i1 = Array.from(blade.index!.array), i2 = Array.from(cross.index!.array).map((v) => v + 4);
    tuftGeo.setIndex([...i1, ...i2]);
  }
  // без освещения: трава на просвет светится сама, а лит-материал делал бы её чёрной против солнца
  const tuftMat = new THREE.MeshBasicMaterial({
    map: tuftTexture(g), alphaTest: 0.2, alphaToCoverage: true, side: THREE.DoubleSide, fog: true
  });
  const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, t.count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < t.count; i++) {
    // ближе к камере — плотнее: квадратичное распределение по z
    const z = t.zFrom + (t.zTo - t.zFrom) * Math.pow(r(), 1.7);
    const side = r() < 0.5 ? -1 : 1;
    const off = g.pathWidth / 2 + 0.15 + Math.pow(r(), 1.3) * 12;
    p.set(centerX(z) + side * off, 0, z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * Math.PI);
    const sc = 0.6 + r() * 0.9;
    s.set(sc, sc * (0.8 + r() * 0.5), sc);
    m.compose(p, q, s);
    tufts.setMatrixAt(i, m);
    col.setRGB(0.75 + r() * 0.35, 0.75 + r() * 0.3, 0.6 + r() * 0.3);
    tufts.setColorAt(i, col);
  }
  tufts.receiveShadow = true;
  group.add(tufts);

  return group;
}
