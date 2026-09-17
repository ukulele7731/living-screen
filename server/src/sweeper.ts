// Уборка по расписанию: просроченные комнаты (сутки без листьев, год с последнего листа).
// Коды привязки чистятся при обращении. Запуск раз в 10 минут, первый — через минуту после старта.
import fs from 'node:fs/promises';
import type { Services } from './app.js';

export function startSweeper(s: Services, log: { info: (m: string) => void; error: (m: string) => void }, intervalMs = 10 * 60_000): () => void {
  const run = async () => {
    try {
      const gone = s.rooms.sweepExpired((code) => { void fs.rm(s.storage.pathFor(`rooms/${code}`), { recursive: true, force: true }); });
      if (gone.length) log.info(`удалены просроченные комнаты: ${gone.join(', ')}`);
      const origs = await s.leaves.sweepOriginals();
      if (origs) log.info(`удалены оригиналы старше 7 дней: ${origs}`);
    } catch (e) { log.error(`уборка: ${(e as Error).message}`); }
  };
  const t = setInterval(() => { void run(); }, intervalMs);
  t.unref();
  const first = setTimeout(() => { void run(); }, Math.min(60_000, intervalMs));
  first.unref();
  return () => { clearInterval(t); clearTimeout(first); };
}
