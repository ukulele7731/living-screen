// Листья: строки в базе, файлы в data/, слоты атласа (раздел 4–5 server-spec.md).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { Db } from './db.js';
import type { Storage } from './storage.js';
import { tokenHash } from './codes.js';
import { iso, ROOM_TTL_MS, type Room } from './rooms.js';
import type { ProcessedLeaf } from './leaf-image.js';

export interface Leaf {
  id: string; room_id: number; kind: string; name: string; author_token_hash: string;
  tex_key: string; thumb_key: string; orig_key: string | null; normal_key: string; thick_key: string;
  atlas_slot: number; created_at: string; deleted_at: string | null;
}

export const MAX_LEAVES_PER_ROOM = 200;
export const ORIG_TTL_MS = 7 * 24 * 3600_000;

export interface LeafView {
  id: string; kind: string; name: string; atlas_slot: number; created_at: string;
  tex_url: string; thumb_url: string; normal_url: string; thick_url: string;
}

export class Leaves {
  constructor(private db: Db, private storage: Storage, private now: () => number = Date.now) {}

  view(l: Leaf): LeafView {
    const u = (key: string) => `/files/${key}`;
    return {
      id: l.id, kind: l.kind, name: l.name, atlas_slot: l.atlas_slot, created_at: l.created_at,
      tex_url: u(l.tex_key), thumb_url: u(l.thumb_key), normal_url: u(l.normal_key), thick_url: u(l.thick_key)
    };
  }

  live(room: Room): Leaf[] {
    return this.db.prepare('SELECT * FROM leaves WHERE room_id = ? AND deleted_at IS NULL ORDER BY created_at').all(room.id) as Leaf[];
  }

  mine(room: Room, guestToken: string): Leaf[] {
    return this.db.prepare('SELECT * FROM leaves WHERE room_id = ? AND author_token_hash = ? AND deleted_at IS NULL ORDER BY created_at')
      .all(room.id, tokenHash(guestToken)) as Leaf[];
  }

  byId(room: Room, id: string): Leaf | undefined {
    return this.db.prepare('SELECT * FROM leaves WHERE id = ? AND room_id = ?').get(id, room.id) as Leaf | undefined;
  }

  count(room: Room): number {
    return (this.db.prepare('SELECT count(*) AS n FROM leaves WHERE room_id = ? AND deleted_at IS NULL').get(room.id) as { n: number }).n;
  }

  /** Самый маленький свободный слот атласа в комнате. */
  private freeSlot(room: Room): number {
    const used = new Set((this.db.prepare('SELECT atlas_slot FROM leaves WHERE room_id = ? AND deleted_at IS NULL').all(room.id) as { atlas_slot: number }[]).map((r) => r.atlas_slot));
    let s = 0;
    while (used.has(s)) s++;
    return s;
  }

  /** Записать файлы и строку. Файлы — до строки: если запись не удалась, папка листа убирается. */
  async add(room: Room, kind: string, name: string, guestToken: string, img: ProcessedLeaf, orig: Buffer): Promise<Leaf> {
    const id = crypto.randomUUID();
    const base = `rooms/${room.code}/leaves/${id}`;
    const keys = { tex: `${base}/tex.webp`, thumb: `${base}/thumb.webp`, normal: `${base}/normal.webp`, thick: `${base}/thick.webp`, orig: `${base}/orig.png` };
    const dir = this.storage.pathFor(base);
    await fs.mkdir(dir, { recursive: true });
    try {
      await Promise.all([
        fs.writeFile(this.storage.pathFor(keys.tex), img.tex), fs.writeFile(this.storage.pathFor(keys.thumb), img.thumb),
        fs.writeFile(this.storage.pathFor(keys.normal), img.normal), fs.writeFile(this.storage.pathFor(keys.thick), img.thick),
        fs.writeFile(this.storage.pathFor(keys.orig), orig)
      ]);
      const t = this.now();
      const tx = this.db.transaction(() => {
        const slot = this.freeSlot(room);
        this.db.prepare(`INSERT INTO leaves (id, room_id, kind, name, author_token_hash, tex_key, thumb_key, orig_key, normal_key, thick_key, atlas_slot, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, room.id, kind, name, tokenHash(guestToken), keys.tex, keys.thumb, keys.orig, keys.normal, keys.thick, slot, iso(t));
        this.db.prepare('UPDATE rooms SET last_leaf_at = ?, expires_at = ? WHERE id = ?').run(iso(t), iso(t + ROOM_TTL_MS), room.id);
        this.db.prepare('INSERT INTO events (room_id, type, at) VALUES (?, ?, ?)').run(room.id, 'leaf.new', iso(t));
      });
      tx();
    } catch (e) {
      await fs.rm(dir, { recursive: true, force: true });
      throw e;
    }
    return this.byId(room, id)!;
  }

  /** Удаление: строка остаётся с deleted_at (статистика), файлы стираются сразу — «удалять честно». */
  async remove(room: Room, leaf: Leaf): Promise<void> {
    const t = this.now();
    this.db.prepare('UPDATE leaves SET deleted_at = ?, orig_key = NULL WHERE id = ?').run(iso(t), leaf.id);
    this.db.prepare('INSERT INTO events (room_id, type, at) VALUES (?, ?, ?)').run(room.id, 'leaf.deleted', iso(t));
    await fs.rm(this.storage.pathFor(`rooms/${room.code}/leaves/${leaf.id}`), { recursive: true, force: true });
  }

  /** Сброс комнаты: файлы всех листьев. Строки помечает Rooms.reset. */
  async removeAllFiles(room: Room): Promise<void> {
    await fs.rm(this.storage.pathFor(`rooms/${room.code}/leaves`), { recursive: true, force: true });
    this.db.prepare('UPDATE leaves SET orig_key = NULL WHERE room_id = ?').run(room.id);
  }

  /** Оригиналы старше 7 дней — удалить (раздел 5). */
  async sweepOriginals(): Promise<number> {
    const rows = this.db.prepare('SELECT id, orig_key FROM leaves WHERE orig_key IS NOT NULL AND created_at < ?')
      .all(iso(this.now() - ORIG_TTL_MS)) as { id: string; orig_key: string }[];
    for (const r of rows) {
      await fs.rm(this.storage.pathFor(r.orig_key), { force: true });
      this.db.prepare('UPDATE leaves SET orig_key = NULL WHERE id = ?').run(r.id);
    }
    return rows.length;
  }

  /** Проверка ключа файла для раздачи: комната есть, лист живой, файл — один из его. */
  fileAllowed(key: string): boolean {
    const m = /^rooms\/([A-Z]{4}-[A-Z0-9]{4,5})\/leaves\/([0-9a-f-]{36})\/(tex|thumb|normal|thick)\.webp$/.exec(key);
    if (!m) return false;
    const row = this.db.prepare('SELECT l.deleted_at FROM leaves l JOIN rooms r ON r.id = l.room_id WHERE r.code = ? AND l.id = ?').get(m[1], m[2]) as { deleted_at: string | null } | undefined;
    return !!row && row.deleted_at === null;
  }
}
