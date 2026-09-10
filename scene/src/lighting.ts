// Свет — самое важное. Низкое осеннее солнце впереди-сбоку (листья будут
// просвечивать), холодный заполняющий свет от неба сверху и тёплый отражённый
// от земли снизу, мягкие тени 2048 PCF.
import * as THREE from 'three';
import type { Season } from './config';
import { sunDirection } from './util';

export interface Lighting {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sunDir: THREE.Vector3;
  group: THREE.Group;
}

export function makeLighting(season: Season): Lighting {
  const group = new THREE.Group();
  group.name = 'lighting';
  const sunDir = sunDirection(season.sun.azimuth, season.sun.elevation);

  const sun = new THREE.DirectionalLight(new THREE.Color(season.sun.color), season.sun.intensity);
  sun.target.position.set(0, 1.5, -7);
  sun.position.copy(sun.target.position).addScaledVector(sunDir, 90);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const cam = sun.shadow.camera;
  cam.left = -14; cam.right = 14; cam.top = 14; cam.bottom = -14;
  cam.near = 20; cam.far = 200;
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 4;
  group.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(
    new THREE.Color(season.hemisphere.sky), new THREE.Color(season.hemisphere.ground), season.hemisphere.intensity);
  hemi.position.set(0, 50, 0);
  group.add(hemi);

  return { sun, hemi, sunDir, group };
}
