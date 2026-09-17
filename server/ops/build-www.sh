#!/bin/sh
# Собирает страницы сайта в server/www (их раздаёт Caddy):
#   www/index.html   — главная (site/)
#   www/tv/          — сцена (scene/, сборка Vite в контейнере node:22 — Node на VPS не нужен)
#   www/r/           — загрузчик (uploader/)
#   www/vendor/      — capture.js + LICENSE (vendor/paper-aquarium/, как есть)
# Запуск на VPS: sh server/ops/build-www.sh   (из корня репозитория или откуда угодно)
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WWW="$ROOT/server/www"
echo "→ сборка сцены (scene/)"
if docker info >/dev/null 2>&1; then
  docker run --rm -v "$ROOT:/repo" -w /repo/scene node:22-bookworm-slim sh -c "npm ci --no-audit --no-fund && npm run build"
else
  (cd "$ROOT/scene" && npm ci --no-audit --no-fund && npm run build)
fi
rm -rf "$WWW/tv" "$WWW/r" "$WWW/vendor"
mkdir -p "$WWW/tv" "$WWW/r" "$WWW/vendor"
cp -r "$ROOT/scene/dist/." "$WWW/tv/"
cp "$ROOT/uploader/index.html" "$ROOT/uploader/app.js" "$ROOT/uploader/app.css" "$WWW/r/"
cp "$ROOT/vendor/paper-aquarium/capture.js" "$ROOT/vendor/paper-aquarium/LICENSE" "$WWW/vendor/"
cp "$ROOT/site/index.html" "$ROOT/site/rules.html" "$WWW/"
echo "✓ готово: $WWW"
ls "$WWW"
