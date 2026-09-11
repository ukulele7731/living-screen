// Лист как твёрдое тело с аэродинамикой (раздел 4.3): {pos, vel, quat, angVel},
// тензор инерции пластины, центр масс сдвинут к черешку. Поверхность
// представлена 9 опорными точками; в каждой — относительная скорость воздуха,
// давление ∝ ρ·|v_rel|²·|dot(n, v̂_rel)| вдоль нормали. Сумма сил даёт
// сопротивление и подъём, сумма моментов — вращение. Режимы падения (зигзаг,
// кувырок, спираль, штопор) получаются сами. Полунеявный Эйлер с подшагами.
import * as THREE from 'three';
import type { Wind } from './wind';
import type { LeafShape } from './leaf-shapes';

export interface AeroCfg {
  gravity: number;
  pressure: number;      // коэффициент давления k: F = k·A·|v|·vn
  leadShift: number;     // смещение центра давления к ведущему краю (0 — нет, 0.8 — сильное): даёт зигзаг и кувырок
  skin: number;          // касательное трение
  angDampQuad: number;   // квадратичное демпфирование вращения
  angDampLin: number;
  maxAngVel: number;
  massOffset: number;    // сдвиг центра масс к черешку, доля длины
  bendGain: number;      // сила → изгиб в шейдере
  groundSpring: number;
  groundDamp: number;
  groundFriction: number;
  restTime: number;      // сколько секунд покоя до «лежит»
  liftSpeed: number;     // ветер, при котором лежащий лист может взлететь
}

export type LeafState = 'fly' | 'settling' | 'ground' | 'fading';

const TMP = {
  v: new THREE.Vector3(), v2: new THREE.Vector3(), w: new THREE.Vector3(), n: new THREE.Vector3(),
  rp: new THREE.Vector3(), f: new THREE.Vector3(), F: new THREE.Vector3(), T: new THREE.Vector3(),
  q: new THREE.Quaternion(), dq: new THREE.Quaternion(), local: new THREE.Vector3(), lowest: new THREE.Vector3(),
  Fn: new THREE.Vector3()
};
const UP = new THREE.Vector3(0, 1, 0);

export class LeafBody {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  readonly angVel = new THREE.Vector3();       // в мировых координатах
  state: LeafState = 'fly';
  restTimer = 0;
  age = 0;
  fade = 1;                                    // 1 — обычный, → 0 при удалении из ковра
  /** выход для шейдера: направление потока в плоскости (x,y) и величина изгиба (z) */
  readonly bend = new THREE.Vector3(0, 1, 0);
  flutter = 0;
  lod = 0;
  slot = 0;
  twist = 0;
  readonly tint = new THREE.Color(1, 1, 1);
  /** опорные точки в локальной системе (x поперёк, y вдоль жилки, z нормаль), относительно центра масс */
  private points: THREE.Vector3[] = [];
  private areaPerPoint: number;
  private halfSpan = 0.1;
  private invI = new THREE.Vector3();          // 1/I по осям (диагональный тензор в локальной системе)
  private I = new THREE.Vector3();
  private geomCenter = new THREE.Vector3();    // геометрический центр листа относительно центра масс (локально)

  constructor(readonly shape: LeafShape, readonly size: number, readonly scale: number, readonly kind: string,
              readonly dry: number, readonly variant: number, readonly phase: number, slot: number, cfg: AeroCfg) {
    this.slot = slot;
    // размеры в метрах: длинная сторона bbox = size·scale
    const L = size * scale;
    const bw = (shape.bbox.x1 - shape.bbox.x0) * L, bh = (shape.bbox.y1 - shape.bbox.y0) * L;
    // жилка в локальных единицах (модель → метры)
    const vb = shape.vein[0], vt = shape.vein[1];
    const ax = (vt[0] - vb[0]) * L, ay = (vt[1] - vb[1]) * L;
    const vl = Math.hypot(ax, ay) || L;
    const ux = ax / vl, uy = ay / vl, px = -uy, py = ux;
    const mid = [(vb[0] + vt[0]) / 2 * L, (vb[1] + vt[1]) / 2 * L];
    // центр масс сдвинут к черешку
    const com = [mid[0] - ux * vl * cfg.massOffset, mid[1] - uy * vl * cfg.massOffset];
    this.geomCenter.set(mid[0] - com[0], mid[1] - com[1], 0);
    const half = vl * 0.5, halfW = Math.min(bw, bh) * 0.5;
    const pts: [number, number][] = [
      [0, 0], [0, 0.55], [0, -0.55], [0.55, 0], [-0.55, 0],          // центр, 4 вдоль жилок (доли half/halfW)
      [0.5, 0.5], [-0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]            // 4 у края
    ];
    for (const [s, t] of pts) {
      const lx = mid[0] + px * s * halfW + ux * t * half, ly = mid[1] + py * s * halfW + uy * t * half;
      this.points.push(new THREE.Vector3(lx - com[0], ly - com[1], 0));
    }
    this.halfSpan = Math.max(half, halfW);
    const area = bw * bh * 0.62;
    this.areaPerPoint = area / this.points.length;
    // пластина: масса 1 (нормировано); тензор по осям локальной системы
    const m = 1;
    this.I.set(m / 12 * bh * bh, m / 12 * bw * bw, m / 12 * (bw * bw + bh * bh));
    this.invI.set(1 / this.I.x, 1 / this.I.y, 1 / this.I.z);
  }

  /** Матрица для рендера: центр геометрии, а не центр масс. */
  writeMatrix(out: THREE.Matrix4) {
    const c = TMP.local.copy(this.geomCenter).applyQuaternion(this.quat).add(this.pos);
    const s = this.scale * this.fade;
    out.compose(c, this.quat, TMP.v.set(s, s, s));
  }

  /** Один подшаг физики. Возвращает высоту самой нижней опорной точки. */
  step(dt: number, wind: Wind, cfg: AeroCfg, groundY: number): number {
    const { v, v2, w, n, rp, f, F, T } = TMP;
    F.set(0, -cfg.gravity, 0);                       // масса 1
    T.set(0, 0, 0);
    n.set(0, 0, 1).applyQuaternion(this.quat);
    let loadN = 0, lowest = Infinity;
    v2.set(0, 0, 0);
    const Fn = TMP.Fn.set(0, 0, 0);                  // суммарная нормальная (давление) сила
    for (const p of this.points) {
      rp.copy(p).applyQuaternion(this.quat);
      // скорость точки = v + ω × r
      v.crossVectors(this.angVel, rp).add(this.vel);
      wind.sample(TMP.lowest.copy(this.pos).add(rp), w);
      v.sub(w);                                      // относительная скорость воздуха (лист относительно воздуха)
      const speed = v.length();
      const vn = v.dot(n);
      // давление: сила против нормальной составляющей потока, ∝ |v|·vn
      const k = cfg.pressure * this.areaPerPoint * speed;
      f.copy(n).multiplyScalar(-k * vn);
      Fn.add(f);
      // касательное трение
      f.addScaledVector(v, -cfg.skin * this.areaPerPoint * speed);
      F.add(f);
      T.add(TMP.local.crossVectors(rp, f));
      loadN += vn * speed;
      v2.add(v);
      const y = this.pos.y + rp.y;
      if (y < lowest) lowest = y;
    }
    // центр давления пластины смещён к ведущему краю на leadShift·полуразмах·cos(угла атаки):
    // сила давления приложена не в центре, а ближе к краю, встречающему поток. Ребром вперёд
    // лист лететь не может — раскачивается, отсюда зигзаг, кувырок и спираль.
    {
      const vr = TMP.lowest.copy(v2).multiplyScalar(1 / this.points.length);   // средняя относительная скорость
      const vrn = vr.dot(n);
      const vt = TMP.local.copy(vr).addScaledVector(n, -vrn);                 // касательная составляющая
      const vtLen = vt.length(), vrLen = vr.length();
      if (vtLen > 1e-4 && vrLen > 1e-4) {
        // ведущий край — в направлении движения листа относительно воздуха (vt), сила там больше
        const shift = cfg.leadShift * this.halfSpan * (vtLen / vrLen);
        vt.multiplyScalar(shift / vtLen);
        // сдвиг центра масс → геометрический центр уже учтён в rp; добавляем момент от переноса силы
        T.add(TMP.f.crossVectors(vt, Fn));
      }
    }
    // земля: мягкий контакт самой нижней точки
    if (lowest < groundY) {
      const pen = groundY - lowest;
      const fy = cfg.groundSpring * pen - cfg.groundDamp * this.vel.y;
      F.y += Math.max(0, fy);
      F.x -= this.vel.x * cfg.groundFriction;
      F.z -= this.vel.z * cfg.groundFriction;
      this.angVel.multiplyScalar(Math.max(0, 1 - dt * 6));
    }
    // интегрирование: скорость, положение
    this.vel.addScaledVector(F, dt);
    this.pos.addScaledVector(this.vel, dt);
    // вращение: момент в локальную систему, ω += I⁻¹(T − ω×Iω)
    const qi = TMP.q.copy(this.quat).invert();
    const Tl = T.applyQuaternion(qi);
    const wl = TMP.w.copy(this.angVel).applyQuaternion(qi);
    const Iw = TMP.f.set(wl.x * this.I.x, wl.y * this.I.y, wl.z * this.I.z);
    Tl.sub(TMP.local.crossVectors(wl, Iw));
    wl.x += Tl.x * this.invI.x * dt; wl.y += Tl.y * this.invI.y * dt; wl.z += Tl.z * this.invI.z * dt;
    // демпфирование вращения: квадратичное сопротивление + линейное
    const wm = wl.length();
    const damp = Math.max(0, 1 - dt * (cfg.angDampLin + cfg.angDampQuad * wm));
    wl.multiplyScalar(damp);
    if (wm > cfg.maxAngVel) wl.multiplyScalar(cfg.maxAngVel / wm);
    this.angVel.copy(wl).applyQuaternion(this.quat);
    // кватернион: q += 0.5·(ω q)·dt
    const a = this.angVel.length() * dt;
    if (a > 1e-6) {
      TMP.dq.setFromAxisAngle(TMP.v.copy(this.angVel).normalize(), a);
      this.quat.premultiply(TMP.dq).normalize();
    }
    // выход для шейдера: изгиб ∝ нормальной нагрузке, направление потока в плоскости листа
    const rel = v2.multiplyScalar(1 / this.points.length).applyQuaternion(qi);
    const relLen = rel.length();
    const load = loadN / this.points.length;
    this.bend.set(rel.x, rel.y, 0);
    if (this.bend.lengthSq() > 1e-6) this.bend.normalize(); else this.bend.set(0, 1, 0);
    this.bend.z = THREE.MathUtils.clamp(-load * cfg.bendGain, -0.35, 0.35);
    this.flutter = THREE.MathUtils.clamp(relLen / 3, 0, 1);
    this.age += dt;
    return lowest;
  }

  /** Лежит: медленно доворачиваем к плоскому положению на земле, ветер может поднять. */
  settle(dt: number) {
    const n = TMP.n.set(0, 0, 1).applyQuaternion(this.quat);
    const target = n.y >= 0 ? UP : TMP.v.set(0, -1, 0);
    TMP.dq.setFromUnitVectors(n, target);
    TMP.q.identity().slerp(TMP.dq, Math.min(1, dt * 2.5));
    this.quat.premultiply(TMP.q).normalize();
    this.vel.multiplyScalar(Math.max(0, 1 - dt * 8));
    this.angVel.multiplyScalar(Math.max(0, 1 - dt * 8));
    this.bend.z *= Math.max(0, 1 - dt * 3);
    this.flutter *= Math.max(0, 1 - dt * 3);
  }

  /** Подъём с земли порывом: сначала приподнимается край. */
  lift(wind: THREE.Vector3, r: () => number) {
    this.state = 'fly';
    this.restTimer = 0;
    const dir = TMP.v.copy(wind).setY(0).normalize();
    // момент вокруг оси, перпендикулярной ветру: подветренный край вверх
    const axis = TMP.w.crossVectors(UP, dir).normalize();
    this.angVel.copy(axis).multiplyScalar(-(3 + r() * 3));
    this.vel.set(wind.x * 0.35, 0.9 + r() * 1.2, wind.z * 0.35);
  }
}
