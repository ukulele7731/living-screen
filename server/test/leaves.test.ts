import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import WebSocket from 'ws';
import { makeTestApp, Client, createRoom, type TestApp } from './helpers.js';
import { fishFor } from '../src/manifests.js';

const DAY = 24 * 3600_000;
let t: TestApp;
before(async () => { t = await makeTestApp(); });
after(async () => { await t.close(); });

/** «Текстура от телефона»: кадр по bbox вида, непрозрачный PNG 1024 px, цветные пятна. */
async function fakeTexture(kind = 'maple', width = 1024): Promise<Buffer> {
  const fish = fishFor('autumn', kind)!;
  const aspect = (fish.bboxModel.z[1] - fish.bboxModel.z[0]) / (fish.bboxModel.y[1] - fish.bboxModel.y[0]);
  const h = Math.round(width / aspect);
  const circles = Array.from({ length: 12 }, (_, i) => `<circle cx="${(i * 97) % width}" cy="${(i * 131) % h}" r="${80 + i * 9}" fill="hsl(${i * 30},80%,55%)"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}"><rect width="100%" height="100%" fill="#f4e6c0"/>${circles}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function multipart(fields: Record<string, string>, file?: { name: string; data: Buffer; filename?: string }): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----living' + Math.random().toString(36).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) parts.push(Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename ?? 'leaf.png'}"\r\nContent-Type: image/png\r\n\r\n`), file.data, Buffer.from('\r\n')]));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const payload = Buffer.concat(parts);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(payload.length) } };
}

async function upload(c: Client, code: string, fields: Record<string, string>, data?: Buffer) {
  const m = multipart(fields, data ? { name: 'texture', data } : undefined);
  const res = await c.app.inject({ method: 'POST', url: `/api/rooms/${code}/leaves`, cookies: c.cookies, remoteAddress: c.ip, headers: m.headers, payload: m.payload });
  for (const ck of res.cookies) c.cookies[ck.name] = ck.value;
  return res;
}

describe('загрузка листа', () => {
  test('гость загружает: файлы, строка, список комнаты, срок жизни год', async () => {
    const { tv, code } = await createRoom(t, '10.7.0.1');
    const phone = new Client(t.app, '10.7.0.2');
    const res = await upload(phone, code, { kind: 'maple', name: 'Артём' }, await fakeTexture('maple'));
    assert.equal(res.statusCode, 201, res.body);
    const j = res.json();
    assert.equal(j.kind, 'maple');
    assert.equal(j.name, 'Артём');
    assert.equal(j.atlas_slot, 0);
    assert.match(j.tex_url, /^\/files\/rooms\/LEAF-[A-Z2-9]{4}\/leaves\/[0-9a-f-]{36}\/tex\.webp$/);
    assert.ok(phone.cookies.ls_guest, 'гостю выдан токен');
    for (const f of ['tex.webp', 'thumb.webp', 'normal.webp', 'thick.webp', 'orig.png']) {
      assert.ok(fs.existsSync(path.join(t.services.cfg.dataDir, j.tex_url.replace('/files/', '').replace('tex.webp', f))), f);
    }
    // размеры: tex 512 px без альфы, thumb 128 с альфой
    const tex = await sharp(fs.readFileSync(t.services.storage.pathFor(j.tex_url.slice(7)))).metadata();
    assert.equal(tex.width, 512); assert.equal(tex.channels, 3);
    const thumb = await sharp(fs.readFileSync(t.services.storage.pathFor(j.thumb_url.slice(7)))).metadata();
    assert.equal(thumb.width, 128); assert.equal(thumb.channels, 4);
    // комната видит лист, срок жизни — год
    const info = await tv.get(`/api/rooms/${code}`);
    assert.equal(info.json().leaf_count, 1);
    assert.equal(info.json().leaves[0].id, j.id);
    const room = t.services.rooms.byCode(code)!;
    assert.ok(Date.parse(room.expires_at) - t.now() > 360 * DAY);
    assert.ok(room.last_leaf_at);
  });

  test('слоты атласа: самый маленький свободный', async () => {
    const { code } = await createRoom(t, '10.7.0.3');
    const phone = new Client(t.app, '10.7.0.4');
    const tex = await fakeTexture('oak');
    const a = (await upload(phone, code, { kind: 'oak', name: '' }, tex)).json();
    const b = (await upload(phone, code, { kind: 'oak', name: '' }, tex)).json();
    assert.deepEqual([a.atlas_slot, b.atlas_slot], [0, 1]);
    assert.equal((await phone.del(`/api/rooms/${code}/leaves/${a.id}`)).statusCode, 200);
    const c = (await upload(phone, code, { kind: 'oak', name: '' }, tex)).json();
    assert.equal(c.atlas_slot, 0, 'освободившийся слот занят снова');
  });

  test('отказы: нет картинки, чужой вид, длинное имя, не те пропорции, не картинка', async () => {
    const { code } = await createRoom(t, '10.7.0.5');
    const phone = new Client(t.app, '10.7.0.6');
    const tex = await fakeTexture('birch');
    assert.equal((await upload(phone, code, { kind: 'birch', name: 'x' })).statusCode, 400);
    assert.equal((await upload(phone, code, { kind: 'palm', name: 'x' }, tex)).statusCode, 400);
    assert.equal((await upload(phone, code, { kind: 'birch', name: 'очень длинное имя ребёнка тут' }, tex)).statusCode, 400);
    assert.equal((await upload(phone, code, { kind: 'birch', name: '<b>' }, tex)).statusCode, 400);
    const wrong = await upload(phone, code, { kind: 'maple', name: 'x' }, tex);          // берёза в кадре клёна
    assert.equal(wrong.statusCode, 400);
    assert.match(wrong.json().error, /пропорции/);
    const junk = await upload(phone, code, { kind: 'birch', name: 'x' }, Buffer.from('not a png'));
    assert.equal(junk.statusCode, 400);
    const noForm = await phone.post(`/api/rooms/${code}/leaves`, { kind: 'birch' });
    assert.equal(noForm.statusCode, 400);
  });

  test('картинка больше 3 МБ — 400', async () => {
    const { code } = await createRoom(t, '10.7.0.7');
    const phone = new Client(t.app, '10.7.0.8');
    const big = Buffer.concat([await fakeTexture('maple'), Buffer.alloc(3 * 1024 * 1024 + 10, 1)]);
    const res = await upload(phone, code, { kind: 'maple', name: 'x' }, big);
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /3 МБ/);
  });

  test('лимит 200 листьев на комнату', async () => {
    const { code } = await createRoom(t, '10.7.0.9');
    const room = t.services.rooms.byCode(code)!;
    const ins = t.services.db.prepare(`INSERT INTO leaves (id, room_id, kind, name, author_token_hash, tex_key, thumb_key, normal_key, thick_key, atlas_slot)
      VALUES (?, ?, 'maple', '', 'h', 'k', 'k', 'k', 'k', ?)`);
    for (let i = 0; i < 200; i++) ins.run(`fill-${i}`, room.id, i);
    const res = await upload(new Client(t.app, '10.7.0.10'), code, { kind: 'maple', name: 'x' }, await fakeTexture('maple'));
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /200/);
  });

  test('лимит 60 загрузок в час с адреса', async () => {
    const { code } = await createRoom(t, '10.7.0.11');
    const room = t.services.rooms.byCode(code)!;
    for (let i = 0; i < 60; i++) t.services.limiter.take('upload:10.7.0.12', 60, 3600_000);
    const res = await upload(new Client(t.app, '10.7.0.12'), code, { kind: 'maple', name: 'x' }, await fakeTexture('maple'));
    assert.equal(res.statusCode, 429);
    void room;
  });
});

describe('мои листья, удаление, файлы', () => {
  test('свой — вижу и удаляю; чужой — не вижу и не удаляю; владелец удаляет любой', async () => {
    const { tv, code } = await createRoom(t, '10.8.0.1');
    const masha = new Client(t.app, '10.8.0.2'), petya = new Client(t.app, '10.8.0.3');
    const tex = await fakeTexture('linden');
    const m1 = (await upload(masha, code, { kind: 'linden', name: 'Маша' }, tex)).json();
    const p1 = (await upload(petya, code, { kind: 'linden', name: 'Петя' }, tex)).json();
    assert.deepEqual((await masha.get(`/api/rooms/${code}/leaves/mine`)).json().map((l: { name: string }) => l.name), ['Маша']);
    assert.deepEqual((await petya.get(`/api/rooms/${code}/leaves/mine`)).json().map((l: { name: string }) => l.name), ['Петя']);
    assert.equal((await masha.del(`/api/rooms/${code}/leaves/${p1.id}`)).statusCode, 403);
    assert.equal((await masha.del(`/api/rooms/${code}/leaves/${m1.id}`)).statusCode, 200);
    assert.equal((await masha.del(`/api/rooms/${code}/leaves/${m1.id}`)).statusCode, 404, 'второй раз — нет');
    assert.equal((await tv.del(`/api/rooms/${code}/leaves/${p1.id}`)).statusCode, 200, 'владелец удаляет чужой');
    assert.equal((await tv.get(`/api/rooms/${code}`)).json().leaf_count, 0);
    assert.ok(!fs.existsSync(t.services.storage.pathFor(m1.tex_url.slice(7))), 'файлы удалённого листа стёрты');
  });

  test('раздача файлов: живой лист — 200 webp с кэшем, удалённый и мусор — 404', async () => {
    const { code } = await createRoom(t, '10.8.0.4');
    const phone = new Client(t.app, '10.8.0.5');
    const leaf = (await upload(phone, code, { kind: 'rowan', name: '' }, await fakeTexture('rowan'))).json();
    const anon = new Client(t.app, '10.8.0.6');
    for (const u of [leaf.tex_url, leaf.thumb_url, leaf.normal_url, leaf.thick_url]) {
      const res = await anon.get(u);
      assert.equal(res.statusCode, 200, u);
      assert.equal(res.headers['content-type'], 'image/webp');
      assert.match(String(res.headers['cache-control']), /immutable/);
    }
    assert.equal((await anon.get(leaf.tex_url.replace('tex.webp', 'orig.png'))).statusCode, 404, 'оригинал не раздаётся');
    assert.equal((await anon.get('/files/rooms/LEAF-ZZZZ/leaves/x/tex.webp')).statusCode, 404);
    assert.equal((await anon.get('/files/../../etc/passwd')).statusCode, 404);
    await phone.del(`/api/rooms/${code}/leaves/${leaf.id}`);
    assert.equal((await anon.get(leaf.tex_url)).statusCode, 404);
  });

  test('сброс комнаты стирает листья и файлы', async () => {
    const { tv, code } = await createRoom(t, '10.8.0.7');
    const phone = new Client(t.app, '10.8.0.8');
    const leaf = (await upload(phone, code, { kind: 'aspen', name: '' }, await fakeTexture('aspen'))).json();
    assert.equal((await tv.post(`/api/rooms/${code}/reset`)).json().removed, 1);
    assert.equal((await tv.get(`/api/rooms/${code}`)).json().leaf_count, 0);
    assert.ok(!fs.existsSync(t.services.storage.pathFor(leaf.tex_url.slice(7))));
  });

  test('оригинал живёт 7 дней', async () => {
    const { code } = await createRoom(t, '10.8.0.9');
    const phone = new Client(t.app, '10.8.0.10');
    const leaf = (await upload(phone, code, { kind: 'chestnut', name: '' }, await fakeTexture('chestnut'))).json();
    const orig = t.services.storage.pathFor(leaf.tex_url.slice(7).replace('tex.webp', 'orig.png'));
    assert.ok(fs.existsSync(orig));
    t.advance(8 * DAY);
    assert.ok(await t.services.leaves.sweepOriginals() >= 1);                 // плюс оригиналы листьев других тестов
    assert.ok(!fs.existsSync(orig));
    assert.ok(fs.existsSync(t.services.storage.pathFor(leaf.tex_url.slice(7))), 'текстура на месте');
  });
});

describe('манифест и раскраски', () => {
  test('GET /api/manifest и /api/sheets.pdf', async () => {
    const c = new Client(t.app);
    const m = await c.get('/api/manifest?season=autumn');
    assert.equal(m.statusCode, 200);
    assert.equal(m.json().fish.length, 8);
    assert.equal((await c.get('/api/manifest?season=summer')).statusCode, 404);
    const pdf = await c.get('/api/sheets.pdf');
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.ok(pdf.rawPayload.length > 10000);
  });
});

describe('WebSocket экрана', () => {
  test('два экрана получают leaf.new, leaf.deleted, room.season; гость не подключается', async () => {
    const addr = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const { tv, code } = await createRoom(t, '10.9.0.1');
    // второй экран
    const tv2 = new Client(t.app, '10.9.0.2');
    const pc = (await tv2.get('/api/tv/pairing')).json().code;
    await tv.post(`/api/rooms/${code}/screens`, { pairing_code: pc });
    const connect = (cookies: Record<string, string>) => new Promise<{ ws: WebSocket; messages: unknown[]; closed: Promise<number> }>((ok, fail) => {
      const ws = new WebSocket(`${addr.replace('http', 'ws')}/ws/rooms/${code}`, { headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') } });
      const messages: unknown[] = [];
      const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
      ws.on('message', (d) => messages.push(JSON.parse(String(d))));
      ws.on('open', () => ok({ ws, messages, closed }));
      ws.on('error', fail);
    });
    const s1 = await connect({ ls_screen: tv.cookies.ls_screen });
    const s2 = await connect({ ls_screen: tv2.cookies.ls_screen });
    const guest = await connect({ ls_guest: 'nope' });
    assert.equal(await guest.closed, 4003);
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await wait(50);
    assert.equal((s1.messages[0] as { type: string }).type, 'hello');

    const phone = new Client(t.app, '10.9.0.3');
    const leaf = (await upload(phone, code, { kind: 'willow', name: 'Ира' }, await fakeTexture('willow'))).json();
    assert.equal(leaf.screens_notified, 2);
    await wait(50);
    for (const s of [s1, s2]) {
      const ev = s.messages.find((m) => (m as { type: string }).type === 'leaf.new') as { leaf: { id: string; name: string } };
      assert.ok(ev, 'leaf.new пришёл');
      assert.equal(ev.leaf.id, leaf.id);
      assert.equal(ev.leaf.name, 'Ира');
    }
    await tv.patch(`/api/rooms/${code}`, { season: 'winter' });
    await phone.del(`/api/rooms/${code}/leaves/${leaf.id}`);
    await wait(50);
    const types = s2.messages.map((m) => (m as { type: string }).type);
    assert.ok(types.includes('room.season'));
    assert.ok(types.includes('leaf.deleted'));
    s1.ws.close(); s2.ws.close();
    await wait(20);
    assert.equal(t.services.hub.online, 0);
  });
});
