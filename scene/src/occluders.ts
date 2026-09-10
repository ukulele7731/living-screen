// Заслонки глубины: невидимые тела на месте нарисованных фонарей, скамеек,
// кустов и стволов. Пишут только глубину, поэтому лист, пролетающий позади
// фонаря, скрывается за ним — картина перестаёт быть плоской. Положение
// задаётся в долях экрана (точка касания земли и верх объекта), в метры
// переводится через камеру: луч через точку экрана пересекается с землёй.
import * as THREE from 'three';
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
  for (const o of season.occluders.items) {
    groundPoint(camera, o.base[0], o.base[1], base);
    const h = heightAt(camera, base, o.top);
    // ширина в метрах по доле экрана на этой глубине
    const d = camDepth(base);
    const wMeters = (o.width ?? 0) * 2 * d * Math.tan(camera.fov / 2 * Math.PI / 180) * camera.aspect;
    let mesh: THREE.Mesh;
    if (o.type === 'cylinder') {
      const r = o.radius ?? 0.06;
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.2, h, 10), mat);
      mesh.position.set(base.x, h / 2, base.z);
      if (o.cap) {                                            // фонарь: короб лампы наверху
        const cap = new THREE.Mesh(new THREE.BoxGeometry(o.cap, o.cap * 1.3, o.cap), mat);
        cap.position.set(base.x, h - o.cap * 0.65, base.z);
        group.add(cap);
      }
    } else {
      const depth = o.depth ?? 0.6;
      mesh = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.3, wMeters), h, depth), mat);
      mesh.position.set(base.x, h / 2, base.z);
    }
    mesh.renderOrder = -2;                                    // раньше листьев: глубина уже записана
    mesh.name = 'occ:' + o.name;
    group.add(mesh);
  }
  return group;
}
