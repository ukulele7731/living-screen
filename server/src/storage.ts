// Картинки — папка data/ (раздел 5 server-spec.md): rooms/{code}/leaves/{id}/{tex|thumb|...}.
// Наружу папка не торчит, файлы отдаёт сервер (шаг 3.3). Здесь — пути и проверка для /healthz.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';

export interface Storage {
  root: string;
  minFreeMb: number;
  /** абсолютный путь по ключу; ключ не может выйти за пределы data/ */
  pathFor(key: string): string;
}

export function makeStorage(cfg: Config): Storage {
  const root = cfg.dataDir;
  fs.mkdirSync(path.join(root, 'rooms'), { recursive: true });
  return {
    root,
    minFreeMb: cfg.minFreeMb,
    pathFor(key: string) {
      const p = path.resolve(root, key);
      if (!p.startsWith(root + path.sep)) throw new Error(`недопустимый ключ ${key}`);
      return p;
    }
  };
}

/** Проверка для /healthz: в data/ можно писать, и на диске есть место. */
export async function checkStorage(storage: Storage): Promise<{ freeMb: number }> {
  const probe = path.join(storage.root, `.healthz-${process.pid}`);
  await fsp.writeFile(probe, String(Date.now()));
  await fsp.unlink(probe);
  const st = await fsp.statfs(storage.root);
  const freeMb = Math.floor((st.bavail * st.bsize) / 1024 / 1024);
  if (freeMb < storage.minFreeMb) throw new Error(`на диске ${freeMb} МБ, нужно не меньше ${storage.minFreeMb}`);
  return { freeMb };
}
