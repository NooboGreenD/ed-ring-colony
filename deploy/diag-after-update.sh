#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — что именно сломалось после обновления.
#
# Скрипт ТОЛЬКО ЧИТАЕТ. Он ничего не меняет: ни в базе, ни в контейнерах,
# ни в git. Задача — за одну минуту отделить четыре разные поломки, которые
# снаружи выглядят одинаково («половина сайта не работает, админки нет»,
# хотя в psql права админа на месте):
#
#   1. контейнер web потерял сеть Supabase → `getaddrinfo EAI_AGAIN db`:
#      приложение не достаёт базу, но psql на хосте работает. Известная
#      причина — `docker compose up` без доп. -f файлов (см. compose-lib.sh).
#   2. PostgREST не отдаёт схему (500 на /rest/v1/): тогда браузерный клиент
#      не читает even profiles, роль выглядит как «user», и админка отвечает
#      «нет прав», хотя в базе всё верно.
#   3. миграции не применились (нет прямого psql/контейнера при обновлении):
#      нет новых таблиц, роуты отвечают 500 — остальной сайт жив.
#   4. сайт застрял на заглушке «Ведутся технические работы»: признак лежит
#      в public.app_flags и сам гаснет по expires_at.
#
# Вывод: разделы с ✓/✗ и итог с конкретным следующим шагом.
# Значения, похожие на секреты, не печатаются: только имена, роли и коды.
#
# Запуск (на сервере, от пользователя с доступом к docker):
#   bash deploy/diag-after-update.sh
#   PROJECT_DIR=/opt/ed-ring-colony/src bash deploy/diag-after-update.sh
# ─────────────────────────────────────────────────────────────────────
set -uo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/ed-ring-colony/src}"
STATE_DIR="${UPDATE_STATE_DIR:-$PROJECT_DIR/../update-state}"
ENV_FILE="${ENV_FILE:-.env.production}"
WEB_CONTAINER="${WEB_CONTAINER:-web}"
SUPA_CONTAINER="${SUPABASE_CONTAINER:-supabase-db}"
SUPA_USER="${SUPABASE_DB_USER:-postgres}"
SUPA_DB="${SUPABASE_DB_NAME:-postgres}"
REST_CONTAINER="${REST_CONTAINER:-supabase-rest}"

say() { printf '%s\n' "$*"; }
head2() { printf '\n\033[1m%s\033[0m\n' "$*"; }
# Сколько проверок реально выполнено: без docker и без psql скрипт не должен
# делать вид, что «всё хорошо».
RAN=0
# Сколько проверок касалось собственно сервера (docker/psql). Если ноль —
# скрипт запущен не там, где нужно, и «всё хорошо» говорить нельзя.
RUNTIME=0
ok() { RAN=$((RAN + 1)); printf '  ✓ %s\n' "$*"; }
bad() { RAN=$((RAN + 1)); printf '  ✗ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }

# Найденные проблемы: печатаются в конце по порядку важности.
FIND_CRITICAL=()
FIND_WARN=()
critical() { FIND_CRITICAL+=("$*"); }
note() { FIND_WARN+=("$*"); }

have() { command -v "$1" >/dev/null 2>&1; }
docker_ok() { have docker && docker info >/dev/null 2>&1; }

# ── 0. контейнеры ────────────────────────────────────────────────────
head2 "1. Контейнеры"
psql_mode=""
if docker_ok; then
  # compose зовёт контейнер <проект>-web-1: без поиска по метке проверки
  # «web не отвечает» срабатывали бы на здоровом стенде.
  if ! docker inspect "$WEB_CONTAINER" >/dev/null 2>&1; then
    resolved="$(docker ps -q --filter label=com.docker.compose.service=web 2>/dev/null | head -n1 || true)"
    [ -n "$resolved" ] && WEB_CONTAINER="$resolved"
  fi
  running="$(docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null || true)"
  for name in "$SUPA_CONTAINER" "$REST_CONTAINER" web; do
    line="$(printf '%s\n' "$running" | grep -E "^${name}[[:space:]]" || true)"
    if [ -n "$line" ]; then ok "$line"; else bad "$name не запущен"; fi
  done
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$REST_CONTAINER"; then
    critical "контейнер $REST_CONTAINER не найден: PostgREST не отвечает, поэтому браузер не читает ни profiles, ни остальное (сайт «в БД всё ок», но админки нет)."
  fi
else
  warn "docker недоступен из этого пользователя — проверки контейнеров пропущены"
fi

# Доступ к базе выбираем по факту подключения, а не по наличию контейнера:
# «контейнер поднят» и «в него пускают» — разные вещи, и вторая ломается чаще.
db_url="${DATABASE_URL:-${SUPABASE_DB_URL:-}}"
if [ -z "$db_url" ] && [ -f "$ENV_FILE" ]; then
  db_url="$(grep -E '^(DATABASE_URL|SUPABASE_DB_URL)=' "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
fi
if docker_ok && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$SUPA_CONTAINER" \
   && docker exec "$SUPA_CONTAINER" psql -U "$SUPA_USER" -d "$SUPA_DB" -tAc 'select 1' >/dev/null 2>&1; then
  psql_mode="container"
elif have psql && [ -n "$db_url" ] && psql "$db_url" -tAc 'select 1' >/dev/null 2>&1; then
  psql_mode="url"; PSQL_URL="$db_url"
fi

run_sql() { # SQL на stdin → строки без заголовка
  case "$psql_mode" in
    container) docker exec -i -e PGOPTIONS='-c client_min_messages=warning' "$SUPA_CONTAINER" \
                 psql -U "$SUPA_USER" -d "$SUPA_DB" -q -tA -F '|' -v ON_ERROR_STOP=1 2>&1 ;;
    url) PGOPTIONS='-c client_min_messages=warning' psql "$PSQL_URL" -q -tA -F '|' -v ON_ERROR_STOP=1 2>&1 ;;
    *) return 1 ;;
  esac
}
sql() { printf '%s\n' "$1" | run_sql; }

# ── 1. ревизия: что на диске и что в контейнере ──────────────────────
head2 "2. Ревизия кода"
if [ -d "$PROJECT_DIR/.git" ]; then
  disk_sha="$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
  disk_subject="$(git -C "$PROJECT_DIR" log -1 --format=%s 2>/dev/null | cut -c1-90 || true)"
  ok "на диске: $disk_sha — $disk_subject"
else
  warn "каталог $PROJECT_DIR не найден (задайте PROJECT_DIR)"
  disk_sha="?"
fi
if docker_ok && docker inspect "$WEB_CONTAINER" >/dev/null 2>&1; then
  env_sha="$(docker inspect "$WEB_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | grep -E '^APP_GIT_SHA=' | cut -d= -f2- | cut -c1-7 || true)"
  if [ -z "$env_sha" ]; then
    note "у контейнера $WEB_CONTAINER нет APP_GIT_SHA — сверить ревизию образа нельзя"
  elif [ "$disk_sha" != "?" ] && [ "${disk_sha:0:7}" != "$env_sha" ]; then
    critical "на диске $disk_sha, а работает образ $env_sha: обновление не переключило код (сборка/health упали). Симптомы — «половина проекта не работает» при целой базе."
  else
    ok "образ собран из текущей ревизии ($env_sha)"
  fi
fi

# ── 2. сеть Supabase: может ли web дотянуться до базы ───────────────
head2 "3. Сеть Supabase (web → db)"
if docker_ok && docker inspect "$WEB_CONTAINER" >/dev/null 2>&1; then
  nets="$(docker inspect "$WEB_CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null || true)"
  ok "сети web: ${nets:-—}"
  RUNTIME=$((RUNTIME + 1))
  if docker exec "$WEB_CONTAINER" getent hosts db >/dev/null 2>&1; then
    ok "имя db резолвится внутри web"
  else
    bad "внутри web имя db не резолвится"
    critical "контейнер web не в сети Supabase: приложение не видит базу (getaddrinfo EAI_AGAIN db), хотя psql на хосте работает. Лечение: пересоздать web с доп. -f файлами (deploy/compose-lib.sh), а не голым docker compose up."
  fi
else
  warn "проверить сеть web нельзя: нет docker или контейнера $WEB_CONTAINER"
fi

# ── 3. PostgREST и сам сайт ──────────────────────────────────────────
head2 "4. PostgREST и HTTP сайта"
probe() { # probe URL → код ответа, 'ERR:<текст>' или пусто
  local url="$1"
  docker exec "$WEB_CONTAINER" node -e "
    fetch('$url', { redirect: 'manual' })
      .then((r) => { console.log(r.status); })
      .catch((e) => { console.log('ERR:' + (e && e.message ? e.message : e)); });
  " 2>/dev/null | tr -d '\r' | head -n1
}
if docker_ok && docker inspect "$WEB_CONTAINER" >/dev/null 2>&1 && have docker; then
  health="$(probe 'http://127.0.0.1:3000/api/health')"
  case "$health" in
    200) ok "сайт отвечает: /api/health → 200" ;;
    ERR:*) bad "сайт не отвечает: $health"; critical "веб-процесс не обслуживает запросы: смотрите docker logs --tail 120 $WEB_CONTAINER (частая причина — не завершилась сборка)." ;;
    "") warn "проверка /api/health не дала ответа (нет node внутри web?)" ;;
    *) bad "/api/health → $health" ;;
  esac
  rest="$(probe 'http://127.0.0.1:3000/api/supabase/rest/v1/')"
  case "$rest" in
    401|404|200) ok "шлюз PostgREST жив (код $rest)" ;;
    500|502|503) bad "шлюз PostgREST отвечает $rest"
                 critical "PostgREST не отдаёт схему (код $rest): браузерный клиент не читает profiles, роль выглядит как «user» — отсюда «нет админских прав». Смотрите: docker logs --tail 80 $REST_CONTAINER." ;;
    ERR:*) bad "шлюз PostgREST недоступен: $rest"
           critical "шлюз PostgREST недоступен ($rest): все запросы приложения к базе падают, psql при этом работает. Проверьте контейнеры supabase-rest и kong." ;;
    "") warn "проверка шлюза PostgREST не дала ответа" ;;
    *) bad "шлюз PostgREST → $rest" ;;
  esac
else
  warn "проверить HTTP сайта нельзя: нет docker или контейнера $WEB_CONTAINER"
fi

# ── 4. база: миграции и новые таблицы ────────────────────────────────
head2 "5. База: схема и миграции"
if [ -n "$psql_mode" ]; then
  RUNTIME=$((RUNTIME + 1))
  tables="$(sql "select count(*) from information_schema.tables where table_schema='public';" | tail -n1)"
  ok "таблиц в public: ${tables:-?}"
  missing="$(sql "select t from unnest(array['helper_devices','helper_link_codes','helper_settings']) t
                  where not exists (select 1 from information_schema.tables
                                    where table_schema='public' and table_name=t);" | sed '/^$/d' | paste -sd' ' -)"
  if [ -z "$missing" ]; then
    ok "таблицы привязки лаунчера на месте (helper_devices, helper_link_codes, helper_settings)"
  else
    bad "нет таблиц: $missing"
    critical "миграция 20261104090000_helper_device_linking.sql не применена: новые роуты (/api/uploader/link, /api/uploader/settings) отвечают 500. Лечение: docker exec -i $SUPA_CONTAINER psql -U postgres -d postgres < supabase/migrations/20261104090000_helper_device_linking.sql"
  fi

  policies="$(sql "select count(*) from pg_policies where schemaname='public' and tablename='profiles';" | tail -n1)"
  if [ "${policies:-0}" -ge 1 ]; then
    ok "политик RLS на profiles: ${policies}"
  else
    bad "на profiles нет политик RLS"
    critical "на public.profiles нет ни одной политики: владелец не читает свою строку, админка не видит роль. Нужно применить supabase/migrations/20261015000000_profiles_rls_hardening.sql."
  fi

  staff_fn="$(sql "select case when exists (
                     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname='public' and p.proname='request_is_staff' and p.prosecdef
                   ) then 'ok' else 'missing' end;" | tail -n1)"
  if [ "$staff_fn" = "ok" ]; then
    ok "request_is_staff() есть и работает как SECURITY DEFINER"
  else
    bad "request_is_staff() отсутствует или не SECURITY DEFINER"
    critical "без SECURITY DEFINER функции request_is_staff() политики на profiles уходят в рекурсию и чтение роли падает — админка отвечает «нет прав». Примените 20261015000000_profiles_rls_hardening.sql."
  fi

  anon_select="$(sql "select has_table_privilege('anon','public.profiles','SELECT');" | tail -n1)"
  auth_select="$(sql "select has_table_privilege('authenticated','public.profiles','SELECT');" | tail -n1)"
  if [ "$auth_select" = "t" ]; then
    ok "authenticated может читать profiles (строки фильтрует RLS)"
  else
    bad "у authenticated нет SELECT на profiles"
    critical "у роли authenticated отозван SELECT на public.profiles — клиент не читает даже свою строку, админка теряет роль. Верните: GRANT SELECT ON public.profiles TO authenticated;"
  fi
  [ "$anon_select" = "t" ] && note "у anon есть SELECT на profiles — это возвращает старую утечку email/role; должна стоять ревизия 20261015000000"

  admins="$(sql "select coalesce(string_agg(role || ':' || cnt, ', '), '—') from (
                   select role, count(*)::text as cnt from public.profiles group by role) s;" | tail -n1)"
  ok "роли в profiles: ${admins:-—}"

  # Флаг техработ пишется из src/lib/maintenanceFlag.ts в camelCase
  # (active/expiresAt) и сам истекает по expiresAt — повторяем эту логику,
  # иначе просроченный флаг выглядел бы как «сайт всё ещё закрыт».
  flag="$(sql "select coalesce(value->>'active','') || '|' || coalesce(value->>'expiresAt','')
                from public.app_flags where key = 'maintenance';" | tail -n1)"
  if [ -z "$flag" ] || [ "$flag" = "|" ]; then
    ok "признак техработ не выставлен"
  else
    flag_active="${flag%%|*}"
    flag_until="${flag#*|}"
    flag_until_epoch=""
    if [ -n "$flag_until" ]; then
      flag_until_epoch="$(date -d "$flag_until" +%s 2>/dev/null || true)"
    fi
    if [ "$flag_active" = "true" ] && [ -n "$flag_until_epoch" ] && [ "$flag_until_epoch" -gt "$(date +%s)" ]; then
      bad "включён признак техработ до $flag_until"
      critical "сайт отдаёт заглушку «Ведутся технические работы» (public.app_flags.key='maintenance'), поэтому часть страниц недоступна. Снять: откройте /admin → «Резервная копия» и отмените окно, либо удалите строку key='maintenance'."
    elif [ "$flag_active" = "true" ]; then
      note "флаг техработ записан, но срок истёк ($flag_until) — прокси обязан сайт уже отпустить; если заглушка видна, проблема в другом"
    else
      ok "признак техработ снят (active=$flag_active)"
    fi
  fi

  if [ -f "$STATE_DIR/migrations.mark" ]; then
    ok "последние отмеченные миграции: $(tail -n 3 "$STATE_DIR/migrations.mark" | paste -sd' ' -)"
    if grep -qxF '20261104090000_helper_device_linking.sql' "$STATE_DIR/migrations.mark"; then
      ok "миграция привязки лаунчера отмечена применённой"
    else
      warn "миграции 20261104090000_helper_device_linking.sql нет в migrations.mark — примените её вручную"
    fi
  else
    warn "нет $STATE_DIR/migrations.mark (другой UPDATE_STATE_DIR?)"
  fi
else
  warn "нет доступа к Postgres (ни контейнер $SUPA_CONTAINER, ни DATABASE_URL) — проверки базы пропущены"
fi

# ── 5. логи web ──────────────────────────────────────────────────────
head2 "6. Последние ошибки web"
if docker_ok && docker inspect "$WEB_CONTAINER" >/dev/null 2>&1; then
  errors="$(docker logs --tail 200 "$WEB_CONTAINER" 2>&1 \
    | grep -iE 'error|EAI_AGAIN|ECONNREFUSED|PGRST|denied|failed' | tail -n 8 || true)"
  if [ -n "$errors" ]; then
    printf '%s\n' "$errors" | sed 's/^/  │ /'
  else
    ok "в последних 200 строках журнала ошибок нет"
  fi
else
  warn "журнал web прочитать нельзя: нет docker или контейнера $WEB_CONTAINER"
fi

# ── итог ─────────────────────────────────────────────────────────────
head2 "ИТОГ"
if [ "$RUNTIME" -eq 0 ]; then
  warn "сервер не проверен (нет docker и доступа к Postgres): скрипт запускается НА СЕРВЕРЕ, от пользователя с доступом к docker"
  warn "например: sudo bash deploy/diag-after-update.sh"
  if [ ${#FIND_CRITICAL[@]} -gt 0 ]; then
    printf '\n  Но уже видно:\n'
    index=1
    for item in "${FIND_CRITICAL[@]}"; do
      printf '  %d. %s\n' "$index" "$item"
      index=$((index + 1))
    done
  fi
elif [ ${#FIND_CRITICAL[@]} -eq 0 ]; then
  printf '  ✓ проверок выполнено: %s, известных поломок не найдено\n' "$RAN"
  printf '    пришлите вывод целиком: разбираем по конкретной ошибке, а не по догадке\n'
else
  index=1
  for item in "${FIND_CRITICAL[@]}"; do
    printf '  %d. %s\n' "$index" "$item"
    index=$((index + 1))
  done
fi
if [ ${#FIND_WARN[@]} -gt 0 ]; then
  printf '\n  Замечания:\n'
  for item in "${FIND_WARN[@]}"; do printf '   · %s\n' "$item"; done
fi
printf '\n  Скрипт ничего не менял: только чтение.\n'
