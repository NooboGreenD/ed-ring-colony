#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════
# ED Ring Colony — автоматическая установка «всё на одной машине»
# (сайт + self-hosted Supabase) одними командами терминала.
#
# Поддерживается: Ubuntu 20.04 / 22.04 / 24.04 (и Debian 11/12).
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
#   --no-cron          не настраивать крон-задачи и бэкапы
#   --no-ufw           не трогать файрвол
#
# Что делает: пакеты → ufw → swap → Docker → Supabase-стек → секреты →
# схема БД → сайт → nginx → (certbot) → cron+бэкапы → сводка.
# Скрипт идемпотентен: перезапуск продолжает с недоделанного.
# Все пароли/ключи сохраняются в /opt/ed-ring-colony/credentials.txt (0600).
# ═════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── разбор аргументов ────────────────────────────────────────────────
MODE="" ADDR="" EMAIL="" DO_CERTBOT=1 DO_CRON=1 DO_UFW=1
while [ $# -gt 0 ]; do
  case "$1" in
    --ip)         MODE="ip";     ADDR="${2:?}"; shift 2;;
    --domain)     MODE="domain"; ADDR="${2:?}"; shift 2;;
    --email)      EMAIL="${2:?}"; shift 2;;
    --no-certbot) DO_CERTBOT=0; shift;;
    --no-cron)    DO_CRON=0; shift;;
    --no-ufw)     DO_UFW=0; shift;;
    -h|--help)    grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -30; exit 0;;
    *) echo "Неизвестный флаг: $1 (см. --help)" >&2; exit 1;;
  esac
done

[ -n "$MODE" ] || { echo "Укажите --ip АДРЕС или --domain ДОМЕН (см. --help)" >&2; exit 1; }
if [ "$MODE" = domain ] && [ "$DO_CERTBOT" = 1 ] && [ -z "$EMAIL" ]; then
  echo "С --domain нужен --email для Let's Encrypt (или добавьте --no-certbot)" >&2; exit 1
fi
[ "$(id -u)" = 0 ] || { echo "Запускайте под root: sudo bash $0 ..." >&2; exit 1; }

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
SRC_DIR="/opt/ed-ring-colony/src"
SUPA_DIR="/opt/supabase"
CRED="/opt/ed-ring-colony/credentials.txt"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

step() { echo; echo "════ $* ════"; }

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

if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile
  mkswap /swapfile >/dev/null && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
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
else
  POSTGRES_PASSWORD=$(openssl rand -hex 24)
  JWT_SECRET=$(openssl rand -hex 32)
  ANON_KEY=$(make_jwt anon "$JWT_SECRET")
  SERVICE_ROLE_KEY=$(make_jwt service_role "$JWT_SECRET")
  DASHBOARD_PASSWORD=$(openssl rand -hex 12)
  CRON_SECRET=$(openssl rand -hex 32)
  cat > "$CRED" <<EOF
# ED Ring Colony — секреты установки $(date -Iseconds). НЕ УДАЛЯТЬ.
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
JWT_SECRET=$JWT_SECRET
ANON_KEY=$ANON_KEY
SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=$DASHBOARD_PASSWORD
CRON_SECRET=$CRON_SECRET
EOF
  chmod 600 "$CRED"
  echo "секреты сгенерированы → $CRED"
fi

# ═════════════════════════════════════════════════════════════════════
step "5/10 Supabase-стек → $SUPA_DIR"
# ═════════════════════════════════════════════════════════════════════
if [ ! -f "$SUPA_DIR/docker-compose.yml" ]; then
  mkdir -p "$SUPA_DIR" /tmp/supabase-src
  curl -fsSL -o /tmp/supabase.tar.gz \
    https://github.com/supabase/supabase/archive/refs/heads/master.tar.gz
  tar xzf /tmp/supabase.tar.gz -C /tmp/supabase-src --strip-components=1
  cp -r /tmp/supabase-src/docker/* "$SUPA_DIR/"
  cp /tmp/supabase-src/docker/.env.example "$SUPA_DIR/.env"
  rm -rf /tmp/supabase.tar.gz /tmp/supabase-src
  echo "стек скачан"
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
# Production email ownership must be verified. Finish SMTP/templates before
# enabling new signups; see POST-MIGRATION.md (never auto-confirm mailboxes).
set_env "$E" ENABLE_EMAIL_AUTOCONFIRM "false"
set_env "$E" DISABLE_SIGNUP "true"
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
        proxy_pass http://127.0.0.1:3000;
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
    location /_next/static/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
}
EOF

if [ "$MODE" = domain ]; then
cat >> "$NG" <<EOF

server {
    listen 80;
    server_name $SUPA_HOST;
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
    client_max_body_size 50m;
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
  certbot --nginx --non-interactive --agree-tos -m "$EMAIL" \
    -d "$ADDR" -d "$SUPA_HOST"
  echo "HTTPS выпущен для $ADDR и $SUPA_HOST"
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
if [ "$DO_CRON" != 1 ]; then set_env "$SE" JOBS_ENABLED ""; fi
chmod 600 "$SE"
ln -sf .env.production "$SRC_DIR/.env"

( cd "$SRC_DIR" && docker compose --env-file .env.production up -d --build )

echo -n "жду ответа сайта"
for i in $(seq 1 36); do
  if curl -sf -o /dev/null http://127.0.0.1:3000; then echo " — работает"; break; fi
  echo -n "."; sleep 5
  [ "$i" = 36 ] && { echo " сайт не ответил — docker logs src-web-1" >&2; exit 1; }
done

# ═════════════════════════════════════════════════════════════════════
step "9/10 Крон-задачи и бэкапы"
# ═════════════════════════════════════════════════════════════════════
if [ "$DO_CRON" = 1 ]; then
  mkdir -p /opt/backups
  cat > /etc/cron.d/ed-ring-colony <<EOF
SHELL=/bin/bash
# Фоновые задачи выполняет compose-сервис jobs. Здесь только бэкапы.
# бэкапы
0 4 * * *  root docker exec supabase-db pg_dump -U postgres -d postgres -Fc > /opt/backups/edrc-\$(date +\%F).dump
30 4 * * * root tar czf /opt/backups/storage-\$(date +\%F).tgz $SUPA_DIR/volumes/storage 2>/dev/null
0 5 * * *  root find /opt/backups -mtime +14 -delete
EOF
  chmod 644 /etc/cron.d/ed-ring-colony
  echo "бэкапы настроены (/etc/cron.d/ed-ring-colony); фоновые задачи — docker compose --env-file .env.production logs jobs"
fi

# ═════════════════════════════════════════════════════════════════════
step "10/10 ГОТОВО"
# ═════════════════════════════════════════════════════════════════════
cat <<EOF

  Сайт:            $SITE_URL
  Supabase Studio: $SUPA_URL  (логин: admin, пароль в $CRED)
  Секреты:         $CRED  (сделайте копию в надёжное место!)
  Бэкапы:          /opt/backups (ежедневно 04:00, ротация 14 дней)

  Проверка:
    docker compose -f $SUPA_DIR/docker-compose.yml ps
    docker ps
    curl -I $SITE_URL

  Логи:
    docker logs -f src-web-1
    docker compose -f $SUPA_DIR/docker-compose.yml logs -f auth

EOF
