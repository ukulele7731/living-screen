// Лимиты «N в час с адреса» — в памяти процесса (раздел 4: можно потерять при перезапуске).
// Скользящее окно по отметкам времени; старые ключи выметаются раз в несколько минут.

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private now: () => number = Date.now) {}

  /** true — можно; false — лимит исчерпан (попытка не засчитывается). */
  take(key: string, limit: number, windowMs: number): boolean {
    const t = this.now();
    this.sweep(t);
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (arr.length >= limit) { this.hits.set(key, arr); return false; }
    arr.push(t);
    this.hits.set(key, arr);
    return true;
  }

  /** Сколько ждать до освобождения слота, секунд. */
  retryAfterSec(key: string, windowMs: number): number {
    const arr = this.hits.get(key);
    if (!arr || !arr.length) return 0;
    return Math.max(1, Math.ceil((arr[0] + windowMs - this.now()) / 1000));
  }

  private sweep(t: number) {
    if (t - this.lastSweep < 5 * 60_000) return;
    this.lastSweep = t;
    for (const [k, arr] of this.hits) {
      const fresh = arr.filter((x) => t - x < 24 * 3600_000);
      if (fresh.length) this.hits.set(k, fresh); else this.hits.delete(k);
    }
  }
}

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
