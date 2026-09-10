// Материал листа (раздел 4.2): MeshStandardMaterial с расширениями в шейдере.
//   вершины: форма покоя по виду (купол, волна края, лодочка, кончик), сухость
//            (края скручены к изнанке), изгиб под потоком, флаттер края,
//            кручение вокруг жилки; всё по атрибуту aux и атрибутам экземпляра
//   фрагмент: нормаль из производных (flatShading, реагирует на каждую волну) + карта
//             нормалей из рисунка, просвет (обратный лэмберт с толщиной: у
//             жилки толще), изнанка светлее и матовее, серо-жёлтая.
// Атрибуты экземпляра (InstancedBufferAttribute):
//   iParams: dry, twist, flutter, phase
//   iBend:   направление потока в плоскости листа (x, y), знак/величина изгиба (z), запас (w)
//   iUvRect: смещение (x, y) и масштаб (z, w) в атласе текстур
import * as THREE from 'three';

export interface LeafProfile {
  dome: number;      // купол: края приподняты (плюс) или опущены (минус)
  wave: number;      // волна по краю, амплитуда
  waveN: number;     // число волн по краю
  boat: number;      // лодочка вдоль жилки: края вверх
  tipCurl: number;   // загнутый кончик
  dryCurl: number;   // насколько сухость скручивает края к изнанке
}

export interface LeafMaterialOptions {
  map: THREE.Texture;
  normalMap?: THREE.Texture;
  profile: LeafProfile;
  translucency?: number;
  backTint?: THREE.ColorRepresentation;
  size?: number;
}

export interface LeafMaterial extends THREE.MeshStandardMaterial {
  leafUniforms: {
    time: THREE.IUniform<number>;
    profile: THREE.IUniform<THREE.Vector4>;   // dome, wave, waveN, boat
    profile2: THREE.IUniform<THREE.Vector4>;  // tipCurl, dryCurl, bendScale, flutterScale
    translucency: THREE.IUniform<number>;
    backTint: THREE.IUniform<THREE.Color>;
    leafSize: THREE.IUniform<number>;         // масштаб геометрии: смещения считаются в единицах листа
  };
}

export function makeLeafMaterial(opts: LeafMaterialOptions): LeafMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: opts.map,
    normalMap: opts.normalMap ?? null,
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 0.55,
    metalness: 0,
    flatShading: true,               // нормаль из производных: изгиб в шейдере виден в освещении
    side: THREE.FrontSide            // лицо и изнанка — отдельные сетки геометрии
  }) as LeafMaterial;
  const p = opts.profile;
  mat.leafUniforms = {
    time: { value: 0 },
    profile: { value: new THREE.Vector4(p.dome, p.wave, p.waveN, p.boat) },
    profile2: { value: new THREE.Vector4(p.tipCurl, p.dryCurl, 1, 1) },
    translucency: { value: opts.translucency ?? 1.1 },
    backTint: { value: new THREE.Color(opts.backTint ?? '#d9cf9c') },
    leafSize: { value: opts.size ?? 1 }
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.leafUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        attribute vec4 aux;
        attribute vec4 iParams;
        attribute vec4 iBend;
        attribute vec4 iUvRect;
        uniform float time, leafSize;
        uniform vec4 profile, profile2;
        varying vec4 vAux;

        // смещение по нормали листа в точке p (единицы листа: длинная сторона = 1)
        float leafZ(vec2 p, vec4 a, vec4 par, vec4 bend) {
          float edge = a.x, s = a.y, t = a.z;
          float soft = (0.25 + 0.75 * (1.0 - edge)) * (0.3 + 0.7 * abs(s));  // мягко у края и вдали от жилки
          float z = 0.0;
          // форма покоя
          z += profile.x * (s * s * 0.6 + (t - 0.5) * (t - 0.5) * 0.8);       // купол
          z += profile.y * sin(t * profile.z * 6.2832 + s * 2.0) * (1.0 - edge) * abs(s); // волна края
          z += profile.w * s * s;                                              // лодочка
          z += profile2.x * smoothstep(0.65, 1.0, t) * smoothstep(0.65, 1.0, t);  // кончик
          // сухость: края к изнанке
          z -= profile2.y * par.x * pow(1.0 - edge, 2.0) * (0.4 + 0.6 * abs(s));
          // изгиб под потоком: подветренная сторона гнётся сильнее
          float down = 0.5 + 0.5 * dot(normalize(vec2(s, t - 0.5) + 1e-4), bend.xy);
          z += bend.z * profile2.z * soft * down;
          // флаттер: волны бегут по краю
          z += par.z * profile2.w * (1.0 - edge) * 0.05 * sin(time * 9.0 + par.w + s * 5.0 + t * 7.0);
          // кручение вокруг жилки
          z += par.y * s * 0.3 * t;
          return z;
        }
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        vec3 transformed = vec3(position);
        transformed.z = leafZ(position.xy, aux, iParams, iBend) * leafSize + position.z;
        vAux = aux;
      `)
      .replace('#include <uv_vertex>', /* glsl */`
        #include <uv_vertex>
        #ifdef USE_MAP
          vMapUv = uv * iUvRect.zw + iUvRect.xy;
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv = uv * iUvRect.zw + iUvRect.xy;
        #endif
      `)
      ;

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform float translucency;
        uniform vec3 backTint;
        varying vec4 vAux;
      `)
      .replace('#include <map_fragment>', /* glsl */`
        #include <map_fragment>
        if (vAux.w < -0.5) diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * backTint * 1.4, 0.55);
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
        if (vAux.w < -0.5) roughnessFactor = min(1.0, roughnessFactor + 0.25);
      `)
      .replace('#include <lights_fragment_end>', /* glsl */`
        #include <lights_fragment_end>
        #if NUM_DIR_LIGHTS > 0
        {
          // просвет: свет из-за листа проходит сквозь; у жилки и черешка лист толще
          vec3 L = directionalLights[0].direction;
          float back = clamp(dot(-normal, L), 0.0, 1.0);
          float thickV = mix(1.0, 0.35, smoothstep(0.0, 0.16, abs(vAux.y)));
          thickV = max(thickV, 1.0 - smoothstep(0.0, 0.2, vAux.z));
          float thin = 1.0 - thickV;
          vec3 trans = diffuseColor.rgb * directionalLights[0].color * back * thin * translucency;
          reflectedLight.indirectDiffuse += trans;
        }
        #endif
      `);
  };
  mat.customProgramCacheKey = () => 'leaf';
  return mat;
}
