// Манифесты контуров по сезонам (seasons/<сезон>/manifest.json — копия assets/coloring/manifest.json,
// см. README) и раскраски PDF. Сервер не импортирует из tools/ и scene/: общий контракт — сам файл.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Fish {
  name: string; title: string;
  contourModel: [number, number][];
  bboxModel: { z: [number, number]; y: [number, number] };
  vein?: [[number, number], [number, number]];
}
export interface Manifest { version?: number; sheet: unknown; fish: Fish[] }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'seasons');
const cache = new Map<string, Manifest>();

export function manifestFor(season: string): Manifest | null {
  if (!/^[a-z]+$/.test(season)) return null;
  const hit = cache.get(season);
  if (hit) return hit;
  const file = path.join(ROOT, season, 'manifest.json');
  if (!fs.existsSync(file)) return null;
  const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
  cache.set(season, m);
  return m;
}

export function sheetsPdfFor(season: string): string | null {
  if (!/^[a-z]+$/.test(season)) return null;
  const file = path.join(ROOT, season, 'sheets.pdf');
  return fs.existsSync(file) ? file : null;
}

export function fishFor(season: string, kind: string): Fish | null {
  return manifestFor(season)?.fish.find((f) => f.name === kind) ?? null;
}
