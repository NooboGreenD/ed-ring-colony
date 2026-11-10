#!/bin/sh
# ══════════════════════════════════════════════════════════════════════════
# Страж кэша сборки Turbopack (выполняется внутри слоя builder образа web).
#
# Зачем. С Next 16.3 Turbopack пишет персистентный кэш сборки в `.next/cache`,
# а Dockerfile держит этот каталог в кэш-маунте BuildKit — он переживает
# ЛЮБУЮ пересборку, включая `--no-cache`, и переживает смену версии Next.
# Записи чужой версии Turbopack читает как свои, ссылается на задачи, которых
# уже нет, и сборка умирает ещё до разбора кода:
#
#   Error [TurbopackInternalError]: read_task_output: task TaskId 7 no longer
#   exists (it was garbage collected). The reading task holds a stale
#   reference to it and is expected to be dropped by its parent.
#
# Ретраи не помогают: они попадают в тот же отравленный кэш. Этот шаг
# сравнивает версию Next с маркером рядом с кэшем и вычищает кэш ДО сборки,
# если версия сменилась. `NEXT_BUILD_CACHE=off` выключает персистентный кэш
# совсем (каждая сборка холодная) — крайняя мера для отравленного кэша.
#
# Использование (из Dockerfile):
#   RUN --mount=type=cache,target=/app/.next/cache sh ./deploy/docker-next-cache-guard.sh
# ══════════════════════════════════════════════════════════════════════════
set -e

cache="${1:-/app/.next/cache}"
mode="${NEXT_BUILD_CACHE:-on}"
marker_file="$cache/.edrc-next-version"

# Версия Next — из установленных зависимостей, а не из package.json: образ
# собирается ровно с тем, что поставил `npm ci` (диапазоны и ^ тут не врут).
version="$(node -p 'require("./node_modules/next/package.json").version' 2>/dev/null || true)"
if [ -z "$version" ]; then
  echo "страж кэша: версия Next не определена — кэш не трогаю" >&2
  exit 0
fi

marker="$(cat "$marker_file" 2>/dev/null || true)"

if [ "$mode" = "off" ]; then
  reason="NEXT_BUILD_CACHE=off"
elif [ "$marker" != "$version" ]; then
  reason="версия Next: \"${marker:-пусто}\" → \"$version\""
else
  echo "кэш Turbopack: версия $version совпадает с маркером — оставляю"
  exit 0
fi

echo "кэш Turbopack: чищу (${reason})"
find "$cache" -mindepth 1 -delete 2>/dev/null || rm -rf "$cache"/* 2>/dev/null || true
printf '%s' "$version" > "$marker_file" 2>/dev/null || true
