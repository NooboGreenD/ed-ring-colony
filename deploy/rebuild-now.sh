#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — ручная ПОЛНАЯ пересборка на сервере (актуальный main).
#
# Для стандартной схемы: git-клон + Docker Compose, приложение на
# 127.0.0.1:3000 за nginx. НЕ применяйте после обновления управляющим
# скриптом upgrade.py (UBUNTU20-UPGRADE.md) — у него свой Compose-контекст,
# используйте его status/logs/rollback.
#
#   bash deploy/rebuild-now.sh               # git pull + полная пересборка
#   NO_PULL=1 bash deploy/rebuild-now.sh     # только пересборка, без git pull
#   SKIP_TESTS=1 bash deploy/rebuild-now.sh  # экстренно: без npm test в сборке
#   bash deploy/rebuild-now.sh --rollback    # вернуть предыдущий образ web
#
# Что делает: fetch + ff-only перемотку ветки, передаёт метаданные
# APP_GIT_* в сборку, сохраняет текущий образ web как ed-ring-colony:prev,
# гоняет `docker compose build --no-cache` (полная пересборка слоёв:
# npm ci + тесты + next build), переключает контейнеры и проверяет
# /api/health. Старый сайт продолжает работать, пока новая сборка не
# прошла: при ошибке сборки контейнеры не заменяются.
#
# Пересборка на малом VPS идёт 30–60 минут — это не зависание
# (см. DEPLOY.md, «Скорость сборки образа»).
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="${REPO_DIR:-$PWD}"
BRANCH="${PROJECT_UPDATE_BRANCH:-main}"
REPOSITORY="${PROJECT_REPOSITORY:-NooboGreenD/ed-ring-colony}"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env.production}"
WEB_URL="${WEB_URL:-http://127.0.0.1:3000/api/health}"
HEALTH_TRIES="${HEALTH_TRIES:-60}"   # до ~4 минут: 60 × 4 с
COMPOSE_SERVICES="${COMPOSE_SERVICES:-web jobs}"
PREV_TAG="ed-ring-colony:prev"

say()  { printf '%s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*"; }
die()  { printf 'ОШИБКА: %s\n' "$*" >&2; exit 1; }

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@"
  else die "ни docker compose, ни docker-compose не найдены"; fi
}

# Тот же набор -f и профиль, что у штатных скриптов (compose-lib.sh):
# иначе очередное up молча пересоздало бы web без сети Supabase и вернул
# «getaddrinfo EAI_AGAIN db». Доп. файл подключается только если сеть
# Supabase реально существует — см. deploy/compose.supabase-net.yml.
EXTRA_FILES=""
if [ -f "$REPO_DIR/deploy/compose-lib.sh" ]; then
  # shellcheck source=compose-lib.sh
  source "$REPO_DIR/deploy/compose-lib.sh"
  EXTRA_FILES="$(edrc_extra_compose_files "$REPO_DIR" "$ENV_FILE")"
  [ -n "$EXTRA_FILES" ] && say "сеть Supabase: подключаю web ($EXTRA_FILES)"
fi

compose_base() {
  # $EXTRA_FILES — строка вида "-f deploy/compose.supabase-net.yml",
  # слова разворачиваются намеренно.
  # shellcheck disable=SC2086
  compose --env-file "$ENV_FILE" -f "$REPO_DIR/docker-compose.yml" $EXTRA_FILES \
    --profile monitoring "$@"
}

probe() {
  if command -v curl >/dev/null 2>&1; then
    curl -sf --max-time 5 -o /dev/null "$WEB_URL"
  else
    wget -q -T 5 -O /dev/null "$WEB_URL"
  fi
}

verify_health() {
  local i
  for i in $(seq 1 "$HEALTH_TRIES"); do
    if probe; then say "✓ сайт отвечает: $WEB_URL"; return 0; fi
    sleep 4
  done
  warn "сайт не ответил за $((HEALTH_TRIES * 4))с — хвост логов web:"
  compose_base logs --tail=80 web 2>/dev/null || true
  return 1
}

# ── 0. окружение ────────────────────────────────────────────────────
[ -f "$REPO_DIR/docker-compose.yml" ] \
  || die "не вижу docker-compose.yml (REPO_DIR=$REPO_DIR) — запускайте из корня клона"
cd "$REPO_DIR"
[ -f "$ENV_FILE" ] || die "нет $ENV_FILE (нужен и для build-args, и для запуска)"
for key in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY \
           NEXT_PUBLIC_SITE_URL CRON_SECRET; do
  grep -qE "^${key}=..*" "$ENV_FILE" || die "$ENV_FILE: не задан (или пуст) $key"
done
if [ "${SKIP_TESTS:-0}" = "1" ]; then
  export RUN_TESTS=0
  warn "SKIP_TESTS=1 — npm test внутри образа будет пропущен"
fi

# ── откат: вернуть сохранённый предыдущий образ web ─────────────────
if [ "${1:-}" = "--rollback" ]; then
  docker image inspect "$PREV_TAG" >/dev/null 2>&1 \
    || die "образ $PREV_TAG не найден — откатывать нечего"
  say "▶ откат: возвращаю предыдущий образ web ($PREV_TAG)"
  IMG="$(compose_base config --images 2>/dev/null | grep -E -- '-web$' | head -n1 || true)"
  [ -n "$IMG" ] || die "compose config --images не вернул образ web"
  docker tag "$PREV_TAG" "$IMG"
  compose_base up -d --no-deps web
  if verify_health; then
    say "ОТКАТ ЗАВЕРШЁН: работает предыдущая сборка"
    exit 0
  fi
  die "предыдущий образ запущен, но сайт не отвечает — логи выше"
fi

# ── 1. актуальные исходники ─────────────────────────────────────────
if [ "${NO_PULL:-0}" = "1" ]; then
  say "NO_PULL=1 — пересборка текущих исходников без git pull"
else
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "$REPO_DIR не git-клон — обновляйте вручную или запустите с NO_PULL=1"
  say "▶ синхронизация с GitHub: $REPOSITORY@$BRANCH"
  REMOTE="$(git remote 2>/dev/null | head -n1 || true)"
  REMOTE="${REMOTE:-origin}"
  git fetch --quiet --prune "$REMOTE" "$BRANCH" \
    || die "git fetch $REMOTE/$BRANCH не удался (сеть/доступность $REPOSITORY)"
  BEHIND="$(git rev-list --count "HEAD..$REMOTE/$BRANCH")"
  if [ "$BEHIND" = "0" ]; then
    say "исходники уже актуальны: $(git rev-parse --short=12 HEAD)"
  else
    STASHED=0
    if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
      warn "есть незакоммиченные изменения — уношу в stash и верну после перемотки"
      git stash push -u -m "rebuild-now-$(date -u +%Y%m%dT%H%M%SZ)" >/dev/null \
        || die "git stash не удался — разберите изменения вручную"
      STASHED=1
    fi
    if ! git merge --ff-only "$REMOTE/$BRANCH" >/dev/null 2>&1; then
      [ "$STASHED" = "1" ] && git stash pop --index >/dev/null 2>&1 || true
      die "merge --ff-only не удался — локальная ветка разошлась с $REMOTE/$BRANCH"
    fi
    if [ "$STASHED" = "1" ]; then
      git stash pop --index >/dev/null 2>&1 \
        || warn "git stash pop не удался — ваши изменения в stash (git stash list)"
    fi
    say "исходники перемотаны: → $(git rev-parse --short=12 HEAD)"
  fi
fi

# ── 2. метаданные ревизии для панели «Версия проекта» ───────────────
APP_GIT_SHA="$(git rev-parse HEAD 2>/dev/null || printf 'unknown')"
APP_GIT_REF="$BRANCH"
APP_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export APP_GIT_SHA APP_GIT_REF APP_BUILD_TIME
if declare -F edrc_persist_env >/dev/null 2>&1; then
  edrc_persist_env "$ENV_FILE" APP_GIT_SHA    "$APP_GIT_SHA"
  edrc_persist_env "$ENV_FILE" APP_GIT_REF    "$APP_GIT_REF"
  edrc_persist_env "$ENV_FILE" APP_BUILD_TIME "$APP_BUILD_TIME"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
fi
say "ревизия сборки: $APP_GIT_SHA ($APP_GIT_REF)"

# ── 3. конфигурация compose — падаем ДО сборки, если чего-то нет ────
say "▶ проверяю compose-конфигурацию"
compose_base config --quiet \
  || die "compose config: в $ENV_FILE не хватает значений или есть ошибка"

# ── 4. снимок текущего образа web для отката ────────────────────────
CID="$(docker ps -aq --filter publish=3000 2>/dev/null | head -n1 || true)"
[ -n "$CID" ] || CID="$(docker ps -aq --filter label=com.docker.compose.service=web 2>/dev/null | head -n1 || true)"
if [ -n "$CID" ]; then
  IMG_ID="$(docker inspect --format '{{.Image}}' "$CID" 2>/dev/null || true)"
  if [ -n "$IMG_ID" ] && docker image inspect "$IMG_ID" >/dev/null 2>&1; then
    docker tag "$IMG_ID" "$PREV_TAG"
    say "текущий образ сохранён как $PREV_TAG — откат: bash deploy/rebuild-now.sh --rollback"
  fi
else
  warn "контейнер, публикующий порт 3000, не найден — снимок для отката не сделан"
fi

# ── 5. полная пересборка без кэша ───────────────────────────────────
# $COMPOSE_SERVICES — список слов, разворачивается намеренно.
# shellcheck disable=SC2086
say "▶ ПОЛНАЯ ПЕРЕСБОРКА без кэша: $COMPOSE_SERVICES"
say "  (npm ci + тесты + next build; 30–60 минут на малом VPS — это не зависание)"
# shellcheck disable=SC2086
compose_base build --no-cache $COMPOSE_SERVICES

# ── 6. переключение ─────────────────────────────────────────────────
say "▶ переключаю контейнеры"
# shellcheck disable=SC2086
compose_base up -d $COMPOSE_SERVICES
docker image prune -f >/dev/null 2>&1 || true
compose_base ps

# ── 7. проверка живости ─────────────────────────────────────────────
if verify_health; then
  say "ГОТОВО: развёрнута ревизия $APP_GIT_SHA"
  say "если что-то не так — откат: bash deploy/rebuild-now.sh --rollback"
  exit 0
fi
die "сайт не ответил после пересборки. Причины: docker compose logs --tail=200 web; \
sudo tail -n 50 /var/log/nginx/error.log; df -h (нет ли места); free -m (нет ли OOM)"
