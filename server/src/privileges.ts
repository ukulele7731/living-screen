// Контейнер стартует от root, чтобы поправить права на bind-mount папку data/ (её создаёт
// Docker от root), и сразу сбрасывает привилегии до пользователя node (uid 1000 в официальном
// образе). Без Docker, от обычного пользователя, ничего не делает.
import fs from 'node:fs';
import path from 'node:path';

export function dropPrivileges(dataDir: string, log: (m: string) => void): void {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const uid = Number(process.env.RUN_AS_UID ?? 1000), gid = Number(process.env.RUN_AS_GID ?? 1000);
  fs.mkdirSync(path.join(dataDir, 'rooms'), { recursive: true });
  // только верхний уровень и файлы базы: рекурсивно по 50 ГБ рисунков при каждом старте — долго,
  // а они и так создаются уже от нужного пользователя
  const fix = (p: string) => { try { fs.chownSync(p, uid, gid); } catch { /* нет файла — не страшно */ } };
  fix(dataDir);
  fix(path.join(dataDir, 'rooms'));
  for (const f of fs.readdirSync(dataDir)) if (f.startsWith('db.sqlite')) fix(path.join(dataDir, f));
  process.setgid?.(gid);
  process.setuid?.(uid);
  log(`права на ${dataDir} выставлены, работаем от uid ${uid}`);
}
