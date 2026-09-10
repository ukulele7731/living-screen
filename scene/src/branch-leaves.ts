// Листва на ветке среднего плана: «исходные» нарисованные листья на концах
// веточек. Пока статичны (лёгкий флаттер), ветер подхватит их на этапе 2.3;
// на этапе 5 отсюда будут срываться новые листья.
import * as THREE from 'three';
import type { Season } from './config';
import { rng } from './util';
import { LeafBatch } from './leaves';
import { LEAF_SHAPES } from './leaf-shapes';
import { paintLeafAtlas } from './leaf-textures';
import type { TwigTip } from './midTrees';

export interface BranchLeaves {
  batches: LeafBatch[];
  update(time: number): void;
}

export function makeBranchLeaves(season: Season, tips: TwigTip[]): BranchLeaves {
  const cfg = season.leaves;
  const bl = cfg.branch;
  const shape = LEAF_SHAPES[bl.kind];
  const sp = cfg.species[bl.kind as keyof typeof cfg.species];
  const atlas = paintLeafAtlas(shape, sp.palettes, 77, cfg.baseSize * sp.size * 1000);
  const r = rng(bl.seed);
  const perTip = bl.perTip;
  const batch = new LeafBatch(shape, atlas, sp.profile, tips.length * perTip, { size: cfg.baseSize * sp.size, translucency: cfg.translucency, segments: bl.segments });

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion(), axis = new THREE.Vector3();
  const color = new THREE.Color();
  let i = 0;
  for (const tip of tips) {
    for (let k = 0; k < perTip; k++) {
      if (r() > bl.density) continue;
      // лист висит на черешке у конца веточки: кончик листа вниз-наружу
      const dir = tip.dir.clone();
      dir.y -= 0.9 + r() * 0.8;                       // повисает
      dir.normalize();
      // локальная ось листа y (черешок→кончик) вдоль −dir (кончик от ветки), т.е. лист «растёт» от точки крепления
      q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().negate());
      // случайный поворот вокруг своей оси и небольшой наклон
      axis.copy(dir);
      tmpQ.setFromAxisAngle(axis, r() * Math.PI * 2);
      q.premultiply(tmpQ);
      const sc = 0.8 + r() * 0.5;
      s.set(sc, sc, sc);
      // черешок: лист чуть отступает от точки крепления вдоль dir
      p.copy(tip.pos).addScaledVector(dir, cfg.baseSize * sp.size * 0.55 * sc + (k > 0 ? 0.04 : 0));
      // сдвигаем так, чтобы основание листа (y = −0.5 в единицах листа) было у черешка
      m.compose(p, q, s);
      color.setHSL(0, 0, 1).lerp(new THREE.Color().setHSL(0.03 + r() * 0.1, 0.6, 0.6), 0.25);
      batch.set(i++, {
        matrix: m, color,
        dry: r() * 0.5, twist: (r() - 0.5) * 0.6, flutter: 0.3 + r() * 0.5, phase: r() * 6.28,
        variant: Math.floor(r() * atlas.variants)
      });
    }
  }
  batch.commit();
  return {
    batches: [batch],
    update(time) { batch.update(time); }
  };
}
