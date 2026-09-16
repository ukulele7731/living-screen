// Сборка Fastify-приложения: сервисы (база, папка данных) и маршруты.
// Отдельно от index.ts, чтобы тесты поднимали приложение без сети (app.inject).
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { Config } from './config.js';
import { makeDb, type Db } from './db.js';
import { makeStorage, type Storage } from './storage.js';
import { Rooms } from './rooms.js';
import { RateLimiter } from './rate-limit.js';
import { ApiError } from './errors.js';
import { healthRoutes } from './routes/health.js';
import { roomRoutes } from './routes/rooms.js';
import { screenRoutes } from './routes/screens.js';

export interface Services {
  cfg: Config;
  db: Db;
  storage: Storage;
  rooms: Rooms;
  limiter: RateLimiter;
  /** текущее время — подменяется в тестах (сроки жизни, TTL кодов) */
  now: () => number;
  version: string;
}

export function makeServices(cfg: Config, now: () => number = Date.now): Services {
  const db = makeDb(cfg);
  return {
    cfg, db, storage: makeStorage(cfg), rooms: new Rooms(db, now), limiter: new RateLimiter(now), now,
    version: process.env.npm_package_version ?? '0.1.0'
  };
}

export async function buildApp(services: Services): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: services.cfg.logLevel },
    trustProxy: true,                 // за Caddy: реальный адрес клиента из X-Forwarded-For (лимиты по адресу)
    bodyLimit: 4 * 1024 * 1024        // текстура листа до 3 МБ плюс поля формы
  });
  app.decorate('services', services);
  await app.register(cookie);
  await healthRoutes(app, services);
  await roomRoutes(app, services);
  await screenRoutes(app, services);
  app.setErrorHandler((err: FastifyError | ApiError, req, reply) => {
    if (err instanceof ApiError) {
      if (err.statusCode === 429 && err.extra?.retryAfterSec) reply.header('retry-after', String(err.extra.retryAfterSec));
      reply.code(err.statusCode).send({ error: err.message, ...(err.extra ?? {}) });
      return;
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
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
