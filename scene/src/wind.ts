// Поле ветра (раздел 4.3): фон + порывы + вихри (3D curl noise) + восходящие
// потоки над дорожкой. Трёхмерное: есть составляющая к экрану и от экрана.
// Всё детерминировано по seed, параметры — seasons/autumn.json → wind.
import * as THREE from 'three';
import type { Season } from './config';
import { rng, lerp, smoothstep } from './util';

type WindCfg = Season['wind'];

/** 3D value noise без таблиц — для curl noise. */
function hash3(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise3(x: number, y: number, z: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const c = (dx: number, dy: number, dz: number) => hash3(x0 + dx, y0 + dy, z0 + dz);
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), sx), x10 = lerp(c(0, 1, 0), c(1, 1, 0), sx);
  const x01 = lerp(c(0, 0, 1), c(1, 0, 1), sx), x11 = lerp(c(0, 1, 1), c(1, 1, 1), sx);
  return lerp(lerp(x00, x10, sy), lerp(x01, x11, sy), sz);
}

interface Gust { t0: number; dur: number; speed: number; dir: THREE.Vector3; s0: number; width: number; vFront: number }
interface Vortex { pos: THREE.Vector3; radius: number; strength: number; boost: number; boostEnd: number }

export class Wind {
  time = 0;
  /** текущий фоновый ветер (м/с) */
  readonly base = new THREE.Vector3();
  private baseFrom = new THREE.Vector3();
  private baseTo = new THREE.Vector3();
  private baseT0 = 0;
  private baseT1 = 0;
  private gust: Gust | null = null;
  private nextGust = 0;
  private vortices: Vortex[] = [];
  private r: () => number;
  /** множитель силы ветра из панели: штиль / ветерок / буря */
  strength = 1;

  constructor(readonly cfg: WindCfg, seed = 1, readonly pathHalfWidth = 3) {
    this.r = rng(seed);
    this.pickBase(0);
    this.base.copy(this.baseTo);
    this.baseFrom.copy(this.baseTo);
    this.nextGust = 3 + this.r() * 5;
    for (let i = 0; i < cfg.vortices.count; i++) {
      this.vortices.push({
        pos: new THREE.Vector3((this.r() - 0.5) * 30, 1.5 + this.r() * 4, -4 - this.r() * 20),
        radius: cfg.vortices.radius[0] + this.r() * (cfg.vortices.radius[1] - cfg.vortices.radius[0]),
        strength: cfg.vortices.strength[0] + this.r() * (cfg.vortices.strength[1] - cfg.vortices.strength[0]),
        boost: 1, boostEnd: 0
      });
    }
  }

  private pickBase(now: number) {
    const c = this.cfg.base;
    const ang = (c.direction + (this.r() - 0.5) * 2 * c.spread) * Math.PI / 180;
    const speed = c.speed[0] + this.r() * (c.speed[1] - c.speed[0]);
    // направление: 0° — слева направо (+x), положительный угол — к камере (+z)
    this.baseFrom.copy(this.base);
    this.baseTo.set(Math.cos(ang) * speed, 0, Math.sin(ang) * speed);
    this.baseT0 = now;
    this.baseT1 = now + 6;                                   // плавный переход 6 с
  }

  update(dt: number) {
    this.time += dt;
    const t = this.time, c = this.cfg;
    // фон
    if (t > this.baseT1 + lerp(c.base.period[0], c.base.period[1], this.r())) this.pickBase(t);
    const k = smoothstep(this.baseT0, this.baseT1, t);
    this.base.lerpVectors(this.baseFrom, this.baseTo, k);
    // порывы
    if (!this.gust && t > this.nextGust) {
      const dir = this.base.clone();
      if (dir.lengthSq() < 1e-4) dir.set(1, 0, 0);
      dir.normalize();
      dir.y = 0.12 + this.r() * 0.15;                          // порыв чуть вверх — поднимает лежащие
      dir.normalize();
      const speed = c.gust.speed[0] + this.r() * (c.gust.speed[1] - c.gust.speed[0]);
      this.gust = {
        t0: t, dur: c.gust.duration[0] + this.r() * (c.gust.duration[1] - c.gust.duration[0]),
        speed, dir, s0: -25, width: c.gust.width, vFront: speed * 1.3
      };
    }
    if (this.gust && t > this.gust.t0 + this.gust.dur + 2) {
      this.gust = null;
      this.nextGust = t + c.gust.interval[0] + this.r() * (c.gust.interval[1] - c.gust.interval[0]);
    }
    // вихри дрейфуют с ветром, иногда усиливаются
    for (const v of this.vortices) {
      v.pos.addScaledVector(this.base, dt * 0.5);
      v.pos.x += Math.sin(t * 0.13 + v.radius) * dt * 0.4;
      if (v.pos.x > 22) v.pos.x = -22;
      if (v.pos.x < -22) v.pos.x = 22;
      if (v.pos.z > 2) v.pos.z = -24;
      if (v.pos.z < -26) v.pos.z = -2;
      if (t > v.boostEnd) {
        if (this.r() < dt / c.vortices.boostEvery) { v.boost = 2.2; v.boostEnd = t + 5; } else v.boost = 1;
      }
    }
  }

  /** Скорость ветра в точке. */
  sample(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const c = this.cfg, t = this.time;
    out.copy(this.base);
    // порыв: фронт шириной width движется по направлению ветра
    if (this.gust) {
      const g = this.gust;
      const age = t - g.t0;
      const env = smoothstep(0, 0.6, age) * (1 - smoothstep(g.dur - 0.8, g.dur + 1.5, age));
      const s = p.x * g.dir.x + p.z * g.dir.z;
      const front = g.s0 + g.vFront * age;
      const band = Math.exp(-Math.pow((s - front) / (g.width * 0.5), 2));
      out.addScaledVector(g.dir, g.speed * env * band);
    }
    // вихри: закрутка вокруг вертикальной оси + турбулентность
    for (const v of this.vortices) {
      const dx = p.x - v.pos.x, dz = p.z - v.pos.z, dy = p.y - v.pos.y;
      const r = Math.hypot(dx, dz);
      const fall = Math.exp(-(r * r) / (v.radius * v.radius)) * Math.exp(-(dy * dy) / 16);
      const sw = v.strength * v.boost * fall * (r / v.radius) / Math.max(0.3, r / v.radius);
      out.x += -dz / (r + 0.1) * sw;
      out.z += dx / (r + 0.1) * sw;
      out.y += 0.35 * sw;                                    // вихрь чуть поднимает
    }
    // curl noise — мелкая турбулентность, есть составляющая по z
    const sc = c.turbulence.scale, e = 0.5, tt = t * c.turbulence.speed;
    const px = p.x * sc, py = p.y * sc, pz = p.z * sc;
    const n1 = (x: number, y: number, z: number) => noise3(x + tt, y, z + 11.3);
    const n2 = (x: number, y: number, z: number) => noise3(x + 31.7, y + tt, z);
    const n3 = (x: number, y: number, z: number) => noise3(x, y + 7.1, z + tt);
    const cx = (n3(px, py + e, pz) - n3(px, py - e, pz)) - (n2(px, py, pz + e) - n2(px, py, pz - e));
    const cy = (n1(px, py, pz + e) - n1(px, py, pz - e)) - (n3(px + e, py, pz) - n3(px - e, py, pz));
    const cz = (n2(px + e, py, pz) - n2(px - e, py, pz)) - (n1(px, py + e, pz) - n1(px, py - e, pz));
    out.x += cx * c.turbulence.strength;
    out.y += cy * c.turbulence.strength;
    out.z += cz * c.turbulence.strength;
    // восходящий поток над «тёплой» дорожкой
    const over = Math.exp(-(p.x * p.x) / (this.pathHalfWidth * this.pathHalfWidth * 2));
    out.y += c.updraft * over * smoothstep(0, 2, p.y) * (1 - smoothstep(4, 8, p.y));
    return out.multiplyScalar(this.strength);
  }

  get gustActive(): boolean { return !!this.gust; }
}
