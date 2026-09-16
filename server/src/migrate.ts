// Миграции — простые SQL-файлы в migrations/, по имени по порядку (0001_init.sql, 0002_...).
// Применяются при старте приложения в транзакции под advisory-lock, чтобы два экземпляра
// не гонялись. Применённые запоминаются в schema_migrations. Отдельно: npm run migrate.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

const LOCK_KEY = 7_331_001;   // произвольная константа для pg_advisory_lock

export async function migrate(db: Db, dir = defaultDir()): Promise<string[]> {
  const files = (await fs.readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await fs.readFile(path.join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Миграция ${f} не применилась: ${(e as Error).message}`);
      }
      applied.push(f);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => { /* соединение всё равно вернём */ });
    client.release();
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
  const applied = await migrate(db);
  console.log(applied.length ? `применено: ${applied.join(', ')}` : 'миграций нет — схема актуальна');
  await db.end();
}
