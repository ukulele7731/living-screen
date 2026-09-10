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
  const trees = makeMidTrees(season);
  scene.add(trees.group);
  const branchLeaves = makeBranchLeaves(season, trees.tips);
  for (const b of branchLeaves.batches) scene.add(b.mesh);
  scene.add(makeGround(season));

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

  const renderFrame = (dt: number) => {
    time += dt;
    composite.update(time);
    branchLeaves.update(time);
    renderer.info.reset();
    composer.render();
  };

  return {
    renderer, scene, camera, composite: cu,
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
