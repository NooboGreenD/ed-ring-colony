#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — мониторинг одной командой (Ubuntu 20.04, Desktop как сервер)
#
# Скрипт идемпотентен и не печатает секреты. Всё, что уже настроено, он
# оставляет как есть.
#
# Одна команда с чистого сервера (клонирование + Docker + мониторинг + апдейтер):
#
#   curl -fsSL https://raw.githubusercontent.com/NooboGreenD/ed-ring-colony/main/deploy/monitoring-setup.sh | sudo bash
#
# Или из существующего клона:
#
#   sudo bash deploy/monitoring-setup.sh
#
# Флаги:
#   --repo-dir DIR        каталог клона (default /opt/ed-ring-colony/src)
#   --branch BRANCH       ветка для деплоя (default main)
#   --env-file FILE       свой путь к .env.production (default DIR/.env.production)
#   --no-docker-install   не устанавливать Docker, если его нет
#   --no-update-agent     не включать update-agent (кнопки «Обновить сейчас»
#                         и «API-ключи» останутся недоступны)
#   --no-pull             не подтягивать свежие коммиты (работаем с тем, что на диске)
#
# Что делает скрипт:
#   1. при необходимости ставит git/Docker (get.docker.com) и включает сервис;
#   2. клонирует репозиторий, если его ещё нет (или берёт текущий каталог);
#   3. подтягивает ветку (чистое дерево: локальные правки уйдут в stash
#      позже сам update-project.sh, здесь только fetch + ff-only merge);
#   4. bash deploy/start-monitoring.sh  — ключи, MONITOR_DB_URL, web+jobs+
#      monitor-agent, проверка цепочки web → monitor-agent;
#   5. bash deploy/start-update-agent.sh — ключи, update-agent (единственный,
#      кому разрешено менять развёрнутую версию; теперь с /env-эндпоинтами
#      для редактирования ключей из панели), проверка связности;
#   6. предупреждает о ключах, без которых части панели останутся «пустыми».
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="/opt/ed-ring-colony/src"
BRANCH="main"
REPOSITORY="NooboGreenD/ed-ring-colony"
ENV_FILE=""
INSTALL_DOCKER=1
ENABLE_UPDATE_AGENT=1
DO_PULL=1

while [ $# -gt 0 ]; do
  case "$1" in
    --repo-dir)          REPO_DIR="${2:?}"; shift 2;;
    --branch)            BRANCH="${2:?}"; shift 2;;
    --env-file)          ENV_FILE="${2:?}"; shift 2;;
    --no-docker-install) INSTALL_DOCKER=0; shift;;
    --no-update-agent)   ENABLE_UPDATE_AGENT=0; shift;;
    --no-pull)           DO_PULL=0; shift;;
    -h|--help)
      if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
        tail -n +2 "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//' | head -34
      else
        echo "Использование: bash deploy/monitoring-setup.sh [--repo-dir DIR] [--branch BRANCH] [--env-file FILE] [--no-docker-install] [--no-update-agent] [--no-pull]"
      fi
      exit 0;;
    *) echo "Неизвестный флаг: $1 (см. --help)" >&2; exit 1;;
  esac
done

say()  { printf '%s\n' "$*"; }
step() { printf '\n── %s ──\n' "$*"; }
die()  { echo "Ошибка: $*" >&2; exit 1; }

# Запущено из клона (bash deploy/monitoring-setup.sh) — каталог уже известен.
SCRIPT_SELF=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_SELF="${BASH_SOURCE[0]}"
  CANDIDATE_ROOT="$(cd "$(dirname "$SCRIPT_SELF")/.." && pwd)"
  if [ -f "$CANDIDATE_ROOT/docker-compose.yml" ] && [ -f "$CANDIDATE_ROOT/deploy/start-monitoring.sh" ]; then
    REPO_DIR="$CANDIDATE_ROOT"
  fi
fi

[ -n "$ENV_FILE" ] || ENV_FILE="$REPO_DIR/.env.production"

# ── 1. базовые инструменты ───────────────────────────────────────────
step "Инструменты (git, curl, ca-certificates)"
have() { command -v "$1" >/dev/null 2>&1; }
if ! have apt-get; then
  say "apt-get не найден (не Debian/Ubuntu?): поставьте git и curl вручную и повторите."
fi
NEED_PKGS=()
have git || NEED_PKGS+=(git)
have curl || NEED_PKGS+=(curl ca-certificates)
if [ "${#NEED_PKGS[@]}" -gt 0 ] && have apt-get; then
  if [ "$(id -u)" != 0 ]; then
    die "нужно установить: ${NEED_PKGS[*]} — повторите с sudo (или поставьте вручную и запустите снова)"
  fi
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${NEED_PKGS[@]}"
  say "  ✓ установлены: ${NEED_PKGS[*]}"
elif [ "${#NEED_PKGS[@]}" -gt 0 ]; then
  die "нет apt-get, чтобы поставить: ${NEED_PKGS[*]}"
fi

# ── 2. Docker ────────────────────────────────────────────────────────
step "Docker"
docker_ok() { have docker && docker info >/dev/null 2>&1; }
if docker_ok; then
  say "  ✓ Docker доступен"
else
  if [ "$INSTALL_DOCKER" = 0 ]; then
    die "Docker недоступен (и --no-docker-install): поставьте Docker и повторите"
  fi
  if [ "$(id -u)" != 0 ]; then
    die 'Docker недоступен, и установка требует sudo: повторите с sudo (или поставьте Docker вручную и запустите снова)'
  fi
  say "  · устанавливаю Docker (get.docker.com, ~1-3 минуты)…"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  if [ "$(id -u)" = "0" ] && [ -n "${SUDO_USER:-}" ] && id "$SUDO_USER" >/dev/null 2>&1; then
    usermod -aG docker "$SUDO_USER" || true
    say "  · $SUDO_USER добавлен в группу docker (для текущего сеанса войдите заново или sudo -g docker)"
  fi
  # Права процесса могли смениться — проверяю ещё раз.
  docker_ok || die "Docker установлен, но daemon не отвечает: systemctl status docker"
  say "  ✓ Docker запущен"
fi

# ── 3. репозиторий ───────────────────────────────────────────────────
step "Репозиторий → $REPO_DIR"
if [ -z "$SCRIPT_SELF" ] || [ ! -f "$REPO_DIR/deploy/start-monitoring.sh" ]; then
  if [ -d "$REPO_DIR/.git" ]; then
    say "  · существующий клон: $REPO_DIR"
  else
    say "  · клонирую $REPOSITORY ($BRANCH)…"
    mkdir -p "$(dirname "$REPO_DIR")"
    git clone --branch "$BRANCH" "https://github.com/$REPOSITORY.git" "$REPO_DIR"
    say "  ✓ клон готов"
  fi
  # Пипед-запуск (curl | bash): догоняем реальной копией скрипта из клона,
  # передавая все флаги — чтобы --no-update-agent и им подобные не потерялись.
  if [ -z "$SCRIPT_SELF" ]; then
    REEXEC_ARGS=(--repo-dir "$REPO_DIR" --branch "$BRANCH" --env-file "$ENV_FILE")
    [ "$INSTALL_DOCKER" = 1 ] || REEXEC_ARGS+=(--no-docker-install)
    [ "$ENABLE_UPDATE_AGENT" = 1 ] || REEXEC_ARGS+=(--no-update-agent)
    [ "$DO_PULL" = 1 ] || REEXEC_ARGS+=(--no-pull)
    exec bash "$REPO_DIR/deploy/monitoring-setup.sh" "${REEXEC_ARGS[@]}"
  fi
fi
cd "$REPO_DIR"

if [ "$DO_PULL" = 1 ]; then
  step "Свежие коммиты ($BRANCH)"
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    say "  ! рабочее дерево не чистое — подтягиваю без merge, конфликт разберёт update-project.sh"
  else
    git fetch --quiet --prune origin "$BRANCH" || die "git fetch origin/$BRANCH не удался"
    if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$BRANCH")" ]; then
      git merge --ff-only --quiet "origin/$BRANCH" || die "ff-only merge не удался: git status"
      say "  ✓ ветка подтянута до $(git rev-parse --short HEAD)"
    else
      say "  ✓ уже на последнем коммите $(git rev-parse --short HEAD)"
    fi
  fi
fi

# Обновлённые образы агентов должны собраться из тех же исходников.
export PROJECT_HOST_DIR="$REPO_DIR"

# ── 4. мониторинг: ключи + web + jobs + monitor-agent ────────────────
step "start-monitoring.sh"
bash deploy/start-monitoring.sh --env-file "$ENV_FILE"

# ── 5. update-agent: «Обновить сейчас» + «API-ключи» ─────────────────
if [ "$ENABLE_UPDATE_AGENT" = 1 ]; then
  step "start-update-agent.sh"
  bash deploy/start-update-agent.sh --env-file "$ENV_FILE" --project-dir "$REPO_DIR"
else
  say "⚠ update-agent не включён (--no-update-agent): в панели не будет «Обновить сейчас» и «API-ключи»."
fi

# ── 6. что ещё может остаться «пустым» на панели ─────────────────────
step "Проверка ключей для панели"
env_value() { grep -E "^$2=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true; }
for k in NEXT_PUBLIC_SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
  if [ -z "$(env_value "$k")" ]; then
    say "  ! $k пуст — блок «База данных» и контент не заработают. Заполните"
    say "    в .env.production или через Админка → Мониторинг → «API-ключи сайта»,"
    say "    затем «Применить»."
  fi
done
if [ -z "$(env_value YANDEX_TRANSLATE_API_KEY)" ]; then
  say "  ! YANDEX_TRANSLATE_API_KEY пуст — Galnet и новости будут в статусе pending."
fi
if [ -z "$(env_value DATABASE_URL)" ] && [ -z "$(env_value SUPABASE_DB_URL)" ]; then
  say "  ! нет DATABASE_URL/SUPABASE_DB_URL — размер БД посчитать нечем (и размер"
  say "    каталога спанша тоже). Для Supabase в своей Docker-сети укажите хост,"
  say "    видимый с сайта: например postgresql://postgres:ПАРОЛЬ@host.docker.internal:5432/postgres"
fi

SITE_URL="$(env_value NEXT_PUBLIC_SITE_URL)"
[ -n "$SITE_URL" ] || SITE_URL="http://localhost:3000"
cat <<EOF

ГОТОВО. Панель: ${SITE_URL}/admin (вкладка «Мониторинг», роль admin).
  • мониторинг: web + jobs + monitor-agent подняты, цепочка проверена;
  • обновление: update-agent запущен — «Обновить сейчас» и «API-ключи сайта»
    доступны из панели; ключи редактируются без SSH (Админка → Мониторинг →
    «API-ключи сайта» → правка/добавление → «Применить»);
  • env-файл: $ENV_FILE (права 600);
  • логи: docker compose --env-file $ENV_FILE --profile monitoring logs -f
  повторный запуск безопасен: bash deploy/monitoring-setup.sh
EOF
