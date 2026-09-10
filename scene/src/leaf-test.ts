// Тестовая страница (leaf.html): один лист крупным планом, вращается, солнце
// сзади-сбоку для просвета, ползунки — вид, вариант, сухость, изгиб, флаттер,
// кручение, просвет. Здесь оцениваем объём листа глазами (раздел 4.2).
import * as THREE from 'three';
import { season } from './config';
import { LEAF_SHAPES, LEAF_KINDS } from './leaf-shapes';
import { paintLeafAtlas, atlasFromImage, type LeafAtlas } from './leaf-textures';
import { LeafBatch } from './leaves';
import { makeLighting } from './lighting';
import { makeDevOverlay } from './dev';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const devEl = document.getElementById('dev') as HTMLElement;
const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = season.exposure;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.info.autoReset = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#9fb8d0');
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 50);
camera.position.set(0, 0.15, 1.15);
camera.lookAt(0, 0, 0);

const lighting = makeLighting(season);
scene.add(lighting.group);
// солнце для теста — ближе, чтобы тень-камера точно накрывала лист
lighting.sun.position.copy(lighting.sunDir).multiplyScalar(6);
lighting.sun.target.position.set(0, 0, 0);
lighting.sun.shadow.camera.left = -1; lighting.sun.shadow.camera.right = 1;
lighting.sun.shadow.camera.top = 1; lighting.sun.shadow.camera.bottom = -1;
lighting.sun.shadow.camera.near = 1; lighting.sun.shadow.camera.far = 12;

// подставка, чтобы видеть тень
const floor = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshStandardMaterial({ color: '#b39a72', roughness: 1 }));
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.35;
floor.receiveShadow = true;
scene.add(floor);

const kindSel = $('kind') as unknown as HTMLSelectElement;
for (const k of LEAF_KINDS) {
  const o = document.createElement('option');
  o.value = k; o.textContent = LEAF_SHAPES[k].title;
  kindSel.appendChild(o);
}

let batch: LeafBatch | null = null;
const flags = new URLSearchParams(location.search);
let kind = flags.get('kind') && LEAF_SHAPES[flags.get('kind')!] ? flags.get('kind')! : 'maple';
kindSel.value = kind;
const texSel = $('tex') as unknown as HTMLSelectElement;
const sunSel = $('sun') as unknown as HTMLSelectElement;
if (flags.get('tex')) texSel.value = flags.get('tex')!;
if (flags.get('sun')) sunSel.value = flags.get('sun')!;

// солнце относительно камеры (камера на +z смотрит в начало координат)
const SUN_DIRS: Record<string, THREE.Vector3> = {
  front: new THREE.Vector3(0.35, 0.5, 1),        // из-за камеры: лист освещён в лоб
  side: new THREE.Vector3(1, 0.35, 0.15),        // сбоку слева
  back: new THREE.Vector3(-0.25, 0.3, -1)        // из-за листа: проверка просвета
};
function applySun() {
  const d = (SUN_DIRS[sunSel.value] ?? SUN_DIRS.front).clone().normalize();
  lighting.sun.position.copy(d).multiplyScalar(6);
  lighting.sun.target.position.set(0, 0, 0);
  lighting.sun.target.updateMatrixWorld();
}
sunSel.addEventListener('change', applySun);

const testTextures: Record<string, HTMLImageElement> = {};
async function loadTestTexture(k: string): Promise<HTMLImageElement | null> {
  if (testTextures[k]) return testTextures[k];
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => { testTextures[k] = im; resolve(im); };
    im.onerror = () => resolve(null);
    im.src = import.meta.env.BASE_URL + 'test-leaves/' + k + '.png';
  });
}

async function rebuild() {
  const shape = LEAF_SHAPES[kind];
  const sp = season.leaves.species[kind as keyof typeof season.leaves.species];
  const sizeMm = season.leaves.baseSize * sp.size * 1000;
  let atlas: LeafAtlas;
  if (texSel.value === 'test') {
    const img = await loadTestTexture(kind);
    if (!img) { devEl.hidden = false; devEl.textContent = 'нет public/test-leaves/' + kind + '.png — сними через tools/test-capture.html'; texSel.value = 'paint'; }
    atlas = img ? atlasFromImage(img, shape, sizeMm) : paintLeafAtlas(shape, sp.palettes, 77, sizeMm);
  } else {
    atlas = paintLeafAtlas(shape, sp.palettes, 77, sizeMm);
  }
  if (batch) { scene.remove(batch.mesh); batch.mesh.geometry.dispose(); batch.material.dispose(); }
  batch = new LeafBatch(shape, atlas, sp.profile, 1, { size: 0.6, translucency: Number($('trans').value) });
  ($('variant')).max = String(atlas.variants - 1);
  if (Number($('variant').value) >= atlas.variants) $('variant').value = '0';
  scene.add(batch.mesh);
  apply();
}
texSel.addEventListener('change', () => { void rebuild(); });

const matrix = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(0, 0, 0), one = new THREE.Vector3(1, 1, 1);
let angle = 0;

function apply() {
  if (!batch) return;
  batch.material.leafUniforms.translucency.value = Number($('trans').value);
  batch.set(0, {
    matrix, dry: Number($('dry').value), twist: Number($('twist').value), flutter: Number($('flutter').value), phase: 0,
    bend: new THREE.Vector3(0, 1, Number($('bend').value)), variant: Number($('variant').value)
  });
  batch.commit();
  for (const id of ['variant', 'dry', 'bend', 'flutter', 'twist', 'trans', 'spin']) {
    const v = $(id).value;
    document.getElementById(id + '-v')!.textContent = id === 'variant' ? v : Number(v).toFixed(2);
  }
}

for (const id of ['variant', 'dry', 'bend', 'flutter', 'twist', 'trans', 'spin']) $(id).addEventListener('input', apply);
kindSel.addEventListener('change', () => { kind = kindSel.value; void rebuild(); });

const resize = () => {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
};
window.addEventListener('resize', resize);
resize();
applySun();
void rebuild();

const dev = makeDevOverlay(devEl);
const timer = new THREE.Timer();
let time = 0;
function frame(dt: number) {
  time += dt;
  angle += dt * Number($('spin').value) * 1.2;
  // медленный кувырок: вращение вокруг наклонённой оси
  q.setFromEuler(new THREE.Euler(Math.sin(angle * 0.7) * 0.5, angle, Math.cos(angle * 0.5) * 0.3));
  matrix.compose(pos, q, one);
  if (batch) {
    batch.set(0, {
      matrix, dry: Number($('dry').value), twist: Number($('twist').value), flutter: Number($('flutter').value), phase: 0,
      bend: new THREE.Vector3(0, 1, Number($('bend').value)), variant: Number($('variant').value)
    });
    batch.commit();
    batch.update(time);
  }
  renderer.info.reset();
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(() => {
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.1);
  const t0 = performance.now();
  frame(dt);
  dev.frame(renderer, performance.now() - t0);
});
(window as unknown as { leafTest: unknown }).leafTest = { renderer, scene, camera, renderOnce: () => frame(0), setAngle: (a: number) => { angle = a; } };
