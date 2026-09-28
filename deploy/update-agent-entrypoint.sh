#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — точка входа контейнера update-agent.
#
# Зачем нужна отдельная точка входа:
#
# Обновление проекта (deploy/update-project.sh) не пересоздаёт контейнер
# апдейтера в foreground — он же выполняет этот прогон, и пересоздание убило бы
# его на середине. После успешной проверки web скрипт запускает detached helper,
# который заменяет контейнер уже из свежесобранного образа. Поэтому пакеты уровня
# образа (например, docker-cli-buildx) действительно появляются у следующего
# агента, а не только при перезапуске Node-процесса.
#
# Репозиторий и так смонтирован в контейнер по тому же пути, что и на хосте
# (см. docker-compose.yml). До безопасной замены код агента можно брать прямо
# оттуда — правки из git pull сразу видны после перезапуска процесса. Копия в
# образе остаётся запасной: если клон неполный или файла нет, агент поднимется
# из /app.
#
# Выбор можно переопределить:
#   UPDATE_AGENT_ENTRY=/путь/к/update-agent.mjs   — явный файл
#   UPDATE_AGENT_FROM_REPO=0                      — всегда копия из образа
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/ed-ring-colony/src}"
IMAGE_ENTRY="/app/scripts/update-agent.mjs"
REPO_ENTRY="$PROJECT_DIR/scripts/update-agent.mjs"
REPO_SHARED="$PROJECT_DIR/scripts/lib/update-state.mjs"

ENTRY="${UPDATE_AGENT_ENTRY:-}"
if [ -z "$ENTRY" ]; then
  if [ "${UPDATE_AGENT_FROM_REPO:-1}" != "0" ] && [ -f "$REPO_ENTRY" ] && [ -f "$REPO_SHARED" ]; then
    ENTRY="$REPO_ENTRY"
  else
    ENTRY="$IMAGE_ENTRY"
  fi
fi

if [ ! -f "$ENTRY" ]; then
  echo "update-agent: не найден ни $REPO_ENTRY, ни $IMAGE_ENTRY" >&2
  exit 1
fi

if [ "$ENTRY" = "$REPO_ENTRY" ]; then
  echo "update-agent: код берётся из клона ($REPO_ENTRY) — правки вступают после перезапуска контейнера"
else
  echo "update-agent: код берётся из образа ($IMAGE_ENTRY)"
fi

# exec: node становится PID 1 (через docker init), сигналы доходят напрямую,
# а завершение процесса (самоперезапуск агента) поднимает контейнер заново.
exec node "$ENTRY" "$@"
