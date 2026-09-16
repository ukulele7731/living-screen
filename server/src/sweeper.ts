// Уборка по расписанию: просроченные комнаты (сутки без листьев, год с последнего листа).
// Коды привязки чистятся при обращении. Запуск раз в 10 минут, первый — через минуту после старта.
import type { Services } from './app.js';

export function startSweeper(s: Services, log: { info: (m: string) => void; error: (m: string) => void }, intervalMs = 10 * 60_000): () => void {
  const run = () => {
    try {
      const gone = s.rooms.sweepExpired();
      if (gone.length) log.info(`удалены просроченные комнаты: ${gone.join(', ')}`);
    } catch (e) { log.error(`уборка: ${(e as Error).message}`); }
  };
  const t = setInterval(run, intervalMs);
  t.unref();
  const first = setTimeout(run, Math.min(60_000, intervalMs));
  first.unref();
  return () => { clearInterval(t); clearTimeout(first); };
}
