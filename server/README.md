# «Живой экран» — сервер

Серверная часть по `../server-spec.md`: комнаты, роли, листья, WebSocket, Telegram-бот.
Папка самостоятельна: свой `package.json`, ничего не импортирует из `scene/` и `uploader/`.
В декабре уезжает в приватный репозиторий как есть.

## Поднять локально одной командой

Нужен Docker с Compose.

```
cd server
cp .env.example .env
docker compose up -d --build
curl http://localhost:8080/healthz
```

Ответ `{"ok":true,"checks":{"db":{"ok":true,...},"redis":{...},"storage":{...}}}` — всё поднялось.
Если что-то не так — `ok:false` и в `checks` написано, что именно (503).

Что запускается: `app` (Node 20: API, позже WS и бот), `postgres` 16, `redis` 7, `minio`
(локальное S3, консоль http://localhost:9001, логин/пароль из `.env`), `minio-init` (создаёт
бакет и выходит), `caddy` (снаружи порт 8080 → API в `app`, статика из `./www`).

Логи: `docker compose logs -f app`. Остановить: `docker compose down` (данные остаются в
volumes; `down -v` — стереть всё).

## Без Docker (разработка)

Нужны локальные PostgreSQL 16, Redis 7 и любое S3 (MinIO). В `.env` — адреса `localhost`
вместо имён сервисов compose. Затем:

```
npm ci
npm run dev          # tsx watch, миграции применяются при старте
npm run typecheck
npm run build && npm start
npm run migrate      # применить миграции отдельно
```

## Миграции

`migrations/NNNN_название.sql`, применяются по порядку при старте под advisory-lock;
применённые — в таблице `schema_migrations`. Новая миграция — новый файл, старые не менять.

## Переменные окружения

Все — в `.env.example` с комментариями. Обязательные: `DATABASE_URL`, `REDIS_URL`,
`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`. `TELEGRAM_BOT_TOKEN` до
шага 3.4 пустой.

## На VPS

`SITE_ADDRESS=домен` (Caddy сам получит HTTPS), порты Caddy `80:80` и `443:443`, ключи
внешнего хранилища вместо MinIO. Деплой: `git pull && docker compose up -d --build`.
Подробно — шаг 3.7.
