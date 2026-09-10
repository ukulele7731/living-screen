// Материал листа (раздел 4.2): MeshStandardMaterial с расширениями в шейдере.
//   вершины: крупная форма покоя (один купол на весь лист + плавно приподнятые
//            кончики), сухость (края к изнанке), изгиб под потоком, слабый
//            флаттер, кручение — всё как гладкая функция координат жилки, поэтому
//            нормали считаются аналитически (конечные разности) и остаются гладкими
//   фрагмент: карта нормалей (жилки — рельеф), просвет по толщине (у жилки
//             толще), изнанка светлее и матовее, белая бумага рисунка чуть теплее,
//             контровой блик по краю от солнца
// Атрибуты экземпляра (InstancedBufferAttribute):
//   iParams: dry, twist, flutter, phase
//   iBend:   направление потока в плоскости листа (x, y), знак/величина изгиба (z), запас (w)
//   iUvRect: смещение (x, y) и масштаб (z, w) в атласе текстур
import * as THREE from 'three';
import type { LeafShape } from './leaf-shapes';
import { veinFrame } from './leaf-geometry';

export interface LeafProfile {
  dome: number;      // купол: края приподняты (плюс) или опущены (минус), доля длины листа
  tipLift: number;   // плавно приподнятые кончики
  dryCurl: number;   // насколько сухость 1.0 скручивает края к изнанке
  bend: number;      // множитель изгиба под потоком
}

export interface LeafMaterialOptions {
  map: THREE.Texture;
  normalMap?: THREE.Texture;
  profile: LeafProfile;
  shape: LeafShape;
  size: number;                 // масштаб геометрии (длинная сторона в метрах)
  translucency?: number;
  backTint?: THREE.ColorRepresentation;
  paperWarm?: number;           // 0..1 — насколько белую бумагу сдвигать к кремовому
  rim?: number;                 // сила контрового блика
}

export interface LeafMaterial extends THREE.MeshStandardMaterial {
  leafUniforms: {
    time: THREE.IUniform<number>;
    profile: THREE.IUniform<THREE.Vector4>;   // dome, tipLift, dryCurl, bend
    translucency: THREE.IUniform<number>;
    backTint: THREE.IUniform<THREE.Color>;
    leafSize: THREE.IUniform<number>;
    veinBase: THREE.IUniform<THREE.Vector2>;
    veinDir: THREE.IUniform<THREE.Vector2>;
    veinLen: THREE.IUniform<number>;
    maxLat: THREE.IUniform<number>;
    paperWarm: THREE.IUniform<number>;
    rim: THREE.IUniform<number>;
  };
}

export function makeLeafMaterial(opts: LeafMaterialOptions): LeafMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: opts.map,
    normalMap: opts.normalMap ?? null,
    normalScale: new THREE.Vector2(0.7, 0.7),
    roughness: 0.55,
    metalness: 0,
    side: THREE.FrontSide            // лицо и изнанка — отдельные сетки геометрии
  }) as LeafMaterial;
  const p = opts.profile;
  const f = veinFrame(opts.shape);
  const size = opts.size;
  mat.leafUniforms = {
    time: { value: 0 },
    profile: { value: new THREE.Vector4(p.dome, p.tipLift, p.dryCurl, p.bend) },
    translucency: { value: opts.translucency ?? 1.1 },
    backTint: { value: new THREE.Color(opts.backTint ?? '#d9cf9c') },
    leafSize: { value: size },
    veinBase: { value: new THREE.Vector2(f.base[0] * size, f.base[1] * size) },
    veinDir: { value: new THREE.Vector2(f.dir[0], f.dir[1]) },
    veinLen: { value: f.len * size },
    maxLat: { value: f.maxLat * size },
    paperWarm: { value: opts.paperWarm ?? 0 },
    rim: { value: opts.rim ?? 0.35 }
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
        uniform float time, leafSize, veinLen, maxLat;
        uniform vec2 veinBase, veinDir;
        uniform vec4 profile;
        varying vec4 vAux;

        // координаты жилки: s поперёк (−1…1), t вдоль (0…1), r — радиус от центра (~1 у краёв)
        vec3 leafCoords(vec2 p) {
          vec2 d = p - veinBase;
          float t = dot(d, veinDir) / veinLen;
          float s = dot(d, vec2(-veinDir.y, veinDir.x)) / maxLat;
          float r = length(vec2(s, (t - 0.5) * 2.0));
          return vec3(s, t, r);
        }
        // смещение по нормали листа (в метрах): только крупные формы
        float leafZ(vec2 p, vec4 par, vec4 bend) {
          vec3 c = leafCoords(p);
          float s = c.x, t = c.y, r = min(c.z, 1.4);
          float r2 = r * r;
          float z = profile.x * r2;                                        // купол на весь лист
          z += profile.y * smoothstep(0.5, 1.2, r) * r2;                   // плавно приподнятые кончики
          z -= profile.z * par.x * r2 * r;                                 // сухость: края к изнанке
          vec2 dir = vec2(s, (t - 0.5) * 2.0) / max(r, 1e-3);
          float down = 0.5 + 0.5 * dot(dir, bend.xy);
          z += bend.z * profile.w * r2 * down;                             // изгиб под потоком
          z += par.z * 0.012 * r2 * r * sin(time * 7.0 + par.w + s * 2.5 + t * 3.0); // флаттер, крупный и слабый
          z += par.y * s * 0.25 * t;                                       // кручение вокруг жилки
          return z * leafSize;
        }
      `)
      .replace('#include <beginnormal_vertex>', /* glsl */`
        // гладкая нормаль изогнутой поверхности: конечные разности аналитического смещения
        float eps = leafSize * 0.01;
        float z0 = leafZ(position.xy, iParams, iBend);
        float zx = leafZ(position.xy + vec2(eps, 0.0), iParams, iBend);
        float zy = leafZ(position.xy + vec2(0.0, eps), iParams, iBend);
        vec3 bentN = normalize(vec3(-(zx - z0) / eps, -(zy - z0) / eps, 1.0));
        vec3 objectNormal = aux.w > 0.5 ? bentN : (aux.w < -0.5 ? -bentN : vec3(normal));
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3( tangent.xyz );
        #endif
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        vec3 transformed = vec3(position);
        transformed.z = leafZ(position.xy, iParams, iBend) + position.z;
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
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform float translucency, paperWarm, rim;
        uniform vec3 backTint;
        varying vec4 vAux;
      `)
      .replace('#include <map_fragment>', /* glsl */`
        #include <map_fragment>
        // белая бумага детского рисунка — чуть теплее, под золотистый свет картины; цвета рисунка не трогаем
        float paper = smoothstep(0.45, 0.9, min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b)));
        diffuseColor.rgb *= mix(vec3(1.0), vec3(1.0, 0.90, 0.74), paper * paperWarm);
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
          vec3 L = directionalLights[0].direction;
          vec3 sunC = directionalLights[0].color;
          // просвет: свет из-за листа проходит сквозь; жилка (≈4% ширины) и черешок толще
          float back = clamp(dot(-normal, L), 0.0, 1.0);
          float thickV = mix(0.68, 0.35, smoothstep(0.0, 0.045, abs(vAux.y)));
          thickV = max(thickV, mix(0.68, 0.35, smoothstep(0.0, 0.12, vAux.z)));
          reflectedLight.indirectDiffuse += diffuseColor.rgb * sunC * back * (1.0 - thickV) * translucency;
          // контровой блик по краю: солнце за объектом, край светится, как у предметов на картине
          float ndv = clamp(dot(normal, geometryViewDir), 0.0, 1.0);
          float backlit = clamp(-dot(L, geometryViewDir), 0.0, 1.0);
          float edgeGlow = pow(1.0 - ndv, 3.5) * (0.3 + 0.7 * backlit);
          reflectedLight.directSpecular += sunC * rim * edgeGlow;
        }
        #endif
      `);
  };
  mat.customProgramCacheKey = () => 'leaf';
  return mat;
}
