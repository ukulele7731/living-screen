// WebSocket /ws/rooms/:code (раздел 6): экран (или владелец) подписывается своим токеном,
// сервер шлёт события комнаты: leaf.new, leaf.deleted, room.reset, room.season, room.settings.
// Пинг раз в 30 с — телевизоры за NAT иначе теряют соединение молча.
import type { FastifyInstance, FastifyReply } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { Services } from './app.js';
import { actorFor } from './auth.js';

export type RoomEvent =
  | { type: 'leaf.new'; leaf: unknown }
  | { type: 'leaf.deleted'; id: string }
  | { type: 'room.reset' }
  | { type: 'room.season'; season: string }
  | { type: 'room.settings'; settings: unknown };

export class Hub {
  private rooms = new Map<number, Set<WebSocket>>();

  add(roomId: number, ws: WebSocket): void {
    let set = this.rooms.get(roomId);
    if (!set) { set = new Set(); this.rooms.set(roomId, set); }
    const mine = set;
    mine.add(ws);
    ws.on('close', () => { mine.delete(ws); if (!mine.size && this.rooms.get(roomId) === mine) this.rooms.delete(roomId); });
  }

  broadcast(roomId: number, event: RoomEvent): number {
    const set = this.rooms.get(roomId);
    if (!set) return 0;
    const msg = JSON.stringify(event);
    let n = 0;
    for (const ws of set) { if (ws.readyState === ws.OPEN) { ws.send(msg); n++; } }
    return n;
  }

  count(roomId: number): number { return this.rooms.get(roomId)?.size ?? 0; }

  /** сколько экранов онлайн сейчас (для сводки админу) */
  get online(): number { let n = 0; for (const s of this.rooms.values()) n += s.size; return n; }
}

export async function wsRoutes(app: FastifyInstance, s: Services): Promise<void> {
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
  app.get<{ Params: { code: string } }>('/ws/rooms/:code', { websocket: true }, (socket, req) => {
    let actor;
    try {
      // cookie на рукопожатии WS не ставим: гостю здесь делать нечего
      const noReply = { setCookie() { return noReply; } } as unknown as FastifyReply;
      actor = actorFor(req, noReply, s);
    } catch (e) {
      socket.close(4004, (e as Error).message.slice(0, 120));
      return;
    }
    if (!actor.screen && !actor.owner) { socket.close(4003, 'Только привязанный экран или владелец'); return; }
    s.hub.add(actor.room.id, socket);
    socket.send(JSON.stringify({ type: 'hello', room: actor.room.code, season: actor.room.season, leaves: s.leaves.count(actor.room) }));
    const ping = setInterval(() => { if (socket.readyState === socket.OPEN) socket.ping(); }, 30_000);
    socket.on('close', () => clearInterval(ping));
  });
}
