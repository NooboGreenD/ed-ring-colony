#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — «куда уходит диск после переборок».
#
# Запуск на сервере (из корня клона; нужен доступ к Docker, для du по
# /var/lib/docker — root):
#   bash deploy/docker-disk-report.sh             # только посмотреть
#   bash deploy/docker-disk-report.sh --wipe      # ещё и вычистить кэш-маунты
#
# Отвечает на вопрос из прод-инцидента: «кэш сборки минимальный, а после
# каждой переборки минус 1–2 ГБ». Показывает по порядку:
#   • df по корню Docker и по корню ФС;
#   • docker system df — образы/контейнеры/тома/кэш сборки (как их видит демон);
#   • du по подкаталогам /var/lib/docker — overlay2, volumes, containers,
#     buildkit: где РЕАЛЬНО лежат гигабайты;
#   • размеры контейнеров вместе с журналами (docker ps -s);
#   • размеры КЭШ-МАУНТОВ BuildKit — /root/.npm и /app/.next/cache из
#     Dockerfile web. Их не видит ни docker system df, ни docker builder
#     prune, а с Next 16.3 Turbopack дописывает в .next/cache персистентный
#     кэш КАЖДОЙ сборки (turbopackFileSystemCacheForBuild=true по умолчанию)
#     — типичный источник «утечки в никуда»;
#   • сколько занимают резервные копии БД (перед обновлениями и ручные).
#
# --wipe вычищает оба кэш-маунта целиком (edrc_trim_cache_mounts wipe):
# место возвращается сразу, следующая сборка будет «холодной» по этим кэшам.
# ─────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WIPE=0
[ "${1:-}" = "--wipe" ] && WIPE=1

say()  { printf '%s\n' "$*"; }
head() { printf '\n── %s ──\n' "$*"; }

command -v docker >/dev/null 2>&1 || { echo "ОШИБКА: docker не найден"; exit 1; }
docker info >/dev/null 2>&1 || { echo "ОШИБКА: демон Docker не отвечает"; exit 1; }

DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
[ -n "$DOCKER_ROOT" ] || DOCKER_ROOT="/var/lib/docker"

head "свободное место"
df -h / "$DOCKER_ROOT" 2>/dev/null || df -h / || true

head "docker system df (как это видит демон)"
docker system df 2>/dev/null || true

head "строители buildx (кэш может жить не только в default)"
docker buildx ls 2>/dev/null || true

head "du по $DOCKER_ROOT (нужен root; это то, что реально на диске)"
if [ -r "$DOCKER_ROOT" ]; then
  du -sh "$DOCKER_ROOT"/* 2>/dev/null | sort -h || true
else
  say "⚠ нет прав на чтение $DOCKER_ROOT — запустите через sudo, чтобы увидеть раскладку"
fi

head "контейнеры: размер слоя записи + журналов (docker ps -s)"
docker ps -s --format 'table {{.Names}}\t{{.Status}}\t{{.Size}}' 2>/dev/null || true

# Кэш-маунты: единственный переносимый способ их померить/почистить —
# синтетическая сборка с теми же target (см. edrc_trim_cache_mounts).
if [ -f "$SCRIPT_DIR/compose-lib.sh" ]; then
  # shellcheck source=compose-lib.sh
  source "$SCRIPT_DIR/compose-lib.sh"
  head "кэш-маунты BuildKit (не видны в docker system df / builder prune)"
  if declare -F edrc_trim_cache_mounts >/dev/null 2>&1; then
    if edrc_compose_uses_buildkit; then
      if [ "$WIPE" = "1" ]; then
        say "вычищаю оба кэш-маунта (/app/.next/cache и /root/.npm)…"
        edrc_trim_cache_mounts wipe || true
      else
        edrc_trim_cache_mounts measure || true
      fi
    else
      say "buildx/BuildKit недоступен — сборки идут по запасному Dockerfile без кэш-маунтов: подчищать нечего"
    fi
  else
    say "⚠ в compose-lib.sh нет edrc_trim_cache_mounts — обновите клон"
  fi
else
  say "⚠ $SCRIPT_DIR/compose-lib.sh не найден — кэш-маунты не проверены"
fi

head "резервные копии БД"
for d in "$REPO_ROOT/../backups" "/opt/ed-ring-colony/backups"; do
  [ -d "$d" ] || continue
  say "$d — $(du -sh "$d" 2>/dev/null | cut -f1 || echo '?'):"
  ls -lht "$d"/edrc-db-*.dump "$d"/edrc-before-update-*.dump 2>/dev/null | head -n 12 || true
done

# Релизы Helper не являются Docker-кэшем и не удаляются --wipe. Они лежат
# на том же диске с backup'ами, но в отдельной папке.
for d in "$REPO_ROOT/../backups/uploader-releases" "/opt/ed-ring-colony/backups/uploader-releases"; do
  [ -d "$d" ] || continue
  say "$d — $(du -sh "$d" 2>/dev/null | cut -f1 || echo '?') (релизы Helper, НЕ удалять автоматически)"
done

say ""
if [ "$WIPE" = "1" ]; then
  say "ГОТОВО: кэш-маунты вычищены. Сверьте df выше с состоянием ДО запуска."
else
  say "Это только замер. Вернуть место, если кэш-маунты распухли:"
  say "  bash deploy/docker-disk-report.sh --wipe"
  say "Бюджет на будущее (в .env.production): UPDATE_NEXT_CACHE_KEEP=2g, UPDATE_NPM_CACHE_KEEP=2g"
fi
