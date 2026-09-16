// Комнаты, экраны, коды привязки, события — работа с базой (раздел 4 server-spec.md).
// Только SQL и правила данных; HTTP-слой — в routes/.
import type { Db } from './db.js';
import { roomCode, ownerPassword, passwordHash, token, tokenHash, pairingCode } from './codes.js';

export interface Room {
  id: number; code: string; season: string; password_hash: string; owner_token_hash: string;
  settings: string; tg_chat_id: number | null; created_at: string; last_leaf_at: string | null; expires_at: string;
}
export interface Screen {
  id: number; room_id: number; token_hash: string; label: string; user_agent: string; last_seen_at: string | null; created_at: string;
}

export const EMPTY_ROOM_TTL_MS = 24 * 3600_000;         // комната без листьев живёт сутки
export const ROOM_TTL_MS = 365 * 24 * 3600_000;         // год с последнего листа
export const PAIRING_TTL_MS = 10 * 60_000;              // код привязки — 10 минут

export const iso = (ms: number) => new Date(ms).toISOString();

export class Rooms {
  constructor(private db: Db, private now: () => number = Date.now) {}

  event(type: string, roomId: number | null = null): void {
    this.db.prepare('INSERT INTO events (room_id, type, at) VALUES (?, ?, ?)').run(roomId, type, iso(this.now()));
  }

  /** Создать комнату: код, пароль (возвращается один раз), токен владельца (возвращается один раз). */
  create(season: string): { room: Room; password: string; ownerToken: string } {
    const password = ownerPassword();
    const ownerToken = token();
    const t = this.now();
    const insert = this.db.prepare(`INSERT INTO rooms (code, season, password_hash, owner_token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    // код уникален: при коллизии пробуем ещё; после многих коллизий — пятый символ
    for (let attempt = 0; attempt < 40; attempt++) {
      const code = roomCode(season, attempt < 30 ? 4 : 5);
      try {
        const r = insert.run(code, season, passwordHash(password), tokenHash(ownerToken), iso(t), iso(t + EMPTY_ROOM_TTL_MS));
        const room = this.byId(Number(r.lastInsertRowid))!;
        this.db.prepare('INSERT INTO owner_tokens (room_id, token_hash, created_at) VALUES (?, ?, ?)').run(room.id, tokenHash(ownerToken), iso(t));
        this.event('room.created', room.id);
        return { room, password, ownerToken };
      } catch (e) {
        if (!/UNIQUE/.test((e as Error).message)) throw e;
      }
    }
    throw new Error('не удалось подобрать свободный код комнаты');
  }

  byId(id: number): Room | undefined {
    return this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as Room | undefined;
  }

  byCode(code: string): Room | undefined {
    return this.db.prepare('SELECT * FROM rooms WHERE code = ?').get(code) as Room | undefined;
  }

  isOwner(room: Room, ownerToken: string | undefined): boolean {
    if (!ownerToken) return false;
    const row = this.db.prepare('SELECT id FROM owner_tokens WHERE room_id = ? AND token_hash = ?').get(room.id, tokenHash(ownerToken)) as { id: number } | undefined;
    if (!row) return false;
    this.db.prepare('UPDATE owner_tokens SET last_seen_at = ? WHERE id = ?').run(iso(this.now()), row.id);
    return true;
  }

  /** Новое устройство владельца после входа по паролю: свой токен, старые устройства не страдают. */
  addOwnerToken(room: Room): string {
    const fresh = token();
    this.db.prepare('INSERT INTO owner_tokens (room_id, token_hash, created_at) VALUES (?, ?, ?)').run(room.id, tokenHash(fresh), iso(this.now()));
    this.event('room.login', room.id);
    return fresh;
  }

  update(room: Room, patch: { season?: string; settings?: Record<string, unknown> }): Room {
    if (patch.season !== undefined) {
      this.db.prepare('UPDATE rooms SET season = ? WHERE id = ?').run(patch.season, room.id);
      this.event('room.season', room.id);
    }
    if (patch.settings !== undefined) {
      const merged = { ...JSON.parse(room.settings || '{}'), ...patch.settings };
      this.db.prepare('UPDATE rooms SET settings = ? WHERE id = ?').run(JSON.stringify(merged), room.id);
      this.event('room.settings', room.id);
    }
    return this.byId(room.id)!;
  }

  /** Сброс: все листья помечаются удалёнными (файлы убирает шаг 3.3), срок жизни — как у пустой комнаты. */
  reset(room: Room): number {
    const t = this.now();
    const r = this.db.prepare('UPDATE leaves SET deleted_at = ? WHERE room_id = ? AND deleted_at IS NULL').run(iso(t), room.id);
    this.db.prepare('UPDATE rooms SET last_leaf_at = NULL, expires_at = ? WHERE id = ?').run(iso(t + EMPTY_ROOM_TTL_MS), room.id);
    this.event('room.reset', room.id);
    return r.changes;
  }

  liveLeafCount(room: Room): number {
    return (this.db.prepare('SELECT count(*) AS n FROM leaves WHERE room_id = ? AND deleted_at IS NULL').get(room.id) as { n: number }).n;
  }

  // ── экраны ──

  screenByToken(screenToken: string | undefined): Screen | undefined {
    if (!screenToken) return undefined;
    return this.db.prepare('SELECT * FROM screens WHERE token_hash = ?').get(tokenHash(screenToken)) as Screen | undefined;
  }

  screensOf(room: Room): Screen[] {
    return this.db.prepare('SELECT * FROM screens WHERE room_id = ? ORDER BY created_at').all(room.id) as Screen[];
  }

  touchScreen(screen: Screen): void {
    this.db.prepare('UPDATE screens SET last_seen_at = ? WHERE id = ?').run(iso(this.now()), screen.id);
  }

  addScreen(room: Room, screenToken: string, label: string, userAgent: string): Screen {
    const r = this.db.prepare(`INSERT INTO screens (room_id, token_hash, label, user_agent, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(room.id, tokenHash(screenToken), label, userAgent.slice(0, 200), iso(this.now()), iso(this.now()));
    this.event('screen.paired', room.id);
    return this.db.prepare('SELECT * FROM screens WHERE id = ?').get(Number(r.lastInsertRowid)) as Screen;
  }

  removeScreen(room: Room, id: number): boolean {
    const r = this.db.prepare('DELETE FROM screens WHERE id = ? AND room_id = ?').run(id, room.id);
    if (r.changes) this.event('screen.removed', room.id);
    return r.changes > 0;
  }

  // ── коды привязки (TTL 10 минут, просроченные чистятся при обращении) ──

  /** Выдать код для экрана. Один живой код на экран: повторный запрос возвращает новый и гасит старый. */
  issuePairingCode(screenToken: string): string {
    this.sweepPairing();
    const th = tokenHash(screenToken);
    this.db.prepare('DELETE FROM pairing_codes WHERE screen_token = ?').run(th);
    const insert = this.db.prepare('INSERT INTO pairing_codes (code, screen_token, expires_at) VALUES (?, ?, ?)');
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = pairingCode();
      try {
        insert.run(code, th, iso(this.now() + PAIRING_TTL_MS));
        return code;
      } catch (e) {
        if (!/UNIQUE/.test((e as Error).message)) throw e;
      }
    }
    throw new Error('свободных кодов привязки нет — попробуйте через минуту');
  }

  /** Привязать экран по коду: создаёт запись screens с тем же токеном, код гасится. */
  pairScreen(room: Room, code: string, label: string): Screen | null {
    this.sweepPairing();
    const row = this.db.prepare('SELECT * FROM pairing_codes WHERE code = ?').get(code.trim()) as { code: string; screen_token: string } | undefined;
    if (!row) return null;
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM pairing_codes WHERE code = ?').run(row.code);
      // экран мог быть привязан к другой комнате (например, к прежней) — перепривязываем
      this.db.prepare('DELETE FROM screens WHERE token_hash = ?').run(row.screen_token);
      const r = this.db.prepare(`INSERT INTO screens (room_id, token_hash, label, user_agent, last_seen_at, created_at)
        VALUES (?, ?, ?, '', ?, ?)`).run(room.id, row.screen_token, label, iso(this.now()), iso(this.now()));
      this.event('screen.paired', room.id);
      return this.db.prepare('SELECT * FROM screens WHERE id = ?').get(Number(r.lastInsertRowid)) as Screen;
    });
    return tx();
  }

  private sweepPairing(): void {
    this.db.prepare('DELETE FROM pairing_codes WHERE expires_at < ?').run(iso(this.now()));
  }

  // ── срок жизни ──

  /** Удалить просроченные комнаты (без листьев — сутки, с листьями — год с последнего). */
  sweepExpired(): string[] {
    const rows = this.db.prepare('SELECT id, code FROM rooms WHERE expires_at < ?').all(iso(this.now())) as { id: number; code: string }[];
    for (const r of rows) {
      this.event('room.expired', null);
      this.db.prepare('DELETE FROM rooms WHERE id = ?').run(r.id);   // экраны, листья, коды — каскадом
    }
    return rows.map((r) => r.code);
  }
}
