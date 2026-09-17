// Раздача страниц самим Node — только для разработки без Docker (WWW_DIR=../server/www).
// В бою страницы отдаёт Caddy (см. Caddyfile), а сюда приходят только /api, /ws, /files.
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Services } from '../app.js';

export async function staticRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const www = s.cfg.wwwDir;
  if (!www || !fs.existsSync(www)) return;
  // wildcard: false — маршрут на каждый файл www/ (в том числе /tv/, /r/app.js, /vendor/capture.js)
  await app.register(fastifyStatic, { root: www, prefix: '/', wildcard: false, index: ['index.html'] });
  app.get('/tv', async (_req, reply) => reply.redirect('/tv/'));
  app.get('/rules', async (_req, reply) => reply.sendFile('rules.html', www));
  app.get('/r/*', async (_req, reply) => reply.sendFile('index.html', path.join(www, 'r')));
  app.log.info(`статика: ${www}`);
}
