#!/bin/sh
set -eu

store="${UPLOADER_STORE_DIR:-/data/uploader}"
mkdir -p "$store"
# Хранилище содержит приватный ключ подписи. Корень доступен только web-user;
# существующие файлы от старого root-контейнера также передаём ему.
chown -R nextjs:nodejs "$store"
chmod 0700 "$store"

# Дампы Spansh и шарды лежат на отдельном диске (bind mount
# GALAXY_DATA_HOST_DIR → /app/data/spansh). Каталог на хосте обычно создан
# root'ом, поэтому права приводим к пользователю веб-процесса — иначе импорт
# не сможет записать архив. Файлов тут десятки, не миллионы: chown дешёвый.
galaxy="${GALAXY_ARCHIVE_DIR:-/app/data/spansh}"
mkdir -p "$galaxy/shards"
chown -R nextjs:nodejs "$galaxy" 2>/dev/null || chown nextjs:nodejs "$galaxy" "$galaxy/shards" || true

exec su-exec nextjs:nodejs "$@"
