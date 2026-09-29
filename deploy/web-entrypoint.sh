#!/bin/sh
set -eu

store="${UPLOADER_STORE_DIR:-/data/uploader}"
mkdir -p "$store"
# Хранилище содержит приватный ключ подписи. Корень доступен только web-user;
# существующие файлы от старого root-контейнера также передаём ему.
chown -R nextjs:nodejs "$store"
chmod 0700 "$store"

exec su-exec nextjs:nodejs "$@"
