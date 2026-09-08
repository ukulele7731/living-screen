// Небо: большая сфера с градиентным шейдером. Градиент по высоте над горизонтом,
// дымка у горизонта, тёплое свечение около солнца. Все цвета — из seasons/autumn.json.
import * as THREE from 'three';
import type { Season } from './config';

export function makeSky(season: Season, sunDir: THREE.Vector3): THREE.Mesh {
  const s = season.sky;
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      zenith: { value: new THREE.Color(s.zenith) },
      mid: { value: new THREE.Color(s.mid) },
      horizon: { value: new THREE.Color(s.horizon) },
      haze: { value: new THREE.Color(s.haze) },
      hazeHeight: { value: s.hazeHeight },
      sunDir: { value: sunDir.clone() },
      sunGlow: { value: new THREE.Color(s.sunGlow) },
      sunGlowStrength: { value: s.sunGlowStrength },
      sunGlowPower: { value: s.sunGlowPower },
      sunHaloStrength: { value: s.sunHaloStrength }
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vDir = wp.xyz - cameraPosition;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 zenith, mid, horizon, haze, sunGlow, sunDir;
      uniform float hazeHeight, sunGlowStrength, sunGlowPower, sunHaloStrength;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        // низ → середина → зенит; середина на ~25° над горизонтом
        float t1 = smoothstep(0.0, 0.42, h);
        float t2 = smoothstep(0.30, 1.0, h);
        vec3 col = mix(horizon, mid, t1);
        col = mix(col, zenith, t2);
        // дымка у горизонта — чем ниже, тем светлее и теплее
        float hz = exp(-h / hazeHeight);
        col = mix(col, haze, hz * 0.9);
        // ниже горизонта небо не видно (там земля), но на всякий случай — цвет дымки
        col = mix(col, haze, smoothstep(0.0, -0.05, d.y));
        // солнце: узкое свечение + широкое тёплое гало, сильнее у горизонта
        float s = max(dot(d, sunDir), 0.0);
        col += sunGlow * sunGlowStrength * pow(s, sunGlowPower);
        col += sunGlow * sunHaloStrength * pow(s, 2.5) * (0.4 + 0.6 * hz);
        gl_FragColor = vec4(col, 1.0);
      }
    `
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1800, 48, 24), material);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  mesh.name = 'sky';
  return mesh;
}
