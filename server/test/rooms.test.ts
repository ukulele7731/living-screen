import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, Client, createRoom, type TestApp } from './helpers.js';
import { ALPHABET } from '../src/codes.js';

const HOUR = 3600_000;
let t: TestApp;
before(async () => { t = await makeTestApp(); });
after(async () => { await t.close(); });

describe('создание комнаты', () => {
  test('код, пароль, cookie владельца и экрана, код привязки', async () => {
    const tv = new Client(t.app, '10.1.0.1');
    const res = await tv.post('/api/rooms', { season: 'autumn' });
    assert.equal(res.statusCode, 201);
    const j = res.json();
    assert.match(j.code, /^LEAF-[A-Z2-9]{4}$/);
    assert.ok(!/[01OI]/.test(j.code.slice(5)), 'в коде нет похожих символов');
    assert.equal(j.password.length, 6);
    assert.ok([...j.password].every((c: string) => ALPHABET.includes(c)));
    assert.match(j.screen_pairing_code, /^\d{4}$/);
    assert.ok(tv.cookies.ls_owner, 'cookie владельца');
    assert.ok(tv.cookies.ls_screen, 'cookie экрана');
    // телевизор видит комнату как владелец (он её создал)
    const info = await tv.get(`/api/rooms/${j.code}`);
    assert.equal(info.statusCode, 200);
    assert.equal(info.json().role, 'owner');
    assert.equal(info.json().season, 'autumn');
    assert.equal(info.json().leaf_count, 0);
  });

  test('неизвестный сезон — 400 с текстом', async () => {
    const res = await new Client(t.app, '10.1.0.2').post('/api/rooms', { season: 'summer' });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /сезон/i);
  });

  test('сезон по умолчанию, без тела', async () => {
    const res = await new Client(t.app, '10.1.0.3').call('POST', '/api/rooms');
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().season, 'autumn');
  });

  test('лимит 5 в час с адреса, другой адрес не страдает, через час снова можно', async () => {
    const ip = '10.1.0.4';
    for (let i = 0; i < 5; i++) assert.equal((await new Client(t.app, ip).post('/api/rooms')).statusCode, 201);
    const sixth = await new Client(t.app, ip).post('/api/rooms');
    assert.equal(sixth.statusCode, 429);
    assert.ok(Number(sixth.headers['retry-after']) > 0);
    assert.match(sixth.json().error, /за час/);
    assert.equal((await new Client(t.app, '10.1.0.5').post('/api/rooms')).statusCode, 201);
    t.advance(HOUR + 1000);
    assert.equal((await new Client(t.app, ip).post('/api/rooms')).statusCode, 201);
  });

  test('лимит 20 в сутки с адреса', async () => {
    const ip = '10.1.0.6';
    for (let batch = 0; batch < 4; batch++) {
      for (let i = 0; i < 5; i++) assert.equal((await new Client(t.app, ip).post('/api/rooms')).statusCode, 201);
      t.advance(HOUR + 1000);
    }
    const res = await new Client(t.app, ip).post('/api/rooms');
    assert.equal(res.statusCode, 429);
    assert.match(res.json().error, /за сутки/);
  });
});

describe('роли', () => {
  test('гость: видит комнату, получает cookie, менять не может', async () => {
    const { code } = await createRoom(t, '10.2.0.1');
    const guest = new Client(t.app, '10.2.0.2');
    const info = await guest.get(`/api/rooms/${code}`);
    assert.equal(info.statusCode, 200);
    assert.equal(info.json().role, 'guest');
    assert.ok(guest.cookies.ls_guest, 'гостю выдан токен');
    const g1 = guest.cookies.ls_guest;
    await guest.get(`/api/rooms/${code}`);
    assert.equal(guest.cookies.ls_guest, g1, 'токен гостя постоянный');
    assert.equal((await guest.patch(`/api/rooms/${code}`, { season: 'winter' })).statusCode, 401);
    assert.equal((await guest.post(`/api/rooms/${code}/reset`)).statusCode, 401);
    assert.equal((await guest.get(`/api/rooms/${code}/screens`)).statusCode, 401);
    assert.equal((await guest.post(`/api/rooms/${code}/screens`, { pairing_code: '1234' })).statusCode, 401);
  });

  test('код в нижнем регистре и без дефиса тоже находит комнату', async () => {
    const { code } = await createRoom(t, '10.2.0.3');
    const guest = new Client(t.app, '10.2.0.4');
    assert.equal((await guest.get(`/api/rooms/${code.toLowerCase()}`)).statusCode, 200);
  });

  test('чужой владелец — не владелец здесь', async () => {
    const a = await createRoom(t, '10.2.0.5');
    const b = await createRoom(t, '10.2.0.6');
    const phoneA = new Client(t.app, '10.2.0.5');
    phoneA.cookies.ls_owner = a.tv.cookies.ls_owner;               // телефон владельца A, без cookie экрана
    assert.equal((await phoneA.patch(`/api/rooms/${a.code}`, { season: 'winter' })).statusCode, 200);
    assert.equal((await phoneA.patch(`/api/rooms/${b.code}`, { season: 'winter' })).statusCode, 401);
    assert.equal((await phoneA.get(`/api/rooms/${b.code}`)).json().role, 'guest');
  });

  test('экран чужой комнаты — 403', async () => {
    const a = await createRoom(t, '10.2.0.7');
    const b = await createRoom(t, '10.2.0.8');
    const screenOnly = new Client(t.app, '10.2.0.7');
    screenOnly.cookies.ls_screen = a.tv.cookies.ls_screen;      // только cookie экрана, без владельца
    assert.equal((await screenOnly.get(`/api/rooms/${a.code}`)).json().role, 'screen');
    assert.equal((await screenOnly.get(`/api/rooms/${b.code}`)).statusCode, 403);
    assert.equal((await screenOnly.patch(`/api/rooms/${a.code}`, { season: 'winter' })).statusCode, 401, 'экран не меняет настройки');
  });

  test('токен можно слать заголовком Bearer', async () => {
    const { tv, code } = await createRoom(t, '10.2.0.9');
    const bare = new Client(t.app, '10.2.0.10');
    const res = await bare.get(`/api/rooms/${code}`, { authorization: `Bearer owner.${tv.cookies.ls_owner}` });
    assert.equal(res.json().role, 'owner');
  });

  test('несуществующая комната — 404', async () => {
    assert.equal((await new Client(t.app).get('/api/rooms/LEAF-ZZZZ')).statusCode, 404);
  });
});

describe('вход владельца', () => {
  test('неверный пароль и неверный код — один и тот же 401', async () => {
    const { code } = await createRoom(t, '10.3.0.1');
    const phone = new Client(t.app, '10.3.0.2');
    const bad = await phone.post(`/api/rooms/${code}/login`, { password: 'AAAAAA' });
    const noRoom = await phone.post('/api/rooms/LEAF-ZZZZ/login', { password: 'AAAAAA' });
    assert.equal(bad.statusCode, 401);
    assert.equal(noRoom.statusCode, 401);
    assert.equal(bad.json().error, noRoom.json().error);
    assert.equal((await phone.post(`/api/rooms/${code}/login`, {})).statusCode, 400);
  });

  test('верный пароль (в любом регистре, с 0 вместо O) — владелец на новом устройстве, старое тоже владелец', async () => {
    const { tv, code, password } = await createRoom(t, '10.3.0.3');
    const phone = new Client(t.app, '10.3.0.4');
    const typed = password.toLowerCase().replace(/o/g, '0');
    const res = await phone.post(`/api/rooms/${code}/login`, { password: typed });
    assert.equal(res.statusCode, 200);
    assert.ok(phone.cookies.ls_owner);
    assert.notEqual(phone.cookies.ls_owner, tv.cookies.ls_owner);
    assert.equal((await phone.patch(`/api/rooms/${code}`, { season: 'winter' })).statusCode, 200);
    assert.equal((await tv.get(`/api/rooms/${code}`)).json().role, 'owner');
    assert.equal((await tv.get(`/api/rooms/${code}`)).json().season, 'winter');
  });

  test('10 неверных попыток в час — 429', async () => {
    const { code } = await createRoom(t, '10.3.0.5');
    const phone = new Client(t.app, '10.3.0.6');
    for (let i = 0; i < 10; i++) assert.equal((await phone.post(`/api/rooms/${code}/login`, { password: 'BBBBBB' })).statusCode, 401);
    assert.equal((await phone.post(`/api/rooms/${code}/login`, { password: 'BBBBBB' })).statusCode, 429);
  });
});

describe('настройки, сезон, сброс', () => {
  test('PATCH: проверка тела, слияние настроек', async () => {
    const { tv, code } = await createRoom(t, '10.4.0.1');
    assert.equal((await tv.patch(`/api/rooms/${code}`, {})).statusCode, 400);
    assert.equal((await tv.patch(`/api/rooms/${code}`, { season: 'spring' })).statusCode, 400);
    assert.equal((await tv.patch(`/api/rooms/${code}`, { settings: [1] })).statusCode, 400);
    assert.equal((await tv.patch(`/api/rooms/${code}`, { settings: { pad: 'x'.repeat(3000) } })).statusCode, 400);
    const r1 = await tv.patch(`/api/rooms/${code}`, { settings: { sound: true, wind: 'breeze' } });
    assert.equal(r1.statusCode, 200);
    const r2 = await tv.patch(`/api/rooms/${code}`, { settings: { wind: 'storm' }, season: 'winter' });
    assert.deepEqual(r2.json().settings, { sound: true, wind: 'storm' });
    assert.equal(r2.json().season, 'winter');
  });

  test('сброс помечает листья удалёнными и возвращает срок жизни пустой комнаты', async () => {
    const { tv, code } = await createRoom(t, '10.4.0.2');
    const room = t.services.rooms.byCode(code)!;
    const ins = t.services.db.prepare(`INSERT INTO leaves (id, room_id, kind, name, author_token_hash, tex_key, thumb_key, normal_key, thick_key, atlas_slot)
      VALUES (?, ?, 'maple', 'Маша', 'h', 'k', 'k', 'k', 'k', 0)`);
    ins.run('leaf-1', room.id); ins.run('leaf-2', room.id);
    t.services.db.prepare('UPDATE rooms SET expires_at = ? WHERE id = ?').run('2099-01-01T00:00:00.000Z', room.id);
    assert.equal((await tv.get(`/api/rooms/${code}`)).json().leaf_count, 2);
    const res = await tv.post(`/api/rooms/${code}/reset`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().removed, 2);
    assert.equal((await tv.get(`/api/rooms/${code}`)).json().leaf_count, 0);
    const after = t.services.rooms.byCode(code)!;
    assert.equal(Date.parse(after.expires_at), t.now() + 24 * HOUR);
  });
});

describe('срок жизни', () => {
  test('комната без листьев исчезает через сутки, с листьями — живёт', async () => {
    const empty = await createRoom(t, '10.5.0.1');
    const full = await createRoom(t, '10.5.0.2');
    const room = t.services.rooms.byCode(full.code)!;
    t.services.db.prepare(`INSERT INTO leaves (id, room_id, kind, name, author_token_hash, tex_key, thumb_key, normal_key, thick_key, atlas_slot)
      VALUES ('leaf-x', ?, 'oak', '', 'h', 'k', 'k', 'k', 'k', 0)`).run(room.id);
    t.services.db.prepare('UPDATE rooms SET expires_at = ? WHERE id = ?').run(new Date(t.now() + 365 * 24 * HOUR).toISOString(), room.id);
    t.advance(25 * HOUR);
    const gone = t.services.rooms.sweepExpired();                  // уйдут и пустые комнаты прочих тестов
    assert.ok(gone.includes(empty.code));
    assert.ok(!gone.includes(full.code));
    assert.equal((await empty.tv.get(`/api/rooms/${empty.code}`)).statusCode, 404);
    assert.equal((await full.tv.get(`/api/rooms/${full.code}`)).statusCode, 200);
    // каскад: экраны удалённой комнаты тоже исчезли
    assert.equal((await empty.tv.get('/api/tv/pairing')).json().paired, false);
  });
});

describe('здоровье', () => {
  test('/healthz отвечает ok', async () => {
    const res = await new Client(t.app).get('/healthz');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
  });
});
