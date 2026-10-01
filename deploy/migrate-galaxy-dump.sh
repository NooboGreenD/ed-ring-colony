#!/usr/bin/env bash
# Перенос хранилища дампов Spansh (архивы + распакованные шарды) с Docker
# named volume `galaxy-dump` на отдельный диск сервера (по умолчанию /mnt/sdb).
#
# Зачем: полный systems.json.gz — 5.9 ГиБ, его шарды — ещё столько же, а
# сырой systems.json был бы 32+ ГБ. Этому хозяйству не место на системном
# диске рядом с образами Docker.
#
# Запускать от root ДО первого `docker compose up -d` после перехода на bind
# mount:
#   sudo bash deploy/migrate-galaxy-dump.sh
#
# Куда переносить, берётся из GALAXY_DATA_HOST_DIR (.env.production), иначе
# /mnt/sdb/ed-ring-colony/spansh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env.production}"
[ -f "$ENV_FILE" ] || ENV_FILE="$PROJECT_DIR/.env"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/docker-compose.yml}"
DEFAULT_DEST="/mnt/sdb/ed-ring-colony/spansh"

value_from_env() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  awk -F= -v wanted="$key" '$1 == wanted { sub(/^[^=]*=/, ""); value=$0 } END { print value }' "$ENV_FILE"
}

HOST_DIR="${GALAXY_DATA_HOST_DIR:-$(value_from_env GALAXY_DATA_HOST_DIR)}"
HOST_DIR="${HOST_DIR:-$DEFAULT_DEST}"
case "$HOST_DIR" in
  /*) ;;
  *) HOST_DIR="$PROJECT_DIR/$HOST_DIR" ;;
esac

command -v docker >/dev/null 2>&1 || { echo "Нужен docker" >&2; exit 1; }
[ -f "$COMPOSE_FILE" ] || { echo "Не найден $COMPOSE_FILE" >&2; exit 1; }

# Предупреждаем, если каталог оказался не на отдельном диске: ради этого всё и
# затевалось, а молча заполнить системный раздел на 12 ГиБ — плохой сюрприз.
MOUNT_ROOT="$HOST_DIR"
while [ ! -d "$MOUNT_ROOT" ] && [ "$MOUNT_ROOT" != "/" ]; do MOUNT_ROOT="$(dirname "$MOUNT_ROOT")"; done
if command -v findmnt >/dev/null 2>&1; then
  TARGET_DEV="$(findmnt -no SOURCE --target "$MOUNT_ROOT" 2>/dev/null || true)"
  ROOT_DEV="$(findmnt -no SOURCE --target / 2>/dev/null || true)"
  if [ -n "$TARGET_DEV" ] && [ "$TARGET_DEV" = "$ROOT_DEV" ]; then
    echo "ВНИМАНИЕ: $HOST_DIR лежит на корневом разделе ($TARGET_DEV), а не на отдельном диске."
    echo "          Смонтируйте диск (например /mnt/sdb) или задайте GALAXY_DATA_HOST_DIR."
  fi
fi

AVAIL_GIB="$(df -BG --output=avail "$MOUNT_ROOT" 2>/dev/null | tail -n 1 | tr -dc '0-9' || true)"
if [ -n "$AVAIL_GIB" ]; then
  echo "Свободно на $MOUNT_ROOT: ${AVAIL_GIB} ГиБ (полному дампу с шардами нужно ~13 ГиБ)"
fi

mkdir -p "$HOST_DIR/shards"

compose() {
  docker compose --project-directory "$PROJECT_DIR" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

PROJECT_NAME="$(compose config --name 2>/dev/null || basename "$PROJECT_DIR")"
VOLUME_NAME="${PROJECT_NAME}_galaxy-dump"
if ! docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
  VOLUME_NAME="$(docker volume ls -q --filter label=com.docker.compose.volume=galaxy-dump | head -n 1)"
fi
if [ -z "$VOLUME_NAME" ] || ! docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
  echo "Старый volume galaxy-dump не найден — копировать нечего."
  echo "Новый каталог готов: $HOST_DIR"
  exit 0
fi

MOUNTPOINT="$(docker volume inspect -f '{{.Mountpoint}}' "$VOLUME_NAME")"
[ -d "$MOUNTPOINT" ] || { echo "Не найден mountpoint $MOUNTPOINT" >&2; exit 1; }

SIZE="$(du -sh "$MOUNTPOINT" 2>/dev/null | cut -f1 || echo '?')"
echo "Источник: $VOLUME_NAME ($MOUNTPOINT, $SIZE)"
echo "Назначение: $HOST_DIR"

if command -v rsync >/dev/null 2>&1; then
  # --ignore-existing: повторный запуск не перезаписывает уже перенесённое.
  rsync -aH --numeric-ids --info=progress2 --ignore-existing "$MOUNTPOINT/" "$HOST_DIR/"
else
  cp -an "$MOUNTPOINT/." "$HOST_DIR/"
fi

ARCHIVES="$(find "$HOST_DIR" -maxdepth 1 -type f -name 'systems*.json.gz' | wc -l | tr -d ' ')"
SHARDS="$(find "$HOST_DIR/shards" -maxdepth 1 -type f -name 'shard-*.tsv.gz' 2>/dev/null | wc -l | tr -d ' ')"
printf 'Готово: %s архив(ов) и %s шард(ов) в %s\n' "$ARCHIVES" "$SHARDS" "$HOST_DIR"
printf 'Исходный volume НЕ удалён. Проверьте работу импорта и освободите место:\n'
printf '  docker volume rm %s\n' "$VOLUME_NAME"
