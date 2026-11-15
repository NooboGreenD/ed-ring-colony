#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════
# ED Ring Colony — починка глобального лимита Storage на уже работающем
# сервере (облако точек карты не загружается, 413 «size exceeds»).
#
#   sudo bash deploy/selfhost/fix-storage-limit.sh --check   # только показать
#   sudo bash deploy/selfhost/fix-storage-limit.sh           # исправить
#
# Зачем отдельный скрипт. Глобальный лимит файла у self-hosted Supabase —
# 50 МиБ, и он не зависит от `.env` стека: число зашито в docker-compose.yml
# сервиса storage. Облако точек карты (`galaxy-data`) весит до 64 МиБ, и
# такая загрузка отклоняется навсегда — по размеру она не повторяется.
# Скрипт подставляет `${FILE_SIZE_LIMIT:-52428800}` в compose, ставит
# `FILE_SIZE_LIMIT=73400320` (70 МиБ) в `.env` и пересоздаёт только контейнер
# storage. Сайт, база и Auth не перезапускаются.
#
# Идемпотентен: на исправленном стенде ничего не меняет (в режиме --check
# только сообщает состояние). Стек Supabase ищется в /opt/supabase либо в
# каталоге из переменной SUPABASE_HOST_DIR.
# ═════════════════════════════════════════════════════════════════════
set -uo pipefail

SUPA_DIR="${SUPABASE_HOST_DIR:-}"
CHECK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)   SUPA_DIR="${2:?}"; shift 2;;
    --check) CHECK_ONLY=1; shift;;
    -h|--help) sed -n '2,/^set -uo pipefail$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "Неизвестный флаг: $1 (см. --help)" >&2; exit 1;;
  esac
done
SUPA_DIR="${SUPA_DIR:-/opt/supabase}"
COMPOSE="$SUPA_DIR/docker-compose.yml"
ENVFILE="$SUPA_DIR/.env"
TARGET_LIMIT=73400320   # 70 МиБ: облако точек 64 МиБ + запас на multipart

[ -f "$COMPOSE" ] || { echo "✗ нет $COMPOSE — укажите --dir или SUPABASE_HOST_DIR" >&2; exit 1; }

# Текущий лимит: последнее значение из compose (у сервиса storage оно одно).
current() {
  sed -n 's/^[[:space:]]*FILE_SIZE_LIMIT:[[:space:]]*\(.*\)$/\1/p' "$COMPOSE" | tail -n1
}

BEFORE="$(current)"
echo "Стек:   $SUPA_DIR"
echo "Лимит в compose: ${BEFORE:-не найден}"

if [ "$BEFORE" = '${FILE_SIZE_LIMIT:-52428800}' ]; then
  echo "✓ compose уже берёт лимит из .env стека"
elif [ -z "$BEFORE" ]; then
  echo "✗ в compose нет FILE_SIZE_LIMIT — версия стека другая, правьте вручную" >&2
  exit 1
else
  echo "→ будет заменён на \${FILE_SIZE_LIMIT:-52428800}"
fi

ENV_LIMIT="$(grep -q '^FILE_SIZE_LIMIT=' "$ENVFILE" 2>/dev/null && grep '^FILE_SIZE_LIMIT=' "$ENVFILE" | tail -n1 | cut -d= -f2- || true)"
echo "Лимит в .env:    ${ENV_LIMIT:-не задан}"
if [ "${ENV_LIMIT:-0}" -ge 67108864 ] 2>/dev/null; then
  echo "✓ .env уже разрешает 64 МиБ и больше"
else
  echo "→ в .env будет FILE_SIZE_LIMIT=$TARGET_LIMIT (70 МиБ)"
fi

if [ "$CHECK_ONLY" = 1 ]; then
  echo
  echo "Режим --check: ничего не изменено. Запустите без флага, чтобы исправить."
  exit 0
fi

[ "$(id -u)" = 0 ] || { echo "Запускайте под root: sudo bash $0" >&2; exit 1; }

BACKUP="$COMPOSE.bak-$(date +%Y%m%d%H%M%S)"
cp "$COMPOSE" "$BACKUP"
echo "копия compose: $BACKUP"
sed -i 's|^\([[:space:]]*\)FILE_SIZE_LIMIT:.*|\1FILE_SIZE_LIMIT: ${FILE_SIZE_LIMIT:-52428800}|' "$COMPOSE"

if grep -q '^FILE_SIZE_LIMIT=' "$ENVFILE" 2>/dev/null; then
  sed -i "s|^FILE_SIZE_LIMIT=.*|FILE_SIZE_LIMIT=$TARGET_LIMIT|" "$ENVFILE"
else
  echo "FILE_SIZE_LIMIT=$TARGET_LIMIT" >> "$ENVFILE"
fi

# Пересоздаём только storage: остальные сервисы стека читают compose при
# следующем обычном перезапуске, а сайт вообще не участвует.
if ! ( cd "$SUPA_DIR" && docker compose up -d --no-deps storage ); then
  echo "✗ не удалось пересоздать storage. Откат: cp $BACKUP $COMPOSE && docker compose up -d --no-deps storage" >&2
  exit 1
fi

echo
echo "Готово. Проверка:"
docker exec supabase-storage sh -c 'echo "FILE_SIZE_LIMIT=$FILE_SIZE_LIMIT"' 2>/dev/null \
  || echo "  (контейнер не ответил — docker logs supabase-storage)"
echo
echo "Дальше — кнопка «Повторить загрузку в storage» в Админке (или следующий"
echo "импорт/пересборка облака точек). Новый лимит: $TARGET_LIMIT байт."
