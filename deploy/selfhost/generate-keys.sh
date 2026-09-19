#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Генерация секретов для self-hosted Supabase (всё на одной машине).
#
# Выдаёт три значения, которые нужно вписать в supabase/docker/.env
# (JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY) и в .env.production сайта
# (NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY).
#
# ANON_KEY и SERVICE_ROLE_KEY — это JWT, подписанные JWT_SECRET'ом
# (HS256, срок 10 лет) — ровно так их генерирует supabase.com.
#
# Требуется node ИЛИ docker: если node на хосте нет (например, чистый
# Ubuntu 20.04, где сайт живёт в Docker), скрипт сам использует
# контейнер node:22-alpine.
# Использование:  ./generate-keys.sh
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

JWT_SECRET="$(openssl rand -hex 32)"

# node на хосте или через docker
if command -v node >/dev/null 2>&1; then
  NODE_RUN=(node)
elif command -v docker >/dev/null 2>&1; then
  NODE_RUN=(docker run --rm -i -e JWT_SECRET -e ROLE node:22-alpine node)
else
  echo "Ошибка: нужен node или docker" >&2
  exit 1
fi

sign() {
  local role="$1"
  JWT_SECRET="$JWT_SECRET" ROLE="$role" "${NODE_RUN[@]}" -e '
    const crypto = require("crypto");
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const header  = b64({ alg: "HS256", typ: "JWT" });
    const payload = b64({
      role: process.env.ROLE,
      iss: "supabase",
      iat: now,
      exp: now + 10 * 365 * 24 * 3600,
    });
    const sig = crypto.createHmac("sha256", process.env.JWT_SECRET)
      .update(header + "." + payload).digest("base64url");
    process.stdout.write(header + "." + payload + "." + sig);
  '
}

ANON_KEY="$(sign anon)"
SERVICE_ROLE_KEY="$(sign service_role)"
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
DASHBOARD_PASSWORD="$(openssl rand -hex 12)"

cat <<EOF
# ── Вставьте в supabase/docker/.env ─────────────────────────────────
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
JWT_SECRET=$JWT_SECRET
ANON_KEY=$ANON_KEY
SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=$DASHBOARD_PASSWORD

# ── Вставьте в .env.production сайта ────────────────────────────────
NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
EOF
