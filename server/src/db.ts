// PostgreSQL: один пул на процесс. Всё, что нельзя потерять, — здесь (раздел 4 server-spec.md).
import pg from 'pg';
import type { Config } from './config.js';

export type Db = pg.Pool;

export function makeDb(cfg: Config): Db {
  const pool = new pg.Pool({
    connectionString: cfg.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'living-screen'
  });
  pool.on('error', (err) => { console.error('[db] ошибка соединения в пуле:', err.message); });
  return pool;
}

/** Проверка для /healthz: простой запрос с таймаутом. */
export async function checkDb(db: Db, timeoutMs = 2000): Promise<void> {
  const client = await db.connect();
  try {
    await client.query({ text: 'SELECT 1', query_timeout: timeoutMs } as pg.QueryConfig);
  } finally {
    client.release();
  }
}
