// Настройки из переменных окружения (.env.example — полный список с комментариями).
// Читаем один раз при старте; отсутствие обязательной переменной — ошибка сразу, а не в бою.

export interface Config {
  env: 'development' | 'production' | 'test';
  port: number;
  host: string;
  logLevel: string;
  publicUrl: string;
  databaseUrl: string;
  redisUrl: string;
  s3: { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string; forcePathStyle: boolean };
  telegramBotToken: string;   // пусто — бот не запускается (шаг 3.4)
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Не задана переменная окружения ${name} (см. .env.example)`);
  return v;
}

function opt(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

export function loadConfig(): Config {
  const env = opt('NODE_ENV', 'development');
  if (env !== 'development' && env !== 'production' && env !== 'test') throw new Error(`NODE_ENV=${env}: ожидается development | production | test`);
  return {
    env,
    port: Number(opt('PORT', '3000')),
    host: opt('HOST', '0.0.0.0'),
    logLevel: opt('LOG_LEVEL', 'info'),
    publicUrl: opt('PUBLIC_URL', 'http://localhost:8080').replace(/\/+$/, ''),
    databaseUrl: need('DATABASE_URL'),
    redisUrl: need('REDIS_URL'),
    s3: {
      endpoint: need('S3_ENDPOINT'),
      region: opt('S3_REGION', 'ru-1'),
      bucket: need('S3_BUCKET'),
      accessKey: need('S3_ACCESS_KEY'),
      secretKey: need('S3_SECRET_KEY'),
      forcePathStyle: opt('S3_FORCE_PATH_STYLE', 'true') === 'true'
    },
    telegramBotToken: opt('TELEGRAM_BOT_TOKEN', '')
  };
}
