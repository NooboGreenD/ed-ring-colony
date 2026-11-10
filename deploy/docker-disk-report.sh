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
#   • ОСТАТКИ СОРВАВШИХСЯ ПЕРЕКЛЮЧЕНИЙ — контейнеры вида «<id>_src-web-1».
#     Их оставляет `up -d`, упавший на «Error when allocating new name:
#     Conflict». Пока они живы, предыдущий образ web не удаляется никаким
#     prune — каждая переборка прибавляет к диску целый образ (1.5–3 ГБ);
#   • образы, висячие образы, именованные и анонимные тома;
#   • УДАЛЁННЫЕ, НО ОТКРЫТЫЕ файлы (их место считает df и не видит du);
#   • файлы, СПРЯТАННЫЕ ПОД ТОЧКАМИ МОНТИРОВАНИЯ (данные записаны до того,
#     как диск был смонтирован поверх каталога, — классические «сотни ГБ,
#     которых нет ни в одной папке»);
#   • сколько занимают резервные копии БД (перед обновлениями и ручные).
#
# --wipe-next вычищает ТОЛЬКО кэш сборки Next (.next/cache; npm-кэш остаётся) —
# это лечение «отравленного» кэша Turbopack: сборка падает с
# TurbopackInternalError ещё до разбора кода, а повторы попадают в тот же кэш.
#
# --wipe вычищает кэш-маунты целиком (edrc_trim_cache_mounts wipe), снимает
# ОСТАНОВЛЕННЫЕ остатки переключений, забирает освободившиеся висячие образы
# и анонимные тома-сироты. Именованные тома (galaxy-dump, uploader-store) и
# релизы Helper не трогаются никогда.
# ─────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WIPE=0
WIPE_NEXT=0
case "${1:-}" in
  --wipe) WIPE=1 ;;
  --wipe-next) WIPE_NEXT=1 ;;
esac

say()  { printf '%s\n' "$*"; }
# ВАЖНО: функция называется section, а не head — одноимённая функция
# перекрывала бы системный /usr/bin/head, и каждый `| head -n 20` в этом
# же скрипте печатал бы заголовок вместо усечения вывода.
section() { printf '\n── %s ──\n' "$*"; }

command -v docker >/dev/null 2>&1 || { echo "ОШИБКА: docker не найден"; exit 1; }
docker info >/dev/null 2>&1 || { echo "ОШИБКА: демон Docker не отвечает"; exit 1; }

DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
[ -n "$DOCKER_ROOT" ] || DOCKER_ROOT="/var/lib/docker"

section "свободное место"
df -h / "$DOCKER_ROOT" 2>/dev/null || df -h / || true

section "docker system df (как это видит демон)"
docker system df 2>/dev/null || true

# Итоговая строка `docker system df` прячет виновника: том на 60 ГБ и том на
# 300 МБ дают одну цифру. `-v` показывает каждый том и каждый образ отдельно —
# именно здесь видно базу Supabase, Storage и всё, что растёт само.
section "docker system df -v (по томам и образам — кто именно занял место)"
docker system df -v 2>/dev/null || say "⚠ демон не отдал подробную раскладку"

section "строители buildx (кэш может жить не только в default)"
docker buildx ls 2>/dev/null || true

section "du по $DOCKER_ROOT (нужен root; это то, что реально на диске)"
if [ -r "$DOCKER_ROOT" ]; then
  du -sh "$DOCKER_ROOT"/* 2>/dev/null | sort -h || true
else
  say "⚠ нет прав на чтение $DOCKER_ROOT — запустите через sudo, чтобы увидеть раскладку"
fi

section "контейнеры: размер слоя записи + журналов (docker ps -s)"
docker ps -as --format 'table {{.Names}}\t{{.Status}}\t{{.Size}}' 2>/dev/null || true

# ── Журналы контейнеров ─────────────────────────────────────────────
# json-file без `max-size` не подрезается ничем: файл в
# /var/lib/docker/containers/<id>/<id>-json.log растёт, пока живёт контейнер.
# В нашем docker-compose.yml лимиты есть у web/jobs/monitor-agent/update-agent,
# но стек Supabase живёт своим compose — там их может не быть вовсе.
section "журналы контейнеров (/var/lib/docker/containers, топ по размеру)"
if [ "$(id -u)" = "0" ] && [ -d "$DOCKER_ROOT/containers" ]; then
  LOGS_TOTAL="$(du -sm "$DOCKER_ROOT/containers" 2>/dev/null | cut -f1)"
  say "всего: ${LOGS_TOTAL:-?} МБ"
  du -sh "$DOCKER_ROOT"/containers/*/*-json.log 2>/dev/null | sort -h | tail -n 10 || true
else
  say "⚠ нужен root, чтобы прочитать $DOCKER_ROOT/containers"
fi

UNBOUNDED="$(docker inspect --format '{{.Name}}|{{.HostConfig.LogConfig.Type}}|{{index .HostConfig.LogConfig.Config "max-size"}}' $(docker ps -aq) 2>/dev/null \
  | awk -F'|' '($2 == "json-file" || $2 == "") && $3 == "" { sub(/^\//, "", $1); print $1 }')"
if [ -n "$UNBOUNDED" ]; then
  say ""
  say "⚠ без ротации (лог растёт, пока живёт контейнер):"
  printf '%s\n' "$UNBOUNDED" | head -n 12 | sed 's/^/  /'
  say "  Лечится лимитом в compose сервиса (max-size/max-file) либо разово:"
  say "  truncate -s 0 \$(docker inspect -f '{{.LogPath}}' <контейнер>) — только у остановленного"
else
  say ""
  say "у всех работающих контейнеров журналы подрезаны (max-size задан)"
fi

# ── Остатки сорвавшихся переключений ────────────────────────────────
# «<12 hex>_src-web-1» — переименованный compose'ом старый контейнер. Если
# переключение сорвалось («Error when allocating new name: Conflict»), он
# остаётся на хосте и ДЕРЖИТ предыдущий образ web: docker image prune не
# может его удалить, и каждая переборка прибавляет к диску целый образ.
section "остатки переключений контейнеров (главный скрытый пожиратель места)"
STALE="$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E '^[0-9a-f]{8,64}_.+' || true)"
if [ -n "$STALE" ]; then
  docker ps -as --filter "name=^[0-9a-f]" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Size}}' 2>/dev/null \
    | grep -E '^NAMES|^[0-9a-f]{8,64}_' || printf '%s\n' "$STALE"
  say ""
  say "Эти контейнеры — мусор прошлых обновлений. Пока они есть, старые образы"
  say "не удаляются. Снять: docker rm -f <имя> (сайт работает на обычном src-web-1)."
else
  say "остатков нет — переключения проходили чисто"
fi

section "образы: что занято и что можно освободить"
docker images --format 'table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}' 2>/dev/null \
  | head -n 20 || true
DANGLING="$(docker images -qf dangling=true 2>/dev/null | wc -l | tr -d ' ')"
say "висячих (<none>) образов: ${DANGLING:-0} — их держат либо остатки контейнеров выше, либо кэш"

section "тома: именованные (беречь) и анонимные сироты (можно удалять)"
docker volume ls --format 'table {{.Name}}\t{{.Driver}}' 2>/dev/null | head -n 20 || true
ANON="$(docker volume ls -qf dangling=true 2>/dev/null | grep -cE '^[0-9a-f]{64}$' || true)"
say "анонимных томов-сирот: ${ANON:-0} (их чистит edrc_prune_anonymous_volumes при обновлении;"
say "обычный docker volume prune НЕ применять — он снесёт и galaxy-dump/uploader-store)"

# ── Отдельный стек Supabase ──────────────────────────────────────────
# ~10 контейнеров (db, kong, auth, rest, realtime, storage, studio…) со своими
# томами и журналами. В наш docker-compose они не входят, наш `--wipe` их не
# трогает — а база и Storage растут сами по себе.
section "стек Supabase (отдельный compose, вне этого репозитория)"
STACK_DIR="${SUPABASE_STACK_DIR:-/opt/supabase}"
if [ -d "$STACK_DIR" ]; then
  say "$STACK_DIR — $(du -sh "$STACK_DIR" 2>/dev/null | cut -f1 || echo '?')"
else
  say "каталог $STACK_DIR не найден (если стек в другом месте — SUPABASE_STACK_DIR=<путь>)"
fi
docker ps -a --format '{{.Names}}|{{.Status}}|{{.Size}}' 2>/dev/null \
  | awk -F'|' '$1 ~ /supabase/ { printf "  %-28s %-40s %s\n", $1, $2, $3 }' || true
SUPA_VOLS="$(docker volume ls -q 2>/dev/null | grep -c 'supabase' || true)"
say "томов со «supabase» в имени: ${SUPA_VOLS:-0} (их размеры — в разделе docker system df -v)"

# bind-монтирования контейнеров: дампы Spansh (~6 ГиБ каждый), релизы Helper,
# данные стека. Это хостовые каталоги, и в `du` по проекту их не видно.
section "данные на хосте: bind-монтирования контейнеров"
docker ps -aq 2>/dev/null | while read -r id; do
  docker inspect --format '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{"\n"}}{{end}}{{end}}' "$id" 2>/dev/null
done | sort -u | while read -r src; do
  [ -n "$src" ] && [ -d "$src" ] || continue
  printf '  %-8s %s\n' "$(du -sh "$src" 2>/dev/null | cut -f1 || echo '?')" "$src"
done

# ── «Место занято, а каталогов таких нет» ───────────────────────────
# Две классические причины, которых не видно ни в du по проекту, ни в
# docker system df. Обе дают ровно описанный симптом.
section "удалённые, но ещё открытые файлы (df считает, du — нет)"
if [ "$(id -u)" = "0" ]; then
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP +L1 2>/dev/null | awk 'NR==1 || $NF ~ /deleted|\(deleted\)/ || $5=="REG"' | head -n 20 || true
  else
    # Без lsof: обход /proc — ищем ссылки fd на удалённые файлы и их размер.
    total=0
    for fd in /proc/[0-9]*/fd/*; do
      target="$(readlink "$fd" 2>/dev/null || true)"
      case "$target" in
        *"(deleted)")
          sz="$(stat -L -c %s "$fd" 2>/dev/null || echo 0)"
          [ "${sz:-0}" -gt $((50 * 1024 * 1024)) ] && \
            printf '  %s МБ — %s (pid %s)\n' "$((sz / 1024 / 1024))" "${target% (deleted)}" "$(echo "$fd" | cut -d/ -f3)"
          total=$((total + ${sz:-0}))
          ;;
      esac
    done
    printf 'итого удалённых, но открытых файлов: %s МБ\n' "$((total / 1024 / 1024))"
    say "если здесь гигабайты — место вернёт перезапуск держащего процесса"
    say "(чаще всего это dockerd или контейнер с удалённым журналом/дампом)"
  fi
else
  say "⚠ нужен root: sudo bash deploy/docker-disk-report.sh"
fi

section "файлы, СПРЯТАННЫЕ под точками монтирования"
# Самый частый источник «не хватает 200 ГБ, а таких папок нет»: данные
# записаны в каталог (например /mnt/sdb/ed-ring-colony/spansh — дампы Spansh
# по 6 ГиБ каждый), пока диск НЕ был смонтирован. Потом диск монтируется
# поверх, файлы остаются на корневом диске и становятся невидимыми: du по
# пути показывает содержимое СМОНТИРОВАННОГО диска, а место на корне занято.
if [ "$(id -u)" = "0" ]; then
  ROOTVIEW="$(mktemp -d /tmp/edrc-rootview.XXXXXX)"
  if mount --bind / "$ROOTVIEW" 2>/dev/null; then
    FOUND=0
    while read -r mp; do
      case "$mp" in
        /|/proc*|/sys*|/dev*|/run*) continue ;;
      esac
      hidden="$ROOTVIEW${mp}"
      [ -d "$hidden" ] || continue
      sz="$(du -sxm "$hidden" 2>/dev/null | cut -f1)"
      if [ -n "$sz" ] && [ "$sz" -gt 100 ]; then
        printf '  под точкой монтирования %s спрятано %s МБ на корневом диске\n' "$mp" "$sz"
        FOUND=1
      fi
    done <<< "$(findmnt -rno TARGET 2>/dev/null | sort -u)"
    if [ "$FOUND" = "0" ]; then
      say "скрытых данных под точками монтирования не найдено"
    else
      say ""
      say "Посмотреть и вычистить (ПРОВЕРИВ, что это не живые данные):"
      say "  mount --bind / /mnt/rootview && du -shx /mnt/rootview/<путь>/*"
      say "  rm -rf /mnt/rootview/<путь>/<лишнее> && umount /mnt/rootview"
      say "Типовой случай этого проекта: дампы Spansh (~6 ГиБ каждый) записаны"
      say "в GALAXY_DATA_HOST_DIR до монтирования /dev/sdb1."
    fi
    umount "$ROOTVIEW" 2>/dev/null || true
  else
    say "⚠ не удалось сделать bind-mount корня — проверка пропущена"
  fi
  rmdir "$ROOTVIEW" 2>/dev/null || true
else
  say "⚠ нужен root: sudo bash deploy/docker-disk-report.sh"
fi

section "крупнейшие каталоги корневого диска (du -x, без других ФС)"
du -xhd2 / 2>/dev/null | sort -h | tail -n 15 || true

# journald держит свой бюджет (по умолчанию — до 10% диска) и живёт мимо
# Docker: в `docker system df` его нет, в `du` по проекту — тоже.
section "журналы системы (systemd journald и /var/log)"
if command -v journalctl >/dev/null 2>&1; then
  journalctl --disk-usage 2>/dev/null || true
  say "подрезать: journalctl --vacuum-size=500M (или SystemMaxUse в journald.conf)"
fi
du -sh /var/log/* 2>/dev/null | sort -h | tail -n 8 || true

# Кэш-маунты: единственный переносимый способ их померить/почистить —
# синтетическая сборка с теми же target (см. edrc_trim_cache_mounts).
if [ -f "$SCRIPT_DIR/compose-lib.sh" ]; then
  # shellcheck source=compose-lib.sh
  source "$SCRIPT_DIR/compose-lib.sh"
  # Здесь был именно `head`: функция-заголовок когда-то так называлась, и
  # этот вызов остался после переименования в `section`. В итоге GNU head
  # пытался открыть заголовок как файл («cannot open … for reading»), а
  # раздел о кэш-маунтах печатался без заголовка.
  section "кэш-маунты BuildKit (не видны в docker system df / builder prune)"
  if declare -F edrc_trim_cache_mounts >/dev/null 2>&1; then
    if edrc_compose_uses_buildkit; then
      if [ "$WIPE_NEXT" = "1" ]; then
        say "вычищаю кэш сборки Next (/app/.next/cache); npm-кэш не трогаю…"
        edrc_trim_cache_mounts next || true
      elif [ "$WIPE" = "1" ]; then
        say "вычищаю оба кэш-маунта (/app/.next/cache и /root/.npm)…"
        edrc_trim_cache_mounts wipe || true
        # Остатки сорвавшихся переключений держат старые образы — снимаем
        # остановленные и забираем освободившиеся образы и анонимные тома.
        edrc_remove_stale_containers || true
        docker image prune -f >/dev/null 2>&1 || true
        edrc_prune_anonymous_volumes || true
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

section "резервные копии БД"
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
if [ "$WIPE_NEXT" = "1" ]; then
  say "ГОТОВО: вычищен только кэш сборки Next. Следующая сборка начнётся холодной"
  say "(дольше), npm-кэш на месте."
elif [ "$WIPE" = "1" ]; then
  say "ГОТОВО: вычищены кэш-маунты, остатки переключений, висячие образы и"
  say "анонимные тома. Сверьте df выше с состоянием ДО запуска."
else
  say "Это только замер. Вернуть место (кэш-маунты + остатки контейнеров + образы):"
  say "  sudo bash deploy/docker-disk-report.sh --wipe"
  say "Лечение «отравленного» кэша Turbopack (сборка падает на read_task_output) —"
  say "  sudo bash deploy/docker-disk-report.sh --wipe-next"
  say "Бюджеты на будущее (в .env.production):"
  say "  UPDATE_NEXT_CACHE_KEEP=2g · UPDATE_NPM_CACHE_KEEP=2g · UPDATE_DOCKER_CACHE_KEEP=8g"
  say "Переключение контейнеров: UPDATE_STOP_TIMEOUT=120 (сек на корректную остановку)."
fi
say ""
say "Если df показывает занятыми сотни ГБ, а каталогов таких нет — смотрите"
say "два раздела выше: «удалённые, но ещё открытые файлы» и «файлы, СПРЯТАННЫЕ"
say "под точками монтирования». du их не видит по определению, df считает."
