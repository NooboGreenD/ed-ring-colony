#!/usr/bin/env bash
# Перенос старого Docker named volume uploader-store на отдельный диск с backup'ами.
# Запускать от root ДО первого `docker compose up -d` после перехода на bind mount:
#   sudo bash deploy/migrate-uploader-store.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env.production}"
[ -f "$ENV_FILE" ] || ENV_FILE="$PROJECT_DIR/.env"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/docker-compose.yml}"
DEFAULT_DEST="/opt/ed-ring-colony/backups/uploader-releases"

value_from_env() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  awk -F= -v wanted="$key" '$1 == wanted { sub(/^[^=]*=/, ""); value=$0 } END { print value }' "$ENV_FILE"
}

HOST_DIR="${UPLOADER_STORE_HOST_DIR:-$(value_from_env UPLOADER_STORE_HOST_DIR)}"
HOST_DIR="${HOST_DIR:-$DEFAULT_DEST}"
case "$HOST_DIR" in
  /*) ;;
  *) HOST_DIR="$PROJECT_DIR/$HOST_DIR" ;;
esac

command -v docker >/dev/null 2>&1 || { echo "Нужен docker" >&2; exit 1; }
[ -f "$COMPOSE_FILE" ] || { echo "Не найден $COMPOSE_FILE" >&2; exit 1; }

compose() {
  docker compose --project-directory "$PROJECT_DIR" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

# Compose labels are preferred; the project-prefixed fallback covers older
# Compose versions which did not write the label consistently.
PROJECT_NAME="$(compose config --name 2>/dev/null || basename "$PROJECT_DIR")"
VOLUME_NAME="${PROJECT_NAME}_uploader-store"
if ! docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
  VOLUME_NAME="$(docker volume ls -q --filter label=com.docker.compose.volume=uploader-store | head -n 1)"
fi
if [ -z "$VOLUME_NAME" ] || ! docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
  echo "Старый volume uploader-store не найден — копировать нечего."
  echo "Новая папка: $HOST_DIR"
  mkdir -p "$HOST_DIR"
  exit 0
fi

MOUNTPOINT="$(docker volume inspect -f '{{.Mountpoint}}' "$VOLUME_NAME")"
[ -d "$MOUNTPOINT" ] || { echo "Не найден mountpoint $MOUNTPOINT" >&2; exit 1; }
mkdir -p "$HOST_DIR"

if [ "$(find "$HOST_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  echo "В $HOST_DIR уже есть файлы. Копирование будет объединено без перезаписи существующих файлов."
fi

echo "Источник: $VOLUME_NAME ($MOUNTPOINT)"
echo "Назначение: $HOST_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -aH --numeric-ids --ignore-existing "$MOUNTPOINT/" "$HOST_DIR/"
else
  # install.sh ставит rsync, но сохраняем рабочий fallback для ручного запуска.
  cp -an "$MOUNTPOINT/." "$HOST_DIR/"
fi

# web-entrypoint всё равно выправит владельца при запуске; root:root здесь
# допустим и не требует менять права на исходный named volume.
if [ -d "$HOST_DIR/manifests" ]; then
  COUNT="$(find "$HOST_DIR/manifests" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')"
else
  COUNT=0
fi
printf 'Готово: %s манифестов перенесено/найдено в %s\n' "$COUNT" "$HOST_DIR"
printf 'Исходный volume НЕ удалён. После проверки можно оставить его как аварийную копию.\n'
