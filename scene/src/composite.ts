// Финальный проход: задник (cover-масштабирование, горизонт на месте) + живые
// облака по маске неба + 3D-слой поверх (он отрендерен на прозрачном фоне и
// уже прошёл тонмаппинг и sRGB в OutputPass). Всё смешивается в sRGB.
import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { Season } from './config';
import type { Backdrop } from './backdrop';
import { GLSL_NOISE } from './util';

export interface CompositePass {
  pass: ShaderPass;
  resize(width: number, height: number): void;
  update(time: number): void;
}

export function makeComposite(season: Season, backdrop: Backdrop): CompositePass {
  const c = season.clouds;
  const shader = {
    uniforms: {
      tDiffuse: { value: null },
      tBackdrop: { value: backdrop.texture },
      tSky: { value: backdrop.skyMask },
      uvScale: { value: new THREE.Vector2(1, 1) },
      uvOffset: { value: new THREE.Vector2(0, 0) },
      time: { value: 0 },
      cloudOpacity: { value: c.enabled ? c.opacity : 0 },
      cloudColor: { value: new THREE.Color(c.color) },
      cloudScale: { value: c.scale },
      cloudCoverage: { value: c.coverage },
      cloudSoftness: { value: c.softness },
      cloudSpeed: { value: new THREE.Vector2(c.speed[0], c.speed[1]) },
      cloudStretch: { value: c.stretch },
      debugMask: { value: 0 }
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D tDiffuse, tBackdrop, tSky;
      uniform vec2 uvScale, uvOffset, cloudSpeed;
      uniform float time, cloudOpacity, cloudScale, cloudCoverage, cloudSoftness, cloudStretch, debugMask;
      uniform vec3 cloudColor;
      varying vec2 vUv;
      ${GLSL_NOISE}
      void main() {
        // экран → картинка (cover: масштаб по большей стороне, горизонт закреплён)
        vec2 buv = vUv * uvScale + uvOffset;
        vec3 bg = texture2D(tBackdrop, buv).rgb;

        // облака: шум плывёт в координатах картинки, только там, где небо
        float sky = texture2D(tSky, buv).r;
        if (sky > 0.002 && cloudOpacity > 0.0) {
          vec2 p = buv;
          p.x /= cloudStretch;
          p = p * cloudScale + cloudSpeed * time;
          float n = fbm(p);
          float dens = smoothstep(cloudCoverage, cloudCoverage + cloudSoftness, n);
          // у горизонта облака тоньше и мельче — так они не «стоят» на аллее
          float a = dens * cloudOpacity * sky;
          bg = mix(bg, cloudColor, a);
        }

        if (debugMask > 0.5) bg = mix(bg, vec3(1.0, 0.1, 0.1), sky * 0.7);

        // 3D-слой: rgb уже премножен на альфу (рендер на прозрачный чёрный)
        vec4 layer = texture2D(tDiffuse, vUv);
        gl_FragColor = vec4(bg * (1.0 - layer.a) + layer.rgb, 1.0);
      }
    `
  };
  const pass = new ShaderPass(shader);
  const horizon = season.backdrop.horizon;
  return {
    pass,
    resize(width, height) {
      // uv экрана: (0,0) внизу слева. Горизонт картинки на высоте (1 − horizon) от низа,
      // и он должен совпасть с горизонтом камеры — тот на той же доле экрана.
      const view = width / height, img = backdrop.aspect;
      const u = pass.uniforms as Record<string, THREE.IUniform>;
      if (view >= img) {
        // экран шире картинки: тянем по ширине, режем сверху/снизу вокруг горизонта
        const k = img / view;                          // видимая доля высоты картинки
        const h = 1 - horizon;                          // горизонт в uv картинки (снизу)
        u.uvScale.value.set(1, k);
        u.uvOffset.value.set(0, h - h * k);
      } else {
        // экран уже картинки: тянем по высоте, режем по бокам симметрично
        const k = view / img;
        u.uvScale.value.set(k, 1);
        u.uvOffset.value.set((1 - k) / 2, 0);
      }
    },
    update(time) { (pass.uniforms as Record<string, THREE.IUniform>).time.value = time; }
  };
}
