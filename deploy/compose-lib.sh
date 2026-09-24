#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — общий хелпер Compose-запусков (override-файлы деплоя).
#
# Источник: start-docker.sh, start-monitoring.sh, update-project.sh,
# apply-env.sh, selfhost/install.sh. Все они запускают `docker compose up -d`
# для ОДНОГО стека, поэтому список `-f`-файлов должен быть одинаковым у всех:
# иначе очередное «up» молча уберёт сеть Supabase или дополнительную публикацию
# сайта для Synology Reverse Proxy.
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

# edrc_extra_compose_files [repo_root] [env_file] — все дополнительные
# `-f`-аргументы или пусто. Может вернуть несколько пар, например:
#   -f deploy/compose.supabase-net.yml -f deploy/compose.synology.yml
# Потребители намеренно разворачивают результат как слова.
edrc_extra_compose_files() {
  local repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  local env_file="${2:-$repo_root/.env.production}"
  repo_root="${repo_root%/}"
  local network supabase_override synology_override synology_bind files=""

  # Self-hosted Supabase: добавляем общую external-сеть только когда она
  # существует. Неверное имя сети не должно ломать запуск всего сайта.
  supabase_override="$repo_root/deploy/compose.supabase-net.yml"
  if [ -f "$supabase_override" ]; then
    network="$(edrc_detect_supabase_network "$env_file")"
    if [ -n "$network" ]; then
      if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1 \
         || docker network inspect "$network" >/dev/null 2>&1; then
        files="-f ${supabase_override#$repo_root/}"
      fi
    fi
  fi

  # Synology: значение — только LAN_IP:HOST_PORT, например
  # 192.168.8.177:9000. Сам override дописывает внутренний :3000. В отличие
  # от PORT_BIND базовый 127.0.0.1:3000 сохраняется: локальные проверки и
  # nginx на VM не ломаются, а Synology получает стабильный отдельный порт.
  synology_bind="${SYNOLOGY_SITE_BIND:-}"
  if [ -z "$synology_bind" ] && [ -f "$env_file" ]; then
    synology_bind="$(grep -E '^SYNOLOGY_SITE_BIND=' "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
  fi
  synology_override="$repo_root/deploy/compose.synology.yml"
  if [ -n "$synology_bind" ] && [ -f "$synology_override" ]; then
    files="${files:+$files }-f ${synology_override#$repo_root/}"
  fi

  printf '%s' "$files"
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
