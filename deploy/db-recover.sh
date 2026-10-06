#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — диагностика и восстановление БД после перезагрузки.
#
# Запускается НА ХОСТЕ (sudo не обязателен, если пользователь в группе
# docker). Ничего не удаляет и не трогает данные: по умолчанию только
# собирает картину «почему стек Supabase поднялся не до конца».
#
#   bash deploy/db-recover.sh            # только отчёт
#   bash deploy/db-recover.sh --fix      # отчёт + перезапуск в верном порядке
#
# Почему порядок важен: после ребута Postgres может минутами проигрывать
# WAL, а rest/auth/realtime/pooler за это время исчерпывают свои ретраи и
# остаются unhealthy, хотя БД уже готова. Лечение — не «перезапустить всё
# разом», а дождаться готовности supabase-db и затем поднять зависимые
# сервисы (и наш web, который держит пул соединений).
#
# Переменные:
#   SUPABASE_DIR        каталог стека Supabase (default /opt/supabase)
#   SUPABASE_CONTAINER  контейнер Postgres (default: ищем *supabase-db)
#   PROJECT_DIR         каталог приложения (default /opt/ed-ring-colony/src)
#   WAIT_SECONDS        сколько ждать готовности БД в режиме --fix (default 300)
#   LOG_LINES           сколько строк логов показывать (default 40)
# ─────────────────────────────────────────────────────────────────────
set -uo pipefail

SUPABASE_DIR="${SUPABASE_DIR:-/opt/supabase}"
PROJECT_DIR="${PROJECT_DIR:-/opt/ed-ring-colony/src}"
WAIT_SECONDS="${WAIT_SECONDS:-300}"
LOG_LINES="${LOG_LINES:-40}"
FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

say()  { printf '%s\n' "$*"; }
head2() { printf '\n──────── %s ────────\n' "$*"; }
warn() { printf '!! %s\n' "$*"; }

command -v docker >/dev/null 2>&1 || { warn "docker не найден"; exit 1; }

DB="${SUPABASE_CONTAINER:-$(docker ps -a --format '{{.Names}}' | grep -E 'supabase-db$' | head -n1)}"
[ -n "$DB" ] || { warn "контейнер supabase-db не найден"; exit 1; }

# ── 1. Состояние контейнеров ─────────────────────────────────────────
head2 "Контейнеры стека"
docker ps -a --filter 'name=supabase' --filter 'name=realtime' \
  --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}' 2>/dev/null
docker ps -a --filter 'name=src-' --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null

# ── 2. Почему healthcheck красный ────────────────────────────────────
head2 "Последние ответы healthcheck"
for c in "$DB" supabase-rest supabase-auth supabase-pooler realtime-dev.supabase-realtime; do
  docker inspect "$c" >/dev/null 2>&1 || continue
  state="$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}} failing={{.State.Health.FailingStreak}}{{else}}no-healthcheck{{end}}' "$c" 2>/dev/null)"
  say "• $c — $state"
  docker inspect -f '{{if .State.Health}}{{range $i, $l := .State.Health.Log}}{{if lt $i 2}}  exit={{$l.ExitCode}} {{$l.Output}}{{end}}{{end}}{{end}}' "$c" 2>/dev/null \
    | tr -s '\n' '\n' | sed 's/^/    /' | head -n 6
done

# ── 3. Живость самого Postgres ───────────────────────────────────────
head2 "Postgres"
if docker exec "$DB" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then
  say "pg_isready: принимает соединения"
  docker exec "$DB" psql -U postgres -d postgres -tAc \
    "select 'in_recovery=' || pg_is_in_recovery() || ' uptime=' || date_trunc('second', now() - pg_postmaster_start_time()) || ' conn=' || (select count(*) from pg_stat_activity)" 2>&1 | sed 's/^/  /'
  docker exec "$DB" psql -U postgres -d postgres -tAc \
    "select 'max_connections=' || setting from pg_settings where name='max_connections'" 2>&1 | sed 's/^/  /'
  # Роли, без которых rest/auth/realtime не стартуют (частое последствие
  # неудачно применённой миграции, а не самого ребута).
  docker exec "$DB" psql -U postgres -d postgres -tAc \
    "select 'roles: ' || string_agg(rolname, ',') from pg_roles where rolname in ('authenticator','anon','service_role','supabase_admin','supabase_auth_admin','supabase_storage_admin','supabase_realtime_admin')" 2>&1 | sed 's/^/  /'
else
  warn "pg_isready: НЕ принимает соединения — смотрите лог ниже (recovery / postmaster.pid / права на PGDATA)"
fi

head2 "Лог supabase-db (последние $LOG_LINES строк)"
docker logs --tail "$LOG_LINES" "$DB" 2>&1 | sed 's/^/  /'

head2 "Лог supabase-rest / supabase-auth"
docker logs --tail 15 supabase-rest 2>&1 | sed 's/^/  rest  /'
docker logs --tail 15 supabase-auth 2>&1 | sed 's/^/  auth  /'

# ── 4. Хостовые причины: диск и монтирование ─────────────────────────
head2 "Диск и тома"
df -h / /var/lib/docker "$SUPABASE_DIR" 2>/dev/null | sed 's/^/  /'
VOL="$(docker inspect -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' "$DB" 2>/dev/null | grep -E '/(var/lib/postgresql|data)' | head -n3)"
[ -n "$VOL" ] && say "  PGDATA mount: $VOL"
mountpoint -q /mnt/sdb 2>/dev/null && say "  /mnt/sdb смонтирован" || warn "/mnt/sdb не смонтирован (каталог систем Spansh и бэкапы; см. SPANSH-IMPORT.md)"

# ── 5. Образ auth: не остался ли rollback-образ ──────────────────────
AUTH_IMG="$(docker inspect -f '{{.Config.Image}}' supabase-auth 2>/dev/null || true)"
case "$AUTH_IMG" in
  *rollback*) warn "supabase-auth работает на временном образе $AUTH_IMG — после починки БД верните штатный образ (MONITORING.md, раздел про auth)";;
esac

if [ "$FIX" -eq 0 ]; then
  say ""
  say "Отчёт собран. Для восстановления: bash deploy/db-recover.sh --fix"
  exit 0
fi

# ── 6. Восстановление в правильном порядке ───────────────────────────
head2 "Ожидание готовности Postgres (до ${WAIT_SECONDS}с)"
docker start "$DB" >/dev/null 2>&1 || true
deadline=$(( $(date +%s) + WAIT_SECONDS ))
until docker exec "$DB" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; do
  [ "$(date +%s)" -ge "$deadline" ] && { warn "Postgres так и не принял соединения — дальше НЕ перезапускаю, разбирайте лог supabase-db"; exit 1; }
  sleep 5
  printf '.'
done
say ""
say "Postgres готов."

head2 "Перезапуск зависимых сервисов"
for c in supabase-rest supabase-auth realtime-dev.supabase-realtime supabase-pooler supabase-meta supabase-storage supabase-envoy supabase-kong; do
  docker inspect "$c" >/dev/null 2>&1 || continue
  say "  restart $c"
  docker restart "$c" >/dev/null 2>&1 || warn "    не удалось перезапустить $c"
  sleep 3
done

# web держит пул соединений: после недоступной БД его стоит перезапустить
# последним, когда шлюз уже отвечает.
if [ -d "$PROJECT_DIR" ]; then
  say "  restart web/jobs"
  ( cd "$PROJECT_DIR" && docker compose --env-file .env.production restart web jobs >/dev/null 2>&1 ) \
    || docker restart src-web-1 src-jobs-1 >/dev/null 2>&1 || warn "    перезапустите web вручную"
fi

head2 "Итог (через 30с)"
sleep 30
docker ps --filter 'name=supabase' --filter 'name=realtime' --filter 'name=src-' \
  --format 'table {{.Names}}\t{{.Status}}'
