// Привязка телевизора (раздел 3.1 server-spec.md): экран получает 4-значный код, владелец
// вводит его на телефоне; список экранов и отвязка — владелец.
import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.js';
import { actorFor, readToken, requireOwner, setToken } from '../auth.js';
import { token } from '../codes.js';
import { badRequest, notFound, tooMany } from '../errors.js';
import { HOUR } from '../rate-limit.js';

const PAIRING_PER_HOUR = 60;   // с адреса: экран обновляет код при каждой загрузке /tv

export async function screenRoutes(app: FastifyInstance, s: Services): Promise<void> {
  // Экран без комнаты: код привязки (и cookie экрана). Уже привязан — говорим, к какой комнате.
  app.get('/api/tv/pairing', async (req, reply) => {
    let screenToken = readToken(req, 'screen');
    if (!screenToken) { screenToken = token(); setToken(reply, s, 'screen', screenToken); }
    const screen = s.rooms.screenByToken(screenToken);
    if (screen) {
      const room = s.rooms.byId(screen.room_id)!;
      s.rooms.touchScreen(screen);
      return { paired: true, room: room.code, season: room.season };
    }
    const key = `pairing:${req.ip}`;
    if (!s.limiter.take(key, PAIRING_PER_HOUR, HOUR)) throw tooMany('Слишком много запросов кода привязки', s.limiter.retryAfterSec(key, HOUR));
    return { paired: false, code: s.rooms.issuePairingCode(screenToken), ttl_sec: 600 };
  });

  // Привязать экран по коду с телевизора — владелец
  app.post<{ Params: { code: string }; Body: { pairing_code?: unknown; label?: unknown } | null }>('/api/rooms/:code/screens', async (req, reply) => {
    const a = actorFor(req, reply, s);
    requireOwner(a);
    const pc = req.body?.pairing_code;
    if (typeof pc !== 'string' || !/^\d{4}$/.test(pc.trim())) throw badRequest('Код привязки — четыре цифры с экрана телевизора');
    const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 40) : '';
    const screen = s.rooms.pairScreen(a.room, pc, label || 'Экран');
    if (!screen) throw notFound('Код не подошёл или устарел: на телевизоре откройте страницу заново и введите новый код');
    reply.code(201);
    return { id: screen.id, label: screen.label, created_at: screen.created_at };
  });

  app.get<{ Params: { code: string } }>('/api/rooms/:code/screens', async (req, reply) => {
    const a = actorFor(req, reply, s);
    requireOwner(a);
    return s.rooms.screensOf(a.room).map((x) => ({ id: x.id, label: x.label, user_agent: x.user_agent, last_seen_at: x.last_seen_at, created_at: x.created_at }));
  });

  app.delete<{ Params: { code: string; id: string } }>('/api/rooms/:code/screens/:id', async (req, reply) => {
    const a = actorFor(req, reply, s);
    requireOwner(a);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw badRequest('Неверный номер экрана');
    if (!s.rooms.removeScreen(a.room, id)) throw notFound('Такого экрана в комнате нет');
    return { ok: true };
  });
}
