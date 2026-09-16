// Настройки из переменных окружения (.env.example — полный список с комментариями).
// Читаем один раз при старте; неверное значение — ошибка сразу, а не в бою.
import path from 'node:path';

export interface Config {
  env: 'development' | 'production' | 'test';
  port: number;
  host: string;
  logLevel: string;
  publicUrl: string;
  dataDir: string;            // база и картинки: data/db.sqlite, data/rooms/...
  minFreeMb: number;          // ниже этого /healthz даёт 503 — место кончается
  defaultSeason: string;      // сезон новых комнат
  telegramBotToken: string;   // пусто — бот не запускается (шаг 3.4)
}

function opt(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

export function loadConfig(): Config {
  const env = opt('NODE_ENV', 'development');
  if (env !== 'development' && env !== 'production' && env !== 'test') throw new Error(`NODE_ENV=${env}: ожидается development | production | test`);
  const port = Number(opt('PORT', '3000'));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT=${process.env.PORT}: ожидается число`);
  return {
    env,
    port,
    host: opt('HOST', '0.0.0.0'),
    logLevel: opt('LOG_LEVEL', 'info'),
    publicUrl: opt('PUBLIC_URL', 'http://localhost:8080').replace(/\/+$/, ''),
    dataDir: path.resolve(opt('DATA_DIR', 'data')),
    minFreeMb: Number(opt('MIN_FREE_MB', '500')),
    defaultSeason: opt('DEFAULT_SEASON', 'autumn'),
    telegramBotToken: opt('TELEGRAM_BOT_TOKEN', '')
  };
}
