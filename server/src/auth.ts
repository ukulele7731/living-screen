// Роли (раздел 2 server-spec.md): экран, гость, владелец. Каждая роль — свой токен в cookie;
// телефон может слать его и заголовком Authorization: Bearer (localStorage). Гость получает
// токен автоматически при первом обращении к комнате.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Services } from './app.js';
import { token } from './codes.js';
import { forbidden, notFound, unauthorized } from './errors.js';
import type { Room, Screen } from './rooms.js';

export const COOKIE = { owner: 'ls_owner', screen: 'ls_screen', guest: 'ls_guest' } as const;
const COOKIE_MAX_AGE = 400 * 24 * 3600;   // предел браузеров — 400 дней

export function readToken(req: FastifyRequest, name: keyof typeof COOKIE): string | undefined {
  const c = req.cookies?.[COOKIE[name]];
  if (c) return c;
  // Bearer: «<роль>.<токен>» или просто токен (тогда роль определяется по имени cookie, которую просят)
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    const v = h.slice(7).trim();
    const dot = v.indexOf('.');
    if (dot > 0) return v.slice(0, dot) === name ? v.slice(dot + 1) : undefined;
    return v;
  }
  return undefined;
}

export function setToken(reply: FastifyReply, services: Services, name: keyof typeof COOKIE, value: string): void {
  reply.setCookie(COOKIE[name], value, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: services.cfg.env === 'production', maxAge: COOKIE_MAX_AGE
  });
}

export function clearToken(reply: FastifyReply, name: keyof typeof COOKIE): void {
  reply.clearCookie(COOKIE[name], { path: '/' });
}

export interface Actor {
  room: Room;
  owner: boolean;
  screen: Screen | null;
  /** токен гостя (уже был или только что выдан) */
  guestToken: string;
}

/** Комната по коду из пути + кто обращается. Гостю без токена — выдать. */
export function actorFor(req: FastifyRequest, reply: FastifyReply, services: Services): Actor {
  const raw = (req.params as { code?: string }).code ?? '';
  const room = services.rooms.byCode(raw.toUpperCase());
  if (!room) throw notFound('Комнаты с таким кодом нет');
  const owner = services.rooms.isOwner(room, readToken(req, 'owner'));
  const screen = services.rooms.screenByToken(readToken(req, 'screen')) ?? null;
  if (screen && screen.room_id !== room.id) throw forbidden('Этот экран привязан к другой комнате');
  if (screen) services.rooms.touchScreen(screen);
  let guestToken = readToken(req, 'guest');
  if (!guestToken) { guestToken = token(); setToken(reply, services, 'guest', guestToken); }
  return { room, owner, screen, guestToken };
}

export function requireOwner(a: Actor): void {
  if (!a.owner) throw unauthorized('Это может только владелец комнаты: войдите по коду и паролю');
}

export function requireScreenOrOwner(a: Actor): void {
  if (!a.owner && !a.screen) throw forbidden('Доступ только для привязанного экрана или владельца');
}
