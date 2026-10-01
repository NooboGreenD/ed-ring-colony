#!/usr/bin/env bash
# Хранилище дампов Spansh (архивы + распакованные шарды) на отдельном диске.
#
# Зачем: полный systems.json.gz — 5.9 ГиБ, его шарды — ещё столько же, а
# сырой systems.json был бы 32+ ГБ. Этому хозяйству не место на системном
# диске рядом с образами Docker.
#
# Что делает скрипт:
#   1) находит точку монтирования диска (по умолчанию устройство /dev/sdb1),
#   2) создаёт на нём каталог для дампов и печатает строку для .env.production,
#   3) переносит данные со старого Docker named volume `galaxy-dump`, если он
#      есть (rsync, ничего не удаляя).
#
# Запускать от root ДО первого `docker compose up -d` после перехода на bind
# mount:
#   sudo bash deploy/migrate-galaxy-dump.sh
#
# Переопределения:
#   GALAXY_DATA_HOST_DIR=/mnt/sdb/ed-ring-colony/spansh  # готовый путь
#   GALAXY_DATA_DEVICE=/dev/sdb1                         # какое устройство искать
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env.production}"
[ -f "$ENV_FILE" ] || ENV_FILE="$PROJECT_DIR/.env"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/docker-compose.yml}"
DEVICE="${GALAXY_DATA_DEVICE:-/dev/sdb1}"
SUBDIR="ed-ring-colony/spansh"
DEFAULT_DEST="/mnt/sdb/$SUBDIR"

value_from_env() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  awk -F= -v wanted="$key" '$1 == wanted { sub(/^[^=]*=/, ""); value=$0 } END { print value }' "$ENV_FILE"
}

# ─────────────── 1. куда класть: явный путь → точка монтирования ───────────────

HOST_DIR="${GALAXY_DATA_HOST_DIR:-$(value_from_env GALAXY_DATA_HOST_DIR)}"
MOUNTPOINT=""

if [ -z "$HOST_DIR" ]; then
  # Устройство (/dev/sdb1) само по себе не путь: compose монтирует каталог,
  # поэтому выясняем, куда это устройство смонтировано.
  if command -v findmnt >/dev/null 2>&1; then
    MOUNTPOINT="$(findmnt -no TARGET --source "$DEVICE" 2>/dev/null | head -n 1 || true)"
  fi
  if [ -z "$MOUNTPOINT" ] && [ -r /proc/mounts ]; then
    REAL_DEV="$(readlink -f "$DEVICE" 2>/dev/null || echo "$DEVICE")"
    MOUNTPOINT="$(awk -v dev="$REAL_DEV" '$1 == dev { print $2; exit }' /proc/mounts || true)"
  fi

  if [ -n "$MOUNTPOINT" ]; then
    HOST_DIR="${MOUNTPOINT%/}/$SUBDIR"
    echo "Диск $DEVICE смонтирован в $MOUNTPOINT → каталог дампов: $HOST_DIR"
  else
    echo "ВНИМАНИЕ: $DEVICE не смонтирован (или это не тот диск)."
    if command -v lsblk >/dev/null 2>&1; then
      echo "Текущие диски:"
      lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT 2>/dev/null | sed 's/^/  /'
    fi
    cat <<EOF

Смонтируйте диск постоянно (пример для $DEVICE в /mnt/sdb):
  sudo mkdir -p /mnt/sdb
  sudo blkid $DEVICE          # взять UUID
  echo 'UUID=<uuid> /mnt/sdb ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
  sudo mount -a

Затем повторите запуск этого скрипта.
EOF
    exit 1
  fi
fi

case "$HOST_DIR" in
  /*) ;;
  *) HOST_DIR="$PROJECT_DIR/$HOST_DIR" ;;
esac
[ -n "$HOST_DIR" ] || HOST_DIR="$DEFAULT_DEST"

# ─────────────── 2. проверки: тот ли это раздел и хватит ли места ───────────────

MOUNT_ROOT="$HOST_DIR"
while [ ! -d "$MOUNT_ROOT" ] && [ "$MOUNT_ROOT" != "/" ]; do MOUNT_ROOT="$(dirname "$MOUNT_ROOT")"; done

if command -v findmnt >/dev/null 2>&1; then
  TARGET_DEV="$(findmnt -no SOURCE --target "$MOUNT_ROOT" 2>/dev/null || true)"
  ROOT_DEV="$(findmnt -no SOURCE --target / 2>/dev/null || true)"
  if [ -n "$TARGET_DEV" ] && [ "$TARGET_DEV" = "$ROOT_DEV" ]; then
    echo "ВНИМАНИЕ: $HOST_DIR лежит на корневом разделе ($TARGET_DEV), а не на отдельном диске."
    echo "          Смонтируйте $DEVICE и задайте GALAXY_DATA_HOST_DIR."
  fi
fi

AVAIL_GIB="$(df -BG --output=avail "$MOUNT_ROOT" 2>/dev/null | tail -n 1 | tr -dc '0-9' || true)"
if [ -n "$AVAIL_GIB" ]; then
  echo "Свободно на $MOUNT_ROOT: ${AVAIL_GIB} ГиБ (полному дампу с шардами нужно ~13 ГиБ)"
  [ "$AVAIL_GIB" -lt 13 ] && echo "          Этого мало для холодного старта с распаковкой в шарды."
fi

mkdir -p "$HOST_DIR/shards"

cat <<EOF

Строка для $ENV_FILE:
  GALAXY_DATA_HOST_DIR=$HOST_DIR

EOF

# ─────────────── 3. перенос со старого named volume ───────────────

if ! command -v docker >/dev/null 2>&1; then
  echo "docker не найден — пропускаю перенос старого volume. Каталог готов: $HOST_DIR"
  exit 0
fi
[ -f "$COMPOSE_FILE" ] || { echo "Не найден $COMPOSE_FILE — перенос пропущен. Каталог готов: $HOST_DIR"; exit 0; }

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
  echo "Каталог готов: $HOST_DIR"
  exit 0
fi

VOLUME_PATH="$(docker volume inspect -f '{{.Mountpoint}}' "$VOLUME_NAME")"
[ -d "$VOLUME_PATH" ] || { echo "Не найден mountpoint $VOLUME_PATH" >&2; exit 1; }

SIZE="$(du -sh "$VOLUME_PATH" 2>/dev/null | cut -f1 || echo '?')"
echo "Источник: $VOLUME_NAME ($VOLUME_PATH, $SIZE)"
echo "Назначение: $HOST_DIR"

if command -v rsync >/dev/null 2>&1; then
  # --ignore-existing: повторный запуск не перезаписывает уже перенесённое.
  rsync -aH --numeric-ids --info=progress2 --ignore-existing "$VOLUME_PATH/" "$HOST_DIR/"
else
  cp -an "$VOLUME_PATH/." "$HOST_DIR/"
fi

ARCHIVES="$(find "$HOST_DIR" -maxdepth 1 -type f -name 'systems*.json.gz' | wc -l | tr -d ' ')"
SHARDS="$(find "$HOST_DIR/shards" -maxdepth 1 -type f -name 'shard-*.tsv.gz' 2>/dev/null | wc -l | tr -d ' ')"
printf 'Готово: %s архив(ов) и %s шард(ов) в %s\n' "$ARCHIVES" "$SHARDS" "$HOST_DIR"
printf 'Исходный volume НЕ удалён. Проверьте работу импорта и освободите место:\n'
printf '  docker volume rm %s\n' "$VOLUME_NAME"
