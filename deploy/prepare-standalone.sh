#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Собирает готовый к запуску каталог из standalone-выхлопа Next.js.
#
# Использование (из корня репозитория, после `npm run build`):
#   ./deploy/prepare-standalone.sh [каталог-назначения]
#
# По умолчанию кладёт результат в ./deploy-out.
# Далее каталог можно целиком перенести на сервер (rsync/scp) и запустить:
#   node server.js
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

DEST="${1:-deploy-out}"

if [ ! -d ".next/standalone" ]; then
  echo "Ошибка: .next/standalone не найден. Сначала выполните: npm run build" >&2
  echo "(убедитесь, что в next.config.mjs включён output: 'standalone')" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"

# Минимальный сервер + его node_modules
cp -r .next/standalone/. "$DEST/"
# Клиентская статика (standalone её не включает)
mkdir -p "$DEST/.next/static"
cp -r .next/static/. "$DEST/.next/static/"
# Публичные файлы (иконки, картинки, sw.js, wiki-изображения)
cp -r public "$DEST/public"

echo "Готово: $DEST"
echo
echo "Перенос на сервер:"
echo "  rsync -az --delete $DEST/ user@server:/opt/ed-ring-colony/app/"
echo
echo "Запуск на сервере:"
echo "  cd /opt/ed-ring-colony/app && PORT=3000 node server.js"
