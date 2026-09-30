#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — применение настроек отправки писем (SMTP для GoTrue).
#
# Запускается приватным update-agent (kind=smtp), когда админ нажимает
# «Применить и перезапустить» в Админка → Авторизация → «Отправка писем».
# К этому моменту SMTP-ключи уже записаны агентом в .env стека Supabase;
# скрипт проверяет, что compose-override передаёт их в контейнер auth,
# пересоздаёт auth, затем пересоздаёт web (чтобы поднялись ключи сайта —
# например, AUTH_EMAIL_ENABLED). Файлы и секреты не печатаются.
#
# Прогресс — машиночитаемые строки в stdout (формат scripts/lib/update-state.mjs,
# стадии SMTP_STAGES):
#   ::edrc::{"stage":"smtp_switch","percent":35,"message":"..."}
#
# Переменные:
#   SUPABASE_HOST_DIR   каталог стека Supabase (default /opt/supabase)
#   SUPABASE_ENV_FILE   .env стека (default $SUPABASE_HOST_DIR/.env)
#   PROJECT_DIR         клон репозитория (шаблон override + apply-env.sh)
#   AUTH_HEALTH_URL     ДОПОЛНИТЕЛЬНЫЙ адрес проверки auth (панель передаёт
#                       NEXT_PUBLIC_SUPABASE_URL + /auth/v1/health);
#                       пусто → берём API_EXTERNAL_URL/SUPABASE_PUBLIC_URL
#                       из .env стека, иначе внешняя проверка пропускается
#   UPDATE_HEALTH_URL   что опрашивать после пересоздания web
#   ENV_FILE            env-файл сайта (для compose-переменных web)
#   SYSTEMD_SERVICE     unit сайта для systemd-режима (default ed-ring-colony)
#   SUPABASE_AUTH_CONTAINER  имя контейнера GoTrue (default supabase-auth)
#   AUTH_TRIES          сколько раз по 2с ждать готовности контейнера auth
#   AUTH_HTTP_TRIES     сколько раз по 4с опрашивать AUTH_HEALTH_URL
# ─────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

SUPABASE_DIR="${SUPABASE_HOST_DIR:-/opt/supabase}"
SUPABASE_ENV="${SUPABASE_ENV_FILE:-$SUPABASE_DIR/.env}"
PROJECT_DIR="${PROJECT_DIR:-/opt/ed-ring-colony/src}"
AUTH_HEALTH_URL="${AUTH_HEALTH_URL:-}"
HEALTH_URL="${UPDATE_HEALTH_URL:-http://127.0.0.1:3000/api/health}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env.production}"
SYSTEMD_SERVICE="${SYSTEMD_SERVICE:-ed-ring-colony}"
HEALTH_TRIES="${HEALTH_TRIES:-45}"
AUTH_CONTAINER_NAME="${SUPABASE_AUTH_CONTAINER:-supabase-auth}"
AUTH_TRIES="${AUTH_TRIES:-45}"            # 45 × 2с = 90с на старт GoTrue
AUTH_HTTP_TRIES="${AUTH_HTTP_TRIES:-15}"  # 15 × 4с = 60с на публичный адрес

# Текст для JSON-канала: без кавычек, переводов строк и длинных «простыней».
# Обрез считает БАЙТЫ, а кириллица в UTF-8 занимает два: срез ровно по 200
# мог разрубить символ пополам, и панель показывала «недоступна▒». Поэтому
# после среза (и только после него) снимаем хвост из непечатных в C-локали
# байтов — потерять последнее слово в уже обрезанном сообщении не страшно.
json_safe() {
  local full cut
  full="$(printf '%s' "${1:-}" | tr -d '"\\' | tr '\n\r' '  ')"
  cut="$(printf '%s' "$full" | cut -c1-200)"
  if [ "$cut" != "$full" ]; then
    cut="$(printf '%s' "$cut" | sed -e 's/[^[:print:][:space:]]*$//')"
  fi
  printf '%s' "$cut"
}
say()    { printf '%s\n' "$*"; }
report() { printf '::edrc::{"stage":"%s","percent":%s,"message":"%s"}\n' "$1" "$2" "$(json_safe "$3")"; }
die()  {
  trap - ERR
  printf '::edrc::{"error":"%s"}\n' "$(json_safe "$*")"
  say "ОШИБКА: $*" >&2
  exit 1
}
fail() {
  local code="$1" line="$2"
  trap - ERR
  printf '::edrc::{"error":"%s"}\n' "$(json_safe "применение настроек почты прервано: строка $line, код $code")"
  exit "$code"
}
trap 'fail $? $LINENO' ERR

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@"
  else return 127
  fi
}

# Значение ключа из .env стека (последнее вхождение; без раскрытия $-ссылок).
supa_env_value() {
  grep -E "^$1=" "$SUPABASE_ENV" 2>/dev/null | tail -n1 | cut -d= -f2- || true
}

# Атомарно заменить ключ в env-файле, не раскрывая его значение в журнале.
env_set() { # $1=file $2=key $3=value
  local file="$1" key="$2" value="$3" tmp
  tmp="${file}.smtp.$$"
  [ -f "$file" ] || : > "$file"
  awk -v key="$key" 'index($0, key "=") != 1 { print }' "$file" > "$tmp"
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  chmod --reference="$file" "$tmp" 2>/dev/null || chmod 600 "$tmp" 2>/dev/null || true
  mv "$tmp" "$file"
}

# ── HTTP-проверки ───────────────────────────────────────────────────
# Два уровня: http_ok — «ответил успехом» (быстрый путь), http_code — какой
# именно код пришёл. Код нужен, потому что «не 2xx» и «не ответил» — разные
# диагнозы: у стокового шлюза Supabase /auth/v1/* закрыт плагином key-auth,
# и запрос без заголовка apikey ВСЕГДА получает 401 «No API key found in
# request». Считать это недоступностью нельзя.
#
# Возврат http_ok: 0 — успех, 1 — нет, 2 — проверить нечем (нет curl/wget).
http_ok() { # $1=URL [$2=apikey]
  local url="$1" key="${2:-}"
  if command -v curl >/dev/null 2>&1; then
    if [ -n "$key" ]; then
      if curl -sf -o /dev/null --max-time 8 -H "apikey: $key" "$url"; then return 0; fi
    else
      if curl -sf -o /dev/null --max-time 8 "$url"; then return 0; fi
    fi
    return 1
  fi
  if command -v wget >/dev/null 2>&1; then
    if wget -q -T 8 -O /dev/null "$url"; then return 0; fi
    return 1
  fi
  return 2
}

http_code() { # $1=URL [$2=apikey] → код ответа или 000, если соединения не было
  local url="$1" key="${2:-}" code=""
  if command -v curl >/dev/null 2>&1; then
    if [ -n "$key" ]; then
      code="$(curl -s -o /dev/null --max-time 8 -w '%{http_code}' -H "apikey: $key" "$url" 2>/dev/null || true)"
    else
      code="$(curl -s -o /dev/null --max-time 8 -w '%{http_code}' "$url" 2>/dev/null || true)"
    fi
  fi
  case "$code" in ''|*[!0-9]*) code=000 ;; esac
  printf '%s' "$code"
}

wait_http() { # $1 = URL, $2 = что говорим в процессе
  local url="$1" what="$2" i rc=1
  for i in $(seq 1 "$HEALTH_TRIES"); do
    rc=0
    http_ok "$url" || rc=$?
    if [ "$rc" = 0 ]; then say "✓ $what отвечает"; return 0; fi
    if [ "$rc" = 2 ]; then
      say "⚠ нет ни curl, ни wget — пропускаю проверку: $what"
      return 0
    fi
    sleep 4
  done
  # Последний код в тексте ошибки: «000» — соединения не было (DNS, TLS,
  # firewall), «502/404» — прокси жив, но за ним ничего нет.
  die "$what не ответил за $((HEALTH_TRIES * 4))с ($url, последний код $(http_code "$url"))"
}

# ── проверки контейнера auth (не зависят от сети, TLS и шлюза) ───────
# Контейнер auth: сначала спрашиваем сам compose (он знает project name),
# затем ищем по штатному имени из compose-файла Supabase.
auth_container_id() {
  local id=""
  id="$(compose "${AUTH_COMPOSE[@]}" ps -q auth 2>/dev/null | tail -n1 || true)"
  [ -n "$id" ] || id="$(docker ps -aq --filter "name=^/${AUTH_CONTAINER_NAME}$" 2>/dev/null | head -n1 || true)"
  [ -n "$id" ] || id="$(docker ps -aq --filter "name=${AUTH_CONTAINER_NAME}" 2>/dev/null | head -n1 || true)"
  printf '%s' "$id"
}

# «статус|health|код выхода|перезапусков» одной строкой; пусто — не прочитать.
auth_state() {
  docker inspect --format \
    '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.ExitCode}}|{{.RestartCount}}' \
    "$1" 2>/dev/null | head -n1 || true
}

# Порт GoTrue внутри контейнера (стоковое значение 9999). Окружение контейнера
# содержит секреты, поэтому забираем из него ровно одно число и ничего не печатаем.
auth_api_port() {
  local id="$1" port="" key
  for key in GOTRUE_API_PORT PORT; do
    port="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id" 2>/dev/null \
      | grep -E "^$key=" | tail -n1 | cut -d= -f2- || true)"
    case "$port" in ''|*[!0-9]*) port="" ;; *) break ;; esac
  done
  [ -n "$port" ] || port=9999
  printf '%s' "$port"
}

# Чем стучаться внутри контейнера: wget (им же ходит штатный healthcheck
# стека), curl — или ничем.
auth_probe_tool() {
  docker exec "$1" sh -c 'command -v wget || command -v curl' 2>/dev/null | head -n1 || true
}

# Запрос к /health ИЗНУТРИ контейнера: не зависит ни от docker-сети сайта,
# ни от шлюза с key-auth, ни от DNS/TLS публичного домена.
auth_local_health() { # $1=id $2=порт $3=инструмент
  case "${3##*/}" in
    wget) docker exec "$1" wget -q -T 5 -O /dev/null "http://127.0.0.1:$2/health" >/dev/null 2>&1 ;;
    curl) docker exec "$1" curl -sf -m 5 -o /dev/null "http://127.0.0.1:$2/health" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

# Хвост журнала auth — единственный способ объяснить «почему не поднялся».
# Значения вида ключ=значение с «секретными» именами маскируются: журнал
# задачи виден в панели, а GoTrue печатает свою конфигурацию при старте.
auth_log_tail() { # $1=id [$2=строк]
  local id="$1" lines="${2:-12}"
  docker logs --tail "$lines" "$id" 2>&1 | sed -e 's/\r$//' | awk '
    {
      n = split($0, parts, " "); out = "";
      for (i = 1; i <= n; i++) {
        p = parts[i]; eq = index(p, "=");
        if (eq > 1) {
          k = tolower(substr(p, 1, eq - 1));
          if (k ~ /pass|secret|token|key|credential/) p = substr(p, 1, eq) "***";
        }
        out = (i > 1 ? out " " : "") p;
      }
      print "  │ " substr(out, 1, 200);
    }' || true
}

# ── 1. проверка доступа к стеку Supabase ────────────────────────────
report smtp_prepare 5 "Проверяю доступ к стеку Supabase"
command -v docker >/dev/null 2>&1 || die "docker не найден: применить настройки auth невозможно"
[ -d "$SUPABASE_DIR" ] || die "каталог стека Supabase не найден: $SUPABASE_DIR (SUPABASE_HOST_DIR)"
[ -f "$SUPABASE_DIR/docker-compose.yml" ] || die "в $SUPABASE_DIR нет docker-compose.yml — это точно каталог стека Supabase?"
[ -f "$SUPABASE_ENV" ] || die "нет .env стека Supabase ($SUPABASE_ENV): сначала сохраните SMTP-ключи в панели"
[ -w "$SUPABASE_ENV" ] || die ".env стека Supabase недоступен на запись — проверьте монтирование каталога в update-agent"

for required in SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_ADMIN_EMAIL; do
  [ -n "$(supa_env_value "$required")" ] || die "в .env стека не заполнен $required: заполните SMTP в админке и сохраните"
done

# Успешно заполненный SMTP означает, что обе половины email-регистрации должны
# быть включены. Раньше галочки сохранялись, но старые false в окружении
# переживали перезапуск, из-за чего диагностика продолжала видеть две ошибки.
env_set "$SUPABASE_ENV" DISABLE_SIGNUP false
env_set "$SUPABASE_ENV" ENABLE_EMAIL_AUTOCONFIRM false
[ -w "$(dirname "$ENV_FILE")" ] || die "каталог env сайта недоступен на запись: $(dirname "$ENV_FILE")"
env_set "$ENV_FILE" AUTH_EMAIL_ENABLED true
say "SMTP заполнен; регистрация GoTrue и формы сайта включены"

# ── 2. отдельный управляемый override передаёт SMTP в auth ─────────
report smtp_override 15 "Подготавливаю SMTP override для auth"
OVERRIDE="$SUPABASE_DIR/docker-compose.override.yml"
SMTP_OVERRIDE="$SUPABASE_DIR/docker-compose.smtp-override.yml"
TEMPLATE="$PROJECT_DIR/deploy/selfhost/supabase-auth.override.yml"
[ -f "$TEMPLATE" ] || die "шаблон override не найден в клоне: $TEMPLATE"
cp "$TEMPLATE" "$SMTP_OVERRIDE"
chmod 600 "$SMTP_OVERRIDE" 2>/dev/null || true
say "SMTP override установлен автоматически: $SMTP_OVERRIDE"

# ── 3. пересоздание auth с новыми SMTP-ключами ─────────────────────
report smtp_switch 35 "Пересоздаю контейнер auth (GoTrue)"
cd "$SUPABASE_DIR"
# Чужой docker-compose.override.yml не переписываем, а подключаем вместе с
# отдельным управляемым файлом. Так настройки оператора и SMTP складываются.
AUTH_COMPOSE=(-f docker-compose.yml)
[ -f "$OVERRIDE" ] && AUTH_COMPOSE+=(-f docker-compose.override.yml)
AUTH_COMPOSE+=(-f docker-compose.smtp-override.yml)
compose "${AUTH_COMPOSE[@]}" up -d --no-deps --force-recreate auth 2>&1 | sed -e 's/\r$//' | cut -c1-300

# ── 4. проверка живости auth ────────────────────────────────────────
# Главный признак — состояние САМОГО контейнера, а не публичный адрес.
#
# Почему так. В стоковом стеке Supabase шлюз (Kong, в свежих сборках Envoy)
# закрывает весь /auth/v1/* плагином key-auth: открыты только verify,
# callback, authorize, jwks и SAML. Значит GET /auth/v1/health без заголовка
# apikey получает 401 «No API key found in request» — всегда, даже когда
# GoTrue полностью здоров. Прошлая редакция проверяла адрес через `curl -sf`,
# для которого 401 — ошибка, поэтому применение почты честно ждало 180с и
# падало «auth не ответил за 180с» сразу после успешного «Container
# supabase-auth Started». К тому же адрес панели (NEXT_PUBLIC_SUPABASE_URL,
# то есть https://<домен>/api/supabase) ведёт через публичный DNS, TLS,
# nginx и контейнер web — любой из них ломает проверку, не имея отношения
# к почте.
#
# Теперь порядок такой:
#   1) ждём, пока контейнер станет running/healthy — штатный healthcheck
#      стека это `wget http://localhost:9999/health`, то есть сам GoTrue;
#   2) если healthcheck в образе не определён — стучимся в /health изнутри
#      контейнера через docker exec;
#   3) публичный адрес опрашиваем ДОПОЛНИТЕЛЬНО и с ключом apikey из .env
#      стека; 401/403 трактуем как «шлюз ответил», а не как сбой;
#   4) если auth действительно не поднялся — печатаем состояние и хвост
#      журнала, чтобы в панели была причина, а не таймаут.
report smtp_verify 55 "Проверяю, что контейнер auth поднялся"
ANON_KEY="$(supa_env_value ANON_KEY)"
[ -n "$ANON_KEY" ] || ANON_KEY="$(supa_env_value SUPABASE_PUBLISHABLE_KEY)"

AUTH_ID="$(auth_container_id)"
AUTH_READY=0
AUTH_FATAL=""
AUTH_STATE_TEXT=""
AUTH_LAST_HEALTH=""
if [ -n "$AUTH_ID" ]; then
  AUTH_PORT="$(auth_api_port "$AUTH_ID")"
  AUTH_TOOL="$(auth_probe_tool "$AUTH_ID")"
  unreadable=0
  for i in $(seq 1 "$AUTH_TRIES"); do
    state="$(auth_state "$AUTH_ID")"
    if [ -z "$state" ]; then
      unreadable=$((unreadable + 1))
      if [ "$unreadable" -ge 3 ]; then
        AUTH_FATAL="состояние контейнера auth не читается (docker inspect ничего не вернул)"
        break
      fi
      sleep 2
      continue
    fi
    unreadable=0
    status="${state%%|*}"; rest="${state#*|}"
    health="${rest%%|*}"; rest="${rest#*|}"
    exitcode="${rest%%|*}"; restarts="${rest##*|}"
    case "$restarts" in ''|*[!0-9]*) restarts=0 ;; esac
    AUTH_STATE_TEXT="$status/$health"
    AUTH_LAST_HEALTH="$health"
    if [ "$status" = running ]; then
      if [ "$health" = healthy ]; then AUTH_READY=1; break; fi
      if [ "$health" = none ]; then
        # Инструмент ищем лениво: пока контейнер только стартовал, docker exec
        # мог ещё не пускать внутрь, и единственная попытка до цикла врала бы.
        [ -n "$AUTH_TOOL" ] || AUTH_TOOL="$(auth_probe_tool "$AUTH_ID")"
        if [ -n "$AUTH_TOOL" ]; then
          if auth_local_health "$AUTH_ID" "$AUTH_PORT" "$AUTH_TOOL"; then AUTH_READY=1; break; fi
        elif [ "$i" -ge 3 ]; then
          # Ни healthcheck, ни wget/curl в образе: подтвердить ответ GoTrue
          # нечем, но контейнер устойчиво работает — это не повод падать.
          AUTH_READY=1
          say "⚠ в образе auth нет healthcheck и нет wget/curl — проверил только состояние (running)"
          break
        fi
      fi
    elif [ "$status" = restarting ] && [ "$restarts" -ge 3 ]; then
      AUTH_FATAL="контейнер auth перезапускается по кругу (перезапусков: $restarts)"
      break
    elif [ "$status" = exited ] || [ "$status" = dead ]; then
      AUTH_FATAL="контейнер auth остановился (код выхода $exitcode)"
      break
    fi
    [ "$i" -lt "$AUTH_TRIES" ] && sleep 2
  done
  if [ "$AUTH_READY" = 1 ]; then
    say "✓ контейнер auth работает (${AUTH_STATE_TEXT})"
  elif [ -z "$AUTH_FATAL" ] && [ "$AUTH_LAST_HEALTH" = unhealthy ]; then
    AUTH_FATAL="healthcheck контейнера auth не проходит (${AUTH_STATE_TEXT})"
  fi
  # Контейнер точно не поднялся — внешнюю проверку не ждём, она ничего не
  # добавит: сразу показываем состояние, хвост журнала и причину.
  if [ -n "$AUTH_FATAL" ]; then
    say "── состояние auth: ${AUTH_STATE_TEXT:-неизвестно} ──"
    say "── последние строки журнала auth ──"
    auth_log_tail "$AUTH_ID" 15
    say "Проверьте SMTP_HOST/SMTP_PORT и доступность базы: docker logs $AUTH_CONTAINER_NAME"
    die "auth не поднялся: $AUTH_FATAL"
  fi
else
  say "⚠ контейнер auth не найден (ожидалось имя ${AUTH_CONTAINER_NAME}) — проверю только по адресу"
fi

if [ -z "$AUTH_HEALTH_URL" ]; then
  BASE="$(supa_env_value API_EXTERNAL_URL)"
  [ -n "$BASE" ] || BASE="$(supa_env_value SUPABASE_PUBLIC_URL)"
  [ -n "$BASE" ] && AUTH_HEALTH_URL="${BASE%/}/auth/v1/health"
fi

AUTH_PUBLIC_OK=0   # адрес ответил 2xx/3xx — GoTrue подтверждён снаружи
AUTH_GATEWAY_OK=0  # ответил только шлюз (401/403 key-auth): GoTrue неизвестен
AUTH_LAST_CODE=000
if [ -n "$AUTH_HEALTH_URL" ]; then
  # Контейнер уже подтверждён — адрес проверяем коротко, чтобы задача не
  # висела минуту из-за hairpin NAT или сертификата.
  tries="$AUTH_HTTP_TRIES"
  [ "$AUTH_READY" = 1 ] && tries=2
  for i in $(seq 1 "$tries"); do
    rc=0
    http_ok "$AUTH_HEALTH_URL" "$ANON_KEY" || rc=$?
    if [ "$rc" = 0 ]; then
      AUTH_PUBLIC_OK=1
      say "✓ auth отвечает и по адресу $AUTH_HEALTH_URL"
      break
    fi
    if [ "$rc" = 2 ]; then
      say "⚠ нет ни curl, ни wget — внешнюю проверку auth пропускаю"
      break
    fi
    AUTH_LAST_CODE="$(http_code "$AUTH_HEALTH_URL" "$ANON_KEY")"
    case "$AUTH_LAST_CODE" in
      2??|3??) AUTH_PUBLIC_OK=1; say "✓ auth отвечает по адресу $AUTH_HEALTH_URL (HTTP $AUTH_LAST_CODE)"; break ;;
      401|403)
        AUTH_GATEWAY_OK=1
        if [ "$AUTH_READY" = 1 ]; then
          say "✓ шлюз Supabase отвечает (HTTP $AUTH_LAST_CODE): /auth/v1/health закрыт key-auth — это нормально"
        else
          say "шлюз Supabase ответил HTTP $AUTH_LAST_CODE (/auth/v1/health закрыт key-auth)"
        fi
        break ;;
    esac
    [ "$i" -lt "$tries" ] && sleep 4
  done
elif [ "$AUTH_READY" != 1 ]; then
  say "⚠ адрес проверки auth неизвестен (нет AUTH_HEALTH_URL/API_EXTERNAL_URL) — внешняя проверка пропущена"
fi

if [ "$AUTH_READY" != 1 ] && [ "$AUTH_PUBLIC_OK" != 1 ]; then
  if [ -z "$AUTH_ID" ] && [ -z "$AUTH_HEALTH_URL" ]; then
    # Проверить нечем: ни контейнера рядом, ни адреса. Это не повод считать
    # почту несработавшей — ключи записаны, auth пересоздан.
    say "⚠ проверить auth нечем (контейнер не найден, адрес не задан) — пропускаю проверку"
  elif [ "$AUTH_GATEWAY_OK" = 1 ]; then
    say "⚠ шлюз отвечает, но подтвердить готовность GoTrue не удалось (${AUTH_STATE_TEXT:-состояние контейнера неизвестно})."
    say "  Продолжаю: SMTP-ключи записаны, контейнер auth пересоздан."
  else
    if [ -n "$AUTH_ID" ]; then
      say "── состояние auth: ${AUTH_STATE_TEXT:-неизвестно} ──"
      say "── последние строки журнала auth ──"
      auth_log_tail "$AUTH_ID" 15
    fi
    [ -n "$AUTH_HEALTH_URL" ] && say "Адрес $AUTH_HEALTH_URL отвечает кодом $AUTH_LAST_CODE"
    die "auth не подтвердил готовность за $((AUTH_TRIES * 2))с (${AUTH_STATE_TEXT:-состояние неизвестно})"
  fi
elif [ "$AUTH_READY" = 1 ] && [ "$AUTH_PUBLIC_OK" != 1 ] && [ "$AUTH_GATEWAY_OK" != 1 ] && [ -n "$AUTH_HEALTH_URL" ]; then
  # Почте это не мешает: письма GoTrue отправляет сам, изнутри стека.
  say "⚠ auth работает, но публичный адрес не ответил: $AUTH_HEALTH_URL (последний код $AUTH_LAST_CODE)"
  say "  На отправку писем это не влияет. Если и вход в браузере не работает, проверьте:"
  say "  сертификат домена, доступность /api/supabase у web (SUPABASE_INTERNAL_URL),"
  say "  а также hairpin NAT — сервер может не видеть собственный публичный адрес."
fi

# ── 5. пересоздание web: ключи сайта (AUTH_EMAIL_ENABLED и др.) ─────
report smtp_web 70 "Пересоздаю web, чтобы поднялись ключи сайта"
DEPLOY_MODE="${PROJECT_DEPLOY_MODE:-auto}"
if [ -z "$DEPLOY_MODE" ] || [ "$DEPLOY_MODE" = "auto" ]; then
  if command -v systemctl >/dev/null 2>&1 && systemctl cat "$SYSTEMD_SERVICE.service" >/dev/null 2>&1 \
     && ! [ -f "$PROJECT_DIR/docker-compose.yml" ]; then
    DEPLOY_MODE="systemd"
  else
    DEPLOY_MODE="compose"
  fi
fi
if [ "$DEPLOY_MODE" = "systemd" ]; then
  if command -v sudo >/dev/null 2>&1 && [ "$(id -u)" != "0" ]; then
    sudo systemctl restart "$SYSTEMD_SERVICE"
  else
    systemctl restart "$SYSTEMD_SERVICE"
  fi
else
  # Та же логика -f, что у apply-env.sh/update-project.sh: без доп. файла
  # compose молча пересоздал бы web без сети Supabase («EAI_AGAIN db»).
  cd "$PROJECT_DIR"
  EDRC_EXTRA_COMPOSE_FILES=""
  if [ -f "$PROJECT_DIR/deploy/compose-lib.sh" ]; then
    # shellcheck source=compose-lib.sh
    source "$PROJECT_DIR/deploy/compose-lib.sh"
    EDRC_EXTRA_COMPOSE_FILES="$(edrc_extra_compose_files "$PROJECT_DIR" "$ENV_FILE")"
  fi
  if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC2086
    compose --env-file "$ENV_FILE" -f docker-compose.yml $EDRC_EXTRA_COMPOSE_FILES up -d --force-recreate web 2>&1 | sed -e 's/\r$//' | cut -c1-300
  else
    # shellcheck disable=SC2086
    compose -f docker-compose.yml $EDRC_EXTRA_COMPOSE_FILES up -d --force-recreate web 2>&1 | sed -e 's/\r$//' | cut -c1-300
  fi
fi

# ── 6. финальная проверка сайта ─────────────────────────────────────
# Только процент и подпись: стадия остаётся smtp_web, «Готово» появляется
# лишь после того, как сайт реально ответил.
printf '::edrc::{"percent":95,"message":"Жду, пока сайт ответит"}\n'
wait_http "$HEALTH_URL" "сайт"

printf '::edrc::{"stage":"done","percent":100,"message":"%s"}\n' \
  "$(json_safe "настройки почты применены: auth и web перезапущены")"
say "ПРИМЕНЕНИЕ НАСТРОЕК ПОЧТЫ ЗАВЕРШЕНО"
