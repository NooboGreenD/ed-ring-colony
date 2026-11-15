#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════
# ED Ring Colony — автоматическая установка «всё на одной машине»
# (сайт + self-hosted Supabase) одними командами терминала.
#
# Поддерживается: Ubuntu 20.04 / 22.04 / 24.04 (и Debian 11/12) с Docker.
# Любой хостинг с root-доступом и чистым Debian/Ubuntu подходит одинаково:
# пути, порт сайта и каталог для дампов задаются флагами, а не зашиты в код.
#
# Использование (под root или через sudo, из корня репозитория/архива):
#
#   sudo bash deploy/selfhost/install.sh --ip 203.0.113.10
#   sudo bash deploy/selfhost/install.sh --domain ring.example.com --email you@mail.com
#
# Флаги:
#   --ip АДРЕС         режим «голый статический IP» (без HTTPS)
#   --domain ДОМЕН     режим с доменом: сайт на ДОМЕН, Supabase на
#                      supabase.ДОМЕН, HTTPS через certbot
#   --email EMAIL      email для Let's Encrypt (обязателен с --domain)
#   --no-certbot       в режиме --domain пропустить выпуск сертификата
#   --no-cron          не создавать каталог для резервных копий
#   --no-monitor       не запускать monitor-agent (Админка → Мониторинг
#                      останется без Docker/задач; включается позже скриптом
#                      deploy/start-monitoring.sh)
#   --no-ufw           не трогать файрвол
#   --root КАТАЛОГ     куда ставить проект (по умолчанию /opt/ed-ring-colony;
#                      env EDRC_ROOT); исходники — КАТАЛОГ/src, копии БД —
#                      КАТАЛОГ/backups
#   --web-port ПОРТ    порт сайта на 127.0.0.1 (по умолчанию 3000; env
#                      WEB_HOST_PORT). Внутри контейнера всегда 3000 — порт
#                      меняется только на хосте и в nginx
#   --galaxy-dir ПУТЬ  где хранить дампы Spansh (по умолчанию КАТАЛОГ/data/
#                      spansh; env GALAXY_DATA_HOST_DIR). Нужно ~10 ГиБ, лучше
#                      отдельный диск — см. deploy/migrate-galaxy-dump.sh
#   --supabase-ref REF версия стека Supabase (по умолчанию закреплённая
#                      метка, env SUPABASE_REF; `master` — самый свежий)
#   --force            продолжить несмотря на предупреждения проверки
#                      (неподдерживаемая ОС, мало RAM/диска, занятый порт)
#
# Что делает: проверка сервера → пакеты → ufw → swap → Docker → Supabase-стек →
# секреты → схема БД → nginx → сайт → (certbot) → каталог копий → проверка.
# Скрипт идемпотентен: перезапуск продолжает с недоделанного и не теряет
# секреты. Все пароли/ключи сохраняются в КАТАЛОГ/credentials.txt (0600),
# несекретные параметры установки — в КАТАЛОГ/install-info.txt.
# ═════════════════════════════════════════════════════════════════════
set -euo pipefail

usage() {
  # Печатаем шапку файла до `set -euo pipefail`: она всегда актуальна.
  sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

# ── разбор аргументов ────────────────────────────────────────────────
MODE="" ADDR="" EMAIL="" DO_CERTBOT=1 DO_CRON=1 DO_MONITOR=1 DO_UFW=1 FORCE=0
EDRC_ROOT="${EDRC_ROOT:-/opt/ed-ring-colony}"
WEB_PORT="${WEB_HOST_PORT:-3000}"
GALAXY_DIR="${GALAXY_DATA_HOST_DIR:-}"
SUPABASE_REF="${SUPABASE_REF:-v1.26.08}"
while [ $# -gt 0 ]; do
  case "$1" in
    --ip)           MODE="ip";     ADDR="${2:?}"; shift 2;;
    --domain)       MODE="domain"; ADDR="${2:?}"; shift 2;;
    --email)        EMAIL="${2:?}"; shift 2;;
    --no-certbot)   DO_CERTBOT=0; shift;;
    --no-cron)      DO_CRON=0; shift;;
    --no-monitor)   DO_MONITOR=0; shift;;
    --no-ufw)       DO_UFW=0; shift;;
    --root)         EDRC_ROOT="${2:?}"; shift 2;;
    --web-port)     WEB_PORT="${2:?}"; shift 2;;
    --galaxy-dir)   GALAXY_DIR="${2:?}"; shift 2;;
    --supabase-ref) SUPABASE_REF="${2:?}"; shift 2;;
    --force)        FORCE=1; shift;;
    -h|--help)      usage; exit 0;;
    *) echo "Неизвестный флаг: $1 (см. --help)" >&2; exit 1;;
  esac
done

[ -n "$MODE" ] || { echo "Укажите --ip АДРЕС или --domain ДОМЕН (см. --help)" >&2; exit 1; }
if [ "$MODE" = domain ] && [ "$DO_CERTBOT" = 1 ] && [ -z "$EMAIL" ]; then
  echo "С --domain нужен --email для Let's Encrypt (или добавьте --no-certbot)" >&2; exit 1
fi
[ "$(id -u)" = 0 ] || { echo "Запускайте под root: sudo bash $0 ..." >&2; exit 1; }

# Каталог установки — абсолютный путь без хвостового слэша. Проверяем сразу:
# опечатка в --root иначе всплывёт после получаса сборки.
case "$EDRC_ROOT" in /*) ;; *) echo "--root должен быть абсолютным путём: $EDRC_ROOT" >&2; exit 1;; esac
EDRC_ROOT="${EDRC_ROOT%/}"
[ -n "$EDRC_ROOT" ] || { echo "--root не может быть /" >&2; exit 1; }
case "$WEB_PORT" in ''|*[!0-9]*) echo "--web-port должен быть числом: $WEB_PORT" >&2; exit 1;; esac
{ [ "$WEB_PORT" -ge 1 ] && [ "$WEB_PORT" -le 65535 ]; } \
  || { echo "--web-port вне диапазона 1..65535: $WEB_PORT" >&2; exit 1; }
[ "$WEB_PORT" != 80 ] && [ "$WEB_PORT" != 443 ] \
  || { echo "--web-port не может быть 80/443 — их занимает nginx" >&2; exit 1; }

warn() { echo "⚠ $*" >&2; }
note() { echo "  • $*"; }
die()  { echo "✗ $*" >&2; exit 1; }
# Предупреждение проверки: с --force установка продолжается, без него — стоп.
objection() { if [ "$FORCE" = 1 ]; then warn "$* (продолжаю: --force)"; else die "$* — исправьте или добавьте --force"; fi; }

# ── адреса ───────────────────────────────────────────────────────────
if [ "$MODE" = ip ]; then
  SITE_URL="http://$ADDR"
  SUPA_URL="http://$ADDR:8000"        # Kong напрямую
  SUPA_HOST=""
else
  SITE_URL="https://$ADDR"
  SUPA_HOST="supabase.$ADDR"
  SUPA_URL="https://$SUPA_HOST"       # через nginx
fi

# ── пути ─────────────────────────────────────────────────────────────
# Стек Supabase живёт отдельно от каталога проекта: его compose-проект
# называется `supabase`, и от этого имени зависят сеть `supabase_default`,
# имена контейнеров и .env стека. Путь к нему не параметризуем намеренно.
SRC_DIR="$EDRC_ROOT/src"
BACKUP_DIR="$EDRC_ROOT/backups"
SUPA_DIR="/opt/supabase"
CRED="$EDRC_ROOT/credentials.txt"
INFO="$EDRC_ROOT/install-info.txt"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

step() { echo; echo "════ $* ════"; }

# ═════════════════════════════════════════════════════════════════════
step "0/10 Проверка сервера"
# ═════════════════════════════════════════════════════════════════════
# Проверка ничего не меняет: она нужна, чтобы «не влезло» выяснилось до
# получасовой сборки, а занятый порт — до того, как nginx затёрт.
REINSTALL=0
if [ -f "$CRED" ] || [ -f "$SRC_DIR/docker-compose.yml" ]; then
  REINSTALL=1
  note "в $EDRC_ROOT уже есть установка — режим продолжения/обновления"
fi

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_LIKE="${ID_LIKE:-}"
  OS_PRETTY="${PRETTY_NAME:-$OS_ID}"
  case "$OS_ID $OS_LIKE" in
    *ubuntu*|*debian*) note "ОС: $OS_PRETTY — поддерживается" ;;
    *) objection "ОС «$OS_PRETTY» не проверялась: скрипт рассчитан на Ubuntu/Debian (apt, ufw, nginx, certbot). Для AlmaLinux/Rocky нужны dnf/firewalld — см. DEPLOY-ANY.md" ;;
  esac
else
  objection "не удалось прочитать /etc/os-release — не похоже на Debian/Ubuntu"
fi

# Память: самому Supabase-стеку нужно ~2 ГБ, сайту со сборкой — ещё ~2.
MEM_MB="$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "${MEM_MB:-0}" -lt 3500 ]; then
  objection "RAM ${MEM_MB} МБ: для «всё в одном» нужно минимум 4 ГБ (Supabase ~2 ГБ + сборка сайта ~2 ГБ). Вариант с меньшей памятью — внешний Supabase, см. SERVER-SETUP.md"
else
  note "RAM: ${MEM_MB} МБ"
fi

# Диск: образы + Supabase + запас под дампы Spansh (сам дамп 6 ГиБ и шарды).
DISK_DIR="$EDRC_ROOT"
while [ ! -d "$DISK_DIR" ] && [ "$DISK_DIR" != "/" ]; do DISK_DIR="$(dirname "$DISK_DIR")"; done
DISK_GB="$(df -Pk "$DISK_DIR" | awk 'NR==2 {print int($4/1048576)}')"
if [ "${DISK_GB:-0}" -lt 20 ]; then
  objection "свободно ${DISK_GB} ГБ в $DISK_DIR: нужно минимум 20 ГБ (образы, Supabase, дампы). Отдельный диск для дампов задаётся флагом --galaxy-dir"
else
  note "диск: ${DISK_GB} ГБ свободно в $DISK_DIR"
fi

if [ "$REINSTALL" = 0 ]; then
  port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }
  PORTS_FREE=1
  for port in 80 443 "$WEB_PORT"; do
    if port_busy "$port"; then
      PORTS_FREE=0
      objection "порт $port уже занят другой программой (освободите его или задайте --web-port)"
    fi
  done
  if [ "$MODE" = domain ] && port_busy 8000; then
    PORTS_FREE=0
    objection "порт 8000 занят: его занимает Supabase (Kong)"
  fi
  [ "$PORTS_FREE" = 1 ] && note "порты 80/443/$WEB_PORT свободны"
fi

command -v systemctl >/dev/null 2>&1 || objection "нет systemd: nginx нечем перезагрузить (в контейнере/Docker-песочнице установщик не работает)"

if [ "$MODE" = domain ] && ! command -v getent >/dev/null 2>&1; then
  note "DNS проверить нечем (нет getent) — сертификат выпустится только при готовых A-записях"
elif [ "$MODE" = domain ]; then
  if getent hosts "$ADDR" >/dev/null 2>&1; then
    RESOLVED="$(getent hosts "$ADDR" | awk 'NR==1 {print $1}')"
    PUBLIC=""
    command -v curl >/dev/null 2>&1 && PUBLIC="$(curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || true)"
    if [ -n "$PUBLIC" ] && [ "$RESOLVED" != "$PUBLIC" ]; then
      warn "DNS: $ADDR → $RESOLVED, внешний адрес сервера $PUBLIC — HTTPS не выпустится, пока A-запись не исправят (сайт поднимется по http)"
    else
      note "DNS: $ADDR → $RESOLVED"
    fi
  else
    warn "DNS: $ADDR не резолвится — certbot не подтвердит домен; сайт поднимется по http, сертификат выпустите после правки A-записи"
  fi
  getent hosts "supabase.$ADDR" >/dev/null 2>&1 \
    || warn "DNS: supabase.$ADDR не резолвится — Realtime/Storage на сабдомене не откроются снаружи"
fi

# ═════════════════════════════════════════════════════════════════════
step "1/10 Пакеты, файрвол, swap"
# ═════════════════════════════════════════════════════════════════════
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg lsb-release openssl \
  rsync cron nginx >/dev/null

if [ "$DO_UFW" = 1 ]; then
  apt-get install -y -qq ufw >/dev/null
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp  >/dev/null
  ufw allow 443/tcp >/dev/null
  if [ "$MODE" = ip ]; then ufw allow 8000/tcp >/dev/null; fi
  ufw --force enable >/dev/null
  echo "ufw: 22, 80, 443$([ "$MODE" = ip ] && echo ', 8000') открыты"
fi

if [ ! -f /swapfile ] && ! swapon --show 2>/dev/null | grep -q .; then
  rm -f /swapfile
  # fallocate не работает на btrfs/ZFS и на overlay-корнях некоторых VPS —
  # там файл подкачки создаётся обычной записью (медленнее, но всегда).
  if ! { fallocate -l 2G /swapfile 2>/dev/null && chmod 600 /swapfile; }; then
    dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
  fi
  mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "swap 2G создан"
else
  echo "swap уже есть — пропуск"
fi

# ═════════════════════════════════════════════════════════════════════
step "2/10 Docker"
# ═════════════════════════════════════════════════════════════════════
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
docker compose version >/dev/null 2>&1 || apt-get install -y -qq docker-compose-plugin >/dev/null
echo "docker: $(docker --version)"

# ═════════════════════════════════════════════════════════════════════
step "3/10 Исходники сайта → $SRC_DIR"
# ═════════════════════════════════════════════════════════════════════
mkdir -p /opt/ed-ring-colony
if [ "$REPO_ROOT" != "$SRC_DIR" ]; then
  rsync -a --delete --exclude='.env*' --exclude='node_modules' \
    --exclude='.next' --exclude='dist-archive' "$REPO_ROOT/" "$SRC_DIR/"
fi
echo "исходники на месте: $(ls "$SRC_DIR/package.json" >/dev/null && echo ok)"

# ═════════════════════════════════════════════════════════════════════
step "4/10 Секреты"
# ═════════════════════════════════════════════════════════════════════
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
make_jwt() { # role secret
  local h p s now exp
  now=$(date +%s); exp=$((now + 10*365*24*3600))
  h=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  p=$(printf '{"role":"%s","iss":"supabase","iat":%s,"exp":%s}' "$1" "$now" "$exp" | b64url)
  s=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$2" -binary | b64url)
  printf '%s.%s.%s' "$h" "$p" "$s"
}

if [ -f "$CRED" ]; then
  echo "секреты уже сгенерированы ($CRED) — переиспользую"
  # shellcheck disable=SC1090
  . "$CRED"
  # Старые установки могли быть созданы до появления мониторинга: дописываем
  # отдельный ключ web → monitor-agent, не трогая остальные секреты.
  if [ -z "${MONITOR_AGENT_TOKEN:-}" ]; then
    MONITOR_AGENT_TOKEN=$(openssl rand -hex 32)
    echo "MONITOR_AGENT_TOKEN=$MONITOR_AGENT_TOKEN" >> "$CRED"
    echo "дозаписан MONITOR_AGENT_TOKEN в $CRED"
  fi
  # Ручное обновление проекта (Админка → Мониторинг) — свой ключ, не CRON_SECRET.
  if [ -z "${UPDATE_AGENT_TOKEN:-}" ]; then
    UPDATE_AGENT_TOKEN=$(openssl rand -hex 32)
    echo "UPDATE_AGENT_TOKEN=$UPDATE_AGENT_TOKEN" >> "$CRED"
    echo "дозаписан UPDATE_AGENT_TOKEN в $CRED"
  fi
else
  POSTGRES_PASSWORD=$(openssl rand -hex 24)
  JWT_SECRET=$(openssl rand -hex 32)
  ANON_KEY=$(make_jwt anon "$JWT_SECRET")
  SERVICE_ROLE_KEY=$(make_jwt service_role "$JWT_SECRET")
  DASHBOARD_PASSWORD=$(openssl rand -hex 24)
  CRON_SECRET=$(openssl rand -hex 32)
  # Не переиспользует CRON_SECRET: отдельный ключ только для web → agent.
  MONITOR_AGENT_TOKEN=$(openssl rand -hex 32)
  # Ключ web → update-agent (ручное обновление). Тоже отдельный: компрометация
  # одного не открывает второе.
  UPDATE_AGENT_TOKEN=$(openssl rand -hex 32)
  cat > "$CRED" <<EOF
# ED Ring Colony — секреты установки $(date -Iseconds). НЕ УДАЛЯТЬ.
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
JWT_SECRET=$JWT_SECRET
ANON_KEY=$ANON_KEY
SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=$DASHBOARD_PASSWORD
CRON_SECRET=$CRON_SECRET
MONITOR_AGENT_TOKEN=$MONITOR_AGENT_TOKEN
UPDATE_AGENT_TOKEN=$UPDATE_AGENT_TOKEN
EOF
  chmod 600 "$CRED"
  echo "секреты сгенерированы → $CRED"
fi

# ═════════════════════════════════════════════════════════════════════
step "5/10 Supabase-стек → $SUPA_DIR"
# ═════════════════════════════════════════════════════════════════════
if [ ! -f "$SUPA_DIR/docker-compose.yml" ]; then
  mkdir -p "$SUPA_DIR" /tmp/supabase-src
  # Версия стека закреплена: `master` меняется без предупреждения, и тогда
  # установка на новом сервере ставит не то, что проверено на этом проекте.
  # `--supabase-ref master` возвращает прежнее поведение.
  if [ "$SUPABASE_REF" = master ]; then
    SUPA_ARCHIVE="https://github.com/supabase/supabase/archive/refs/heads/master.tar.gz"
  else
    SUPA_ARCHIVE="https://github.com/supabase/supabase/archive/refs/tags/$SUPABASE_REF.tar.gz"
  fi
  if ! curl -fsSL --retry 3 -o /tmp/supabase.tar.gz "$SUPA_ARCHIVE"; then
    rm -rf /tmp/supabase-src /tmp/supabase.tar.gz
    die "не скачался стек Supabase ($SUPABASE_REF). Нужен доступ к github.com; другую версию можно задать флагом --supabase-ref (например master)"
  fi
  tar xzf /tmp/supabase.tar.gz -C /tmp/supabase-src --strip-components=1
  cp -r /tmp/supabase-src/docker/* "$SUPA_DIR/"
  cp /tmp/supabase-src/docker/.env.example "$SUPA_DIR/.env"
  rm -rf /tmp/supabase.tar.gz /tmp/supabase-src
  echo "стек скачан: $SUPABASE_REF"
  # Быстрая проверка, что скачался ожидаемый набор: без сервиса db дальше
  # нечего делать, а падать лучше здесь, а не на «docker exec supabase-db».
  grep -qE '^  db:' "$SUPA_DIR/docker-compose.yml" \
    || die "в docker-compose.yml стека нет сервиса db — версия $SUPABASE_REF не подходит, попробуйте --supabase-ref master"
else
  echo "стек уже на месте — пропуск скачивания"
fi

set_env() { # file KEY VALUE — заменить или дописать
  local f="$1" k="$2" v="$3"
  if grep -q "^${k}=" "$f"; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$f"
  else
    echo "${k}=${v}" >> "$f"
  fi
}

E="$SUPA_DIR/.env"
# Глобальный лимит Storage (FILE_SIZE_LIMIT) в compose стека зашит числом
# 52428800 — 50 МиБ. Облако точек карты галактики весит до 64 МиБ, и такая
# загрузка получала бы постоянный 413 (по размеру она не повторяется).
# Подставляем значение из .env стека, чтобы оно работало, а не лежало мёртвой
# строкой. Проверка стоит вне блока скачивания: на установке, созданной
# раньше, повторный запуск тоже исправляет файл. Пропатченный — не трогаем.
if grep -q 'FILE_SIZE_LIMIT: 52428800' "$SUPA_DIR/docker-compose.yml"; then
  sed -i 's|FILE_SIZE_LIMIT: 52428800|FILE_SIZE_LIMIT: ${FILE_SIZE_LIMIT:-52428800}|' \
    "$SUPA_DIR/docker-compose.yml"
  echo "Storage: лимит файла берётся из .env стека (было жёстко 50 МиБ)"
fi
set_env "$E" POSTGRES_PASSWORD        "$POSTGRES_PASSWORD"
set_env "$E" JWT_SECRET               "$JWT_SECRET"
set_env "$E" ANON_KEY                 "$ANON_KEY"
set_env "$E" SERVICE_ROLE_KEY         "$SERVICE_ROLE_KEY"
set_env "$E" DASHBOARD_USERNAME       "admin"
set_env "$E" DASHBOARD_PASSWORD       "$DASHBOARD_PASSWORD"
set_env "$E" SITE_URL                 "$SITE_URL"
set_env "$E" API_EXTERNAL_URL         "$SUPA_URL"
set_env "$E" SUPABASE_PUBLIC_URL      "$SUPA_URL"
set_env "$E" ADDITIONAL_REDIRECT_URLS "$SITE_URL/api/auth/callback,$SITE_URL/auth/email"
# Global Storage cap. The effective limit is min(FILE_SIZE_LIMIT, bucket
# file_size_limit): the map point cloud lives in `galaxy-data` and may be up
# to 64 MiB, so the default 52428800 (50 MiB) would reject it with a
# permanent 413 — and a size refusal is deliberately never retried.
set_env "$E" FILE_SIZE_LIMIT           "73400320"
# Production email ownership must be verified. Finish SMTP/templates before
# enabling new signups; see POST-MIGRATION.md (never auto-confirm mailboxes).
set_env "$E" ENABLE_EMAIL_AUTOCONFIRM "false"
set_env "$E" DISABLE_SIGNUP "true"
if [ "$MODE" = domain ]; then
  set_env "$E" KONG_HTTP_PORT  "127.0.0.1:8000"
  set_env "$E" KONG_HTTPS_PORT "127.0.0.1:8443"
fi
set_env "$E" POSTGRES_PORT     "127.0.0.1:5432"
set_env "$E" POOLER_PROXY_PORT_TRANSACTION "127.0.0.1:6543"
echo "$E настроен"

( cd "$SUPA_DIR" && docker compose pull -q && docker compose up -d )

echo -n "жду готовности Postgres"
for i in $(seq 1 60); do
  if docker exec supabase-db pg_isready -U postgres >/dev/null 2>&1; then echo " — готов"; break; fi
  echo -n "."; sleep 5
  [ "$i" = 60 ] && { echo " НЕ ДОЖДАЛСЯ — смотрите docker compose logs db" >&2; exit 1; }
done

# ═════════════════════════════════════════════════════════════════════
step "6/10 Схема БД"
# ═════════════════════════════════════════════════════════════════════
TABLES=$(docker exec supabase-db psql -U postgres -d postgres -tAc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
if [ "${TABLES:-0}" -lt 50 ]; then
  docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=0 \
    < "$SRC_DIR/supabase/full_schema.sql" >/dev/null
  docker exec -i supabase-db psql -U postgres -d postgres \
    < "$SRC_DIR/supabase/maintenance/create_delivery_source_hash_unique_index_concurrently.sql" \
    >/dev/null 2>&1 || true
  TABLES=$(docker exec supabase-db psql -U postgres -d postgres -tAc \
    "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
fi
echo "таблиц в public: $TABLES"
[ "$TABLES" -ge 50 ] || { echo "схема не применилась — проверьте full_schema.sql" >&2; exit 1; }

# ═════════════════════════════════════════════════════════════════════
step "7/10 nginx"
# ═════════════════════════════════════════════════════════════════════
NG=/etc/nginx/sites-available/ed-ring-colony
if [ "$MODE" = ip ]; then SERVER_NAME="_"; else SERVER_NAME="$ADDR"; fi

cat > "$NG" <<EOF
server {
    listen 80$([ "$MODE" = ip ] && echo ' default_server');
    server_name $SERVER_NAME;

    location / {
        proxy_pass http://127.0.0.1:$WEB_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 310s;
        proxy_send_timeout 310s;
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
    client_max_body_size 25m;
    # Старая админка загружала ColonialHelper.exe (22–35 МиБ) одним multipart.
    # Текущая отправляет raw-части до 4 МиБ и при 413 уменьшает их до 1 МиБ;
    # 200m оставлен для обратной совместимости. TLS-location нужно дублировать
    # в отдельный HTTPS server: nginx не наследует locations между блоками.
    location = /api/admin/uploader/release {
        # 200m перекрывает EXE старых клиентов (22–35 МиБ) и multipart-обёртку.
        # Приложение само отклоняет базовую сборку крупнее 128 МиБ, поэтому
        # лимит location обязан быть выше: иначе 413 отвечает nginx, а не сайт.
        client_max_body_size 200m;
        proxy_pass http://127.0.0.1:$WEB_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
    location /_next/static/ {
        proxy_pass http://127.0.0.1:$WEB_PORT;
        proxy_set_header Host \$host;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
    # Запрет публичного доступа к Supabase Studio и pg-meta через туннель /api/supabase
    location = /api/supabase { return 404; }
    location = /api/supabase/ { return 404; }
    location ^~ /api/supabase/project/ { return 404; }
    location ^~ /api/supabase/api/pg-meta/ { return 404; }
    location = /api/capi/token {
        access_log off;
        proxy_pass http://127.0.0.1:$WEB_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

if [ "$MODE" = domain ]; then
cat >> "$NG" <<EOF

server {
    listen 80;
    server_name $SUPA_HOST;
    location ^~ /realtime/v1/ {
        # No URI suffix / trailing slash here: Kong must receive /realtime/v1/...
        # Kong itself rewrites it to /socket/... in Realtime.
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
        proxy_cache off;
        # apikey is present in the WebSocket URL. Never include it in access logs.
        access_log off;
    }
    # Запрет публичного доступа к Supabase Studio и pg-meta на сабдомене API
    location = / { return 404; }
    location ^~ /project/ { return 404; }
    location ^~ /api/pg-meta/ { return 404; }
    location ^~ /_next/ { return 404; }
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
    # Загрузки в Storage через Kong: вложения и PUT облака точек карты (до 64 МиБ).
    client_max_body_size 80m;
}
EOF
fi

ln -sf "$NG" /etc/nginx/sites-enabled/ed-ring-colony
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
echo "nginx настроен"

if [ "$MODE" = domain ] && [ "$DO_CERTBOT" = 1 ]; then
  step "7a HTTPS (certbot)"
  if ! command -v certbot >/dev/null 2>&1; then
    if command -v snap >/dev/null 2>&1; then
      snap install core >/dev/null 2>&1 || true
      snap install --classic certbot >/dev/null
      ln -sf /snap/bin/certbot /usr/bin/certbot
    else
      apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
    fi
  fi
  # Неудача certbot не должна обрывать установку: чаще всего это ещё не
  # обновлённая A-запись или закрытый 80-й порт, а сайт к этому моменту уже
  # собран и работает по http. Повторный запуск скрипта или команда ниже
  # довыпускает сертификат, когда DNS будет готов.
  if certbot --nginx --non-interactive --agree-tos -m "$EMAIL" \
      -d "$ADDR" -d "$SUPA_HOST"; then
    echo "HTTPS выпущен для $ADDR и $SUPA_HOST"
  else
    warn "HTTPS не выпущен (DNS/порт 80). Сайт работает по http://$ADDR"
    warn "когда A-записи указывают на сервер: certbot --nginx -d $ADDR -d $SUPA_HOST"
  fi
fi

# ═════════════════════════════════════════════════════════════════════
step "8/10 Сайт (.env.production + сборка)"
# ═════════════════════════════════════════════════════════════════════
SE="$SRC_DIR/.env.production"
if [ ! -f "$SE" ]; then cp "$SRC_DIR/.env.example" "$SE"; fi
set_env "$SE" NEXT_PUBLIC_SUPABASE_URL      "$SUPA_URL"
set_env "$SE" NEXT_PUBLIC_SUPABASE_ANON_KEY "$ANON_KEY"
set_env "$SE" SUPABASE_SERVICE_ROLE_KEY     "$SERVICE_ROLE_KEY"
set_env "$SE" NEXT_PUBLIC_SITE_URL          "$SITE_URL"
set_env "$SE" CRON_SECRET                   "$CRON_SECRET"
set_env "$SE" FRONTIER_REDIRECT_URI         "$SITE_URL/api/capi/callback"
# Ключи вкладки Админка → Мониторинг (см. MONITORING.md).
set_env "$SE" MONITOR_AGENT_TOKEN           "$MONITOR_AGENT_TOKEN"
set_env "$SE" PROJECT_REPOSITORY            "NooboGreenD/ed-ring-colony"
set_env "$SE" PROJECT_UPDATE_BRANCH         "main"
# Ручное обновление из панели: приватный update-agent в профиле monitoring.
set_env "$SE" UPDATE_AGENT_TOKEN            "$UPDATE_AGENT_TOKEN"
set_env "$SE" UPDATE_AGENT_URL              "http://update-agent:8092"
set_env "$SE" PROJECT_HOST_DIR              "$SRC_DIR"
set_env "$SE" PROJECT_DEPLOY_MODE           "compose"
# Каталог установки не обязан быть /opt/ed-ring-colony: копии БД и каталог
# стека Supabase передаются в update-agent теми же путями, что видит хост
# (агент монтирует их один-в-один), иначе кнопки админки ищут файлы не там.
# Уже заданные в .env.production значения (копии на отдельном диске, стек в
# другом месте) сохраняются: перезапуск установщика не должен их сбрасывать.
env_value() { grep -q "^$1=" "$SE" && grep "^$1=" "$SE" | tail -n1 | cut -d= -f2- || true; }
UPDATE_BACKUP_DIR="${UPDATE_BACKUP_DIR:-$(env_value UPDATE_BACKUP_DIR)}"
UPDATE_BACKUP_DIR="${UPDATE_BACKUP_DIR:-$BACKUP_DIR}"
mkdir -p "$UPDATE_BACKUP_DIR"
set_env "$SE" UPDATE_BACKUP_DIR             "$UPDATE_BACKUP_DIR"
SUPABASE_HOST_DIR_VAL="$(env_value SUPABASE_HOST_DIR)"
set_env "$SE" SUPABASE_HOST_DIR             "${SUPABASE_HOST_DIR_VAL:-$SUPA_DIR}"
# Порт сайта на хосте (внутри контейнера всегда 3000). Читает docker-compose.yml
# и nginx выше; при смене порта пересоберите web: docker compose up -d web.
set_env "$SE" WEB_HOST_PORT                 "$WEB_PORT"
# Все релизы Helper храним не в Docker data-root, а рядом с backup'ами.
# Если путь уже задан в env-файле, сохраняем пользовательский SDB mount.
UPLOADER_HOST_DIR="${UPLOADER_STORE_HOST_DIR:-}"
if [ -z "$UPLOADER_HOST_DIR" ] && grep -q '^UPLOADER_STORE_HOST_DIR=' "$SE"; then
  UPLOADER_HOST_DIR="$(grep '^UPLOADER_STORE_HOST_DIR=' "$SE" | tail -n1 | cut -d= -f2-)"
fi
UPLOADER_HOST_DIR="${UPLOADER_HOST_DIR:-$BACKUP_DIR/uploader-releases}"
set_env "$SE" UPLOADER_STORE_HOST_DIR "$UPLOADER_HOST_DIR"
mkdir -p "$UPLOADER_HOST_DIR"

# ── дампы Spansh ─────────────────────────────────────────────────────
# Раньше путь по умолчанию был /mnt/sdb/... — на новом сервере такого диска
# нет, и Docker создавал каталог от root на системном разделе. Контейнер
# сайта работает под uid 1001 и писать туда не мог: скачивание дампа падало
# на первом же файле. Теперь по умолчанию — каталог внутри установки,
# отдельный диск задаётся явно через --galaxy-dir (или в .env.production).
if [ -z "$GALAXY_DIR" ] && grep -q '^GALAXY_DATA_HOST_DIR=' "$SE"; then
  GALAXY_DIR="$(grep '^GALAXY_DATA_HOST_DIR=' "$SE" | tail -n1 | cut -d= -f2-)"
fi
GALAXY_DIR="${GALAXY_DIR:-$EDRC_ROOT/data/spansh}"
mkdir -p "$GALAXY_DIR"
# Владелец — uid/gid пользователя сайта в образе (nextjs, 1001). На отдельном
# диске каталог обычно root:root, и без этого импорт получает Permission
# denied уже после многогигабайтной загрузки.
chown -R 1001:1001 "$GALAXY_DIR" 2>/dev/null || warn "не удалось сменить владельца $GALAXY_DIR на 1001:1001 — проверьте права вручную"
set_env "$SE" GALAXY_DATA_HOST_DIR "$GALAXY_DIR"
GALAXY_FREE_GB="$(df -Pk "$GALAXY_DIR" | awk 'NR==2 {print int($4/1048576)}')"
if [ "${GALAXY_FREE_GB:-0}" -lt 12 ]; then
  warn "в $GALAXY_DIR свободно ${GALAXY_FREE_GB} ГБ: полный дамп Spansh (~6 ГиБ) + шарды требуют ~10 ГиБ. Укажите --galaxy-dir на диск побольше (см. SPANSH-IMPORT.md)"
fi
if [ "$DO_CRON" != 1 ]; then set_env "$SE" JOBS_ENABLED ""; fi
# Прямой Postgres для быстрого импорта каталога Spansh и замера размера БД:
# web и monitor-agent ниже подключаются к сети стека Supabase (compose-lib.sh),
# поэтому имя сервиса `db` из них резолвится. Значение не печатаем (пароль).
if [ -n "${POSTGRES_PASSWORD:-}" ]; then
  set_env "$SE" SUPABASE_DB_URL "postgresql://postgres:${POSTGRES_PASSWORD}@db:5432/postgres"
  set_env "$SE" MONITOR_DB_URL  "postgresql://postgres:${POSTGRES_PASSWORD}@db:5432/postgres"
else
  echo "⚠ POSTGRES_PASSWORD не найден в $CRED — заполните SUPABASE_DB_URL/MONITOR_DB_URL вручную:"
  echo "  postgresql://postgres:ПАРОЛЬ@db:5432/postgres (пароль — POSTGRES_PASSWORD в $SUPA_DIR/.env)"
fi
set_env "$SE" SUPABASE_NETWORK "supabase_default"
chmod 600 "$SE"
ln -sf .env.production "$SRC_DIR/.env"

# Метаданные ревизии для блока «Версия проекта» (не секреты). Если исходники
# скопированы без .git, сайт соберётся со значением unknown — это безопасно.
# Значения пишутся и в env-файл: ручная пересборка их подхватит через
# ${APP_GIT_SHA:-unknown} из docker-compose.yml.
if [ -d "$SRC_DIR/.git" ]; then
  export APP_GIT_SHA="$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  APP_GIT_REF_VAL="$(git -C "$SRC_DIR" branch --show-current 2>/dev/null || true)"
  export APP_GIT_REF="${APP_GIT_REF_VAL:-unknown}"
fi
export APP_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
set_env "$SE" APP_GIT_SHA    "$APP_GIT_SHA"
set_env "$SE" APP_GIT_REF    "$APP_GIT_REF"
set_env "$SE" APP_BUILD_TIME "$APP_BUILD_TIME"

# Единый список -f с сетью Supabase (как у start-monitoring.sh / update-project.sh),
# чтобы «getaddrinfo EAI_AGAIN db» не появился сразу после установки.
# shellcheck source=../compose-lib.sh
source "$SRC_DIR/deploy/compose-lib.sh"
EXTRA_COMPOSE_FILES="$(edrc_extra_compose_files "$SRC_DIR" "$SE")"

# Свежая машина с docker.io из дистрибутива может не иметь плагина buildx:
# тогда compose уходит в legacy-билдер, которому RUN --mount из Dockerfile
# web незнаком. Готовим запасной Dockerfile без кэш-маунтов (медленнее,
# но установка доходит до конца; поставьте docker-buildx-plugin для скорости).
LEGACY_COMPOSE_FILES="$(edrc_prepare_legacy_build "$SRC_DIR")" || true
[ -n "$LEGACY_COMPOSE_FILES" ] && echo "⚠ buildx не найден — web собирается без кэш-маунтов (медленнее, но работает)"

# Provenance-аттестации buildx здесь не нужны (образы остаются локальными),
# а их запись — лишний вызов Docker Hub в конце сборки: на нестабильном
# канале установка обрывалась «failed to solve: DeadlineExceeded: context
# deadline exceeded» уже после собранных образов.
edrc_disable_default_attestations

# Сборка и запуск разведены, а образы собираются ПО ОДНОМУ (web последним).
# `up -d --build` строит все таргеты параллельно: на слабой машине они дерутся
# за диск, и BuildKit роняет по своему дедлайну случайный уже готовый образ
# («target update-agent: failed to solve: DeadlineExceeded» сразу после его же
# «exporting to image … DONE»). Подробности — edrc_build_each в compose-lib.sh.
if [ "$DO_MONITOR" = 1 ]; then
  # Профиль monitoring поднимает приватный monitor-agent (без открытого порта):
  # он единственный получает docker.sock, web ходит к нему только с токеном.
  INSTALL_COMPOSE_ARGS="--env-file .env.production -f docker-compose.yml $EXTRA_COMPOSE_FILES $LEGACY_COMPOSE_FILES --profile monitoring"
  INSTALL_SERVICES="web jobs monitor-agent update-agent"
else
  INSTALL_COMPOSE_ARGS="--env-file .env.production -f docker-compose.yml $EXTRA_COMPOSE_FILES $LEGACY_COMPOSE_FILES"
  INSTALL_SERVICES="web jobs"
fi
# shellcheck disable=SC2086
( cd "$SRC_DIR" && edrc_build_each docker compose $INSTALL_COMPOSE_ARGS build -- $INSTALL_SERVICES )
# shellcheck disable=SC2086
( cd "$SRC_DIR" && docker compose $INSTALL_COMPOSE_ARGS up -d --no-build $INSTALL_SERVICES )

echo -n "жду ответа сайта"
for i in $(seq 1 36); do
  if curl -sf -o /dev/null "http://127.0.0.1:$WEB_PORT"; then echo " — работает"; break; fi
  echo -n "."; sleep 5
  [ "$i" = 36 ] && { echo " сайт не ответил — docker logs src-web-1" >&2; exit 1; }
done

# ═════════════════════════════════════════════════════════════════════
step "9/10 Каталог для резервных копий"
# ═════════════════════════════════════════════════════════════════════
# Бэкапы намеренно НЕ ставятся в cron: копия базы делается раз в неделю
# вручную из Админка → Бэкапы, а на время дампа сайт показывает заглушку
# «Ведутся технические работы». Расписание в cron означало бы закрытый сайт
# в произвольный момент (см. MONITORING.md).
if [ "$DO_CRON" = 1 ]; then
  # Каталог, куда update-agent (deploy/db-backup.sh) складывает копии.
  mkdir -p "${UPDATE_BACKUP_DIR:-$BACKUP_DIR}"
  # Старый файл с ночными заданиями больше не нужен — убираем, чтобы он не
  # продолжал дампить базу по своему расписанию.
  rm -f /etc/cron.d/ed-ring-colony
  echo "каталог копий: ${UPDATE_BACKUP_DIR:-$BACKUP_DIR}; запуск — Админка → Бэкапы (раз в неделю, вручную)"
  echo "фоновые задачи — docker compose --env-file .env.production logs jobs"
fi

# ═════════════════════════════════════════════════════════════════════
step "9a/10 Проверка после установки"
# ═════════════════════════════════════════════════════════════════════
# Тот же смоук-тест, что запускают руками после переезда: он проверяет не
# «контейнер запущен», а что сайт отвечает, шлюз Supabase жив и каталоги
# дампов доступны на запись. Падение проверки не отменяет установку — она
# уже состоялась, — но итог печатается явно.
SMOKE_ARGS=(--root "$EDRC_ROOT" --web-port "$WEB_PORT")
if [ "$MODE" = domain ] && [ "$DO_CERTBOT" = 1 ]; then SMOKE_ARGS+=(--site-url "$SITE_URL"); fi
if bash "$SRC_DIR/deploy/selfhost/smoke-test.sh" "${SMOKE_ARGS[@]}"; then
  echo "проверка пройдена"
else
  warn "проверка нашла проблемы — см. вывод выше и DEPLOY-ANY.md → «Если что-то не так»"
fi

# ═════════════════════════════════════════════════════════════════════
step "10/10 ГОТОВО"
# ═════════════════════════════════════════════════════════════════════
# Несекретные параметры установки: по ним следующие запуски и смоук-тест
# понимают, где что лежит, не заглядывая в .env.production с ключами.
umask 077
cat > "$INFO" <<EOF
# ED Ring Colony — параметры установки $(date -Iseconds)
MODE=$MODE
ADDR=$ADDR
SITE_URL=$SITE_URL
SITE_ROOT=$EDRC_ROOT
SRC_DIR=$SRC_DIR
WEB_HOST_PORT=$WEB_PORT
SUPABASE_REF=$SUPABASE_REF
SUPABASE_DIR=$SUPA_DIR
GALAXY_DATA_HOST_DIR=$GALAXY_DIR
BACKUP_DIR=${UPDATE_BACKUP_DIR:-$BACKUP_DIR}
UPLOADER_STORE_HOST_DIR=$UPLOADER_HOST_DIR
MONITORING=$DO_MONITOR
EOF

cat <<EOF

  Сайт:            $SITE_URL$([ "$WEB_PORT" != 3000 ] && echo " (порт на хосте: $WEB_PORT)")
  Каталог:         $EDRC_ROOT  (исходники в src/, параметры — install-info.txt)
  Supabase Studio: $SUPA_URL  (логин: admin, пароль в $CRED; стек $SUPABASE_REF)
  Дампы Spansh:    $GALAXY_DIR
  Секреты:         $CRED  (сделайте копию в надёжное место!)
  Бэкапы:          Админка → Бэкапы, раз в неделю вручную (копии в ${UPDATE_BACKUP_DIR:-$BACKUP_DIR}, хранятся 4)
  Helper-релизы:   $UPLOADER_HOST_DIR (все версии и откаты)
$( [ "$DO_MONITOR" = 1 ] && echo "  Мониторинг:      Админка → Мониторинг (monitor-agent + update-agent, ключи в $CRED)" \
     || echo "  Мониторинг:      выключен (--no-monitor); включение: bash $SRC_DIR/deploy/start-monitoring.sh && bash $SRC_DIR/deploy/start-update-agent.sh" )

  Проверка:
    bash $SRC_DIR/deploy/selfhost/smoke-test.sh --root $EDRC_ROOT
    docker compose -f $SUPA_DIR/docker-compose.yml ps
    docker ps
    curl -I $SITE_URL
$( [ "$DO_MONITOR" = 1 ] && echo "    bash $SRC_DIR/deploy/start-monitoring.sh --check" )

  Логи:
    docker logs -f src-web-1
    docker compose -f $SUPA_DIR/docker-compose.yml logs -f auth
$( [ "$DO_MONITOR" = 1 ] && echo "    docker compose --env-file $SRC_DIR/.env.production --profile monitoring logs -f monitor-agent" )

EOF
