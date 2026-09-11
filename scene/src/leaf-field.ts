// Менеджер листьев: пакеты по видам и уровням детализации, спавн, физика с
// подшагами, ковёр (лежащие листья, лимит и вытеснение старых), повторный
// взлёт порывом. Уровень детализации — по расстоянию до камеры: близкие
// листья — сетка 24 сегмента с торцом (гнутся), дальние — грубый многоугольник
// ~24 треугольника на грань. Лежащие переезжают в отдельный пакет-ковёр на вид:
// одна грань ~24 треугольника, лицом или изнанкой вверх, с контактной тенью.
import * as THREE from 'three';
import type { Season } from './config';
import { rng } from './util';
import { LeafBatch } from './leaves';
import { LEAF_SHAPES, LEAF_KINDS } from './leaf-shapes';
import { paintLeafAtlas, type LeafAtlas } from './leaf-textures';
import { LeafBody, type AeroCfg } from './leaf-body';
import type { Wind } from './wind';
import { groundHeight } from './ground';

export interface SpawnOptions {
  /** ambient — фоновый лист (мельче, приглушённый, живёт в глубине кадра), hero — главный: крупный, яркий, летит к камере */
  role?: 'ambient' | 'hero';
  kind?: string;
  pos?: THREE.Vector3;
  vel?: THREE.Vector3;
  variant?: number;
  dry?: number;
  scale?: number;
}

const LODS: { segments?: number; polygon?: 'both'; castShadow: boolean }[] = [
  { segments: 24, castShadow: true },      // ближе field.lodDistance[0]: гнётся, торец, тень
  { polygon: 'both', castShadow: false }   // дальше: многоугольник, без тени
];
/** индекс пакета-ковра в batches/free (после уровней детализации) */
const CARPET = LODS.length;

interface KindSet { atlas: LeafAtlas; batches: LeafBatch[]; free: number[][] }

export class LeafField {
  readonly group = new THREE.Group();
  readonly kinds = new Map<string, KindSet>();
  readonly bodies: LeafBody[] = [];
  private r: () => number;
  private aero: AeroCfg;
  private m = new THREE.Matrix4();
  private tmp = new THREE.Vector3();
  private tilt = new THREE.Vector3();
  private spawnAcc = 0;
  /** статистика для dev-панели */
  stats = { flying: 0, ground: 0, spawned: 0, triangles: 0 };

  constructor(readonly season: Season, readonly wind: Wind, readonly camera: THREE.Camera, seed = 1) {
    this.r = rng(seed);
    this.aero = season.physics as AeroCfg;
    const cfg = season.leaves;
    const cap = season.field.capacityPerKind;
    for (const kind of LEAF_KINDS) {
      const shape = LEAF_SHAPES[kind];
      const sp = cfg.species[kind as keyof typeof cfg.species];
      const size = cfg.baseSize * sp.size;
      const atlas = paintLeafAtlas(shape, sp.palettes, 90 + kind.length, size * 1000);
      const batches = LODS.map((lod) => {
        const b = new LeafBatch(shape, atlas, sp.profile, cap, {
          size, translucency: cfg.translucency, segments: lod.segments, polygon: lod.polygon, castShadow: lod.castShadow, rim: cfg.rim
        });
        this.group.add(b.mesh);
        return b;
      });
      const carpetCap = season.field.maxGround + 20;
      const carpet = new LeafBatch(shape, atlas, sp.profile, carpetCap, {
        size, translucency: cfg.translucency, polygon: 'front', castShadow: true, rim: cfg.rim   // контактная тень: ~20 треугольников на лист
      });
      carpet.mesh.name = 'carpet:' + kind;
      this.group.add(carpet.mesh);
      batches.push(carpet);
      const free = batches.map((b) => Array.from({ length: b.capacity }, (_, i) => b.capacity - 1 - i));
      this.kinds.set(kind, { atlas, batches, free });
    }
    this.group.name = 'leafField';
  }

  get aeroCfg(): AeroCfg { return this.aero; }

  /** Фоновый лист рождается в кронах деревьев вдоль всей аллеи: по обе стороны дорожки,
   *  на высоте крон, от ближних деревьев до дальних — дальние видны как мелкие точки,
   *  и по ним читается глубина. */
  randomSpawnPoint(out: THREE.Vector3, role: 'ambient' | 'hero' = 'ambient'): THREE.Vector3 {
    const f = this.season.field;
    const c = role === 'hero' ? f.hero : f.ambient;
    const z = -(c.depth[0] + Math.pow(this.r(), c.depthBias) * (c.depth[1] - c.depth[0]));
    let x: number;
    if (role === 'hero') {
      x = (this.r() * 2 - 1) * f.hero.halfWidth;
    } else {
      // деревья стоят по сторонам аллеи: |x| от края дорожки до глубины кроны, редко — над дорожкой
      const side = this.r() < 0.5 ? -1 : 1;
      const overPath = this.r() < f.ambient.overPath;
      x = overPath ? (this.r() * 2 - 1) * this.wind.pathHalfWidth
        : side * (this.wind.pathHalfWidth + this.r() * f.ambient.treeDepth);
    }
    out.set(x, c.height[0] + this.r() * (c.height[1] - c.height[0]), z);
    return out;
  }

  /** Уровень детализации по дальности; для летящего с гистерезисом, чтобы не мигал на границе. */
  private lodFor(body: LeafBody): number {
    if (body.state === 'ground' || (body.state === 'fading' && body.lod === CARPET)) return CARPET;
    const d = body.pos.distanceTo(this.camera.position);
    const t = this.season.field.lodDistance;
    let lod = 0;
    for (let i = 0; i < t.length && i < LODS.length - 1; i++) {
      const th = body.lod === CARPET ? t[i] : body.lod <= i ? t[i] * 1.15 : t[i] * 0.85;
      if (d > th) lod = i + 1;
    }
    return lod;
  }

  private takeSlot(kind: string, lod: number): number {
    const set = this.kinds.get(kind)!;
    if (lod === CARPET) {
      const free = set.free[CARPET];
      return free.length ? CARPET * 100000 + free.pop()! : -1;
    }
    for (let l = lod; l < LODS.length; l++) {              // нет места — берём уровень грубее
      const free = set.free[l];
      if (free.length) { return l * 100000 + free.pop()!; }
    }
    return -1;
  }

  /** Матрица экземпляра с учётом ковра: лежащий изнанкой вверх переворачивается вокруг жилки. */
  private writeBodyMatrix(body: LeafBody, out: THREE.Matrix4): number {
    body.writeMatrix(out);
    if (body.lod !== CARPET) return 0;
    const q = body.quat;
    const ny = 2 * (q.y * q.z + q.w * q.x);                // y-компонента нормали листа (локальная +z)
    if (ny >= 0) return 1;
    out.multiply(this.kinds.get(body.kind)!.batches[CARPET].flip);
    return -1;
  }

  spawn(opts: SpawnOptions = {}): LeafBody | null {
    const role = opts.role ?? 'ambient';
    const rc = role === 'hero' ? this.season.field.hero : this.season.field.ambient;
    const kind = opts.kind ?? LEAF_KINDS[Math.floor(this.r() * LEAF_KINDS.length)];
    const set = this.kinds.get(kind);
    if (!set) return null;
    const sp = this.season.leaves.species[kind as keyof typeof this.season.leaves.species];
    const scale = opts.scale ?? (rc.scale[0] + this.r() * (rc.scale[1] - rc.scale[0]));
    const pos = opts.pos ?? this.randomSpawnPoint(this.tmp, role);
    const wantLod = pos.distanceTo(this.camera.position) < this.season.field.lodDistance[0] ? 0
      : pos.distanceTo(this.camera.position) < this.season.field.lodDistance[1] ? 1 : 2;
    const packed = this.takeSlot(kind, wantLod);
    if (packed < 0) return null;
    const lod = Math.floor(packed / 100000), slot = packed % 100000;
    const body = new LeafBody(LEAF_SHAPES[kind], this.season.leaves.baseSize * sp.size, scale, kind,
      opts.dry ?? this.r() * 0.8, opts.variant ?? Math.floor(this.r() * set.atlas.variants), this.r() * 6.28, slot, this.aero);
    body.lod = lod;
    body.role = role;
    body.pos.copy(pos);
    if (opts.vel) body.vel.copy(opts.vel);
    else if (role === 'hero') body.vel.set((this.r() - 0.5) * 0.8, -0.2, 0.6 + this.r() * 0.8);   // главный — сразу к камере
    else body.vel.set((this.r() - 0.5) * 0.6, -0.2, (this.r() - 0.5) * 0.4);
    body.quat.setFromEuler(new THREE.Euler(this.r() * 6.28, this.r() * 6.28, this.r() * 6.28));
    body.angVel.set((this.r() - 0.5) * 3, (this.r() - 0.5) * 3, (this.r() - 0.5) * 3);
    body.twist = (this.r() - 0.5) * 0.4;
    body.liftBias = 0.75 + this.r() * 0.8;
    if (role === 'hero') body.tint.set(1, 1, 1);                       // рисунок как есть, во всю яркость
    else body.tint.setHSL(0.08 + this.r() * 0.06, 0.5, 0.55).lerp(new THREE.Color(1, 1, 1), 0.7).multiplyScalar(this.season.field.ambient.tint);
    this.bodies.push(body);
    this.writeFull(body);
    this.stats.spawned++;
    return body;
  }

  private writeFull(body: LeafBody) {
    const batch = this.kinds.get(body.kind)!.batches[body.lod];
    const side = this.writeBodyMatrix(body, this.m);
    batch.set(body.slot, {
      matrix: this.m, dry: body.dry, twist: body.twist, flutter: body.flutter, phase: body.phase,
      variant: body.variant, bend: body.bend, color: body.tint
    });
    if (side) batch.setMotion(body.slot, this.m, body.bend, body.flutter, side);
  }

  private release(body: LeafBody) {
    const set = this.kinds.get(body.kind)!;
    this.m.makeScale(0, 0, 0);
    set.batches[body.lod].setMotion(body.slot, this.m, body.bend, 0);
    set.free[body.lod].push(body.slot);
  }

  private remove(body: LeafBody) {
    const i = this.bodies.indexOf(body);
    if (i >= 0) this.bodies.splice(i, 1);
    this.release(body);
  }

  private relod(body: LeafBody) {
    const want = this.lodFor(body);
    if (want === body.lod) return;
    const packed = this.takeSlot(body.kind, want);
    if (packed < 0) {
      // ковёр переполнен — лист исчезает (лимит лежащих всё равно рядом)
      if (want === CARPET) { body.state = 'fading'; }
      return;
    }
    this.release(body);
    body.lod = Math.floor(packed / 100000);
    body.slot = packed % 100000;
    this.writeFull(body);
  }

  /** Главный лист держится в зоне перед камерой: к ветру добавляется слабое течение
   *  к точке hero.focus (за её пределы порыв всё равно выносит — но лист возвращается). */
  private steerHero(b: LeafBody) {
    const h = this.season.field.hero;
    const t = this.tmp.set(THREE.MathUtils.clamp(b.pos.x, -h.focus[0], h.focus[0]), h.focus[1], -h.focus[2]).sub(b.pos);
    const d = t.length();
    if (d < 1e-3) { b.steer.set(0, 0, 0); return; }
    // сила растёт с удалением от зоны: рядом — почти нет, далеко — до steer м/с
    const k = h.steer * THREE.MathUtils.smoothstep(d, 1.0, 6);
    b.steer.copy(t).multiplyScalar(k / d);
  }

  /** Физика: dt кадра делится на подшаги. */
  step(dt: number) {
    const cfg = this.aero, f = this.season.field;
    const sub = f.substeps, h = dt / sub;
    const windAt = this.tmp;
    let ground = 0, flying = 0;
    // автоспавн — пока летящих меньше лимита
    this.spawnAcc += dt * f.autoSpawnPerSec;
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      if (this.stats.flying < f.maxFlying) this.spawn();
    }
    const near2 = f.ambient.nearFade * f.ambient.nearFade;
    for (const b of this.bodies.slice()) {
      // фоновый лист, подлетевший к камере, растворяется — на первом плане только главные
      if (b.role === 'ambient' && b.state !== 'fading' && b.pos.distanceToSquared(this.camera.position) < near2) {
        b.state = 'fading';
      }
      if (b.state === 'fly') {
        if (b.role === 'hero') this.steerHero(b); else b.steer.set(0, 0, 0);
        for (let s = 0; s < sub; s++) {
          const gy = groundHeight(b.pos.x, b.pos.z);
          const lowest = b.step(h, this.wind, cfg, gy);
          const slow = b.vel.lengthSq() < 0.04 && b.angVel.lengthSq() < 0.3;
          if (lowest < gy + 0.03 && slow) b.restTimer += h; else b.restTimer = 0;
        }
        if (b.restTimer > cfg.restTime) { b.state = 'ground'; b.restTimer = 0; b.bend.z = 0; b.flutter = 0; }
        // улетел далеко — убираем (главные держатся у камеры, их предел шире)
        const zLim = b.role === 'hero' ? 12 : 4;
        if (b.pos.y < -2 || Math.abs(b.pos.x) > 60 || b.pos.z > zLim || b.pos.z < -80) { this.remove(b); continue; }
        flying++;
      } else if (b.state === 'ground') {
        // лежащий лист приподнят к зрителю, как листья на картине
        const tilt = this.tilt.set(this.camera.position.x - b.pos.x, 0, this.camera.position.z - b.pos.z).normalize().multiplyScalar(cfg.groundTilt);
        b.settle(dt, tilt);
        ground++;
        // порыв поднимает лежащие: сначала край, потом весь лист
        this.wind.sample(windAt.copy(b.pos).setY(b.pos.y + 1.0), windAt);   // ветер над листом, не в пограничном слое
        const wl = Math.hypot(windAt.x, windAt.z);
        const eager = b.role === 'hero' ? 1.0 : 0.3;                  // главные взлетают охотнее
        const need = cfg.liftSpeed * b.liftBias;
        if (wl > need && this.r() < dt * (wl - need) * eager) b.lift(windAt, this.r);
      } else if (b.state === 'fading') {
        b.fade -= dt;
        if (b.fade <= 0) { this.remove(b); continue; }
      }
      this.relod(b);
    }
    // ковёр: лимит лежащих — самые старые уходят «под верхние»
    if (ground > f.maxGround) {
      let extra = ground - f.maxGround;
      for (const role of ['ambient', 'hero'] as const) {                // сначала уходят фоновые
        for (const b of this.bodies) {
          if (extra <= 0) break;
          if (b.state === 'ground' && b.role === role) { b.state = 'fading'; extra--; }
        }
      }
    }
    this.stats.flying = flying;
    this.stats.ground = ground;
    // матрицы в пакеты
    let tris = 0;
    for (const b of this.bodies) {
      const side = this.writeBodyMatrix(b, this.m);
      const batch = this.kinds.get(b.kind)!.batches[b.lod];
      batch.setMotion(b.slot, this.m, b.bend, b.flutter, side);
      tris += batch.triangles;
    }
    this.stats.triangles = tris;
    for (const set of this.kinds.values()) for (const batch of set.batches) batch.commit();
  }

  update(time: number) {
    for (const set of this.kinds.values()) for (const batch of set.batches) batch.update(time);
  }

  /** Снимок состояния для отладки и автотестов. */
  snapshot() {
    return this.bodies.map((b) => ({
      kind: b.kind, state: b.state, lod: b.lod,
      pos: b.pos.toArray().map((v) => +v.toFixed(2)),
      vel: b.vel.toArray().map((v) => +v.toFixed(2)),
      angVel: +b.angVel.length().toFixed(2),
      bend: +b.bend.z.toFixed(3), flutter: +b.flutter.toFixed(2)
    }));
  }
}
