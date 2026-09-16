# «Живой экран» — сервер

Серверная часть по `../server-spec.md` (версия 2.1): комнаты, роли, листья, WebSocket,
Telegram-бот. Стек нарочно простой, как у «Бумажного аквариума»: один процесс Node,
база SQLite и картинки в папке `data/`. Папка самостоятельна: свой `package.json`, ничего
не импортирует из `scene/` и `uploader/`. В декабре уезжает в приватный репозиторий как есть.

## Поднять локально одной командой (Docker)

```
cd server
cp .env.example .env
docker compose up -d --build
curl http://localhost:8080/healthz
```

Ответ `{"ok":true,"checks":{"db":{"ok":true,...},"storage":{"ok":true,"freeMb":...}}}` — всё
поднялось. Если нет — `ok:false` и в `checks` написано, что именно (503).

Два контейнера: `app` (Node 20: API, позже WS и бот; база и картинки в `./data` рядом с
compose) и `caddy` (снаружи порт 8080 → API в `app`, статика сцены из `./www`).

Логи: `docker compose logs -f app`. Остановить: `docker compose down` (папка `data/`
остаётся; стереть всё — удалить её руками).

## Без Docker (разработка)

Нужен только Node 20+. Ничего ставить не надо: база создастся сама в `data/`.

```
cd server
npm ci
npm run dev          # http://localhost:3000/healthz ; tsx watch, миграции при старте
npm run typecheck
npm run build && npm start
npm run migrate      # применить миграции отдельно
```

## Миграции

`migrations/NNNN_название.sql` (диалект SQLite), применяются по порядку при старте, каждая
в транзакции; применённые — в таблице `schema_migrations`. Новая миграция — новый файл,
старые не менять.

## Переменные окружения

Все — в `.env.example` с комментариями. Обязательных нет: по умолчанию порт 3000, данные в
`data/`. `TELEGRAM_BOT_TOKEN` до шага 3.4 пустой, ключи бэкапа — до шага 3.6.

## На VPS

`SITE_ADDRESS=домен` в `.env` (Caddy сам получит HTTPS), порты Caddy `80:80` и `443:443`
в compose. Деплой: `git pull && docker compose up -d --build`. Бэкап — архив `data/`
(шаг 3.6). Подробно — шаг 3.7.
