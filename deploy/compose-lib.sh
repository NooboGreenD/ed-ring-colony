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
  repo_root="${repo_root%/}"
  local network override
  override="$repo_root/deploy/compose.supabase-net.yml"
  [ -f "$override" ] || return 0
  network="$(edrc_detect_supabase_network "$env_file")"
  [ -n "$network" ] || return 0
  # Если docker доступен — проверяем, существует ли сеть в Docker,
  # чтобы несуществующая external-сеть не приводила к падению compose up
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker network inspect "$network" >/dev/null 2>&1 || return 0
  fi
  # Сеть видна — безопасно подключаться к ней как к external.
  printf -- '-f %s' "${override#$repo_root/}"
}

# edrc_compose_uses_buildkit — сможет ли СБОРКА compose работать с BuildKit.
#
# RUN --mount=type=cache (кэши npm и .next/cache в Dockerfile web) понимает
# только BuildKit. Compose v2 собирает через BuildKit плагином buildx: без
# него он печатает «Docker Compose requires buildx plugin» и молча уходит в
# legacy-билдер, для которого --mount — синтаксическая ошибка («the --mount
# option requires BuildKit»). Python-compose v1 не умеет BuildKit вовсе.
# Важно: возможен ли BuildKit, определяется не хостом, а тем, ЧЕМ запускается
# compose — агент обновления собирает стек из своего Alpine-образа, и до
# пакета docker-cli-buildx у него плагина buildx не было.
edrc_compose_uses_buildkit() {
  # Ручной выключатель: собрать без кэш-маунтов, даже если buildx есть
  # (например, когда демон хоста старше 20.10 и не тянет BuildKit-сборки).
  [ "${EDRC_FORCE_LEGACY_BUILD:-0}" = "1" ] && return 1
  # DOCKER_BUILDKIT=0 переводит и docker build, и compose в legacy-билдер.
  [ "${DOCKER_BUILDKIT:-}" = "0" ] && return 1
  command -v docker >/dev/null 2>&1 || return 1
  if docker compose version >/dev/null 2>&1; then
    # Compose v2: BuildKit-сборка идёт через плагин buildx CLI.
    docker buildx version >/dev/null 2>&1 && return 0
  elif command -v docker-compose >/dev/null 2>&1; then
    # Standalone docker-compose: v2 тоже собирает через buildx; python-v1
    # (1.29.x, «docker-compose version 1…») не умеет BuildKit в принципе.
    docker-compose version 2>/dev/null | grep -q 'Compose version v2' \
      && docker buildx version >/dev/null 2>&1 && return 0
  fi
  return 1
}

# edrc_prepare_legacy_build [repo_root] — Dockerfile web без кэш-маунтов.
#
# Возвращает «-f deploy/compose.legacy-build.yml», когда собирать будет
# legacy-билдер: генерирует .edrc-legacy-Dockerfile в корне контекста
# (канонический Dockerfile, из которого sed убирает только RUN --mount=…),
# а статический override deploy/compose.legacy-build.yml переключает на
# него сервис web. Имя образа и все build-args не меняются — «up -d»
# переключает контейнеры как обычно. С BuildKit вывод пуст: кэш-маунты
# работают как задумано. Файл .edrc-legacy-Dockerfile перегенерируется при
# каждом прогоне и занесён в .gitignore/.dockerignore.
#
# Сборка по запасному Dockerfile медленнее (нет переживающих --no-cache
# кэшей npm/.next), зато обновление доходит до конца на любом Docker.
edrc_prepare_legacy_build() {
  local repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  repo_root="${repo_root%/}"
  local dockerfile="$repo_root/Dockerfile"
  local legacy="$repo_root/.edrc-legacy-Dockerfile"
  local override="$repo_root/deploy/compose.legacy-build.yml"
  [ -f "$dockerfile" ] || return 0
  grep -q -- '--mount=type=cache' "$dockerfile" 2>/dev/null || return 0
  [ -f "$override" ] || return 0
  edrc_compose_uses_buildkit && return 0
  # Убираем только флаги --mount (их может быть несколько подряд), сама
  # команда (npm ci / npm run build) остаётся без изменений. BRE-интервал
  # вместо sed -E — чтобы работало и в busybox sed внутри агента (Alpine).
  if ! sed -e 's/^RUN \(--mount=[^ ][^ ]* \)\{1,\}/RUN /' "$dockerfile" > "$legacy" 2>/dev/null; then
    printf '⚠ edrc_prepare_legacy_build: не могу записать %s — сборка пойдёт по исходному Dockerfile\n' "$legacy" >&2
    return 0
  fi
  printf -- '-f deploy/compose.legacy-build.yml'
  return 0
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

# edrc_builder_prune [cache_keep] — подрезать кэш BuildKit до бюджета.
#
# Но-op, когда кэш и так в бюджете: свежие записи остаются ради быстрой
# следующей сборки, срезаются только старейшие. На Docker без --keep-storage
# (старее 23.0) — фильтр until=48h. Строго best-effort: недоступный Docker
# или незнакомый флаг никогда не валят запуск.
edrc_builder_prune() {
  local keep="${1:-${UPDATE_DOCKER_CACHE_KEEP:-8g}}"
  if docker builder prune --help 2>&1 | grep -q -- '--keep-storage'; then
    docker builder prune -f --keep-storage "$keep" >/dev/null 2>&1 \
      || docker builder prune -f --filter until=48h >/dev/null 2>&1 \
      || true
  elif docker builder prune --help 2>&1 | grep -q -- '--filter'; then
    docker builder prune -f --filter until=48h >/dev/null 2>&1 || true
  fi
  return 0
}

# edrc_trim_build_cache — ПЕРЕД сборкой: кэш BuildKit в бюджете.
#
# Уборка после переключения контейнеров помогает только успешным прогонам;
# сорвавшиеся сборки (упавший тест, ENOSPC, таймаут) копили кэш без чистки,
# и каждая следующая сборка шла всё дольше: распухший кэш + почти заполненный
# диск — это деградация I/O и самого BuildKit. Подрезка до старта — no-op,
# когда всё в порядке, и спасение, когда накопилось.
edrc_trim_build_cache() {
  command -v docker >/dev/null 2>&1 || return 0
  docker info >/dev/null 2>&1 || return 0
  edrc_builder_prune
  return 0
}

# edrc_cleanup_docker_disk [cache_keep] — ПОСЛЕ сборки: убрать то, что копит каждая сборка.
#
# Источник «диск тает после каждого обновления, даже при правке в 3 КБ»:
#   • кэш BuildKit. Любое изменение исходников инвалидирует слой COPY,
#     и сборка оставляет НОВЫЙ кэш npm ci / next build (гигабайты), а кэш
#     прошлых прогонов никто не удалял — `docker image prune` его не трогает;
#   • висячие образы и остановленные контейнеры (чистились и раньше);
#   • несрезанные слои от --no-cache пересборок.
#
# Итоговая таблица docker system df печатается в журнал.
edrc_cleanup_docker_disk() {
  command -v docker >/dev/null 2>&1 || return 0
  docker info >/dev/null 2>&1 || return 0

  docker container prune -f >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
  edrc_builder_prune

  # Краткий отчёт оператору: что именно занимает диск после уборки.
  docker system df 2>/dev/null | head -n 8 || true
  return 0
}
