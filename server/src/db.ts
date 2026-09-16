// SQLite: один файл data/db.sqlite, режим WAL (читатели не ждут писателя), внешние ключи
// включены. Всё, что нельзя потерять, — здесь (раздел 4 server-spec.md); счётчики лимитов —
// в памяти процесса.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Config } from './config.js';

export type Db = Database.Database;

export function makeDb(cfg: Config): Db {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const db = new Database(path.join(cfg.dataDir, 'db.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');        // с WAL: не теряет ничего, кроме последних мс при отключении питания
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Проверка для /healthz: база отвечает и не повреждена на уровне заголовка. */
export function checkDb(db: Db): void {
  const r = db.prepare('SELECT 1 AS ok').get() as { ok: number };
  if (r.ok !== 1) throw new Error('база ответила не то');
  const q = db.pragma('quick_check', { simple: true }) as string;
  if (q !== 'ok') throw new Error(`quick_check: ${q}`);
}
