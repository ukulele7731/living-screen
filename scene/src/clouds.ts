// Облака: два горизонтальных слоя с процедурным шумом (fbm), разной высоты и скорости.
// Дальний (верхний) слой медленнее. Слои гаснут к горизонту, где их всё равно съедает дымка.
import * as THREE from 'three';
import type { Season } from './config';
import { GLSL_NOISE } from './util';

export interface Clouds {
  group: THREE.Group;
  update(time: number): void;
}

export function makeClouds(season: Season, sunDir: THREE.Vector3): Clouds {
  const group = new THREE.Group();
  group.name = 'clouds';
  const materials: THREE.ShaderMaterial[] = [];

  season.clouds.layers.forEach((layer, i) => {
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: {
        time: { value: 0 },
        color: { value: new THREE.Color(season.clouds.color) },
        shade: { value: new THREE.Color(season.clouds.shade) },
        scale: { value: layer.scale },
        coverage: { value: layer.coverage },
        softness: { value: layer.softness },
        speed: { value: new THREE.Vector2(layer.speed[0], layer.speed[1]) },
        opacity: { value: layer.opacity },
        stretch: { value: layer.stretch },
        sunDir: { value: sunDir.clone() },
        seed: { value: i * 37.1 }
      },
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */`
        uniform float time, scale, coverage, softness, opacity, stretch, seed;
        uniform vec2 speed;
        uniform vec3 color, shade, sunDir;
        varying vec3 vWorld;
        ${GLSL_NOISE}
        void main() {
          vec2 p = (vWorld.xz + speed * time) * scale + seed;
          p.x /= stretch;                        // облака вытянуты по ветру
          float n = fbm(p);
          float dens = smoothstep(coverage, coverage + softness, n);
          // тень внутри облака: плотнее — темнее; освещённая сторона — со стороны солнца
          float lit = fbm(p + sunDir.xz * 0.02) - n;
          vec3 col = mix(shade, color, clamp(0.55 + lit * 6.0 - dens * 0.25, 0.0, 1.0));
          // гаснем к горизонту по горизонтальной дистанции от камеры
          vec3 rel = vWorld - cameraPosition;
          float dist = length(rel.xz);
          float fade = 1.0 - smoothstep(900.0, 2600.0, dist);
          // у самого зенита слой тоже чуть прозрачнее — там небо чище
          float a = dens * opacity * fade;
          gl_FragColor = vec4(col, a);
        }
      `
    });
    materials.push(material);
    const geo = new THREE.PlaneGeometry(6000, 6000);
    const mesh = new THREE.Mesh(geo, material);
    mesh.rotation.x = Math.PI / 2;            // нормаль вниз, к камере
    mesh.position.y = layer.altitude;
    mesh.frustumCulled = false;
    mesh.renderOrder = -5 + i;
    group.add(mesh);
  });

  return {
    group,
    update(time) {
      for (const m of materials) m.uniforms.time.value = time;
    }
  };
}
