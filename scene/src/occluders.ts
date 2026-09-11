// Заслонки глубины: невидимые тела на месте нарисованных фонарей, скамеек,
// кустов и стволов. Пишут только глубину, поэтому лист, пролетающий позади
// фонаря, скрывается за ним — картина перестаёт быть плоской. Положение
// задаётся в долях экрана (точка касания земли и верх объекта), в метры
// переводится через камеру: луч через точку экрана пересекается с землёй.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Season } from './config';

/** Точка на земле (y = 0) под пикселем экрана (u, v — доли, v сверху). */
export function groundPoint(camera: THREE.PerspectiveCamera, u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  camera.updateMatrixWorld(true);
  const ndc = new THREE.Vector3(u * 2 - 1, 1 - v * 2, 0.5);
  ndc.unproject(camera);
  const dir = ndc.sub(camera.position).normalize();
  const t = -camera.position.y / dir.y;
  return out.copy(camera.position).addScaledVector(dir, Math.max(0.1, t));
}

/** Точка на земле на заданной глубине d (метры вдоль взгляда) под пикселем u:
 *  для стволов, у которых точка касания земли на картине скрыта кустами и лежит
 *  у самого горизонта — пересечение с землёй там дало бы сотни метров. */
export function groundPointAtDepth(camera: THREE.PerspectiveCamera, u: number, d: number, out: THREE.Vector3): THREE.Vector3 {
  camera.updateMatrixWorld(true);
  const ndc = new THREE.Vector3(u * 2 - 1, 0, 0.5).unproject(camera);
  const dir = ndc.sub(camera.position).normalize();
  const along = dir.dot(camera.getWorldDirection(new THREE.Vector3()));
  out.copy(camera.position).addScaledVector(dir, d / along);
  out.y = 0;
  return out;
}

/** Высота объекта по вертикальному размеру на экране на данной глубине. */
export function heightAt(camera: THREE.PerspectiveCamera, base: THREE.Vector3, vTop: number): number {
  // луч через (u_base, vTop) на той же глубине, что и base
  const ndc = new THREE.Vector3(0, 1 - vTop * 2, 0.5).unproject(camera);
  const dir = ndc.sub(camera.position).normalize();
  const depth = base.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3()));
  const along = dir.dot(camera.getWorldDirection(new THREE.Vector3()));
  const p = camera.position.clone().addScaledVector(dir, depth / along);
  return Math.max(0.2, p.y);
}

export function makeOccluders(season: Season, camera: THREE.PerspectiveCamera): THREE.Group {
  const group = new THREE.Group();
  group.name = 'occluders';
  const debug = new URLSearchParams(location.search).get('occ') === '1';
  const mat = debug
    ? new THREE.MeshBasicMaterial({ color: 0xff2080, transparent: true, opacity: 0.35, depthWrite: true })
    : new THREE.MeshBasicMaterial({ colorWrite: false });
  const base = new THREE.Vector3();
  const fwd = camera.getWorldDirection(new THREE.Vector3());
  const camDepth = (p: THREE.Vector3) => p.clone().sub(camera.position).dot(fwd);
  // все заслонки — одна геометрия и один draw call
  const parts: THREE.BufferGeometry[] = [];
  const place = (geo: THREE.BufferGeometry, x: number, y: number, z: number) => { geo.translate(x, y, z); parts.push(geo); };
  for (const o of season.occluders.items) {
    if (o.distance) groundPointAtDepth(camera, o.base[0], o.distance, base);
    else groundPoint(camera, o.base[0], o.base[1], base);
    const h = heightAt(camera, base, o.top);
    // ширина в метрах по доле экрана на этой глубине
    const d = camDepth(base);
    const wMeters = (o.width ?? 0) * 2 * d * Math.tan(camera.fov / 2 * Math.PI / 180) * camera.aspect;
    if (o.type === 'cylinder') {
      const r = o.radius ?? 0.06;
      // bottom — доля экрана, ниже которой ствол скрыт кустами: там заслонка не нужна
      const y0 = o.bottom ? Math.min(h - 0.2, heightAt(camera, base, o.bottom)) : 0;
      place(new THREE.CylinderGeometry(r, y0 > 0 ? r : r * 1.2, h - y0, 10), base.x, (h + y0) / 2, base.z);
      if (o.cap) place(new THREE.BoxGeometry(o.cap, o.cap * 1.3, o.cap), base.x, h - o.cap * 0.65, base.z);   // фонарь: короб лампы
    } else {
      const depth = o.depth ?? 0.6;
      place(new THREE.BoxGeometry(Math.max(0.3, wMeters), h, depth), base.x, h / 2, base.z);
    }
  }
  if (parts.length) {
    const merged = mergeGeometries(parts.map((g) => g.toNonIndexed()));
    for (const g of parts) g.dispose();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.renderOrder = -2;                                    // раньше листьев: глубина уже записана
    mesh.name = 'occluders';
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return group;
}
