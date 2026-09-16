// Миграции — простые SQL-файлы в migrations/, по имени по порядку (0001_init.sql, 0002_...).
// Применяются при старте, каждая в транзакции; применённые запоминаются в schema_migrations.
// SQLite однопроцессный, поэтому блокировок между экземплярами не нужно. Отдельно: npm run migrate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

export function migrate(db: Db, dir = defaultDir()): string[] {
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
  const done = new Set((db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name));
  const applied: string[] = [];
  const mark = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)');
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    try {
      db.transaction(() => { db.exec(sql); mark.run(f); })();
    } catch (e) {
      throw new Error(`Миграция ${f} не применилась: ${(e as Error).message}`);
    }
    applied.push(f);
  }
  return applied;
}

function defaultDir(): string {
  // и из src/ (tsx), и из dist/ (node) — migrations лежит на уровень выше
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
}

// Запуск напрямую: npm run migrate
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { loadConfig } = await import('./config.js');
  const { makeDb } = await import('./db.js');
  const db = makeDb(loadConfig());
  const applied = migrate(db);
  console.log(applied.length ? `применено: ${applied.join(', ')}` : 'миграций нет — схема актуальна');
  db.close();
}
