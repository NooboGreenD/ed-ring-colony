#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════
# ED Ring Colony — проверка только что установленного (или переехавшего)
# сервера. Ничего не меняет: только читает состояние.
#
#   sudo bash deploy/selfhost/smoke-test.sh
#   sudo bash deploy/selfhost/smoke-test.sh --root /srv/edrc --web-port 3000
#   sudo bash deploy/selfhost/smoke-test.sh --site-url https://ring.example.com
#
# Что проверяет: контейнеры сайта, задач и стека Supabase; ответ сайта
# напрямую и через nginx; живость Postgres и схему (>= 50 таблиц); шлюз
# Kong, Auth и Storage; запись в каталоги дампов Spansh и релизов Helper
# от имени пользователя сайта (uid 1001) — именно здесь чаще всего
# всплывают права на отдельном диске.
#
# Код возврата: 0 — всё в порядке (предупреждения допустимы),
#               1 — есть хотя бы одна ошибка.
# ═════════════════════════════════════════════════════════════════════
set -uo pipefail

ROOT_DIR="${EDRC_ROOT:-}"
WEB_PORT="${WEB_HOST_PORT:-}"
SITE_URL="${NEXT_PUBLIC_SITE_URL:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --root)     ROOT_DIR="${2:?}"; shift 2;;
    --web-port) WEB_PORT="${2:?}"; shift 2;;
    --site-url) SITE_URL="${2:?}"; shift 2;;
    -h|--help)  sed -n '2,/^set -uo pipefail$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "Неизвестный флаг: $1 (см. --help)" >&2; exit 1;;
  esac
done

ROOT_DIR="${ROOT_DIR:-/opt/ed-ring-colony}"
ENV_FILE="$ROOT_DIR/src/.env.production"
PASS=0 FAIL=0 WARNED=0
ok()   { echo "  ✓ $*"; PASS=$((PASS + 1)); }
bad()  { echo "  ✗ $*" >&2; FAIL=$((FAIL + 1)); }
soft() { echo "  ! $*"; WARNED=$((WARNED + 1)); }
head_() { echo; echo "── $* ──"; }

env_value() { # KEY — значение из .env.production без кавычек
  [ -f "$ENV_FILE" ] || return 0
  grep "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"'"'"
}

[ -d "$ROOT_DIR" ] || { echo "✗ каталог установки не найден: $ROOT_DIR (укажите --root)" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "✗ нет $ENV_FILE — установка не завершена?" >&2; exit 1; }

WEB_PORT="${WEB_PORT:-$(env_value WEB_HOST_PORT)}"
WEB_PORT="${WEB_PORT:-3000}"
SITE_URL="${SITE_URL:-$(env_value NEXT_PUBLIC_SITE_URL)}"
GALAXY_DIR="$(env_value GALAXY_DATA_HOST_DIR)"
UPLOADER_DIR="$(env_value UPLOADER_STORE_HOST_DIR)"
JOBS_ENABLED="$(env_value JOBS_ENABLED)"
SUPABASE_HOST_DIR="$(env_value SUPABASE_HOST_DIR)"

command -v docker >/dev/null 2>&1 || { echo "✗ docker не найден в PATH" >&2; exit 1; }

# Контейнер по метке compose: имя проекта зависит от каталога установки
# (`src-web-1`, `edrc-web-1`…), а метка сервиса — нет.
ctr_id() { docker ps -q --filter "label=com.docker.compose.service=$1" 2>/dev/null | head -n1; }
ctr_state() { # service — running | exited | отсутствует
  local id; id="$(ctr_id "$1")"
  [ -n "$id" ] || { echo "нет"; return; }
  local status; status="$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null)"
  echo "${status:-unknown}"
}

head_ "Контейнеры проекта"
for service in web jobs; do
  state="$(ctr_state "$service")"
  if [ "$state" = running ]; then ok "$service: работает"
  elif [ "$service" = jobs ] && [ -z "$JOBS_ENABLED" ]; then soft "jobs: не запущен (JOBS_ENABLED пуст — так и задумано)"
  else bad "$service: $state (docker compose logs $service)"
  fi
done
for service in monitor-agent update-agent; do
  state="$(ctr_state "$service")"
  case "$state" in
    running) ok "$service: работает";;
    нет)     soft "$service: не запущен (Админка → Мониторинг будет недоступна; включается deploy/start-monitoring.sh)";;
    *)       bad "$service: $state";;
  esac
done

head_ "Стек Supabase"
for service in db auth rest storage; do
  state="$(ctr_state "$service")"
  [ "$state" = running ] && ok "$service: работает" || bad "$service: $state (см. docker logs supabase-$service)"
done

if [ "$(ctr_state db)" = running ]; then
  if docker exec supabase-db pg_isready -U postgres >/dev/null 2>&1; then
    ok "Postgres принимает подключения"
    TABLES="$(docker exec supabase-db psql -U postgres -d postgres -tAc \
      "SELECT count(*) FROM pg_tables WHERE schemaname='public'" 2>/dev/null | tr -d '[:space:]')"
    if [ "${TABLES:-0}" -ge 50 ]; then ok "схема применена: таблиц в public — $TABLES"
    else bad "в public ${TABLES:-0} таблиц — схема не применилась (supabase/full_schema.sql)"; fi
  else
    bad "Postgres не отвечает (pg_isready)"
  fi
fi

head_ "Сайт"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$WEB_PORT/api/health" || true)"
if [ "$code" = 200 ]; then ok "http://127.0.0.1:$WEB_PORT/api/health — 200"
else bad "http://127.0.0.1:$WEB_PORT/api/health — ${code:-нет ответа} (docker compose logs web)"; fi

if [ -n "$SITE_URL" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$SITE_URL/api/health" || true)"
  case "$code" in
    200) ok "$SITE_URL — 200";;
    000|"") soft "$SITE_URL не открылся изнутри сервера (DNS или внешний файрвол)";;
    *) bad "$SITE_URL ответил $code";;
  esac
fi

# Через nginx: Host берём из публичного адреса, иначе сработает default_server.
HOST_HEADER="${SITE_URL#*://}"
HOST_HEADER="${HOST_HEADER%%/*}"
HOST_HEADER="${HOST_HEADER:-localhost}"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -H "Host: $HOST_HEADER" "http://127.0.0.1/api/health" || true)"
if [ "$code" = 200 ]; then ok "nginx отдаёт сайт на порту 80"
else bad "nginx на :80 ответил ${code:-нет ответа} (nginx -t; tail /var/log/nginx/error.log)"; fi

head_ "Шлюз Kong (Auth / Storage)"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8000/auth/v1/health || true)"
if [ "$code" = 200 ]; then ok "Auth: /auth/v1/health — 200"
else bad "Auth: /auth/v1/health — ${code:-нет ответа} (docker logs supabase-auth)"; fi
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8000/storage/v1/version || true)"
if [ "$code" = 200 ]; then ok "Storage: /storage/v1/version — 200"
else bad "Storage: /storage/v1/version — ${code:-нет ответа} (STORAGE-RESTART.md)"; fi

head_ "Каталоги на запись (от имени пользователя сайта)"
# Внутри контейнера web работает uid 1001; проверяем именно его права, а не
# root: на отдельном диске каталог часто принадлежит root, и загрузка дампа
# падает уже после многочасового скачивания.
web_id="$(ctr_id web)"
if [ -n "$web_id" ]; then
  for path in /app/data/spansh /data/uploader; do
    if docker exec "$web_id" sh -c "touch $path/.edrc-probe && rm -f $path/.edrc-probe" 2>/dev/null; then
      ok "$path: запись разрешена"
    else
      bad "$path: запись запрещена (chown -R 1001:1001 на хостовый каталог)"
    fi
  done
else
  soft "контейнер web не запущен — права на каталоги не проверить"
fi

for dir in "$GALAXY_DIR" "$UPLOADER_DIR"; do
  [ -n "$dir" ] || continue
  [ -d "$dir" ] || { bad "каталога нет: $dir"; continue; }
  free_gb="$(df -Pk "$dir" | awk 'NR==2 {print int($4/1048576)}')"
  if [ "${free_gb:-0}" -lt 5 ]; then soft "$dir: свободно ${free_gb} ГБ — мало для дампа Spansh и релизов"
  else ok "$dir: свободно ${free_gb} ГБ"
  fi
done

head_ "Фоновые задачи"
state_file="$(docker exec "$(ctr_id jobs)" sh -c 'cat /data/jobs-state.json' 2>/dev/null || true)"
if [ -z "$JOBS_ENABLED" ]; then
  soft "JOBS_ENABLED пуст — задачи выключены"
elif [ -n "$state_file" ]; then
  ok "состояние задач доступно ($(printf '%s' "$state_file" | tr -d '\n' | cut -c1-80)…)"
else
  soft "jobs ещё не записал /data/jobs-state.json (первый запуск)"
fi

echo
echo "Итого: ✓ $PASS · ✗ $FAIL · предупреждений $WARNED"
if [ "$FAIL" -gt 0 ]; then
  echo "Есть ошибки — раздел «Если что-то не так» в DEPLOY-ANY.md." >&2
  exit 1
fi
echo "Сервер готов к работе."
