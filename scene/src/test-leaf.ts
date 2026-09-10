// Один тестовый лист на дорожке: настоящий рисунок из галереи теста
// распознавания (public/test-leaves/<вид>.png, прошёл через capture.js).
// Лежит в нижней трети кадра, приподнят на скрученном краю — видно тень.
import * as THREE from 'three';
import type { Season } from './config';
import { LEAF_SHAPES } from './leaf-shapes';
import { LeafBatch } from './leaves';
import { atlasFromImage } from './leaf-textures';
import { groundPoint } from './occluders';

export async function makeTestLeaf(season: Season, camera: THREE.PerspectiveCamera, base: string): Promise<LeafBatch> {
  const t = season.testLeaf;
  const shape = LEAF_SHAPES[t.kind];
  const sp = season.leaves.species[t.kind as keyof typeof season.leaves.species];
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('нет текстуры ' + t.texture));
    im.src = base + t.texture;
  });
  const size = season.leaves.baseSize * sp.size;
  const atlas = atlasFromImage(img, shape, size * 1000);
  const batch = new LeafBatch(shape, atlas, sp.profile, 1, { size, translucency: season.leaves.translucency });
  const pos = groundPoint(camera, t.screen[0], t.screen[1], new THREE.Vector3());
  pos.y += t.lift;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2 + t.tilt, t.yaw, 0, 'YXZ'));
  const m = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(t.scale, t.scale, t.scale));
  batch.set(0, { matrix: m, dry: t.dry, twist: 0, flutter: 0, phase: 0, variant: 0, bend: new THREE.Vector3(0, 1, 0) });
  batch.commit();
  return batch;
}
