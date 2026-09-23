#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — общий хелпер Compose-запусков (подключение к Supabase).
#
# Источник: start-monitoring.sh, update-project.sh, apply-env.sh,
# selfhost/install.sh. Все они запускают `docker compose up -d` для ОДНОГО
# и того же стека, поэтому список `-f`-файлов должен быть одинаковым у
# всех: иначе очередное «up» молча пересоздало бы сервисы без сети
# Supabase, и «getaddrinfo EAI_AGAIN db» вернулся бы.
#
# Использование:
#   source "$(dirname "${BASH_SOURCE[0]}")/compose-lib.sh"
#   EDRC_EXTRA_COMPOSE_FILES="$(edrc_extra_compose_files)"   # может быть пусто
#   docker compose --env-file .env.production \
#     -f docker-compose.yml $EDRC_EXTRA_COMPOSE_FILES up -d
#
# Значения/вывод не содержат секретов: только имена docker-сетей.
# ─────────────────────────────────────────────────────────────────────

# edrc_detect_supabase_network [env_file] — имя сети стека Supabase или пусто.
# Порядок: переменная окружения SUPABASE_NETWORK → сеть живого контейнера
# supabase-db → первая сеть с «supabase» в имени.
# ВАЖНО: скрипты-потребители работают с `set -euo pipefail`, поэтому все
# «обычно пустые» команды защищены `|| true`, а переменные читаются с `:-`.
edrc_detect_supabase_network() {
  local env_file="${1:-}"
  local from_env="" candidate
  if [ -n "${SUPABASE_NETWORK:-}" ]; then
    printf '%s\n' "$SUPABASE_NETWORK"
    return 0
  fi
  if [ -n "$env_file" ] && [ -f "$env_file" ]; then
    from_env="$(grep -E '^SUPABASE_NETWORK=' "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
    if [ -n "$from_env" ]; then
      printf '%s\n' "$from_env"
      return 0
    fi
  fi
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    # Точный источник: сеть, в которой прямо сейчас живёт Postgres Supabase.
    candidate="$(docker inspect supabase-db --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | awk '{print $1}' || true)"
    if [ -n "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
    candidate="$(docker network ls --format '{{.Name}}' 2>/dev/null | grep -i 'supabase' | head -n1 || true)"
    if [ -n "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  return 0
}

# edrc_extra_compose_files [repo_root] [env_file] — доп. `-f`-аргументы или пусто.
# Возвращает строку вида "-f deploy/compose.supabase-net.yml" (без перевода
# строки в конце), готовую к подстановке без кавычек.
edrc_extra_compose_files() {
  local repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  local env_file="${2:-$repo_root/.env.production}"
  local network override
  override="$repo_root/deploy/compose.supabase-net.yml"
  [ -f "$override" ] || return 0
  network="$(edrc_detect_supabase_network "$env_file")"
  [ -n "$network" ] || return 0
  # Сеть видна — безопасно подключаться к ней как к external.
  printf -- '-f %s' "${override#$repo_root/}"
}

# edrc_persist_env FILE KEY VALUE — записать значение в env-файл (sed-аналог
# set_env из start-monitoring.sh, вынесен сюда, чтобы не дублировать).
edrc_persist_env() {
  local f="$1" k="$2" v="$3"
  [ -f "$f" ] || return 0
  if grep -qE "^${k}=" "$f"; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$f"
  else
    printf '%s=%s\n' "$k" "$v" >> "$f"
  fi
}
