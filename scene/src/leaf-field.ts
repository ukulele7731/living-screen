// Менеджер листьев: пакеты по видам, спавн, физика с подшагами, ковёр
// (лежащие листья, лимит и вытеснение старых), повторный взлёт порывом.
import * as THREE from 'three';
import type { Season } from './config';
import { rng } from './util';
import { LeafBatch } from './leaves';
import { LEAF_SHAPES, LEAF_KINDS } from './leaf-shapes';
import { paintLeafAtlas } from './leaf-textures';
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

export class LeafField {
  readonly group = new THREE.Group();
  readonly batches = new Map<string, LeafBatch>();
  readonly bodies: LeafBody[] = [];
  private free = new Map<string, number[]>();
  private r: () => number;
  private aero: AeroCfg;
  private m = new THREE.Matrix4();
  private tmp = new THREE.Vector3();
  /** статистика для dev-панели */
  stats = { flying: 0, ground: 0, spawned: 0 };

  constructor(readonly season: Season, readonly wind: Wind, seed = 1) {
    this.r = rng(seed);
    this.aero = season.physics as AeroCfg;
    const cfg = season.leaves;
    const cap = season.field.capacityPerKind;
    for (const kind of LEAF_KINDS) {
      const shape = LEAF_SHAPES[kind];
      const sp = cfg.species[kind as keyof typeof cfg.species];
      const atlas = paintLeafAtlas(shape, sp.palettes, 90 + kind.length, cfg.baseSize * sp.size * 1000);
      const batch = new LeafBatch(shape, atlas, sp.profile, cap, { size: cfg.baseSize * sp.size, translucency: cfg.translucency });
      this.batches.set(kind, batch);
      this.free.set(kind, Array.from({ length: cap }, (_, i) => cap - 1 - i));
      this.group.add(batch.mesh);
    }
    this.group.name = 'leafField';
  }

  get aeroCfg(): AeroCfg { return this.aero; }

  /** Случайная точка в объёме полёта: по всей глубине кадра, ширина — по перспективе. */
  randomSpawnPoint(out: THREE.Vector3): THREE.Vector3 {
    const f = this.season.field;
    const z = -(f.depth[0] + Math.pow(this.r(), 0.8) * (f.depth[1] - f.depth[0]));
    const halfW = Math.abs(z) * f.halfWidthPerDepth + 1;
    out.set((this.r() * 2 - 1) * halfW, f.spawnHeight[0] + this.r() * (f.spawnHeight[1] - f.spawnHeight[0]), z);
    return out;
  }

  spawn(opts: SpawnOptions = {}): LeafBody | null {
    const kind = opts.kind ?? LEAF_KINDS[Math.floor(this.r() * LEAF_KINDS.length)];
    const batch = this.batches.get(kind);
    const free = this.free.get(kind);
    if (!batch || !free || !free.length) return null;
    const slot = free.pop()!;
    const sp = this.season.leaves.species[kind as keyof typeof this.season.leaves.species];
    const scale = opts.scale ?? (0.85 + this.r() * 0.35);
    const body = new LeafBody(LEAF_SHAPES[kind], this.season.leaves.baseSize * sp.size, scale, kind,
      opts.dry ?? this.r() * 0.8, opts.variant ?? Math.floor(this.r() * batch.atlas.variants), this.r() * 6.28, slot, this.aero);
    body.pos.copy(opts.pos ?? this.randomSpawnPoint(this.tmp));
    if (opts.vel) body.vel.copy(opts.vel); else body.vel.set((this.r() - 0.5) * 0.6, -0.2, (this.r() - 0.5) * 0.4);
    body.quat.setFromEuler(new THREE.Euler(this.r() * 6.28, this.r() * 6.28, this.r() * 6.28));
    body.angVel.set((this.r() - 0.5) * 3, (this.r() - 0.5) * 3, (this.r() - 0.5) * 3);
    this.bodies.push(body);
    body.writeMatrix(this.m);
    batch.set(slot, {
      matrix: this.m, dry: body.dry, twist: (this.r() - 0.5) * 0.4, flutter: 0, phase: body.phase,
      variant: body.variant, bend: body.bend,
      color: new THREE.Color().setHSL(0.08 + this.r() * 0.06, 0.5, 0.55).lerp(new THREE.Color(1, 1, 1), 0.7)
    });
    this.stats.spawned++;
    return body;
  }

  private remove(body: LeafBody) {
    const i = this.bodies.indexOf(body);
    if (i >= 0) this.bodies.splice(i, 1);
    const batch = this.batches.get(body.kind)!;
    this.m.makeScale(0, 0, 0);
    batch.setMotion(body.slot, this.m, body.bend, 0);
    this.free.get(body.kind)!.push(body.slot);
  }

  /** Физика: dt кадра делится на подшаги. */
  step(dt: number) {
    const cfg = this.aero, f = this.season.field;
    const sub = f.substeps, h = dt / sub;
    const windAt = this.tmp;
    let ground = 0, flying = 0;
    for (const b of this.bodies) {
      if (b.state === 'fly' || b.state === 'settling') {
        for (let s = 0; s < sub; s++) {
          const gy = groundHeight(b.pos.x, b.pos.z);
          const lowest = b.step(h, this.wind, cfg, gy);
          const slow = b.vel.lengthSq() < 0.04 && b.angVel.lengthSq() < 0.3;
          if (lowest < gy + 0.03 && slow) b.restTimer += h; else b.restTimer = 0;
        }
        if (b.restTimer > cfg.restTime) { b.state = 'ground'; b.restTimer = 0; }
        // улетел далеко — убираем
        if (b.pos.y < -2 || Math.abs(b.pos.x) > 60 || b.pos.z > 6 || b.pos.z < -80) { this.remove(b); continue; }
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
    for (const b of this.bodies) {
      b.writeMatrix(this.m);
      this.batches.get(b.kind)!.setMotion(b.slot, this.m, b.bend, b.flutter);
    }
    for (const batch of this.batches.values()) batch.commit();
  }

  update(time: number) {
    for (const batch of this.batches.values()) batch.update(time);
  }

  get flyingCount(): number { return this.stats.flying; }
}
