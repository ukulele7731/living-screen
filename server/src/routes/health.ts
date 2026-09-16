// GET /healthz — база, запись в data/, свободное место (раздел 10.2 server-spec.md). Любой
// отказ — 503 с подробностями, чтобы мониторинг и бот админа видели, что именно упало.
import type { FastifyInstance } from 'fastify';
import { checkDb } from '../db.js';
import { checkStorage } from '../storage.js';
import type { Services } from '../app.js';

type Check = { ok: true; ms: number; freeMb?: number } | { ok: false; ms: number; error: string };

async function run(fn: () => Promise<{ freeMb?: number } | void> | void): Promise<Check> {
  const t0 = performance.now();
  try {
    const r = await fn();
    return { ok: true, ms: Math.round(performance.now() - t0), ...(r && r.freeMb !== undefined ? { freeMb: r.freeMb } : {}) };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), error: (e as Error).message };
  }
}

export async function healthRoutes(app: FastifyInstance, services: Services): Promise<void> {
  app.get('/healthz', async (_req, reply) => {
    const [db, storage] = await Promise.all([
      run(() => checkDb(services.db)),
      run(() => checkStorage(services.storage))
    ]);
    const ok = db.ok && storage.ok;
    reply.code(ok ? 200 : 503);
    return { ok, checks: { db, storage }, version: services.version, uptime: Math.round(process.uptime()) };
  });
}
