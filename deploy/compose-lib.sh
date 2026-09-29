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
  local free_kb min_kb
  free_kb="$(edrc_docker_free_kb || true)"
  min_kb="$(edrc_size_to_kb "${UPDATE_DOCKER_MIN_FREE:-4g}")"
  case "$free_kb" in
    ''|*[!0-9]*) : ;;  # место определить не удалось — обычный бюджет
    *)
      if [ "$free_kb" -lt $(( min_kb * 2 )) ]; then
        printf 'свободно %s МБ — подрезаю кэш BuildKit жёстче обычного (до %s вместо %s)\n' \
          $(( free_kb / 1024 )) "$tight" "$keep"
        keep="$tight"
      fi
      ;;
  esac
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
