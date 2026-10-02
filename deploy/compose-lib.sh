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
#
# Предпочитаем сеть ЖИВОГО `supabase-db`, где контейнер имеет alias `db`.
# Значение из окружения/env-файла принимается только если оно не противоречит
# реальному контейнеру. Раньше старое `SUPABASE_NETWORK=supabase_default`
# безусловно побеждало autodetect: web исправно подключался к существующей, но
# чужой/старой сети, а `db` внутри него всё равно не резолвился. Ещё одна гонка
# была у контейнера с несколькими сетями — Go map в `docker inspect` не имеет
# порядка, и `awk '{print $1}'` иногда выбирал не compose-сеть Supabase.
#
# Порядок: сеть supabase-db с alias `db` → другая сеть этого контейнера →
# проверенное значение SUPABASE_NETWORK → первая сеть с «supabase» в имени.
# Без доступного Docker проверить значение нельзя, поэтому сохраняется прежнее
# поведение: явно заданное имя считается источником истины.
#
# ВАЖНО: скрипты-потребители работают с `set -euo pipefail`, поэтому все
# «обычно пустые» команды защищены `|| true`, а переменные читаются с `:-`.
edrc_detect_supabase_network() {
  local env_file="${1:-}"
  local configured="${SUPABASE_NETWORK:-}" candidate="" db_networks="" alias_networks=""

  if [ -z "$configured" ] && [ -n "$env_file" ] && [ -f "$env_file" ]; then
    configured="$(grep -E '^SUPABASE_NETWORK=' "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
  fi

  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    [ -n "$configured" ] && printf '%s\n' "$configured"
    return 0
  fi

  # Docker DNS публикует service alias отдельно для каждой сети. Если
  # supabase-db подключён к нескольким сетям, нужна именно та, где alias=db.
  alias_networks="$(docker inspect supabase-db --format '{{range $network, $config := .NetworkSettings.Networks}}{{range $config.Aliases}}{{if eq . "db"}}{{$network}}{{"\n"}}{{end}}{{end}}{{end}}' 2>/dev/null || true)"
  db_networks="$(docker inspect supabase-db --format '{{range $network, $config := .NetworkSettings.Networks}}{{$network}}{{"\n"}}{{end}}' 2>/dev/null || true)"

  candidate="$(printf '%s\n' "$alias_networks" | sed '/^$/d' | head -n1 || true)"
  if [ -z "$candidate" ]; then
    candidate="$(printf '%s\n' "$db_networks" | grep -i 'supabase' | head -n1 || true)"
  fi
  if [ -z "$candidate" ]; then
    candidate="$(printf '%s\n' "$db_networks" | sed '/^$/d' | head -n1 || true)"
  fi

  # Явное значение остаётся предпочтительным, только когда alias `db`
  # опубликован именно в этой сети. Если inspect не вернул aliases (старый
  # Docker/нестандартный контейнер), достаточно обычного членства. При явном
  # конфликте alias-сеть живой БД важнее старого значения из env.
  if [ -n "$configured" ] && docker network inspect "$configured" >/dev/null 2>&1; then
    if printf '%s\n' "$alias_networks" | grep -Fxq "$configured"; then
      candidate="$configured"
    elif [ -z "$alias_networks" ] \
      && { [ -z "$db_networks" ] || printf '%s\n' "$db_networks" | grep -Fxq "$configured"; }; then
      candidate="$configured"
    fi
  fi

  if [ -n "$candidate" ] && docker network inspect "$candidate" >/dev/null 2>&1; then
    printf '%s\n' "$candidate"
    return 0
  fi

  # Нет живого supabase-db (например, он кратко перезапускается): используем
  # существующую явно заданную сеть, затем осторожный поиск по имени.
  if [ -n "$configured" ] && docker network inspect "$configured" >/dev/null 2>&1; then
    printf '%s\n' "$configured"
    return 0
  fi
  candidate="$(docker network ls --format '{{.Name}}' 2>/dev/null | grep -i 'supabase' | head -n1 || true)"
  [ -n "$candidate" ] && printf '%s\n' "$candidate"
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
  # compose.supabase-net.yml получает имя через ${SUPABASE_NETWORK}. Autodetect
  # сам по себе недостаточен: при нестандартном имени сети Compose иначе взял
  # бы default `supabase_default`, хотя хелпер только что нашёл правильную сеть.
  # Фиксируем результат в том же env-файле, который все entrypoint'ы передают
  # через --env-file. Это заодно самовосстанавливает старое/ошибочное значение.
  if [ -n "$env_file" ] && [ -f "$env_file" ] && [ -w "$env_file" ]; then
    edrc_persist_env "$env_file" SUPABASE_NETWORK "$network"
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

# edrc_disable_default_attestations — сборки без provenance-аттестаций.
#
# Buildx с версии 0.10 (BuildKit 0.11+) добавляет КАЖДОМУ образу
# provenance-аттестацию (mode=min). Чтобы её записать, в КОНЦЕ сборки — уже
# после «naming to docker.io/library/…» — BuildKit заново идёт в реестр за
# манифестом базового образа («resolving provenance for metadata file»).
# На хостах с нестабильным доступом к Docker Hub именно этот шаг ронял весь
# compose build строкой «failed to solve: DeadlineExceeded: context deadline
# exceeded»: образы к тому моменту полностью собраны и лежат в docker-сторадж,
# но update-project.sh/fail получает код 1 и обновление обрывается.
#
# Практической ценности для этого стека аттестации не имеют — образы не
# пушатся в реестр, а загружаются в локальный Docker той же машины, — поэтому
# по умолчанию выключаем их всем сборкам. Compose v2 вызывает сборку через
# библиотеку buildx, которая читает эту переменную: срабатывает и для
# `docker compose build`, и для `up -d --build`. Явное значение оператора
# (BUILDX_NO_DEFAULT_ATTESTATIONS=0) не перекрываем — аттестации вернутся.
edrc_disable_default_attestations() {
  export BUILDX_NO_DEFAULT_ATTESTATIONS="${BUILDX_NO_DEFAULT_ATTESTATIONS:-1}"
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
  # `--all` matters for repeated --no-cache builds: without it BuildKit may
  # retain intermediate records that are not dangling from the current image.
  # Try the budgeted command directly: probing `--help` first is racy on some
  # Docker wrappers and made the real prune branch silently fall back to the
  # 48-hour filter. Old daemons simply take the compatibility fallback.
  docker builder prune -f --keep-storage "$keep" --all >/dev/null 2>&1 \
    || docker builder prune -f --keep-storage "$keep" >/dev/null 2>&1 \
    || docker builder prune -f --filter until=48h >/dev/null 2>&1 \
    || true

  # Buildx can have builders separate from the legacy `docker builder` view.
  # Prune its active cache too; otherwise switching builders makes the budget
  # above look effective while old builder instances continue to consume disk.
  if docker buildx version >/dev/null 2>&1; then
    docker buildx prune -f --keep-storage "$keep" --all >/dev/null 2>&1 \
      || docker buildx prune -f --keep-storage "$keep" >/dev/null 2>&1 \
      || docker buildx prune -f --filter until=48h >/dev/null 2>&1 \
      || true
  fi
  return 0
}

# edrc_trim_cache_mounts [режим] — кэш-маунты BuildKit в бюджете.
#
# Прод-инцидент «после каждой переборки минус 1–2 ГБ, а кэш сборки минимальный»:
# RUN --mount=type=cache в Dockerfile web создаёт ПОСТОЯННЫЕ кэши (/root/.npm
# и /app/.next/cache), которые `docker builder prune` надёжно не подрезает:
#   • кэш-маунт — ОДНА запись кэша целиком: `--keep-storage` срезает СТАРЕЙШИЕ
#     записи до бюджета, а кэш-маунт, которого касалась последняя сборка,
#     всегда «самый свежий» — он остаётся и растёт без предела;
#   • на части демонов кэш-маунты вообще не показываются в `docker system df`
#     — место «уходит в никуда», при том что видимый кэш сборки чистится.
#
# Начиная с Next 16.3 Turbopack ПИШЕТ персистентный кэш сборки в .next/cache
# (turbopackFileSystemCacheForBuild=true по умолчанию, см. блог Next.js 16.3):
# каждая переборка с изменившимися исходниками дописывает туда новые записи,
# ничего не удаляя, — по гигабайту и больше за прогон.
#
# Единственный переносимый способ добраться до кэш-маунта — синтетическая
# сборка с ТЕМ ЖЕ target: кэш-маунты с одним id (= пути) общие для всех сборок
# одного BuildKit. Крошечный шаг RUN меряет размер и, если тот выше бюджета,
# вычищает содержимое (следующая сборка станет «холодной» по этому кэшу —
# плата за освобожденное место). Лучший effort: недоступный BuildKit/демон —
# no-op, обновление это никогда не валит.
#
# Режимы: auto (бюджеты из UPDATE_NEXT_CACHE_KEEP/UPDATE_NPM_CACHE_KEEP,
# по умолчанию 2g каждый) · measure (только померить и доложить) ·
# wipe (вычистить оба, независимо от размера — для тесного диска и отчёта).
edrc_trim_cache_mounts() {
  local mode="${1:-auto}"
  command -v docker >/dev/null 2>&1 || return 0
  docker info >/dev/null 2>&1 || return 0
  # Кэш-маунты бывают только у BuildKit-сборок: без buildx compose уходит в
  # запасной Dockerfile без --mount — подрезать нечего.
  edrc_compose_uses_buildkit || return 0
  local next_kb npm_kb wipe
  case "$mode" in
    measure) next_kb=0; npm_kb=0; wipe=0 ;;
    wipe)    next_kb=0; npm_kb=0; wipe=1 ;;
    *)       next_kb="$(edrc_size_to_kb "${UPDATE_NEXT_CACHE_KEEP:-2g}")"
             npm_kb="$(edrc_size_to_kb "${UPDATE_NPM_CACHE_KEEP:-2g}")"
             wipe=0 ;;
  esac
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/edrc-cachetrim.XXXXXX" 2>/dev/null)" || return 0
  # Скрипт выполняется ВНУТРИ шага сборки (busybox sh Alpine): $1 — каталог
  # кэш-маунта, EDRC_KEEP_KB — бюджет в КБ (0 = только померить),
  # EDRC_WIPE=1 — вычистить независимо от размера.
  cat > "$tmp/edrc-trim.sh" <<'EDRC_TRIM_SH'
#!/bin/sh
dir="$1"
keep="${EDRC_KEEP_KB:-0}"
kb="$(du -sk "$dir" 2>/dev/null | cut -f1)"
[ -n "$kb" ] || kb=0
printf 'кэш-маунт %s: %s КБ (бюджет %s КБ)\n' "$dir" "$kb" "$keep"
if [ "${EDRC_WIPE:-0}" = "1" ] || { [ "$keep" -gt 0 ] && [ "$kb" -gt "$keep" ]; }; then
  printf '  вычищаю %s — следующая сборка будет «холодной» по этому кэшу\n' "$dir"
  find "$dir" -mindepth 1 -delete 2>/dev/null || rm -rf "$dir"/* 2>/dev/null || true
  kb="$(du -sk "$dir" 2>/dev/null | cut -f1)"
  [ -n "$kb" ] || kb=0
  printf '  после очистки: %s КБ\n' "$kb"
fi
EDRC_TRIM_SH
  # node:22-alpine не тянется из сети: это база всех образов стека, она уже
  # лежит в локальном Docker. Подойдёт любой локальный образ с sh.
  {
    printf 'FROM node:22-alpine\n'
    printf 'COPY edrc-trim.sh /tmp/edrc-trim.sh\n'
    printf 'RUN --mount=type=cache,target=/app/.next/cache EDRC_KEEP_KB=%s EDRC_WIPE=%s sh /tmp/edrc-trim.sh /app/.next/cache\n' "$next_kb" "$wipe"
    printf 'RUN --mount=type=cache,target=/root/.npm EDRC_KEEP_KB=%s EDRC_WIPE=%s sh /tmp/edrc-trim.sh /root/.npm\n' "$npm_kb" "$wipe"
  } > "$tmp/Dockerfile"
  local -a runner=(docker)
  # du/удаление на распухшем кэше — это миллионы файлов: не вешаем обновление
  # из-за застрявшего демона, если timeout доступен.
  command -v timeout >/dev/null 2>&1 && runner=(timeout "${EDRC_CACHE_TRIM_TIMEOUT:-600}" docker)
  # Аттестации выключаем и здесь (см. edrc_disable_default_attestations):
  # лишний поход в Docker Hub в конце даже крошечной сборки умеет ронять её
  # по дедлайну на нестабильном канале.
  if ! BUILDX_NO_DEFAULT_ATTESTATIONS="${BUILDX_NO_DEFAULT_ATTESTATIONS:-1}" \
       DOCKER_BUILDKIT=1 "${runner[@]}" build --rm -f "$tmp/Dockerfile" "$tmp" 2>/dev/null; then
    printf '⚠ не удалось проверить кэш-маунты BuildKit (docker build) — пропускаю\n' >&2
  fi
  rm -rf "$tmp" 2>/dev/null || true
  return 0
}

# edrc_trim_build_cache — ПЕРЕД сборкой: кэш BuildKit в бюджете.
#
# Уборка после переключения контейнеров помогает только успешным прогонам;
# сорвавшиеся сборки (упавший тест, ENOSPC, таймаут) копили кэш без чистки,
# и каждая следующая сборка шла всё дольше: распухший кэш + почти заполненный
# диск — это деградация I/O и самого BuildKit. Подрезка до старта — no-op,
# когда всё в порядке, и спасение, когда накопилось.
# Бюджет кэша адаптивный: при тесном диске держать 8 ГБ кэша — значит
# оставить сборке ползти по остаткам. Если свободного места меньше двойного
# порога (UPDATE_DOCKER_MIN_FREE), кэш подрезается жёстче: несколько лишних
# минут на повторное скачивание пакетов дешевле сорвавшегося обновления.
edrc_trim_build_cache() {
  command -v docker >/dev/null 2>&1 || return 0
  docker info >/dev/null 2>&1 || return 0
  local keep="${UPDATE_DOCKER_CACHE_KEEP:-8g}"
  local tight="${UPDATE_DOCKER_CACHE_KEEP_TIGHT:-2g}"
  local free_kb min_kb mount_mode="auto"
  free_kb="$(edrc_docker_free_kb || true)"
  min_kb="$(edrc_size_to_kb "${UPDATE_DOCKER_MIN_FREE:-4g}")"
  case "$free_kb" in
    ''|*[!0-9]*) : ;;  # место определить не удалось — обычный бюджет
    *)
      if [ "$free_kb" -lt $(( min_kb * 2 )) ]; then
        printf 'свободно %s МБ — подрезаю кэш BuildKit жёстче обычного (до %s вместо %s)\n' \
          $(( free_kb / 1024 )) "$tight" "$keep"
        keep="$tight"
        # Кэш-маунты — самый большой «невидимый» потребитель после серии
        # переборок: при тесном диске вычищаем их целиком, без бюджета.
        mount_mode="wipe"
      fi
      ;;
  esac
  edrc_trim_cache_mounts "$mount_mode"
  edrc_builder_prune "$keep"
  return 0
}

# ── Защита диска и устойчивость сборки ──────────────────────────────
# Порочный круг из прод-инцидента: сорвавшаяся сборка оставляла свой кэш
# BuildKit (docker image prune его не трогает), уборка шла только после
# УСПЕШНОГО обновления, а подрезка перед сборкой хранит самые свежие записи
# — то есть как раз кэш сорвавшихся прогонов. Диск заполнялся, демон
# начинал ползать (передача КИЛОбайт контекста занимала по 20+ секунд),
# и очередная сборка умирала на «failed to solve: DeadlineExceeded: context
# deadline exceeded» около 3-й минуты всего цикла. Ниже: страж свободного
# места и обёртка сборки с немедленной уборкой остатков и авто-повтором.

# edrc_size_to_kb 8g|512m|4096k|1048576 — размер в КБ (сравнения места).
edrc_size_to_kb() {
  local v="${1:-0}"
  case "$v" in
    *g|*G) echo $(( ${v%[gG]} * 1024 * 1024 )) ;;
    *m|*M) echo $(( ${v%[mM]} * 1024 )) ;;
    *k|*K) echo $(( ${v%[kK]} )) ;;
    *)     echo $(( ${v:-0} )) ;;
  esac
}

# edrc_docker_free_kb — свободно КБ на ФС, где лежит корень Docker.
# Пустой вывод (при невозможности узнать) НЕ должен мешать сборке: вызывающий
# код трактует его как «пропустить проверку», а не как «диск пуст».
edrc_docker_free_kb() {
  command -v docker >/dev/null 2>&1 || return 0
  local root
  root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
  [ -n "$root" ] || root="/var/lib/docker"
  df -Pk "$root" 2>/dev/null | awk 'NR==2 {print $4}'
}

# edrc_ensure_disk_for_build [min_free] — место под сборку или понятный отказ.
#
# Проверяет фактически свободное место на диске Docker против порога
# UPDATE_DOCKER_MIN_FREE (по умолчанию 4g — web-образ с node_modules и
# промежуточными слоями легко съедает несколько гигабайт рабочего пространца).
# При дефиците сначала САМА запускает уборку (кэш выше бюджета, висячие
# образы, остановленные контейнеры) и перепроверяет; если места всё равно
# мало — возвращает 1 с понятным сообщением вместо того, чтобы сборка час
# ползала по забитому диску и умерла безликим «DeadlineExceeded». 2>&1
# склейка отсутствует: в update-project.sh сообщение попадает в журнал
# стадии и извлекается в `error` как настоящая причина.
edrc_ensure_disk_for_build() {
  local min_free="${1:-${UPDATE_DOCKER_MIN_FREE:-4g}}"
  local min_kb free_kb
  command -v docker >/dev/null 2>&1 || return 0
  docker info >/dev/null 2>&1 || return 0
  min_kb="$(edrc_size_to_kb "$min_free")"
  free_kb="$(edrc_docker_free_kb || true)"
  case "$free_kb" in
    *[!0-9]*|"") return 0 ;;  # определить не удалось — сборку не блокируем
  esac
  if [ "$free_kb" -ge "$min_kb" ]; then
    printf 'свободно под Docker: %s МБ (нужно минимум %s МБ)\n' \
      $(( free_kb / 1024 )) $(( min_kb / 1024 ))
    return 0
  fi
  printf '⚠ свободно под Docker всего %s МБ (порог %s МБ) — выполняю уборку и перепроверяю…\n' \
    $(( free_kb / 1024 )) $(( min_kb / 1024 )) >&2
  edrc_cleanup_docker_disk >/dev/null 2>&1 || true
  free_kb="$(edrc_docker_free_kb || true)"
  case "$free_kb" in
    *[!0-9]*|"") return 0 ;;
  esac
  if [ "$free_kb" -ge "$min_kb" ]; then
    printf '✓ после уборки свободно %s МБ — продолжаю\n' $(( free_kb / 1024 ))
    return 0
  fi
  # Токен «no space» в фатальной строке — не для людей, а для run_step
  # update-project.sh: он вытаскивает причину сбоя grep'ом по латинским
  # токенам, кириллическое «ОШИБКА» в C-локали не сворачивается регистром
  # и в error уезжала бы безликая подсказка вместо «не хватает места».
  printf 'ОШИБКА: не хватает места для сборки (no space): свободно %s МБ при пороге %s МБ даже после уборки кэша\n' \
    $(( free_kb / 1024 )) $(( min_kb / 1024 )) >&2
  printf '       Разберите диск вручную: df -h · docker system df -v · docker builder prune -af\n' >&2
  printf '       (подробности — DEPLOY.md, «failed to solve: DeadlineExceeded»)\n' >&2
  return 1
}

# edrc_build_with_retry команда... — сборка с немедленной уборкой остатков
# и автоповтором. Контракт ответа на «почему диск опять съеден»:
#
#   • диск проверяется ДО старта (см. выше);
#   • остатки КАЖДОЙ сорвавшейся попытки вычищаются сразу же (раньше — только
#     после успешного обновления: кэш failed-сборок рос неограниченно);
#   • после уборки сборка повторяется до UPDATE_BUILD_RETRIES раз (по умолчанию
#     1): кратковременный сбой сети/демона больше не требует ручного повтора
#     всего обновления, ещё час сборки не теряется на второй клик.
#
# Постоянная ошибка (упавший тест, синтаксис) возвращается последним кодом —
# вызывающий скрипт (run_step / set -e) прервётся как раньше, но кэш к этому
# моменту уже подчищен, а случайная сетевая заминка пережита.
edrc_build_with_retry() {
  local retries="${UPDATE_BUILD_RETRIES:-2}"
  local delay="${UPDATE_BUILD_RETRY_DELAY:-20}"
  local attempt=1 max_attempts code=0
  case "$retries" in
    *[!0-9]*|"") retries=2 ;;
  esac
  case "$delay" in
    *[!0-9]*|"") delay=20 ;;
  esac
  max_attempts=$(( retries + 1 ))
  edrc_ensure_disk_for_build || return 1
  while :; do
    # Код ловится в else: `$?` после `if …; fi` — статус составного if (0),
    # а не упавшей команды — ловушка, съевшая причину в первой редакции.
    if "$@"; then
      return 0
    else
      code=$?
    fi
    # Ход прогонов (предупреждение + ретрай) — в stdout: так сообщения видны
    # и в журнале update-project.sh, и в консоли rebuild-now.sh.
    printf '⚠ сборка не удалась (код %s, попытка %s из %s) — убираю её остатки\n' "$code" "$attempt" "$max_attempts"
    edrc_cleanup_docker_disk || true
    if [ "$attempt" -ge "$max_attempts" ]; then
      printf 'ОШИБКА: сборка не удалась после %s попыток (последний код %s)\n' "$max_attempts" "$code" >&2
      return "$code"
    fi
    attempt=$((attempt + 1))
    # Пауза перед повтором. Типовой срыв — «DeadlineExceeded» на перегруженном
    # демоне: сразу после падения он ещё доразгребает прерванную сборку
    # (распаковка слоёв, уборка снапшотов), и мгновенный повтор попадает
    # ровно в ту же яму. Двадцати секунд хватает, чтобы I/O успокоился.
    if [ "$delay" -gt 0 ]; then
      printf '⏸ жду %s с, чтобы демон Docker разгрёб остатки прерванной сборки…\n' "$delay"
      sleep "$delay" || true
    fi
    printf '↻ пробую собрать ещё раз (попытка %s из %s) после уборки…\n' "$attempt" "$max_attempts"
    edrc_ensure_disk_for_build || return 1
  done
}

# edrc_build_order svc… — порядок сборки: лёгкие образы первыми, web последним.
#
# web — единственный тяжёлый таргет (npm ci, тесты, next build). Остальные —
# тонкие обёртки над node:22-alpine, которые почти всегда собираются из кэша
# за секунды. Если сначала быстро закрыть их, тяжёлая сборка получает машину
# в своё распоряжение, а не делит с ними диск.
edrc_build_order() {
  local svc light="" heavy=""
  for svc in "$@"; do
    case "$svc" in
      web|*-web) heavy="$heavy $svc" ;;
      *)         light="$light $svc" ;;
    esac
  done
  printf '%s' "${light# }"
  [ -n "$light" ] && [ -n "$heavy" ] && printf ' '
  printf '%s\n' "${heavy# }"
}

# edrc_build_each команда… -- сервис… — собрать сервисы ПО ОДНОМУ.
#
# Прод-инцидент: `compose build web jobs monitor-agent update-agent` запускает
# все четыре таргета ОДНОВРЕМЕННО. На маленьком VPS они дерутся за один диск,
# и даже полностью закэшированные образы ползут: «load build definition»
# (7 КБ!) — 43 с, «load .dockerignore» — 45 с. У gRPC-вызовов BuildKit есть
# собственный дедлайн, поэтому первым падает не тяжёлый web, а случайный
# лёгкий таргет, уже выгрузивший свой образ:
#   «target update-agent: failed to solve: DeadlineExceeded» через минуту
#   после его же «exporting to image … DONE».
# Симптом выглядел как поломка агента обновления, хотя ломалась очередь I/O.
#
# Поэтому сборка разведена по отдельным вызовам: параллелизма между таргетами
# нет, каждый сервис получает свой авто-повтор (падение web больше не заставляет
# пересобирать агентов), а в журнале видно, на каком именно образе встало.
# Общий прогон становится чуть длиннее на здоровой машине и НАМНОГО надёжнее
# на нагруженной.
edrc_build_each() {
  local -a prefix=() services=()
  local seen_separator=0 arg svc code=0
  for arg in "$@"; do
    if [ "$seen_separator" = 0 ] && [ "$arg" = "--" ]; then
      seen_separator=1
      continue
    fi
    if [ "$seen_separator" = 0 ]; then prefix+=("$arg"); else services+=("$arg"); fi
  done
  # Разделителя нет или список сервисов пуст — ведём себя как раньше
  # (compose сам решит, что собирать).
  if [ "${#services[@]}" -eq 0 ]; then
    edrc_build_with_retry "${prefix[@]}"
    return $?
  fi
  local ordered
  ordered="$(edrc_build_order "${services[@]}")"
  for svc in $ordered; do
    printf '── собираю образ: %s ──\n' "$svc"
    # Код берётся из `|| code=$?`, а НЕ из `if ! …; then code=$?`: во втором
    # случае `$?` — статус инвертированного условия, то есть всегда 0, и
    # упавшая сборка «успешно» доезжала до переключения контейнеров.
    code=0
    edrc_build_with_retry "${prefix[@]}" "$svc" || code=$?
    if [ "$code" != 0 ]; then
      printf 'ОШИБКА: не собрался образ %s (код %s)\n' "$svc" "$code" >&2
      return "$code"
    fi
  done
  return 0
}

# ── Переключение контейнеров: конфликт имени и его цена в гигабайтах ──
#
# Прод-инцидент (журнал обновления):
#   Container src-web-1 Stopping
#   Container 548bf7698162_src-web-1 Recreate
#   Error response from daemon: Error when allocating new name: Conflict.
#   The container name "/src-web-1" is already in use by container "548bf76…"
#   Container src-web-1 Error Error while Stopping
#
# Что произошло. `compose up -d` пересоздаёт контейнер в три приёма:
# остановить старый → переименовать его в «<id>_<имя>» → создать новый под
# освободившимся именем. У docker stop есть таймаут (по умолчанию 10 с).
# На нагруженном диске web не успевает завершиться, compose уходит в
# переименование/создание, пока демон ещё «Stopping», rename не доводится
# до конца — и создание нового контейнера падает на занятом имени.
# Обновление обрывается кодом 1 УЖЕ ПОСЛЕ успешной часовой сборки.
#
# Почему от этого тает диск. После срыва на хосте остаётся СТАРЫЙ контейнер
# (часто под именем «<id>_src-web-1»), и он держит ссылку на СТАРЫЙ образ.
# Поэтому `docker image prune -f` не может удалить предыдущий src-web:
# образ не «висячий», он используется контейнером. Каждая такая переборка
# добавляет на диск полный новый образ (у этого проекта ~1.5–3 ГБ) плюс
# свежие записи кэша BuildKit — и ни один каталог проекта при этом не
# «толстеет»: всё лежит в /var/lib/docker/overlay2 отдельными слоями.
# Отсюда и «5–10 ГБ за проход, а папок таких нет».
#
# Лечение (ниже): переключать контейнеры с ЯВНЫМ длинным стопом, подчищать
# остатки прошлых срывов, распознавать конфликт имени и повторять переключение,
# сняв конфликтующий контейнер.

# edrc_compose_stop_timeout — сколько ждать корректного завершения (сек).
edrc_compose_stop_timeout() {
  local t="${UPDATE_STOP_TIMEOUT:-120}"
  case "$t" in
    ''|*[!0-9]*) t=120 ;;
  esac
  printf '%s\n' "$t"
}

# edrc_stale_switch_containers — контейнеры-остатки переименования compose.
#
# Compose переименовывает заменяемый контейнер в «<12 hex>_<исходное имя>».
# В норме такой контейнер живёт секунды и удаляется; после сорвавшегося
# переключения он остаётся навсегда — вместе со слоем записи и ссылкой на
# старый образ. Признак надёжный: обычные имена compose так не выглядят.
edrc_stale_switch_containers() {
  command -v docker >/dev/null 2>&1 || return 0
  docker ps -a --format '{{.Names}}' 2>/dev/null \
    | grep -E '^[0-9a-f]{8,64}_.+' || true
}

# edrc_remove_stale_containers [--force] — снять остатки прошлых переключений.
#
# Без --force удаляются только ОСТАНОВЛЕННЫЕ остатки: запущенный остаток —
# это сайт, который сейчас обслуживает пользователей (новый контейнер не
# создался), и в фоновой уборке его трогать нельзя. С --force (перед самим
# переключением, когда контейнер всё равно будет пересоздан) снимаются и
# работающие.
edrc_remove_stale_containers() {
  local force=0
  [ "${1:-}" = "--force" ] && force=1
  command -v docker >/dev/null 2>&1 || return 0
  docker info >/dev/null 2>&1 || return 0
  local names name state removed=0
  names="$(edrc_stale_switch_containers)"
  [ -n "$names" ] || return 0
  for name in $names; do
    state="$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null || echo false)"
    if [ "$state" = "true" ] && [ "$force" != "1" ]; then
      printf '⚠ остаток прошлого переключения %s ещё работает — сниму его при следующем переключении\n' "$name"
      continue
    fi
    printf 'убираю остаток прошлого переключения: %s (он держал старый образ и мешал освободить диск)\n' "$name"
    docker rm -f "$name" >/dev/null 2>&1 || true
    removed=$((removed + 1))
  done
  [ "$removed" -gt 0 ] && printf 'снято остатков переключения: %s\n' "$removed"
  return 0
}

# edrc_resolve_name_conflicts FILE — снять контейнеры из ошибки «name … in use».
#
# Из строки демона достаём и имя («/src-web-1»), и id занявшего контейнера:
# в разных версиях Docker остаётся то одно, то другое, поэтому снимаем оба.
edrc_resolve_name_conflicts() {
  local log="${1:-}"
  [ -n "$log" ] && [ -f "$log" ] || return 0
  command -v docker >/dev/null 2>&1 || return 0
  local tokens token fixed=0
  # sed: срезать всё ДО первой кавычки (жадное .*" съело бы и само значение),
  # затем закрывающую кавычку и ведущий слэш docker-имени («/src-web-1»).
  tokens="$(grep -aoE 'container name "/[^"]+"|by container "[0-9a-f]{8,64}"' "$log" 2>/dev/null \
    | sed -e 's/^[^"]*"//' -e 's/"$//' -e 's#^/##' | sort -u || true)"
  [ -n "$tokens" ] || return 1
  for token in $tokens; do
    docker inspect "$token" >/dev/null 2>&1 || continue
    printf 'конфликт имени контейнера: снимаю %s\n' "$token"
    docker rm -f "$token" >/dev/null 2>&1 || true
    fixed=$((fixed + 1))
  done
  [ "$fixed" -gt 0 ] || return 1
  return 0
}

# edrc_compose_switch compose <аргументы compose> -- сервис… — переключение,
# которое не ломается о гонку «Stopping ↔ Recreate».
#
# Порядок:
#   1. снять остатки прошлых срывов (иначе имя занято ещё до старта);
#   2. ЯВНО остановить сервисы с большим таймаутом (UPDATE_STOP_TIMEOUT,
#      по умолчанию 120 с вместо десяти секунд по умолчанию у compose) —
#      когда контейнер уже остановлен, гонки переименования не существует;
#   3. выполнить `up -d --no-build …` как раньше;
#   4. если он всё-таки упал по конфликту имени/«Error while Stopping» —
#      снять конфликтующий контейнер и повторить (UPDATE_SWITCH_RETRIES,
#      по умолчанию 2 повтора).
#
# Вывод compose идёт и в журнал (как прежде), и в файл — по нему распознаётся
# конфликт. Любая другая ошибка возвращается вызывающему без изменений.
edrc_compose_switch() {
  local -a prefix=() services=()
  local seen=0 arg
  for arg in "$@"; do
    if [ "$seen" = 0 ] && [ "$arg" = "--" ]; then seen=1; continue; fi
    if [ "$seen" = 0 ]; then prefix+=("$arg"); else services+=("$arg"); fi
  done
  local retries="${UPDATE_SWITCH_RETRIES:-2}"
  case "$retries" in
    ''|*[!0-9]*) retries=2 ;;
  esac
  local stop_timeout log attempt=1 code=0
  stop_timeout="$(edrc_compose_stop_timeout)"

  edrc_remove_stale_containers --force || true

  if [ "${#services[@]}" -gt 0 ] && [ "${UPDATE_PRESTOP:-1}" = "1" ]; then
    printf 'останавливаю сервисы перед переключением (таймаут %s с): %s\n' "$stop_timeout" "${services[*]}"
    "${prefix[@]}" stop -t "$stop_timeout" "${services[@]}" 2>&1 || \
      printf '⚠ штатная остановка не удалась — продолжаю, конфликт имени будет разобран отдельно\n'
  fi

  log="$(mktemp "${TMPDIR:-/tmp}/edrc-switch.XXXXXX" 2>/dev/null || echo "/tmp/edrc-switch.log")"
  # errexit снимаем на время шага и возвращаем как было: падение compose здесь
  # разбирается, а не обрывает вызывающий скрипт. `|| true` после конвейера для
  # этого НЕ годится — PIPESTATUS тогда относится к `true`, и сорвавшееся
  # переключение выглядело бы успешным.
  local errexit_was=0
  case "$-" in *e*) errexit_was=1 ;; esac
  while :; do
    code=0
    set +e
    "${prefix[@]}" up -d --no-build "${services[@]}" 2>&1 | tee "$log"
    code="${PIPESTATUS[0]}"
    [ "$errexit_was" = "1" ] && set -e
    if [ "$code" = "0" ]; then
      rm -f "$log" 2>/dev/null || true
      # Остатки переименования после УСПЕШНОГО переключения — чистый мусор:
      # пока они есть, старый образ нельзя удалить, и диск не возвращается.
      edrc_remove_stale_containers --force || true
      return 0
    fi
    if [ "$attempt" -gt "$retries" ]; then break; fi
    if grep -qaiE 'already in use|Error when allocating new name|Error while Stopping|Conflict' "$log" 2>/dev/null; then
      printf '⚠ переключение сорвалось конфликтом имени контейнера (попытка %s) — разбираю и повторяю\n' "$attempt"
      edrc_resolve_name_conflicts "$log" || true
      edrc_remove_stale_containers --force || true
      sleep "${UPDATE_SWITCH_RETRY_DELAY:-5}" || true
      attempt=$((attempt + 1))
      continue
    fi
    break
  done
  rm -f "$log" 2>/dev/null || true
  return "$code"
}

# edrc_prune_anonymous_volumes — удалить ТОЛЬКО безымянные тома-сироты.
#
# `docker volume prune -f` сносит все неиспользуемые тома, включая именованные
# (galaxy-dump и uploader-store этого проекта специально оставлены для
# миграций — их терять нельзя). Поэтому удаляются лишь анонимные тома
# (имя — 64 hex-символа): их плодит каждое пересоздание контейнера с
# VOLUME-каталогом, и в `du` по проекту они не видны — лежат в
# /var/lib/docker/volumes.
edrc_prune_anonymous_volumes() {
  command -v docker >/dev/null 2>&1 || return 0
  docker info >/dev/null 2>&1 || return 0
  local vols v removed=0
  vols="$(docker volume ls -qf dangling=true 2>/dev/null | grep -E '^[0-9a-f]{64}$' || true)"
  [ -n "$vols" ] || return 0
  for v in $vols; do
    docker volume rm "$v" >/dev/null 2>&1 && removed=$((removed + 1)) || true
  done
  [ "$removed" -gt 0 ] && printf 'удалено анонимных томов-сирот: %s\n' "$removed"
  return 0
}

# edrc_cleanup_docker_disk [cache_keep] — ПОСЛЕ сборки: убрать то, что копит каждая сборка.
#
# Источник «диск тает после каждого обновления, даже при правке в 3 КБ»:
#   • кэш BuildKit. Любое изменение исходников инвалидирует слой COPY,
#     и сборка оставляет НОВЫЙ кэш npm ci / next build (гигабайты), а кэш
#     прошлых прогонов никто не удалял — `docker image prune` его не трогает;
#   • кэш-МАУНТЫ BuildKit (/root/.npm и /app/.next/cache): их не подрезает
#     даже `docker builder prune` (см. edrc_trim_cache_mounts), а с Next 16.3
#     Turbopack дописывает в .next/cache персистентный кэш каждой сборки —
#     это и был источник «по 1–2 ГБ в никуда при минимальном кэше сборки»;
#   • висячие образы и остановленные контейнеры (чистились и раньше);
#   • несрезанные слои от --no-cache пересборок.
#
# Итоговая таблица docker system df и строка df по корню Docker печатаются
# в журнал.
edrc_cleanup_docker_disk() {
  command -v docker >/dev/null 2>&1 || return 0
  docker info >/dev/null 2>&1 || return 0

  # Остатки сорвавшихся переключений («<id>_src-web-1») удаляем ПЕРВЫМИ:
  # пока такой контейнер существует, он ссылается на предыдущий образ web,
  # и `docker image prune` не может его забрать — именно так на диске
  # накапливались полные образы по 1.5–3 ГБ за проход при «пустых» папках.
  # Работающий остаток (сайт сейчас живёт на нём) не трогаем: его снимет
  # следующее переключение.
  edrc_remove_stale_containers || true
  docker container prune -f >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
  # Анонимные тома-сироты: невидимы в du по проекту, растут с пересозданиями.
  edrc_prune_anonymous_volumes || true
  # Кэш-маунты (/root/.npm, /app/.next/cache) — отдельный, невидимый для
  # `docker builder prune` потребитель: с Next 16.3 Turbopack дописывает
  # туда персистентный кэш КАЖДОЙ сборки. Держим их в собственном бюджете
  # (UPDATE_NEXT_CACHE_KEEP / UPDATE_NPM_CACHE_KEEP, по умолчанию 2g).
  edrc_trim_cache_mounts auto || true
  edrc_builder_prune

  # Краткий отчёт оператору: что именно занимает диск после уборки.
  docker system df 2>/dev/null | head -n 8 || true
  local root
  root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
  [ -n "$root" ] || root="/var/lib/docker"
  df -h "$root" 2>/dev/null | tail -n 1 || true
  return 0
}
