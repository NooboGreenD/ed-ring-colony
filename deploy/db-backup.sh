#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — ручная резервная копия базы данных.
#
# Скрипт выполняется НА ХОСТЕ (не внутри контейнера web): его поднимает
# приватный update-agent (`scripts/update-agent.mjs`), когда админ нажимает
# «Сделать бэкап» в Админка → Бэкапы. Ритм — еженедельный и только ручной:
# никаких cron-задач на сервере для этого нет (см. MONITORING.md).
#
# Пока копия делается, сайт показывает заглушку «Ведутся технические
# работы» — признак включает веб-процесс, а не этот скрипт.
#
# Прогресс сообщается машиночитаемой строкой в stdout:
#   ::edrc::{"stage":"backup","percent":60,"message":"..."}
# Остальные строки — журнал; он показывается админу (со скрытием значений,
# похожих на секреты). Формат описан в scripts/lib/update-state.mjs.
#
# Переменные:
#   BACKUP_FULL            1 — дамп всей базы, включая каталог систем.
#                          0 (по умолчанию) — без public.galaxy_systems:
#                          каталог весит десятки гигабайт и полностью
#                          восстанавливается импортом дампа Spansh, поэтому
#                          окно технических работ короткое.
#   BACKUP_EXCLUDE_TABLE   что исключать (default: public.galaxy_systems)
#   UPDATE_BACKUP_DIR      каталог копий (default: /opt/ed-ring-colony/backups)
#   UPDATE_BACKUP_KEEP     сколько свежих копий хранить (default: 4 — месяц
#                          при еженедельном запуске)
#   UPDATE_STATE_DIR       каталог блокировки и журнала
#   SUPABASE_CONTAINER     имя контейнера Postgres (default: ищем *supabase-db)
#   ENV_FILE               откуда брать DATABASE_URL для не-Docker установки
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/ed-ring-colony/src}"
STATE_DIR="${UPDATE_STATE_DIR:-$PROJECT_DIR/../update-state}"
BACKUP_DIR="${UPDATE_BACKUP_DIR:-/opt/ed-ring-colony/backups}"
KEEP="${UPDATE_BACKUP_KEEP:-4}"
FULL="${BACKUP_FULL:-0}"
ENV_FILE="${ENV_FILE:-.env.production}"
EXCLUDE_TABLE="${BACKUP_EXCLUDE_TABLE:-public.galaxy_systems}"
# Дамп без каталога систем идёт минуты; полный — часы на 10⁸ строк.
POLL_SECONDS="${BACKUP_POLL_SECONDS:-15}"

# ── прогресс и журнал (те же соглашения, что в update-project.sh) ─────
json_safe() { printf '%s' "${1:-}" | tr -d '"\\' | tr '\n\r' '  ' | cut -c1-200; }
say()    { printf '%s\n' "$*"; }
report() { printf '::edrc::{"stage":"%s","percent":%s,"message":"%s"}\n' "$1" "$2" "$(json_safe "$3")"; }
progress() { printf '::edrc::{"percent":%s,"message":"%s"}\n' "$1" "$(json_safe "$2")"; }
# Ошибка пишется в stdout: менеджер разбирает именно этот поток, поэтому
# админ увидит причину в панели, а не только код возврата.
die()    { printf '::edrc::{"message":"%s"}\n' "$(json_safe "$*")"; say "ОШИБКА: $*" >&2; exit 1; }

fail() {
  local code="$1" line="$2"
  printf '::edrc::{"message":"%s"}\n' "$(json_safe "резервное копирование прервано: строка $line, код $code")"
  exit "$code"
}
trap 'fail $? $LINENO' ERR

human() {
  # Байты → читаемый размер без внешних зависимостей (awk есть везде).
  printf '%s' "${1:-0}" | awk '{ b = $1 + 0; split("байт КБ МБ ГБ ТБ", u, " "); i = 1;
    while (b >= 1024 && i < 5) { b = b / 1024; i++ } printf "%.1f %s", b, u[i] }'
}

# ── 0. блокировка: дамп во время обновления — это сломанный дамп ──────
report prepare 5 "Проверяю блокировки и доступ к базе"
mkdir -p "$STATE_DIR" 2>/dev/null || true
LOCK_FILE="$STATE_DIR/backup.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "другая резервная копия ещё выполняется ($LOCK_FILE)"
  # Обновление проекта тоже делает pg_dump перед миграциями: параллельно
  # они спорят за одну и ту же базу, поэтому ждём освобождения его блокировки.
  if [ -f "$STATE_DIR/update.lock" ]; then
    exec 8<"$STATE_DIR/update.lock"
    flock -n 8 || die "идёт обновление проекта — дождитесь его окончания и запустите бэкап снова"
  fi
fi

# ── 1. куда писать ───────────────────────────────────────────────────
if ! mkdir -p "$BACKUP_DIR" 2>/dev/null || [ ! -w "$BACKUP_DIR" ]; then
  say "⚠ $BACKUP_DIR недоступен для записи — пишу в $STATE_DIR/backups"
  BACKUP_DIR="$STATE_DIR/backups"
  mkdir -p "$BACKUP_DIR" 2>/dev/null || die "некуда писать дамп: ни $UPDATE_BACKUP_DIR, ни $STATE_DIR/backups не доступны"
fi
KEEP="$(printf '%s' "$KEEP" | tr -dc '0-9')"
[ -n "$KEEP" ] && [ "$KEEP" -ge 1 ] || KEEP=4
[ "$KEEP" -le 24 ] || KEEP=24

# ── 2. доступ к базе ─────────────────────────────────────────────────
DB_PSQL=""   # container | url | ''
DB_URL="$(grep -E '^(DATABASE_URL|SUPABASE_DB_URL)=' "$PROJECT_DIR/$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
if [ -z "$DB_URL" ]; then
  DB_URL="$(grep -E '^(DATABASE_URL|SUPABASE_DB_URL)=' "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
fi
SUPA_CONTAINER="${SUPABASE_CONTAINER:-}"
if [ -z "$SUPA_CONTAINER" ] && command -v docker >/dev/null 2>&1; then
  SUPA_CONTAINER="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E 'supabase-db$' | head -n1 || true)"
fi
if [ -n "$SUPA_CONTAINER" ] && command -v docker >/dev/null 2>&1 \
   && docker exec "$SUPA_CONTAINER" pg_dump --version >/dev/null 2>&1; then
  DB_PSQL="container"
elif command -v pg_dump >/dev/null 2>&1 && [ -n "$DB_URL" ]; then
  DB_PSQL="url"
else
  die "нет доступа к Postgres: контейнер ${SUPABASE_CONTAINER:-supabase-db} не отвечает и локального pg_dump с DATABASE_URL нет"
fi
progress 8 "доступ к базе: $DB_PSQL$([ -n "$SUPA_CONTAINER" ] && echo " ($SUPA_CONTAINER)")" 
say "источник базы: $DB_PSQL$([ -n "$SUPA_CONTAINER" ] && echo " ($SUPA_CONTAINER)")"
[ "$FULL" = "1" ] && say "⚠ режим FULL: в дамп попадёт и public.galaxy_systems (десятки гигабайт, окно техработ заметно длиннее)"

db_size() {
  if [ "$DB_PSQL" = container ]; then
    docker exec "$SUPA_CONTAINER" psql -U postgres -d postgres -tAc \
      "select coalesce(sum(size), 0) from (select pg_total_relation_size(c.oid) as size from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','m','t')) s" 2>/dev/null || true
  else
    psql "$DB_URL" -tAc \
      "select coalesce(sum(size), 0) from (select pg_total_relation_size(c.oid) as size from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','m','t')) s" 2>/dev/null || true
  fi
}

DB_BYTES="$(db_size || true)"
DB_BYTES="${DB_BYTES:-0}"
[ -n "$DB_BYTES" ] || DB_BYTES=0
if [ "$FULL" != "1" ] && [ "$DB_BYTES" -gt 0 ]; then
  CATALOG_BYTES=""
  if [ "$DB_PSQL" = container ]; then
    CATALOG_BYTES="$(docker exec "$SUPA_CONTAINER" psql -U postgres -d postgres -tAc \
      "select coalesce(pg_total_relation_size('public.galaxy_systems'), 0)" 2>/dev/null || true)"
  else
    CATALOG_BYTES="$(psql "$DB_URL" -tAc "select coalesce(pg_total_relation_size('public.galaxy_systems'), 0)" 2>/dev/null || true)"
  fi
  CATALOG_BYTES="$(printf '%s' "${CATALOG_BYTES:-0}" | tr -dc '0-9')"
  if [ -n "$CATALOG_BYTES" ] && [ "$CATALOG_BYTES" -gt 0 ]; then
    # Оценка обязана оставаться неотрицательной: если статистика базы
    # несогласована, процент считаем от нуля (то есть «неизвестно»).
    if [ "$CATALOG_BYTES" -lt "$DB_BYTES" ]; then
      DB_BYTES=$(( DB_BYTES - CATALOG_BYTES ))
    else
      DB_BYTES=0
    fi
    say "каталог систем ($(human "$CATALOG_BYTES")) в дамп не попадает — остаток $(human "$DB_BYTES")"
  fi
fi
[ "$DB_BYTES" -gt 0 ] && say "размер данных для дампа: $(human "$DB_BYTES")"

# Место на диске: архив -Fc обычно вдвое меньше данных, но проверим с запасом.
if command -v df >/dev/null 2>&1 && [ "$DB_BYTES" -gt 0 ]; then
  FREE_KB="$(df -Pk "$BACKUP_DIR" 2>/dev/null | awk 'NR==2 { print $4 }')"
  if [ -n "${FREE_KB:-}" ]; then
    NEED_KB=$(( DB_BYTES / 1024 / 2 + 262144 ))
    say "свободно на $(printf '%s' "$BACKUP_DIR" | sed 's|.*/||'): $(human $(( FREE_KB * 1024 )))"
    [ "$FREE_KB" -ge "$NEED_KB" ] || die "на диске $(human $(( FREE_KB * 1024 ))) свободно, а для дампа нужно хотя бы $(human $(( NEED_KB * 1024 ))) — освободите место или удалите старые копии в $BACKUP_DIR"
  fi
fi

# ── 3. сам дамп ──────────────────────────────────────────────────────
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# Суффикс собираем отдельной строкой: `$(test && echo)` внутри присваивания
# при set -e убивает скрипт, когда тест ложен (статус подстановки становится
# статусом присваивания).
SUFFIX=""
if [ "$FULL" = "1" ]; then SUFFIX="-full"; fi
DUMP="$BACKUP_DIR/edrc-db-$STAMP$SUFFIX.dump"
DUMP_ARGS=(-Fc)
[ "$FULL" = "1" ] || DUMP_ARGS+=(--exclude-table="$EXCLUDE_TABLE")
say "пишу $DUMP"

if [ "$DB_PSQL" = container ]; then
  docker exec "$SUPA_CONTAINER" pg_dump -U postgres -d postgres "${DUMP_ARGS[@]}" > "$DUMP" &
else
  pg_dump "$DB_URL" "${DUMP_ARGS[@]}" -f "$DUMP" &
fi
DUMP_PID=$!

# Долгий дамп не должен выглядеть зависшим: раз в POLL_SECONDS показываем,
# сколько уже записано (процент — от оценённого размера данных).
report backup 45 "pg_dump: $([ "$FULL" = 1 ] && echo вся база || echo без каталога систем)"
ELAPSED=0
while kill -0 "$DUMP_PID" 2>/dev/null; do
  sleep "$POLL_SECONDS" &
  SLEEP_PID=$!
  # wait прерывается сигналом — так отмена доходит до pg_dump сразу.
  wait "$SLEEP_PID" 2>/dev/null || true
  ELAPSED=$(( ELAPSED + POLL_SECONDS ))
  CURRENT=0
  [ -f "$DUMP" ] && CURRENT="$(wc -c < "$DUMP" 2>/dev/null | tr -dc '0-9' || echo 0)"
  if [ "$DB_BYTES" -gt 0 ]; then
    PERCENT=$(( 45 + CURRENT * 40 / DB_BYTES ))
    [ "$PERCENT" -gt 85 ] && PERCENT=85
    [ "$PERCENT" -lt 45 ] && PERCENT=45
  else
    PERCENT=60
  fi
  progress "$PERCENT" "записано $(human "${CURRENT:-0}") за $(( ELAPSED / 60 )) мин $(( ELAPSED % 60 )) с"
done
wait "$DUMP_PID" || die "pg_dump завершился с ошибкой — копия не создана (проверьте доступ к базе и место на диске)"

[ -s "$DUMP" ] || die "pg_dump не оставил данных в $DUMP"
BYTES="$(wc -c < "$DUMP" | tr -dc '0-9')"
progress 88 "архив $(human "$BYTES") — проверяю читаемость"

# ── 4. проверка архива ───────────────────────────────────────────────
report verify 95 "Проверяю архив (pg_restore --list)"
if [ "$DB_PSQL" = container ]; then
  TOC="$(docker exec -i "$SUPA_CONTAINER" pg_restore --list < "$DUMP" 2>/dev/null | grep -c ';' || true)"
else
  TOC="$(pg_restore --list "$DUMP" 2>/dev/null | grep -c ';' || true)"
fi
TOC="${TOC:-0}"
[ "$TOC" -ge 5 ] || die "архив не читается (pg_restore --list вернул $TOC записей) — копия не засчитана, файл $DUMP оставлен для разбора"
say "архив читается: объектов в оглавлении — $TOC"

# ── 5. ротация: храним KEEP свежих копий ─────────────────────────────
ls -1t "$BACKUP_DIR"/edrc-db-*.dump 2>/dev/null | tail -n +$(( KEEP + 1 )) | while read -r old; do
  [ -n "$old" ] && rm -f "$old" && say "ротация: удалена старая копия $(basename "$old")"
done
say "хранится копий: $(ls -1 "$BACKUP_DIR"/edrc-db-*.dump 2>/dev/null | wc -l) из $KEEP в $BACKUP_DIR"
ls -1t "$BACKUP_DIR"/edrc-db-*.dump 2>/dev/null | head -n "$KEEP" | while read -r kept; do
  say "  • $(basename "$kept") — $(human "$(wc -c < "$kept" | tr -dc '0-9')")"
done

# backupFile/backupBytes забирает агент: по ним панель записывает отметку
# о последней копии, а не разбирает журнал текстом.
printf '::edrc::{"stage":"done","percent":100,"backupFile":"%s","backupBytes":%s,"message":"%s"}\n' \
  "$(json_safe "$(basename "$DUMP")")" "${BYTES:-0}" "$(json_safe "Копия готова: $(basename "$DUMP"), $(human "$BYTES")")"
say "готово: $DUMP ($(human "$BYTES"), объектов $TOC)"
say "восстановление: docker exec -i $SUPA_CONTAINER pg_restore -U postgres -d postgres --clean --if-exists < $DUMP"
