// Сборка сцены: задник-картина, поверх — 3D-слой (свет, ветка среднего плана,
// невидимая земля для теней), композит с живыми облаками, resize, цикл кадров.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { season } from './config';
import { makeLighting } from './lighting';
import { makeMidTrees } from './midTrees';
import { makeBranchLeaves } from './branch-leaves';
import { makeTestLeaf } from './test-leaf';
import { Wind } from './wind';
import { LeafField } from './leaf-field';
import { makeOccluders } from './occluders';
import { makeDevPanel } from './dev-panel';
import { makeGround } from './ground';
import { loadBackdrop } from './backdrop';
import { makeComposite } from './composite';
import { makeDevOverlay } from './dev';

export interface LivingScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Юниформы финального композита — для отладки из консоли. */
  composite: Record<string, THREE.IUniform>;
  wind: Wind;
  field: LeafField;
  /** Прогнать физику на dt секунд без рендера (автотесты). */
  simulate(seconds: number, step?: number): void;
  /** Отрисовать один кадр вручную (для скриншотов и тестов). */
  renderOnce(): void;
  start(): void;
}

export async function createScene(canvas: HTMLCanvasElement, devEl: HTMLElement): Promise<LivingScene> {
  const flags = new URLSearchParams(location.search);   // отладка: ?shadow=0&clouds=0

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = season.exposure;
  renderer.shadowMap.enabled = flags.get('shadow') !== '0';
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(0x000000, 0);                   // 3D-слой рендерится на прозрачном
  renderer.info.autoReset = false;

  const backdrop = await loadBackdrop(season, import.meta.env.BASE_URL);

  const scene = new THREE.Scene();

  // Камера: горизонтально на уровне глаз, с наклоном вниз, чтобы её горизонт
  // совпал с горизонтом картины (доля высоты кадра `backdrop.horizon`).
  const cam = season.camera;
  const camera = new THREE.PerspectiveCamera(cam.fov, 1, cam.near, cam.far);
  camera.position.set(0, cam.height, 0);
  // горизонт ниже центра кадра → камера смотрит чуть вверх (pitch > 0)
  const pitch = Math.atan((season.backdrop.horizon - 0.5) * 2 * Math.tan(cam.fov / 2 * Math.PI / 180));
  camera.rotation.set(pitch, 0, 0);

  const lighting = makeLighting(season);
  scene.add(lighting.group);
  // Ветка среднего плана и листва на ней отложены (midTrees.enabled): код остаётся, в сцену не попадает.
  const updaters: ((time: number) => void)[] = [];
  if (season.midTrees.enabled) {
    const trees = makeMidTrees(season);
    scene.add(trees.group);
    const branchLeaves = makeBranchLeaves(season, trees.tips);
    for (const b of branchLeaves.batches) scene.add(b.mesh);
    updaters.push((t) => branchLeaves.update(t));
  }
  scene.add(makeGround(season));
  // размещение по точке экрана требует актуальных матриц камеры и пропорций экрана
  camera.aspect = (canvas.clientWidth || window.innerWidth) / (canvas.clientHeight || window.innerHeight);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  if (season.testLeaf.enabled) {
    const leaf = await makeTestLeaf(season, camera, import.meta.env.BASE_URL);
    scene.add(leaf.mesh);
    updaters.push((t) => leaf.update(t));
  }
  // ── ветер, листья, заслонки глубины (этап 2, часть 3) ──
  const wind = new Wind(season.wind, season.field.seed, 3);
  const field = new LeafField(season, wind, camera, season.field.seed);
  scene.add(field.group);
  if (season.occluders.enabled) scene.add(makeOccluders(season, camera));
  for (let i = 0; i < season.field.initial; i++) field.spawn();
  const panel = makeDevPanel(season, {
    spawn(n) { for (let i = 0; i < n; i++) field.spawn(); },
    setStrength(k) { wind.strength = k; },
    stats() {
      const b = wind.base;
      return { ...field.stats, wind: `${Math.hypot(b.x, b.z).toFixed(1)} м/с${wind.gustActive ? ', порыв' : ''}, треугольников листьев ${field.stats.triangles.toLocaleString('ru')}` };
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'n' || e.key === 'N' || e.key === 'т' || e.key === 'Т') field.spawn();
  });

  // ── постобработка: 3D-слой → тонмаппинг и sRGB → композит с задником ──
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass());
  const composite = makeComposite(season, backdrop);
  const cu = composite.pass.uniforms as Record<string, THREE.IUniform>;
  if (flags.get('clouds') === '0') cu.cloudOpacity.value = 0;
  if (flags.get('mask') === '1') cu.debugMask.value = 1;
  composer.addPass(composite.pass);

  const resize = () => {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    composite.resize(w, h);
  };
  window.addEventListener('resize', resize);
  resize();

  const dev = makeDevOverlay(devEl);
  const timer = new THREE.Timer();
  let time = 0;

  const stepWorld = (dt: number) => {
    wind.update(dt);
    field.step(dt);
  };
  const renderFrame = (dt: number) => {
    time += dt;
    stepWorld(dt);
    composite.update(time);
    field.update(time);
    for (const u of updaters) u(time);
    panel.frame();
    renderer.info.reset();
    composer.render();
  };

  return {
    renderer, scene, camera, composite: cu, wind, field,
    simulate(seconds, step = 1 / 60) { for (let t = 0; t < seconds; t += step) stepWorld(step); },
    renderOnce() { renderFrame(0); },
    start() {
      renderer.setAnimationLoop(() => {
        timer.update();
        const dt = Math.min(timer.getDelta(), 0.1);
        const t0 = performance.now();
        renderFrame(dt);
        dev.frame(renderer, performance.now() - t0);
      });
    }
  };
}
