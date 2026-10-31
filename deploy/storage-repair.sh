#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — проверка и перезапуск Supabase Storage.
#
# Зачем. Storage живёт в ОТДЕЛЬНОМ стеке (`/opt/supabase`), а не в compose
# сайта: обновление проекта, пересборка web и миграции его не касаются. Когда
# контейнер Storage падает (OOM на маленьком VPS, сбой внутренней миграции,
# отвалившаяся база, права на том /var/lib/storage), сайт продолжает работать,
# но аватары, логотипы эскадрилий и документы молча уходят в резервную
# таблицу — а сам Storage остаётся лежать до ручного `docker compose up`.
# Панель администратора вызывала для этого SSH; теперь есть эта кнопка.
#
# Скрипт делает ровно две вещи и ничего больше:
#   --check   (по умолчанию) только читает: состояние контейнера, healthcheck,
#             счётчик перезапусков, код выхода, OOM и ответ API `GET /bucket`.
#             Ничего не запускает, не останавливает и не пересоздаёт.
#   --restart если Storage НЕ работает — перезапускает ТОЛЬКО сервис storage
#             (docker restart существующего контейнера; compose up -d
#             --no-deps storage, если контейнера нет), затем ждёт готовности и
#             проверяет список бакетов. Если Storage и так работает, ничего не
#             делает: «перезапустить» не должно превращаться в «перезапустить
#             в любом случае».
#
# Чего скрипт НЕ делает (намеренно): не трогает db/auth/kong/imgproxy, не
# удаляет тома и бакеты, не делает `docker compose down`, не меняет `.env`,
# не делает chmod на /var/lib/storage, не пересоздаёт контейнер, если живой
# можно просто перезапустить. Ключи (service role) читаются из .env стека
# только в память и никогда не печатаются.
#
# Вызывается приватным update-agent (scripts/update-agent.mjs):
#   GET  /storage         → bash storage-repair.sh --check
#   POST /storage/restart → bash storage-repair.sh --restart (job kind=storage)
# Ручной запуск на хосте:
#   sudo bash deploy/storage-repair.sh            # только проверка
#   sudo bash deploy/storage-repair.sh --restart  # проверка и, если надо, рестарт
#
# Последняя строка вывода — машиночитаемый итог для панели:
#   ::edrc::{"result":{"ok":true,"problem":false,"state":"running",...}}
#
# Переменные:
#   SUPABASE_HOST_DIR      каталог стека Supabase (default /opt/supabase)
#   SUPABASE_ENV_FILE      .env стека (default $SUPABASE_HOST_DIR/.env)
#   SUPABASE_CONTAINER     контейнер Postgres стека (default supabase-db) —
#                          по нему определяется compose-проект стека
#   STORAGE_SERVICE        имя сервиса в compose (default storage)
#   STORAGE_CONTAINER      имя контейнера (default supabase-storage)
#   STORAGE_INTERNAL_URL   адрес API глазами того, кто запускает скрипт
#                          (например http://storage:5000 — только если есть
#                          общая docker-сеть; по умолчанию пусто: проверка
#                          идёт изнутри контейнера Storage)
#   STORAGE_PORT           порт Storage внутри контейнера (default 5000)
#   STORAGE_WAIT_SECONDS   сколько ждать готовности после рестарта (default 90)
# ─────────────────────────────────────────────────────────────────────
set -uo pipefail

SUPABASE_DIR="${SUPABASE_HOST_DIR:-/opt/supabase}"
SUPABASE_ENV="${SUPABASE_ENV_FILE:-$SUPABASE_DIR/.env}"
SUPABASE_DB_CONTAINER="${SUPABASE_CONTAINER:-supabase-db}"
STORAGE_SERVICE="${STORAGE_SERVICE:-storage}"
STORAGE_CONTAINER="${STORAGE_CONTAINER:-supabase-storage}"
STORAGE_INTERNAL_URL="${STORAGE_INTERNAL_URL:-}"
STORAGE_PORT="${STORAGE_PORT:-5000}"
STORAGE_WAIT_SECONDS="${STORAGE_WAIT_SECONDS:-90}"

MODE="check"
case "${1:-}" in
  --check|check) MODE="check" ;;
  --restart|restart) MODE="restart" ;;
  -h|--help|help) sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") MODE="check" ;;
  *) printf 'неизвестный режим: %s (ожидается --check или --restart)\n' "$1" >&2; exit 2 ;;
esac

# Текст для JSON-канала: без кавычек, переводов строк и «простыней». Срез
# считается в БАЙТАХ, поэтому после него снимаем хвост непечатных в C-локали
# байтов — иначе кириллица обрывалась на полуслове («недоступна▒»).
json_safe() {
  local full cut
  full="$(printf '%s' "${1:-}" | tr -d '"\\' | tr '\n\r' '  ')"
  cut="$(printf '%s' "$full" | cut -c1-200)"
  if [ "$cut" != "$full" ]; then
    cut="$(printf '%s' "$cut" | sed -e 's/[^[:print:][:space:]]*$//')"
  fi
  printf '%s' "$cut"
}
say()   { printf '%s\n' "$*"; }
report() { printf '::edrc::{"stage":"%s","percent":%s,"message":"%s"}\n' "$1" "$2" "$(json_safe "$3")"; }
die() {
  local code="${2:-1}"
  printf '::edrc::{"error":"%s"}\n' "$(json_safe "$1")"
  say "ОШИБКА: $1" >&2
  exit "$code"
}

# Маскировка вывода docker logs: панель показывает журнал, а Storage и Kong
# печатают свою конфигурацию при старте (ANON_KEY, SERVICE_KEY, пароль БД).
mask_line() {
  awk '{
    n = split($0, parts, " "); out = "";
    for (i = 1; i <= n; i++) {
      p = parts[i]; eq = index(p, "=");
      if (eq > 1) {
        k = tolower(substr(p, 1, eq - 1));
        if (k ~ /pass|secret|token|key|credential|dsn|url/) p = substr(p, 1, eq) "***";
      }
      out = (i > 1 ? out " " : "") p;
    }
    print "  │ " substr(out, 1, 200);
  }'
}

log_tail() { # $1=id [$2=строк]
  [ -n "${1:-}" ] || return 0
  docker logs --tail "${2:-12}" "$1" 2>&1 | sed -e 's/\r$//' | mask_line || true
}

docker_ok() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

# Значение ключа из .env стека (последнее вхождение). Печатается только в
# переменную — в журнал не попадает.
supa_env_value() {
  grep -E "^$1=" "$SUPABASE_ENV" 2>/dev/null | tail -n1 | cut -d= -f2- || true
}

# Имя ключа может отличаться между версиями стека: SERVICE_ROLE_KEY в .env
# supabase, SUPABASE_SERVICE_ROLE_KEY — в некоторых сборках.
service_role_key() {
  local key
  key="$(supa_env_value SERVICE_ROLE_KEY)"
  [ -n "$key" ] || key="$(supa_env_value SUPABASE_SERVICE_ROLE_KEY)"
  printf '%s' "$key"
}

# ── поиск контейнера Storage ─────────────────────────────────────────
# Сначала по имени, затем по метке compose-сервиса: имя контейнера зависит от
# проекта (`supabase-storage-1`, `src-storage-1`), а метка стабильна.
storage_id() {
  local id=""
  id="$(docker ps -aq --filter "name=^/${STORAGE_CONTAINER}$" 2>/dev/null | head -n1 || true)"
  if [ -z "$id" ]; then
    id="$(docker ps -aq --filter "label=com.docker.compose.service=$STORAGE_SERVICE" 2>/dev/null | head -n1 || true)"
  fi
  printf '%s' "$id"
}

# status|health|restarts|exit|oom|started
inspect_state() {
  docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.StartedAt}}' "$1" 2>/dev/null || true
}

# ── проверка API Storage ─────────────────────────────────────────────
# Три уровня, от самого точного к запасному:
#  1. GET /bucket из контейнера агента, если он подключён к сети Supabase
#     (deploy/compose.supabase-net.yml; адрес STORAGE_INTERNAL_URL);
#  2. GET /bucket ИЗНУТРИ контейнера Storage через node: сеть агента и DNS
#     тут не нужны, а значит проверка работает и на нестандартной установке;
#  3. ничего — тогда честно «unknown», а не «сломано».
# Возврат через глобальные API_STATUS/API_VIA: ok | auth | failed | unknown.
# Для watchdog важно: перезапускать можно только при доказанной поломке.
API_STATUS="unknown"
API_VIA="none"
API_CODE="000"

probe_from_container() { # $1=id → код ответа или пусто
  local id="$1" out=""
  out="$(docker exec "$id" node -e "
    const url = 'http://127.0.0.1:${STORAGE_PORT}/bucket';
    const key = process.env.SERVICE_KEY || process.env.ANON_KEY || '';
    if (typeof fetch !== 'function') { console.log('nofetch'); process.exit(0); }
    fetch(url, { headers: { authorization: 'Bearer ' + key, apikey: key } })
      .then((r) => { console.log(r.status); process.exit(0); })
      .catch(() => { console.log('000'); process.exit(0); });
  " 2>/dev/null | tr -d '\r' | tail -n1 || true)"
  printf '%s' "$out"
}

# Из кода ответа — вывод проверки. 401/403 — это не «лежит»: Storage ответил,
# но ключ не принят (ротация ключей, чужой .env). Такой случай чинится не
# перезапуском, поэтому и текст другой.
classify_code() { # $1=код $2=как проверяли
  local code="$1" via="$2"
  API_CODE="$code"
  API_VIA="$via"
  case "$code" in
    2??) API_STATUS="ok" ;;
    401|403) API_STATUS="auth" ;;
    nofetch|'') API_STATUS="unknown"; API_VIA="none"; API_CODE="000" ;;
    000) API_STATUS="failed" ;;
    *) API_STATUS="failed" ;;
  esac
}

check_api() { # $1=id (может быть пустым)
  API_STATUS="unknown"; API_VIA="none"; API_CODE="000"
  local key="" code=""
  key="$(service_role_key)"
  if [ -n "$STORAGE_INTERNAL_URL" ] && command -v curl >/dev/null 2>&1 && [ -n "$key" ]; then
    code="$(curl -s -o /dev/null --max-time 6 -w '%{http_code}' \
      -H "Authorization: Bearer $key" -H "apikey: $key" \
      "${STORAGE_INTERNAL_URL%/}/bucket" 2>/dev/null || true)"
    [ -n "$code" ] || code="000"
    # 000 — до Storage не достучались (нет общей сети или он лежит): это ещё
    # не приговор, ниже есть проверка изнутри контейнера.
    if [ "$code" != "000" ]; then classify_code "$code" "agent"; return; fi
  fi
  if [ -n "${1:-}" ]; then
    code="$(probe_from_container "$1")"
    if [ -n "$code" ]; then classify_code "$code" "container"; return; fi
  fi
}

# ── один проход проверки ─────────────────────────────────────────────
PROBLEM=0
# Перезапуск помогает не всегда: при отказе по ключу (401/403) контейнер жив,
# и рестарт лишь оборвёт загрузки, ничего не починив. Такие случаи помечаем
# «перезапуском не лечится» и в режиме --restart честно отказываем.
RESTARTABLE=1
STATE="unknown"
HEALTH="none"
RESTARTS=0
EXIT_CODE=0
OOM="false"
REASON=""

set_state() { # $1=state $2=health $3=restarts $4=exit $5=oom
  STATE="${1:-unknown}"; HEALTH="${2:-none}"; RESTARTS="${3:-0}"; EXIT_CODE="${4:-0}"; OOM="${5:-false}"
  case "$RESTARTS" in ''|*[!0-9]*) RESTARTS=0 ;; esac
}

diagnose() { # $1=id
  local id="$1" raw status health restarts exit_code oom started
  if [ -z "$id" ]; then
    PROBLEM=1
    REASON="контейнер ${STORAGE_CONTAINER} не найден: Storage не запущен"
    set_state missing none 0 0 false
    return
  fi
  raw="$(inspect_state "$id")"
  if [ -z "$raw" ]; then
    PROBLEM=1
    REASON="состояние контейнера Storage не читается (docker inspect ничего не вернул)"
    set_state unknown none 0 0 false
    return
  fi
  status="${raw%%|*}"; rest="${raw#*|}"
  health="${rest%%|*}"; rest="${rest#*|}"
  restarts="${rest%%|*}"; rest="${rest#*|}"
  exit_code="${rest%%|*}"; rest="${rest#*|}"
  oom="${rest%%|*}"; started="${rest#*|}"
  set_state "$status" "$health" "$restarts" "$exit_code" "$oom"

  case "$status" in
    running)
      check_api "$id"
      case "$API_STATUS" in
        ok)
          # API отвечает — Storage работает. Непрошедший healthcheck без
          # отказов API поводом для рестарта не считается: у части версий
          # стека он стучится в /status и «краснеет» от медленного диска.
          [ "$health" = "unhealthy" ] && REASON="API отвечает, но healthcheck не проходит — посмотрите журнал Storage"
          ;;
        auth)
          PROBLEM=1
          RESTARTABLE=0
          REASON="Storage отвечает, но ключ не принят (401/403): проверьте SERVICE_ROLE_KEY в .env стека — перезапуск это не лечит"
          ;;
        failed)
          PROBLEM=1
          REASON="контейнер работает, но API Storage не отвечает"
          ;;
        *)
          if [ "$health" = "unhealthy" ]; then
            PROBLEM=1
            REASON="healthcheck не проходит, а ответ API проверить не удалось"
          else
            REASON="состояние контейнера в норме, ответ API проверить не удалось"
          fi
          ;;
      esac
      ;;
    restarting)
      PROBLEM=1
      REASON="контейнер перезапускается по кругу (перезапусков: ${RESTARTS})"
      ;;
    exited|dead)
      PROBLEM=1
      if [ "$oom" = "true" ]; then
        REASON="убит OOM (код ${EXIT_CODE}), нужен запас памяти"
      else
        REASON="контейнер остановлен (код ${EXIT_CODE})"
      fi
      ;;
    created|paused)
      PROBLEM=1
      REASON="контейнер в состоянии ${status}: Storage не обслуживает запросы"
      ;;
    *)
      PROBLEM=1
      REASON="неизвестное состояние контейнера: ${status}"
      ;;
  esac
}

print_facts() {
  say "контейнер: ${STORAGE_CONTAINER}"
  say "состояние: ${STATE}${HEALTH:+ (health ${HEALTH})}"
  say "перезапусков: ${RESTARTS}${OOM:+, oom=${OOM}}"
  say "API: ${API_STATUS}${API_VIA:+ (проверка: ${API_VIA})}${API_CODE:+, код ${API_CODE}}"
  [ -n "$REASON" ] && say "вывод: ${REASON}"
}

emit_result() {
  local ok="true"
  [ "$PROBLEM" = "0" ] && [ "$STATE" = "running" ] || ok="false"
  printf '::edrc::{"result":{"ok":%s,"problem":%s,"restartable":%s,"state":"%s","health":"%s","restarts":%s,"exitCode":%s,"oom":%s,"api":"%s","apiVia":"%s","apiCode":"%s","reason":"%s"}}\n' \
    "$ok" "$([ "$PROBLEM" = "0" ] && printf false || printf true)" \
    "$([ "$RESTARTABLE" = "1" ] && printf true || printf false)" \
    "$(json_safe "$STATE")" "$(json_safe "$HEALTH")" "$RESTARTS" "$EXIT_CODE" "$OOM" \
    "$(json_safe "$API_STATUS")" "$(json_safe "$API_VIA")" "$(json_safe "$API_CODE")" "$(json_safe "$REASON")"
}

# ── 1. доступ к Docker ───────────────────────────────────────────────
[ "$MODE" = "restart" ] && report storage_prepare 5 "Проверяю доступ к Docker и стеку Supabase"
if ! command -v docker >/dev/null 2>&1; then
  if [ "$MODE" = "restart" ]; then
    die "docker не найден: перезапустить Storage нечем (systemd-установка без Docker?)"
  fi
  say "docker не найден — диагностика Storage невозможна"
  STATE="unknown"; PROBLEM=1; REASON="docker CLI недоступен"
  emit_result
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  if [ "$MODE" = "restart" ]; then
    die "Docker-демон недоступен: не могу перезапустить Storage"
  fi
  say "Docker-демон недоступен — диагностика Storage невозможна"
  STATE="unknown"; PROBLEM=1; REASON="Docker-демон недоступен"
  emit_result
  exit 2
fi

# ── 2. проверка ──────────────────────────────────────────────────────
[ "$MODE" = "restart" ] && report storage_check 20 "Смотрю состояние контейнера Storage и ответ API"
ID="$(storage_id)"
diagnose "$ID"
print_facts

if [ "$MODE" = "check" ]; then
  emit_result
  [ "$PROBLEM" = "0" ] && exit 0
  exit 1
fi

if [ "$PROBLEM" = "0" ]; then
  report storage_verify 75 "Storage уже работает — перезапуск не нужен"
  say "✓ Storage работает: перезапуск не требуется"
  emit_result
  exit 0
fi

if [ "$RESTARTABLE" = "0" ]; then
  say "── последние строки журнала Storage ──"
  log_tail "$ID" 10
  die "${REASON}"
fi

# ── 3. перезапуск (только сервис storage) ────────────────────────────
# Существующий контейнер перезапускаем, а не пересоздаём: `docker restart`
# не может создать дубль и не зависит от того, из какого каталога поднимали
# стек. Пересоздание через compose — только когда контейнера нет вовсе.
if [ -n "$ID" ]; then
  report storage_restart 45 "Перезапускаю контейнер Storage"
  say "перезапуск ${STORAGE_CONTAINER} ($ID)"
  if ! docker restart "$ID" >/dev/null 2>&1; then
    say "── последние строки журнала Storage ──"
    log_tail "$ID" 15
    die "docker restart не удался: ${REASON}. Проверьте диск (df -h, df -i) и права на том /var/lib/storage"
  fi
else
  report storage_restart 45 "Контейнера нет — поднимаю сервис storage через compose"
  DB_ID="$(docker ps -aq --filter "name=^/${SUPABASE_DB_CONTAINER}$" 2>/dev/null | head -n1 || true)"
  STACK_PROJECT="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$DB_ID" 2>/dev/null || true)"
  STACK_DIR="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$DB_ID" 2>/dev/null || true)"
  STACK_FILES="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$DB_ID" 2>/dev/null || true)"
  [ -n "$STACK_DIR" ] || STACK_DIR="$SUPABASE_DIR"
  [ -n "$STACK_PROJECT" ] || STACK_PROJECT="$(basename "$STACK_DIR")"
  [ -d "$STACK_DIR" ] || die "каталог стека Supabase не найден: $STACK_DIR"
  [ -f "$STACK_DIR/docker-compose.yml" ] || die "в $STACK_DIR нет docker-compose.yml — это точно каталог стека Supabase?"
  compose() {
    if docker compose version >/dev/null 2>&1; then docker compose "$@"
    elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@"
    else return 127
    fi
  }
  COMPOSE_ARGS=(--project-name "$STACK_PROJECT" --project-directory "$STACK_DIR")
  [ -f "$SUPABASE_ENV" ] && COMPOSE_ARGS+=(--env-file "$SUPABASE_ENV")
  # Файлы берём ровно те, которыми стек был запущен (метка compose), иначе
  # `up` мог бы поднять сервис с другим набором override-файлов.
  HAS_FILE=0
  if [ -n "$STACK_FILES" ]; then
    IFS=',' read -r -a files <<< "$STACK_FILES"
    for file in "${files[@]}"; do
      if [ -n "$file" ] && [ -f "$file" ]; then
        COMPOSE_ARGS+=(-f "$file")
        HAS_FILE=1
      fi
    done
  fi
  if [ "$HAS_FILE" = "0" ]; then
    COMPOSE_ARGS+=(-f "$STACK_DIR/docker-compose.yml")
    if [ -f "$STACK_DIR/docker-compose.override.yml" ]; then
      COMPOSE_ARGS+=(-f "$STACK_DIR/docker-compose.override.yml")
    fi
  fi
  say "compose-проект ${STACK_PROJECT}, каталог ${STACK_DIR}"
  if ! compose "${COMPOSE_ARGS[@]}" up -d --no-deps "$STORAGE_SERVICE" 2>&1 | sed -e 's/\r$//' | cut -c1-300; then
    die "не удалось поднять сервис ${STORAGE_SERVICE} через compose. Проверьте docker compose ps -a в $STACK_DIR"
  fi
  ID="$(storage_id)"
fi

# ── 4. ждём готовности и проверяем API ──────────────────────────────
report storage_verify 75 "Жду готовности Storage и проверяю список бакетов"
READY=0
WAITED=0
while [ "$WAITED" -lt "$STORAGE_WAIT_SECONDS" ]; do
  ID="$(storage_id)"
  diagnose "$ID"
  # «Готов» — контейнер работает и API не отвергает запросы. Неизвестный ответ
  # (нет node в образе, нет общих сетей) успех не отменяет: иначе исправный
  # Storage на нестандартной установке считался бы сломанным.
  if [ "$STATE" = "running" ] && [ "$HEALTH" != "unhealthy" ] \
     && [ "$API_STATUS" != "failed" ] && [ "$API_STATUS" != "auth" ]; then
    READY=1
    break
  fi
  # Остановившийся/перезапускающийся по кругу контейнер не «дозреет»: ждать
  # его 90 секунд бессмысленно, лучше сразу показать журнал и причину.
  if [ "$STATE" = "exited" ] || [ "$STATE" = "dead" ]; then break; fi
  if [ "$STATE" = "restarting" ] && [ "$RESTARTS" -ge 3 ] 2>/dev/null; then break; fi
  sleep 3
  WAITED=$((WAITED + 3))
done

if [ "$READY" = "1" ]; then
  print_facts
  PROBLEM=0
  if [ "$API_STATUS" = "ok" ]; then
    REASON=""
    say "✓ Storage отвечает: список бакетов читается (${API_VIA})"
    report storage_verify 90 "Storage работает: бакеты читаются"
  else
    REASON="контейнер Storage работает, ответ API проверить не удалось"
    say "✓ контейнер Storage работает (ответ API проверить не удалось: ${API_VIA})"
    report storage_verify 90 "Storage работает; ответ API проверить не удалось"
  fi
  emit_result
  exit 0
fi

say "── состояние после перезапуска ──"
print_facts
say "── последние строки журнала Storage ──"
log_tail "$ID" 20
# Причина — в начале строки: сообщение обрезается до 200 символов, и хвост
# с «что делать» иначе не доезжает до панели.
say "  кнопка: Админка → Мониторинг → «Хранилище файлов»; на хосте: sudo bash deploy/storage-repair.sh --restart"
say "  смотреть: docker logs ${STORAGE_CONTAINER}; df -h и df -i; права на /var/lib/storage; доступность ${SUPABASE_DB_CONTAINER}"
die "Storage не поднялся (${REASON:-причина неизвестна}). Кнопка: Админка → Мониторинг → Хранилище файлов; логи: docker logs ${STORAGE_CONTAINER}"
