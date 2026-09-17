// Загрузка, список, удаление листьев; раздача файлов; манифест и раскраски (раздел 6).
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import type { Services } from '../app.js';
import { actorFor } from '../auth.js';
import { badRequest, forbidden, notFound, tooMany } from '../errors.js';
import { fishFor, manifestFor, sheetsPdfFor } from '../manifests.js';
import { processLeafImage } from '../leaf-image.js';
import { MAX_LEAVES_PER_ROOM } from '../leaves.js';
import { HOUR } from '../rate-limit.js';
import { tokenHash } from '../codes.js';

export const LEAF_LIMITS = { uploadsPerHour: 60, textureBytes: 3 * 1024 * 1024, nameChars: 20 };
const BAD_NAME = /[<>]|[\p{Cc}]/u;   // управляющие символы и угловые скобки

export async function leafRoutes(app: FastifyInstance, s: Services): Promise<void> {
  await app.register(multipart, { limits: { fileSize: LEAF_LIMITS.textureBytes, files: 1, fields: 5 } });

  // Гость (и владелец) добавляет лист: multipart {texture, kind, name}
  app.post<{ Params: { code: string } }>('/api/rooms/:code/leaves', async (req, reply) => {
    const a = actorFor(req, reply, s);
    const key = `upload:${req.ip}`;
    if (!s.limiter.take(key, LEAF_LIMITS.uploadsPerHour, HOUR)) throw tooMany('Слишком много листьев за час с этого адреса', s.limiter.retryAfterSec(key, HOUR));
    if (!req.isMultipart()) throw badRequest('Ожидается форма multipart с полями texture, kind, name');
    let texture: Buffer | null = null, kind = '', name = '';
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'texture') { await part.toBuffer(); continue; }
        try { texture = await part.toBuffer(); }
        catch (e) { if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw badRequest('Картинка больше 3 МБ'); throw e; }
      } else if (part.fieldname === 'kind') kind = String(part.value).trim();
      else if (part.fieldname === 'name') name = String(part.value).trim();
    }
    if (!texture) throw badRequest('Нет картинки: поле texture');
    if (texture.length > LEAF_LIMITS.textureBytes) throw badRequest('Картинка больше 3 МБ');
    const fish = fishFor(a.room.season, kind);
    if (!fish) throw badRequest(`Неизвестный вид листа «${kind}» для сезона ${a.room.season}`);
    if ([...name].length > LEAF_LIMITS.nameChars) throw badRequest(`Имя длиннее ${LEAF_LIMITS.nameChars} символов`);
    if (BAD_NAME.test(name)) throw badRequest('В имени недопустимые символы');
    if (s.leaves.count(a.room) >= MAX_LEAVES_PER_ROOM) throw badRequest(`В комнате уже ${MAX_LEAVES_PER_ROOM} листьев — удалите старые или сбросьте комнату`);

    let processed;
    try { processed = await processLeafImage(texture, fish); }
    catch (e) { throw badRequest(`Картинка не подходит: ${(e as Error).message}`); }
    const leaf = await s.leaves.add(a.room, kind, name, a.guestToken, processed, texture);
    const view = s.leaves.view(leaf);
    const notified = s.hub.broadcast(a.room.id, { type: 'leaf.new', leaf: view });
    reply.code(201);
    return { ...view, screens_notified: notified };
  });

  app.get<{ Params: { code: string } }>('/api/rooms/:code/leaves/mine', async (req, reply) => {
    const a = actorFor(req, reply, s);
    return s.leaves.mine(a.room, a.guestToken).map((l) => s.leaves.view(l));
  });

  app.delete<{ Params: { code: string; id: string } }>('/api/rooms/:code/leaves/:id', async (req, reply) => {
    const a = actorFor(req, reply, s);
    const leaf = s.leaves.byId(a.room, req.params.id);
    if (!leaf || leaf.deleted_at) throw notFound('Такого листа нет');
    const own = leaf.author_token_hash === tokenHash(a.guestToken);
    if (!own && !a.owner) throw forbidden('Удалить можно только свой лист; владелец комнаты может удалить любой');
    await s.leaves.remove(a.room, leaf);
    s.hub.broadcast(a.room.id, { type: 'leaf.deleted', id: leaf.id });
    return { ok: true };
  });

  // Файлы листьев: только tex/thumb/normal/thick живых листьев. Имена уникальны — кэшировать можно вечно.
  app.get<{ Params: { '*': string } }>('/files/*', async (req, reply) => {
    const key = req.params['*'];
    if (!s.leaves.fileAllowed(key)) throw notFound('Файла нет');
    const file = s.storage.pathFor(key);
    if (!fs.existsSync(file)) throw notFound('Файла нет');
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    reply.type('image/webp');
    return reply.send(fs.createReadStream(file));
  });

  // Манифест контуров для capture.js и раскраски
  app.get<{ Querystring: { season?: string } }>('/api/manifest', async (req, reply) => {
    const m = manifestFor(req.query.season ?? s.cfg.defaultSeason);
    if (!m) throw notFound('Нет манифеста для такого сезона');
    reply.header('cache-control', 'public, max-age=3600');
    return m;
  });
  app.get<{ Querystring: { season?: string } }>('/api/sheets.pdf', async (req, reply) => {
    const file = sheetsPdfFor(req.query.season ?? s.cfg.defaultSeason);
    if (!file) throw notFound('Нет раскрасок для такого сезона');
    reply.header('content-disposition', `inline; filename="${path.basename(file)}"`);
    reply.type('application/pdf');
    return reply.send(fs.createReadStream(file));
  });
}
