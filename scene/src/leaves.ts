// Пакет листьев одного вида: InstancedMesh с общей геометрией и материалом,
// атрибуты экземпляра — сухость/кручение/флаттер, изгиб, окно в атласе, цвет.
// Один draw call на вид (раздел 4.6).
import * as THREE from 'three';
import type { LeafShape } from './leaf-shapes';
import { buildLeafGeometry, buildLeafPolygonGeometry, veinFrame } from './leaf-geometry';
import { makeLeafMaterial, type LeafMaterial, type LeafProfile } from './leaf-material';
import type { LeafAtlas } from './leaf-textures';

export interface LeafInstance {
  matrix: THREE.Matrix4;
  color?: THREE.Color;
  dry?: number;        // 0..1
  twist?: number;      // радианы кручения к кончику
  flutter?: number;    // 0..1
  phase?: number;
  bend?: THREE.Vector3;  // x, y — направление потока в плоскости листа; z — величина изгиба
  variant?: number;    // вариант текстуры в атласе
}

export class LeafBatch {
  readonly mesh: THREE.InstancedMesh;
  readonly material: LeafMaterial;
  readonly capacity: number;
  readonly triangles: number;
  count = 0;
  private params: THREE.InstancedBufferAttribute;
  private bends: THREE.InstancedBufferAttribute;
  private rects: THREE.InstancedBufferAttribute;

  /** матрица переворота листа на изнанку: поворот на 180° вокруг жилки через её середину (в метрах) */
  readonly flip = new THREE.Matrix4();

  constructor(readonly shape: LeafShape, readonly atlas: LeafAtlas, profile: LeafProfile, capacity: number,
              opts: { size: number; translucency?: number; segments?: number; noRim?: boolean; paperWarm?: number; rim?: number;
                      /** грубый многоугольник вместо сетки: 'both' — две грани (дальние), 'front' — одна (ковёр) */
                      polygon?: 'both' | 'front'; castShadow?: boolean }) {
    this.capacity = capacity;
    const geo = opts.polygon
      ? buildLeafPolygonGeometry(shape, { bothSides: opts.polygon === 'both' })
      : buildLeafGeometry(shape, { segments: opts.segments ?? 24, noRim: opts.noRim });
    geo.scale(opts.size, opts.size, opts.size);
    {
      const f = veinFrame(shape), sz = opts.size;
      const mid = new THREE.Vector3((f.base[0] + f.dir[0] * f.len / 2) * sz, (f.base[1] + f.dir[1] * f.len / 2) * sz, 0);
      const axis = new THREE.Vector3(f.dir[0], f.dir[1], 0).normalize();
      this.flip.makeTranslation(mid.x, mid.y, 0).multiply(new THREE.Matrix4().makeRotationAxis(axis, Math.PI)).multiply(new THREE.Matrix4().makeTranslation(-mid.x, -mid.y, 0));
    }
    this.triangles = geo.index ? geo.index.count / 3 : 0;
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.bends = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.rects = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.params.setUsage(THREE.DynamicDrawUsage);
    this.bends.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iParams', this.params);
    geo.setAttribute('iBend', this.bends);
    geo.setAttribute('iUvRect', this.rects);
    this.material = makeLeafMaterial({ map: atlas.map, normalMap: atlas.normalMap, profile, shape, size: opts.size, translucency: opts.translucency, paperWarm: opts.paperWarm, rim: opts.rim });
    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = opts.castShadow ?? true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.name = 'leaves:' + shape.name;
  }

  /** Записать экземпляр в слот i (i < capacity). */
  set(i: number, inst: LeafInstance) {
    this.mesh.setMatrixAt(i, inst.matrix);
    this.mesh.setColorAt(i, inst.color ?? WHITE);
    this.params.setXYZW(i, inst.dry ?? 0, inst.twist ?? 0, inst.flutter ?? 0, inst.phase ?? 0);
    const b = inst.bend;
    this.bends.setXYZW(i, b ? b.x : 0, b ? b.y : 1, b ? b.z : 0, 0);
    const r = this.atlas.rect(inst.variant ?? 0);
    this.rects.setXYZW(i, r[0], r[1], r[2], r[3]);
    if (i >= this.count) this.count = i + 1;
    this.mesh.count = this.count;
  }

  /** Только матрица и изгиб — для физики каждый кадр. side ≠ 0 — ковёр: одна грань, лицо (+1) или изнанка (−1). */
  setMotion(i: number, matrix: THREE.Matrix4, bend: THREE.Vector3, flutter: number, side = 0) {
    this.mesh.setMatrixAt(i, matrix);
    this.bends.setXYZW(i, bend.x, bend.y, bend.z, side);
    this.params.setZ(i, flutter);
  }

  commit() {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.params.needsUpdate = true;
    this.bends.needsUpdate = true;
    this.rects.needsUpdate = true;
  }

  update(time: number) {
    this.material.leafUniforms.time.value = time;
  }
}

const WHITE = new THREE.Color(1, 1, 1);
