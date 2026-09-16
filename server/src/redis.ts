// Redis: коды привязки экранов (TTL 10 мин), счётчики лимитов — всё, что можно потерять.
import { Redis } from 'ioredis';
import type { Config } from './config.js';

export type RedisClient = Redis;

export function makeRedis(cfg: Config): RedisClient {
  const redis = new Redis(cfg.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
    retryStrategy: (times) => Math.min(times * 500, 5_000)
  });
  redis.on('error', (err) => { console.error('[redis] ошибка:', err.message); });
  return redis;
}

export async function checkRedis(redis: RedisClient, timeoutMs = 2000): Promise<void> {
  if (redis.status !== 'ready') await redis.connect().catch(() => { /* статус проверим ниже */ });
  const pong = await withTimeout(redis.ping(), timeoutMs, 'redis ping');
  if (pong !== 'PONG') throw new Error(`redis ответил «${pong}»`);
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: таймаут ${ms} мс`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
