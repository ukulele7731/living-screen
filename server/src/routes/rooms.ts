// Комнаты и вход (разделы 3 и 6 server-spec.md).
import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.js';
import { actorFor, readToken, requireOwner, setToken } from '../auth.js';
import { normalizeRoomCode, passwordMatches, SEASONS, token } from '../codes.js';
import { badRequest, tooMany, unauthorized } from '../errors.js';
import { DAY, HOUR } from '../rate-limit.js';

export const LIMITS = {
  roomsPerHour: 5, roomsPerDay: 20,       // раздел 3: создание комнат с адреса
  loginPerHour: 10,                        // подбор пароля: 10 попыток в час на адрес и комнату
  settingsBytes: 2048
};

export async function roomRoutes(app: FastifyInstance, s: Services): Promise<void> {
  // Создать комнату — с экрана телевизора. Экран, если у него уже есть токен, сразу привязывается.
  app.post<{ Body: { season?: string } | null }>('/api/rooms', async (req, reply) => {
    const ip = req.ip;
    if (!s.limiter.take(`rooms:h:${ip}`, LIMITS.roomsPerHour, HOUR)) throw tooMany('Слишком много комнат за час с этого адреса — попробуйте позже', s.limiter.retryAfterSec(`rooms:h:${ip}`, HOUR));
    if (!s.limiter.take(`rooms:d:${ip}`, LIMITS.roomsPerDay, DAY)) throw tooMany('Слишком много комнат за сутки с этого адреса', s.limiter.retryAfterSec(`rooms:d:${ip}`, DAY));
    const season = req.body?.season ?? s.cfg.defaultSeason;
    if (!SEASONS.includes(season)) throw badRequest(`Неизвестный сезон «${season}»; доступны: ${SEASONS.join(', ')}`);

    const { room, password, ownerToken } = s.rooms.create(season);
    setToken(reply, s, 'owner', ownerToken);
    // экран, с которого создали: его токен (или новый) — привязан сразу
    let screenToken = readToken(req, 'screen');
    if (!screenToken) { screenToken = token(); setToken(reply, s, 'screen', screenToken); }
    const existing = s.rooms.screenByToken(screenToken);
    if (existing) s.rooms.removeScreen(s.rooms.byId(existing.room_id)!, existing.id);
    const screen = s.rooms.addScreen(room, screenToken, 'Экран, создавший комнату', String(req.headers['user-agent'] ?? ''));
    const pairing = s.rooms.issuePairingCode(screenToken);
    reply.code(201);
    return { code: room.code, season: room.season, password, screen_id: screen.id, screen_pairing_code: pairing };
  });

  // Комната при загрузке экрана (и гостя): сезон, настройки, листья (список — шаг 3.3)
  app.get<{ Params: { code: string } }>('/api/rooms/:code', async (req, reply) => {
    const a = actorFor(req, reply, s);
    const leaves = s.leaves.live(a.room).map((l) => s.leaves.view(l));
    return {
      code: a.room.code, season: a.room.season, settings: JSON.parse(a.room.settings || '{}'),
      leaves, leaf_count: leaves.length,
      role: a.owner ? 'owner' : a.screen ? 'screen' : 'guest'
    };
  });

  // Настройки и сезон — владелец
  app.patch<{ Params: { code: string }; Body: { season?: unknown; settings?: unknown } | null }>('/api/rooms/:code', async (req, reply) => {
    const a = actorFor(req, reply, s);
    requireOwner(a);
    const body = req.body ?? {};
    const patch: { season?: string; settings?: Record<string, unknown> } = {};
    if (body.season !== undefined) {
      if (typeof body.season !== 'string' || !SEASONS.includes(body.season)) throw badRequest(`Неизвестный сезон; доступны: ${SEASONS.join(', ')}`);
      patch.season = body.season;
    }
    if (body.settings !== undefined) {
      if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) throw badRequest('settings должен быть объектом');
      if (JSON.stringify(body.settings).length > LIMITS.settingsBytes) throw badRequest('Слишком большие настройки');
      patch.settings = body.settings as Record<string, unknown>;
    }
    if (!Object.keys(patch).length) throw badRequest('Нечего менять: передайте season или settings');
    const room = s.rooms.update(a.room, patch);
    if (patch.season !== undefined) s.hub.broadcast(room.id, { type: 'room.season', season: room.season });
    if (patch.settings !== undefined) s.hub.broadcast(room.id, { type: 'room.settings', settings: JSON.parse(room.settings) });
    return { code: room.code, season: room.season, settings: JSON.parse(room.settings) };
  });

  // Сброс: убрать все листья — владелец
  app.post<{ Params: { code: string } }>('/api/rooms/:code/reset', async (req, reply) => {
    const a = actorFor(req, reply, s);
    requireOwner(a);
    const removed = s.rooms.reset(a.room);
    await s.leaves.removeAllFiles(a.room);
    s.hub.broadcast(a.room.id, { type: 'room.reset' });
    return { ok: true, removed };
  });

  // Вход владельца на новом устройстве: код + пароль → cookie владельца
  app.post<{ Params: { code: string }; Body: { password?: unknown } | null }>('/api/rooms/:code/login', async (req, reply) => {
    const code = normalizeRoomCode(req.params.code) ?? req.params.code.toUpperCase();
    const key = `login:${req.ip}:${code}`;
    if (!s.limiter.take(key, LIMITS.loginPerHour, HOUR)) throw tooMany('Слишком много попыток входа — подождите час', s.limiter.retryAfterSec(key, HOUR));
    const room = s.rooms.byCode(code);
    const password = req.body?.password;
    if (typeof password !== 'string' || !password.trim()) throw badRequest('Введите пароль');
    // один и тот же ответ на «нет комнаты» и «не тот пароль» — чтобы не перебирать коды
    if (!room || !passwordMatches(password, room.password_hash)) throw unauthorized('Код комнаты или пароль не подходят');
    const ownerToken = s.rooms.addOwnerToken(room);
    setToken(reply, s, 'owner', ownerToken);
    return { ok: true, code: room.code, season: room.season, owner_token: ownerToken };
  });
}
