// Точка входа: настройки → база и миграции → приложение → слушаем порт. Остановка по
// SIGTERM/SIGINT закрывает базу (docker compose stop даёт 10 с).
import { loadConfig } from './config.js';
import { makeServices, buildApp, closeServices } from './app.js';
import { migrate } from './migrate.js';

const cfg = loadConfig();
const services = makeServices(cfg);
const applied = migrate(services.db);
const app = await buildApp(services);
app.log.info(`данные: ${cfg.dataDir}`);
if (applied.length) app.log.info(`миграции применены: ${applied.join(', ')}`);

await app.listen({ port: cfg.port, host: cfg.host });

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    app.log.info(`${sig}: останавливаемся`);
    await app.close();
    closeServices(services);
    process.exit(0);
  });
}
