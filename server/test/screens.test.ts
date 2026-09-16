import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, Client, createRoom, type TestApp } from './helpers.js';

const MIN = 60_000;
let t: TestApp;
before(async () => { t = await makeTestApp(); });
after(async () => { await t.close(); });

describe('привязка телевизора', () => {
  test('экран без комнаты получает код и cookie; владелец вводит код — экран привязан', async () => {
    const { tv: creator, code } = await createRoom(t, '10.6.0.1');
    const tv2 = new Client(t.app, '10.6.0.2');                    // второй телевизор
    const p = await tv2.get('/api/tv/pairing');
    assert.equal(p.statusCode, 200);
    assert.equal(p.json().paired, false);
    assert.match(p.json().code, /^\d{4}$/);
    assert.ok(tv2.cookies.ls_screen);
    // до привязки этот экран в комнате — гость
    assert.equal((await tv2.get(`/api/rooms/${code}`)).json().role, 'guest');
    // владелец (с телевизора-создателя или с телефона) вводит код
    const wrong = await creator.post(`/api/rooms/${code}/screens`, { pairing_code: '0000' });
    assert.equal(wrong.statusCode, 404);
    assert.equal((await creator.post(`/api/rooms/${code}/screens`, { pairing_code: 'abcd' })).statusCode, 400);
    const ok = await creator.post(`/api/rooms/${code}/screens`, { pairing_code: p.json().code, label: 'Планшет на кухне' });
    assert.equal(ok.statusCode, 201);
    assert.equal(ok.json().label, 'Планшет на кухне');
    // код одноразовый
    assert.equal((await creator.post(`/api/rooms/${code}/screens`, { pairing_code: p.json().code })).statusCode, 404);
    // второй телевизор теперь экран комнаты
    const again = await tv2.get('/api/tv/pairing');
    assert.equal(again.json().paired, true);
    assert.equal(again.json().room, code);
    assert.equal((await tv2.get(`/api/rooms/${code}`)).json().role, 'screen');
    // список экранов — два, с подписями
    const list = await creator.get(`/api/rooms/${code}/screens`);
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().map((x: { label: string }) => x.label), ['Экран, создавший комнату', 'Планшет на кухне']);
  });

  test('код привязки живёт 10 минут', async () => {
    const { tv: creator, code } = await createRoom(t, '10.6.0.3');
    const tv2 = new Client(t.app, '10.6.0.4');
    const p = await tv2.get('/api/tv/pairing');
    t.advance(11 * MIN);
    const res = await creator.post(`/api/rooms/${code}/screens`, { pairing_code: p.json().code });
    assert.equal(res.statusCode, 404);
    assert.match(res.json().error, /устарел/);
    // экран просит код заново — новый работает
    const p2 = await tv2.get('/api/tv/pairing');
    assert.notEqual(p2.json().code, p.json().code);
    assert.equal((await creator.post(`/api/rooms/${code}/screens`, { pairing_code: p2.json().code })).statusCode, 201);
  });

  test('повторный запрос кода гасит прежний код того же экрана', async () => {
    const { tv: creator, code } = await createRoom(t, '10.6.0.5');
    const tv2 = new Client(t.app, '10.6.0.6');
    const p1 = await tv2.get('/api/tv/pairing');
    const p2 = await tv2.get('/api/tv/pairing');
    assert.equal((await creator.post(`/api/rooms/${code}/screens`, { pairing_code: p1.json().code })).statusCode, 404);
    assert.equal((await creator.post(`/api/rooms/${code}/screens`, { pairing_code: p2.json().code })).statusCode, 201);
  });

  test('отвязать экран: он снова без комнаты; чужой экран отвязать нельзя', async () => {
    const { tv: creator, code } = await createRoom(t, '10.6.0.7');
    const tv2 = new Client(t.app, '10.6.0.8');
    const p = await tv2.get('/api/tv/pairing');
    const paired = await creator.post(`/api/rooms/${code}/screens`, { pairing_code: p.json().code });
    const id = paired.json().id;
    const other = await createRoom(t, '10.6.0.9');
    assert.equal((await other.tv.del(`/api/rooms/${other.code}/screens/${id}`)).statusCode, 404, 'экран не в той комнате');
    assert.equal((await creator.del(`/api/rooms/${code}/screens/abc`)).statusCode, 400);
    assert.equal((await creator.del(`/api/rooms/${code}/screens/${id}`)).statusCode, 200);
    assert.equal((await creator.del(`/api/rooms/${code}/screens/${id}`)).statusCode, 404);
    assert.equal((await tv2.get('/api/tv/pairing')).json().paired, false);
    assert.equal((await tv2.get(`/api/rooms/${code}`)).json().role, 'guest');
  });

  test('экран, привязанный к одной комнате, можно перепривязать к другой', async () => {
    const a = await createRoom(t, '10.6.0.10');
    const b = await createRoom(t, '10.6.0.11');
    const tv2 = new Client(t.app, '10.6.0.12');
    const p1 = await tv2.get('/api/tv/pairing');
    assert.equal((await a.tv.post(`/api/rooms/${a.code}/screens`, { pairing_code: p1.json().code })).statusCode, 201);
    // экран уже привязан к A: /api/tv/pairing говорит об этом, код не выдаёт
    assert.equal((await tv2.get('/api/tv/pairing')).json().room, a.code);
    // чтобы перепривязать, экран должен получить код заново — это делает владелец, отвязав его,
    // или сам экран, сбросив cookie (телевизор почистил данные)
    delete tv2.cookies.ls_screen;
    const p2 = await tv2.get('/api/tv/pairing');
    assert.equal((await b.tv.post(`/api/rooms/${b.code}/screens`, { pairing_code: p2.json().code })).statusCode, 201);
    assert.equal((await tv2.get(`/api/rooms/${b.code}`)).json().role, 'screen');
    assert.equal((await a.tv.get(`/api/rooms/${a.code}/screens`)).json().length, 2, 'старая запись в A осталась до отвязки владельцем');
  });

  test('создание комнаты с телевизора, у которого уже есть cookie экрана: он привязывается к новой', async () => {
    const tv = new Client(t.app, '10.6.0.13');
    await tv.get('/api/tv/pairing');
    const first = await tv.post('/api/rooms');
    assert.equal(first.statusCode, 201);
    const ownerOfFirst = new Client(t.app, '10.6.0.13');
    ownerOfFirst.cookies.ls_owner = tv.cookies.ls_owner;
    const second = await tv.post('/api/rooms');                   // новая комната: экран переезжает, cookie владельца — новой
    assert.equal(second.statusCode, 201);
    assert.equal((await tv.get('/api/tv/pairing')).json().room, second.json().code);
    assert.equal((await ownerOfFirst.get(`/api/rooms/${first.json().code}/screens`)).json().length, 0, 'из первой комнаты экран ушёл');
  });

  test('лимит запросов кода привязки с адреса', async () => {
    const ip = '10.6.0.14';
    for (let i = 0; i < 60; i++) assert.equal((await new Client(t.app, ip).get('/api/tv/pairing')).statusCode, 200);
    assert.equal((await new Client(t.app, ip).get('/api/tv/pairing')).statusCode, 429);
  });
});
