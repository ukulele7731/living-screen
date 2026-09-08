// Сборка сцены: рендерер, камера, свет, небо, облака, дальний план, туман,
// средние деревья, земля, глубина резкости, resize и цикл кадров.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { season } from './config';
import { makeLighting } from './lighting';
import { makeSky } from './sky';
import { makeClouds } from './clouds';
import { makeFarTrees } from './farTrees';
import { makeMist } from './mist';
import { makeMidTrees } from './midTrees';
import { makeGround } from './ground';
import { makeDevOverlay } from './dev';

export interface LivingScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Отрисовать один кадр вручную (для скриншотов и тестов). */
  renderOnce(): void;
  start(): void;
}

export function createScene(canvas: HTMLCanvasElement, devEl: HTMLElement): LivingScene {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = season.exposure;
  const flags = new URLSearchParams(location.search);   // отладка: ?dof=0&shadow=0&pitch=-30
  renderer.shadowMap.enabled = flags.get('shadow') !== '0';
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(new THREE.Color(season.fog.color), season.fog.density);

  const cam = season.camera;
  const camera = new THREE.PerspectiveCamera(cam.fov, 1, cam.near, cam.far);
  camera.position.set(0, cam.height, 0);
  camera.lookAt(0, cam.height, -10);        // горизонтально, на уровне глаз
  if (flags.get('pitch')) camera.rotation.x = Number(flags.get('pitch')) * Math.PI / 180;

  const t0 = performance.now();
  const stage = (name: string, fn: () => void) => {
    const t = performance.now();
    fn();
    console.log(`[scene] ${name}: ${(performance.now() - t).toFixed(0)} мс`);
  };
  const lighting = makeLighting(season);
  scene.add(lighting.group);
  stage('небо', () => scene.add(makeSky(season, lighting.sunDir)));
  const clouds = makeClouds(season, lighting.sunDir);
  scene.add(clouds.group);
  stage('дальние деревья', () => scene.add(makeFarTrees(season)));
  const mist = makeMist(season);
  scene.add(mist.group);
  stage('деревья среднего плана', () => scene.add(makeMidTrees(season)));
  let maxAniso = 1;
  stage('анизотропия', () => { maxAniso = renderer.capabilities.getMaxAnisotropy(); });
  stage('земля', () => scene.add(makeGround(season, maxAniso)));
  console.log(`[scene] сборка: ${(performance.now() - t0).toFixed(0)} мс`);

  // ── постобработка: рендер → лёгкое боке → тонмаппинг и sRGB ──
  // render target с MSAA: иначе антиалиасинг рендерера в композере не работает
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bokeh = new BokehPass(scene, camera, {
    focus: season.dof.focus, aperture: season.dof.aperture, maxblur: season.dof.maxBlur
  });
  bokeh.enabled = flags.get('dof') !== '0';
  composer.addPass(bokeh);
  composer.addPass(new OutputPass());

  const resize = () => {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  const dev = makeDevOverlay(devEl);
  const timer = new THREE.Timer();
  let time = 0;

  const renderFrame = (dt: number) => {
    time += dt;
    clouds.update(time);
    mist.update(time);
    renderer.info.reset();
    composer.render();
  };

  return {
    renderer, scene, camera,
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
