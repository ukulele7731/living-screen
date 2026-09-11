// Менеджер листьев: пакеты по видам и уровням детализации, спавн, физика с
// подшагами, ковёр (лежащие листья, лимит и вытеснение старых), повторный
// взлёт порывом. Уровень детализации — по расстоянию до камеры: близкие
// листья 24 сегмента с торцом, средние 12, дальние 6 без торца.
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
  kind?: string;
  pos?: THREE.Vector3;
  vel?: THREE.Vector3;
  variant?: number;
  dry?: number;
  scale?: number;
}

const LODS = [
  { segments: 24, noRim: false },
  { segments: 12, noRim: false },
  { segments: 6, noRim: true }
];

interface KindSet { atlas: LeafAtlas; batches: LeafBatch[]; free: number[][] }

export class LeafField {
  readonly group = new THREE.Group();
  readonly kinds = new Map<string, KindSet>();
  readonly bodies: LeafBody[] = [];
  private r: () => number;
  private aero: AeroCfg;
  private m = new THREE.Matrix4();
  private tmp = new THREE.Vector3();
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
          size, translucency: cfg.translucency, segments: lod.segments, noRim: lod.noRim, rim: cfg.rim
        });
        this.group.add(b.mesh);
        return b;
      });
      const free = LODS.map(() => Array.from({ length: cap }, (_, i) => cap - 1 - i));
      this.kinds.set(kind, { atlas, batches, free });
    }
    this.group.name = 'leafField';
  }

  get aeroCfg(): AeroCfg { return this.aero; }

  /** Случайная точка в объёме полёта: по всей глубине кадра, ширина — по перспективе. */
  randomSpawnPoint(out: THREE.Vector3): THREE.Vector3 {
    const f = this.season.field;
    const z = -(f.depth[0] + Math.pow(this.r(), 1.6) * (f.depth[1] - f.depth[0]));   // ближе к камере — чаще
    const halfW = Math.abs(z) * f.halfWidthPerDepth + 1;
    out.set((this.r() * 2 - 1) * halfW, f.spawnHeight[0] + this.r() * (f.spawnHeight[1] - f.spawnHeight[0]), z);
    return out;
  }

  private lodFor(body: LeafBody): number {
    const d = body.pos.distanceTo(this.camera.position);
    const t = this.season.field.lodDistance;
    // гистерезис: уровень меняется только при заметном пересечении порога
    if (body.lod === 0) return d > t[0] * 1.15 ? (d > t[1] * 1.15 ? 2 : 1) : 0;
    if (body.lod === 1) return d < t[0] * 0.85 ? 0 : d > t[1] * 1.15 ? 2 : 1;
    return d < t[1] * 0.85 ? (d < t[0] * 0.85 ? 0 : 1) : 2;
  }

  private takeSlot(kind: string, lod: number): number {
    const set = this.kinds.get(kind)!;
    for (let l = lod; l < LODS.length; l++) {              // нет места — берём уровень грубее
      const free = set.free[l];
      if (free.length) { return l * 100000 + free.pop()!; }
    }
    return -1;
  }

  spawn(opts: SpawnOptions = {}): LeafBody | null {
    const kind = opts.kind ?? LEAF_KINDS[Math.floor(this.r() * LEAF_KINDS.length)];
    const set = this.kinds.get(kind);
    if (!set) return null;
    const sp = this.season.leaves.species[kind as keyof typeof this.season.leaves.species];
    const scale = opts.scale ?? (0.85 + this.r() * 0.35);
    const pos = opts.pos ?? this.randomSpawnPoint(this.tmp);
    const wantLod = pos.distanceTo(this.camera.position) < this.season.field.lodDistance[0] ? 0
      : pos.distanceTo(this.camera.position) < this.season.field.lodDistance[1] ? 1 : 2;
    const packed = this.takeSlot(kind, wantLod);
    if (packed < 0) return null;
    const lod = Math.floor(packed / 100000), slot = packed % 100000;
    const body = new LeafBody(LEAF_SHAPES[kind], this.season.leaves.baseSize * sp.size, scale, kind,
      opts.dry ?? this.r() * 0.8, opts.variant ?? Math.floor(this.r() * set.atlas.variants), this.r() * 6.28, slot, this.aero);
    body.lod = lod;
    body.pos.copy(pos);
    if (opts.vel) body.vel.copy(opts.vel); else body.vel.set((this.r() - 0.5) * 0.6, -0.2, (this.r() - 0.5) * 0.4);
    body.quat.setFromEuler(new THREE.Euler(this.r() * 6.28, this.r() * 6.28, this.r() * 6.28));
    body.angVel.set((this.r() - 0.5) * 3, (this.r() - 0.5) * 3, (this.r() - 0.5) * 3);
    body.twist = (this.r() - 0.5) * 0.4;
    body.tint.setHSL(0.08 + this.r() * 0.06, 0.5, 0.55).lerp(new THREE.Color(1, 1, 1), 0.7);
    this.bodies.push(body);
    this.writeFull(body);
    this.stats.spawned++;
    return body;
  }

  private writeFull(body: LeafBody) {
    const batch = this.kinds.get(body.kind)!.batches[body.lod];
    body.writeMatrix(this.m);
    batch.set(body.slot, {
      matrix: this.m, dry: body.dry, twist: body.twist, flutter: body.flutter, phase: body.phase,
      variant: body.variant, bend: body.bend, color: body.tint
    });
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
    if (packed < 0) return;
    this.release(body);
    body.lod = Math.floor(packed / 100000);
    body.slot = packed % 100000;
    this.writeFull(body);
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
    for (const b of this.bodies.slice()) {
      if (b.state === 'fly') {
        for (let s = 0; s < sub; s++) {
          const gy = groundHeight(b.pos.x, b.pos.z);
          const lowest = b.step(h, this.wind, cfg, gy);
          const slow = b.vel.lengthSq() < 0.04 && b.angVel.lengthSq() < 0.3;
          if (lowest < gy + 0.03 && slow) b.restTimer += h; else b.restTimer = 0;
        }
        if (b.restTimer > cfg.restTime) { b.state = 'ground'; b.restTimer = 0; }
        // улетел далеко — убираем
        if (b.pos.y < -2 || Math.abs(b.pos.x) > 60 || b.pos.z > 4 || b.pos.z < -80) { this.remove(b); continue; }
        flying++;
      } else if (b.state === 'ground') {
        b.settle(dt);
        ground++;
        // порыв поднимает лежащие: сначала край, потом весь лист
        this.wind.sample(b.pos, windAt);
        const wl = Math.hypot(windAt.x, windAt.z);
        if (wl > cfg.liftSpeed && this.r() < dt * (wl - cfg.liftSpeed) * 0.8) b.lift(windAt, this.r);
      } else if (b.state === 'fading') {
        b.fade -= dt;
        if (b.fade <= 0) { this.remove(b); continue; }
      }
      this.relod(b);
    }
    // ковёр: лимит лежащих — самые старые уходят «под верхние»
    if (ground > f.maxGround) {
      let extra = ground - f.maxGround;
      for (const b of this.bodies) {
        if (extra <= 0) break;
        if (b.state === 'ground') { b.state = 'fading'; extra--; }
      }
    }
    this.stats.flying = flying;
    this.stats.ground = ground;
    // матрицы в пакеты
    let tris = 0;
    for (const b of this.bodies) {
      b.writeMatrix(this.m);
      const batch = this.kinds.get(b.kind)!.batches[b.lod];
      batch.setMotion(b.slot, this.m, b.bend, b.flutter);
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
