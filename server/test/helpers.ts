// Тестовое приложение: временная папка данных, подменяемые часы, cookie-банка для app.inject.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { loadConfig } from '../src/config.js';
import { makeServices, buildApp, closeServices, type Services } from '../src/app.js';
import { migrate } from '../src/migrate.js';

export interface TestApp {
  app: FastifyInstance;
  services: Services;
  /** сдвинуть часы вперёд на мс */
  advance(ms: number): void;
  now(): number;
  close(): Promise<void>;
}

export async function makeTestApp(): Promise<TestApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'living-test-'));
  process.env.DATA_DIR = dir;
  process.env.LOG_LEVEL = 'silent';
  process.env.NODE_ENV = 'test';
  let t = Date.parse('2026-09-16T12:00:00Z');
  const cfg = loadConfig();
  const services = makeServices(cfg, () => t);
  migrate(services.db);
  const app = await buildApp(services);
  return {
    app, services,
    advance: (ms) => { t += ms; },
    now: () => t,
    close: async () => { await app.close(); closeServices(services); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

/** Клиент с cookie-банкой: как отдельный браузер (телевизор, телефон гостя, телефон владельца). */
export class Client {
  cookies: Record<string, string> = {};
  constructor(private app: FastifyInstance, public ip = '10.0.0.1') {}

  async call(method: InjectOptions['method'], url: string, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const res = await this.app.inject({
      method, url, cookies: this.cookies, remoteAddress: this.ip,
      headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {})
    });
    for (const c of res.cookies) {
      if (c.maxAge !== undefined && c.maxAge <= 0) delete this.cookies[c.name]; else this.cookies[c.name] = c.value;
    }
    return res;
  }
  get = (url: string, headers?: Record<string, string>) => this.call('GET', url, undefined, headers);
  post = (url: string, body?: unknown) => this.call('POST', url, body ?? {});
  patch = (url: string, body?: unknown) => this.call('PATCH', url, body ?? {});
  del = (url: string) => this.call('DELETE', url);
}

export async function createRoom(t: TestApp, ip = '10.0.0.1'): Promise<{ tv: Client; code: string; password: string; pairing: string }> {
  const tv = new Client(t.app, ip);
  const res = await tv.post('/api/rooms', { season: 'autumn' });
  if (res.statusCode !== 201) throw new Error(`создание комнаты: ${res.statusCode} ${res.body}`);
  const j = res.json();
  return { tv, code: j.code, password: j.password, pairing: j.screen_pairing_code };
}
