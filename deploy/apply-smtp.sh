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
#   AUTH_HEALTH_URL     адрес проверки auth (панель передаёт
#                       NEXT_PUBLIC_SUPABASE_URL + /auth/v1/health);
#                       пусто → берём API_EXTERNAL_URL/SUPABASE_PUBLIC_URL
#                       из .env стека, иначе проверка пропускается
#   UPDATE_HEALTH_URL   что опрашивать после пересоздания web
#   ENV_FILE            env-файл сайта (для compose-переменных web)
#   SYSTEMD_SERVICE     unit сайта для systemd-режима (default ed-ring-colony)
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

json_safe() { printf '%s' "${1:-}" | tr -d '"\\' | tr '\n\r' '  ' | cut -c1-200; }
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

wait_http() { # $1 = URL, $2 = что говорим в процессе
  local url="$1" what="$2" i
  for i in $(seq 1 "$HEALTH_TRIES"); do
    if command -v curl >/dev/null 2>&1; then
      if curl -sf -o /dev/null --max-time 5 "$url"; then say "✓ $what отвечает"; return 0; fi
    elif command -v wget >/dev/null 2>&1; then
      if wget -q -T 5 -O /dev/null "$url"; then say "✓ $what отвечает"; return 0; fi
    else
      say "⚠ нет ни curl, ни wget — пропускаю проверку: $what"
      return 0
    fi
    sleep 4
  done
  die "$what не ответил за $((HEALTH_TRIES * 4))с ($url)"
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
report smtp_verify 55 "Жду, пока auth начнёт отвечать"
if [ -z "$AUTH_HEALTH_URL" ]; then
  BASE="$(supa_env_value API_EXTERNAL_URL)"
  [ -n "$BASE" ] || BASE="$(supa_env_value SUPABASE_PUBLIC_URL)"
  [ -n "$BASE" ] && AUTH_HEALTH_URL="${BASE%/}/auth/v1/health"
fi
if [ -n "$AUTH_HEALTH_URL" ]; then
  wait_http "$AUTH_HEALTH_URL" "auth"
else
  say "⚠ адрес проверки auth неизвестен (нет AUTH_HEALTH_URL/API_EXTERNAL_URL) — пропускаю проверку"
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
