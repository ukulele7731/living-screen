// Земля: картина уже нарисована, поэтому плоскость невидима и только ловит
// тени (ветка сейчас, листья на этапе 2.3). Та же плоскость y = 0 — опора
// для физики: на неё лягут листья ковра.
import * as THREE from 'three';
import type { Season } from './config';

export function makeGround(season: Season): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(400, 400);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShadowMaterial({ opacity: season.ground.shadowOpacity, color: 0x3a2410 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.name = 'ground';
  return mesh;
}

/** Высота земли в точке — пока плоскость; ковёр из листьев поднимет её на этапе 5. */
export function groundHeight(_x: number, _z: number): number {
  return 0;
}
