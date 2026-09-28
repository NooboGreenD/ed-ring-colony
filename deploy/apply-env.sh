#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — применение изменений .env.production (Админка → Мониторинг
# → «API-ключи» → «Применить»).
#
# Его запускает приватный update-agent (kind=env). Скрипт НЕ пересобирает
# образы: он только пересоздаёт сервисы, чтобы они подняли новые
# RUNTIME-ключи из env-файла. Ключи NEXT_PUBLIC_* вшиваются в бандл при
# сборке — для них нужно полное «Обновить сейчас».
#
# Прогресс сообщается машиночитаемыми строками в stdout (формат
# scripts/lib/update-state.mjs, стадии ENV_STAGES):
#   ::edrc::{"stage":"env_switch","percent":40,"message":"..."}
#
# Переменные:
#   PROJECT_DIR      каталог с клоном (default /opt/ed-ring-colony/src)
#   ENV_FILE         env-файл (default $PROJECT_DIR/.env.production)
#   APPLY_ENV_SCOPE  web (по умолчанию) | all (web jobs monitor-agent)
#   UPDATE_HEALTH_URL  что опрашивать после пересоздания
#   SYSTEMD_SERVICE  unit сайта для systemd-режима (default ed-ring-colony)
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail
# ERR is inherited inside run_step/compose helpers so unexpected failures keep a reason.
set -E

PROJECT_DIR="${PROJECT_DIR:-/opt/ed-ring-colony/src}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env.production}"
SCOPE="${APPLY_ENV_SCOPE:-web}"
HEALTH_URL="${UPDATE_HEALTH_URL:-http://127.0.0.1:3000/api/health}"
SYSTEMD_SERVICE="${SYSTEMD_SERVICE:-ed-ring-colony}"
STATE_DIR="${UPDATE_STATE_DIR:-$PROJECT_DIR/../update-state}"
HEALTH_TRIES="${HEALTH_TRIES:-30}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-2}"

json_safe() { printf '%s' "${1:-}" | tr -d '"\\' | tr '\n\r' '  ' | cut -c1-200; }
say()    { printf '%s\n' "$*"; }
report() { printf '::edrc::{"stage":"%s","percent":%s,"message":"%s"}\n' "$1" "$2" "$(json_safe "$3")"; }
# Ошибка должна приезжать отдельным полем `error`. Если упал compose, поле
# `message` уже занято последней стадией и update-agent иначе показывает
# «пересоздаю сервисы» вместо причины сбоя.
die() {
  trap - ERR
  printf '::edrc::{"error":"%s","message":"%s"}\n' "$(json_safe "$*")" "$(json_safe "$*")"
  say "ОШИБКА: $*" >&2
  exit 1
}
fail() {
  local code="$1" line="$2"
  trap - ERR
  printf '::edrc::{"error":"%s"}\n' "$(json_safe "применение ключей прервано: строка $line, код $code")"
  exit "$code"
}
trap 'fail $? $LINENO' ERR

# Печатает вывод команды в журнал в реальном времени, но при ненулевом коде
# превращает его хвост в понятную причину для update-agent. Важно не оставлять
# compose в pipeline под set -e: ERR иначе видит только номер строки pipeline.
run_step() { # run_step "что делаем" команда...
  local what="$1"; shift
  local log code=0 reason
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  log="$(mktemp "${TMPDIR:-/tmp}/edrc-env-step.XXXXXX" 2>/dev/null || echo "$STATE_DIR/last-step.log")"
  trap - ERR
  set +e
  "$@" 2>&1 | tee "$log"
  code="${PIPESTATUS[0]}"
  set -e
  trap 'fail $? $LINENO' ERR
  if [ "$code" != "0" ]; then
    reason="$(grep -aiE 'error|ошибк|failed|fatal|cannot|not found|no space|denied|refused|killed|unauthorized|timeout' "$log" 2>/dev/null | tail -n 2 | tr '\n' ' ' | cut -c1-200 || true)"
    [ -n "$reason" ] || reason="$(tail -n 2 "$log" 2>/dev/null | tr '\n' ' ' | cut -c1-200 || true)"
    rm -f "$log" 2>/dev/null || true
    die "$what — код $code${reason:+: $reason}"
  fi
  rm -f "$log" 2>/dev/null || true
}

compose() {

  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@"
  else return 127
  fi
}

# ── 1. режим: Docker-стек или systemd-сайт ───────────────────────────
report env_prepare 10 "Определяю режим применения"
DEPLOY_MODE="${PROJECT_DEPLOY_MODE:-auto}"
if [ -z "$DEPLOY_MODE" ] || [ "$DEPLOY_MODE" = "auto" ]; then
  if [ -f "$ENV_FILE" ]; then
    from_file="$(grep -E '^PROJECT_DEPLOY_MODE=' "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
    if [ -n "$from_file" ]; then DEPLOY_MODE="$from_file"; fi
  fi
fi

COMPOSE_OK=0
if [ "$DEPLOY_MODE" = "compose" ]; then
  COMPOSE_OK=1
elif [ "$DEPLOY_MODE" = "systemd" ]; then
  COMPOSE_OK=0
elif command -v docker >/dev/null 2>&1 && [ -f "$PROJECT_DIR/docker-compose.yml" ] && docker info >/dev/null 2>&1; then
  COMPOSE_OK=1
elif command -v docker >/dev/null 2>&1 && [ -f "$PROJECT_DIR/docker-compose.yml" ] && ! command -v systemctl >/dev/null 2>&1; then
  COMPOSE_OK=1
fi
if [ "$COMPOSE_OK" = 0 ] && command -v systemctl >/dev/null 2>&1 && systemctl cat "$SYSTEMD_SERVICE.service" >/dev/null 2>&1; then
  :
elif [ "$COMPOSE_OK" = 0 ]; then
  if [ -f "$PROJECT_DIR/docker-compose.yml" ]; then
    COMPOSE_OK=1
  else
    die "не определил режим: нет ни Docker-стека с docker-compose.yml, ни systemd-unit $SYSTEMD_SERVICE"
  fi
fi
say "режим применения: $([ "$COMPOSE_OK" = 1 ] && echo compose || echo systemd)"

wait_health() {
  # Как в update-project.sh: curl → wget → пропуск (чтобы не убивать
  # применение из-за отсутствия инструмента).
  if command -v curl >/dev/null 2>&1; then
    for _ in $(seq 1 "$HEALTH_TRIES"); do
      if curl -sf -o /dev/null --max-time 5 "$HEALTH_URL"; then return 0; fi
      sleep "$HEALTH_INTERVAL_SECONDS"
    done
  elif command -v wget >/dev/null 2>&1; then
    for _ in $(seq 1 "$HEALTH_TRIES"); do
      if wget -q -T 5 -O /dev/null "$HEALTH_URL"; then return 0; fi
      sleep "$HEALTH_INTERVAL_SECONDS"
    done
  else
    say "⚠ нет ни curl, ни wget — пропускаю проверку доступности"
    return 0
  fi
  die "сайт не ответил по $HEALTH_URL за $((HEALTH_TRIES * HEALTH_INTERVAL_SECONDS))с; docker logs <проект>-web-1 или journalctl -u $SYSTEMD_SERVICE"
}

# ── 2. пересоздание сервисов ─────────────────────────────────────────
if [ "$COMPOSE_OK" = 1 ]; then
  # Из каталога репозитория — то же имя Compose-проекта, которым работают
  # update-project.sh и start-monitoring.sh (имя берётся из имени каталога).
  cd "$PROJECT_DIR"
  # Та же логика -f, что у остальных скриптов стека: без неё force-recreate
  # молча убрал бы у web/monitor-agent сеть Supabase (EAI_AGAIN вернулся бы).
  # При этом ВСЕГДА передаём базовый -f docker-compose.yml, чтобы Compose
  # не счёл deploy/compose.supabase-net.yml единственным файлом конфигурации.
  EDRC_EXTRA_COMPOSE_FILES=""
  if [ -f "$PROJECT_DIR/deploy/compose-lib.sh" ]; then
    # shellcheck source=compose-lib.sh
    source "$PROJECT_DIR/deploy/compose-lib.sh"
    EDRC_EXTRA_COMPOSE_FILES="$(edrc_extra_compose_files "$PROJECT_DIR" "$ENV_FILE")"
  fi
  SERVICES="web"
  if [ "$SCOPE" = "all" ]; then SERVICES="web jobs monitor-agent"; fi
  report env_switch 40 "Пересоздаю: $SERVICES (без пересборки образов)"
  # `--no-build` is intentional: applying runtime keys must never turn into a
  # full source rebuild. The option is kept after the service list for
  # compatibility with older Compose releases that accept interspersed flags.
  if [ -f "$ENV_FILE" ]; then
    run_step "пересоздание сервисов" compose --env-file "$ENV_FILE" -f docker-compose.yml $EDRC_EXTRA_COMPOSE_FILES --profile monitoring up -d --force-recreate $SERVICES --no-build
  else
    say "⚠ $ENV_FILE не найден — пересоздаю без --env-file"
    run_step "пересоздание сервисов" compose -f docker-compose.yml $EDRC_EXTRA_COMPOSE_FILES --profile monitoring up -d --force-recreate $SERVICES --no-build
  fi
  report env_verify 90 "Жду, пока сайт ответит"
  wait_health
else
  report env_switch 40 "Перезапускаю $SYSTEMD_SERVICE"
  if command -v sudo >/dev/null 2>&1 && [ "$(id -u)" != 0 ]; then
    sudo systemctl restart "$SYSTEMD_SERVICE"
  else
    systemctl restart "$SYSTEMD_SERVICE"
  fi
  report env_verify 90 "Жду, пока сайт ответит"
  wait_health
fi

printf '::edrc::{"stage":"done","percent":100,"message":"ключи применены, сайт отвечает"}\n'
say "ПРИМЕНЕНИЕ КЛЮЧЕЙ ЗАВЕРШЕНО"
