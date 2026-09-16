// Точка входа: настройки → миграции → приложение → слушаем порт. Остановка по SIGTERM/SIGINT
// закрывает соединения (docker compose stop даёт 10 с).
import { loadConfig } from './config.js';
import { makeServices, buildApp, closeServices } from './app.js';
import { migrate } from './migrate.js';

const cfg = loadConfig();
const services = makeServices(cfg);
const applied = await migrate(services.db);
const app = await buildApp(services);
if (applied.length) app.log.info(`миграции применены: ${applied.join(', ')}`);
await services.redis.connect().catch((e) => app.log.warn(`redis недоступен при старте: ${(e as Error).message}`));

await app.listen({ port: cfg.port, host: cfg.host });

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    app.log.info(`${sig}: останавливаемся`);
    await app.close();
    await closeServices(services);
    process.exit(0);
  });
}
