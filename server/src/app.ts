// Сборка Fastify-приложения: сервисы (база, папка данных) и маршруты.
// Отдельно от index.ts, чтобы тесты поднимали приложение без сети (app.inject).
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { makeDb, type Db } from './db.js';
import { makeStorage, type Storage } from './storage.js';
import { healthRoutes } from './routes/health.js';

export interface Services {
  cfg: Config;
  db: Db;
  storage: Storage;
  version: string;
}

export function makeServices(cfg: Config): Services {
  return { cfg, db: makeDb(cfg), storage: makeStorage(cfg), version: process.env.npm_package_version ?? '0.1.0' };
}

export async function buildApp(services: Services): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: services.cfg.logLevel },
    trustProxy: true,                 // за Caddy: реальный адрес клиента из X-Forwarded-For (лимиты по адресу)
    bodyLimit: 4 * 1024 * 1024        // текстура листа до 3 МБ плюс поля формы
  });
  app.decorate('services', services);
  await healthRoutes(app, services);
  app.setErrorHandler((err: FastifyError, req, reply) => {
    req.log.error(err);
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({ error: status === 500 ? 'Внутренняя ошибка сервера' : err.message });
  });
  app.setNotFoundHandler((_req, reply) => { reply.code(404).send({ error: 'Не найдено' }); });
  return app;
}

export function closeServices(services: Services): void {
  services.db.close();
}

declare module 'fastify' {
  interface FastifyInstance { services: Services }
}
