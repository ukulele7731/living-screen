// Приземный туман: несколько полупрозрачных завес на разной глубине. У земли
// плотные, к 5–6 м гаснут; по горизонтали — медленно плывущий шум.
import * as THREE from 'three';
import type { Season } from './config';
import { GLSL_NOISE } from './util';

export interface Mist {
  group: THREE.Group;
  update(time: number): void;
}

export function makeMist(season: Season): Mist {
  const cfg = season.mist;
  const group = new THREE.Group();
  group.name = 'mist';
  const materials: THREE.ShaderMaterial[] = [];

  cfg.planes.forEach((p, i) => {
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: {
        time: { value: 0 },
        color: { value: new THREE.Color(cfg.color) },
        opacity: { value: p.opacity },
        seed: { value: i * 11.7 }
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        varying vec3 vWorld;
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */`
        uniform float time, opacity, seed;
        uniform vec3 color;
        varying vec2 vUv;
        varying vec3 vWorld;
        ${GLSL_NOISE}
        void main() {
          // по высоте: у земли 1, кверху 0
          float v = 1.0 - vUv.y;
          float vert = pow(v, 1.6);
          // клочья: медленный шум по горизонтали и чуть по вертикали
          float n = fbm(vec2(vWorld.x * 0.02 + time * 0.004 + seed, vUv.y * 2.5 + time * 0.002));
          float a = vert * opacity * (0.55 + 0.9 * n);
          gl_FragColor = vec4(color, clamp(a, 0.0, 1.0));
        }
      `
    });
    materials.push(material);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(700, cfg.height * (1 + i * 0.35)), material);
    mesh.position.set(0, cfg.height * (1 + i * 0.35) / 2 - 0.6, p.z);
    mesh.renderOrder = 5;
    mesh.frustumCulled = false;
    group.add(mesh);
  });

  return {
    group,
    update(time) { for (const m of materials) m.uniforms.time.value = time; }
  };
}
