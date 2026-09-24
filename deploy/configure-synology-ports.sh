#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — одноразовое безопасное переключение портов для Synology.
#
# Итоговая схема:
#   edringcolony.ru          → Synology HTTPS :443 → VM HTTP :9000 → web :3000
#   supabase.edringcolony.ru → Synology HTTPS :443 → VM HTTP :9100 → Supabase
#
# Команда для стандартной установки /opt/ed-ring-colony/src:
#   bash deploy/configure-synology-ports.sh
#
# Скрипт:
#   • сохраняет 127.0.0.1:3000 для локальных health-check;
#   • добавляет Docker-публикацию LAN_IP:9000 через compose.synology.yml;
#   • убирает конфликтующие `listen 9000 ...` из nginx на VM;
#   • проверяет HTTP Supabase на :9100 до переключения;
#   • пересоздаёт web штатным start-docker.sh и проверяет оба backend;
#   • при любой ошибке автоматически возвращает env и nginx.
#
# Переопределения при нестандартной установке:
#   SITE_BIND_IP=192.168.8.177 SITE_PORT=9000 SUPABASE_PORT=9100 \
#   NGINX_SITE=/etc/nginx/sites-available/edringcolony-tls \
#   ENV_FILE=/opt/ed-ring-colony/src/.env.production \
#     bash deploy/configure-synology-ports.sh
# ─────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env.production}"
NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-available/edringcolony-tls}"
SITE_PORT="${SITE_PORT:-9000}"
SUPABASE_PORT="${SUPABASE_PORT:-9100}"
SITE_HOST="${SITE_HOST:-edringcolony.ru}"

say()  { printf '%s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }
die()  { printf 'ОШИБКА: %s\n' "$*" >&2; exit 1; }

as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

port_is_listening() {
  ss -H -ltn 2>/dev/null | awk -v port=":$1" '$4 ~ port "$" { found=1 } END { exit !found }'
}

http_code() {
  local code
  if code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 4 --max-time 10 "$1" 2>/dev/null)"; then
    printf '%s' "$code"
  else
    printf '000'
  fi
}

env_value() {
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true
}

# LAN IP маршрута по умолчанию; на сервере из инструкции это 192.168.8.177.
SITE_BIND_IP="${SITE_BIND_IP:-$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')}"
[ -n "$SITE_BIND_IP" ] || die "не определил LAN IP; запустите с SITE_BIND_IP=192.168.8.177"
case "$SITE_BIND_IP" in
  127.*|0.0.0.0) die "SITE_BIND_IP должен быть LAN-адресом VM, получено: $SITE_BIND_IP";;
esac
case "$SITE_PORT" in ''|*[!0-9]*) die "SITE_PORT должен быть числовым";; esac
case "$SUPABASE_PORT" in ''|*[!0-9]*) die "SUPABASE_PORT должен быть числовым";; esac
[ "$SITE_PORT" -ge 1 ] && [ "$SITE_PORT" -le 65535 ] || die "недопустимый SITE_PORT: $SITE_PORT"
[ "$SUPABASE_PORT" -ge 1 ] && [ "$SUPABASE_PORT" -le 65535 ] || die "недопустимый SUPABASE_PORT: $SUPABASE_PORT"
[ "$SITE_PORT" != "$SUPABASE_PORT" ] || die "порт сайта и Supabase не могут совпадать"

for command in curl docker ip ss awk grep python3; do
  command -v "$command" >/dev/null 2>&1 || die "не найдена команда: $command"
done
command -v sudo >/dev/null 2>&1 || [ "$(id -u)" = 0 ] || die "нужен sudo для изменения nginx"
docker info >/dev/null 2>&1 || die "нет доступа к Docker daemon (проверьте группу docker)"
[ -f "$ENV_FILE" ] || die "не найден env-файл: $ENV_FILE"
[ -w "$ENV_FILE" ] || die "$ENV_FILE недоступен для записи текущему пользователю"
[ -f "$REPO_ROOT/deploy/compose.synology.yml" ] || die "нет deploy/compose.synology.yml — обновите проект"
[ -f "$REPO_ROOT/deploy/start-docker.sh" ] || die "нет deploy/start-docker.sh — обновите проект"
[ -f "$NGINX_SITE" ] || die "не найден nginx-конфиг: $NGINX_SITE (задайте NGINX_SITE=...)"

SUPABASE_HEALTH="http://127.0.0.1:${SUPABASE_PORT}/auth/v1/health"
SUPABASE_STATUS="$(http_code "$SUPABASE_HEALTH")"
[ "$SUPABASE_STATUS" != 000 ] || die "Supabase не отвечает по HTTP на 127.0.0.1:${SUPABASE_PORT}; ничего не меняю"
say "✓ Supabase отвечает на :${SUPABASE_PORT} (HTTP $SUPABASE_STATUS)"

# Повторный запуск безопасен: если env и оба backend уже в нужном состоянии,
# не трогаем ни Docker, ни nginx и не создаём лишние резервные копии.
SITE_HEALTH="http://${SITE_BIND_IP}:${SITE_PORT}/api/health"
if [ "$(env_value PORT)" = 3000 ] \
   && [ "$(env_value PORT_BIND)" = 127.0.0.1:3000:3000 ] \
   && [ "$(env_value SYNOLOGY_SITE_BIND)" = "${SITE_BIND_IP}:${SITE_PORT}" ] \
   && [ "$(http_code "$SITE_HEALTH")" = 200 ]; then
  say "✓ схема уже настроена: сайт ${SITE_BIND_IP}:${SITE_PORT}, Supabase :${SUPABASE_PORT}"
  exit 0
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ENV_BACKUP="${ENV_FILE}.before-synology-${STAMP}"
NGINX_BACKUP="${NGINX_SITE}.before-synology-${STAMP}"
cp -a "$ENV_FILE" "$ENV_BACKUP"
as_root cp -a "$NGINX_SITE" "$NGINX_BACKUP"
say "Резервные копии:"
say "  $ENV_BACKUP"
say "  $NGINX_BACKUP"

ROLLBACK_READY=1
DONE=0
rollback_on_exit() {
  local code="$?"
  trap - EXIT
  if [ "$DONE" != 1 ] && [ "$ROLLBACK_READY" = 1 ]; then
    set +e
    warn "переключение не завершено — возвращаю прежнюю конфигурацию"
    cp -a "$ENV_BACKUP" "$ENV_FILE"
    WEB_URL=http://127.0.0.1:3000/api/health bash "$REPO_ROOT/deploy/start-docker.sh" --restart >/dev/null 2>&1
    as_root cp -a "$NGINX_BACKUP" "$NGINX_SITE"
    as_root nginx -t >/dev/null 2>&1 && as_root systemctl reload nginx
    warn "откат выполнен; резервные копии оставлены на месте"
  fi
  exit "$code"
}
trap rollback_on_exit EXIT

# Пишем значения без source: env-файл содержит секреты и не обязан быть
# безопасным shell-скриптом. Python переписывает файл на месте, сохраняя owner.
python3 - "$ENV_FILE" "$SITE_BIND_IP:$SITE_PORT" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
updates = {
    "PORT": "3000",                         # внутренний порт Next.js
    "PORT_BIND": "127.0.0.1:3000:3000",   # локальный health/nginx VM
    "SYNOLOGY_SITE_BIND": sys.argv[2],       # дополнительный LAN-порт
}
lines = path.read_text(encoding="utf-8").splitlines()
seen = set()
out = []
for line in lines:
    key = line.split("=", 1)[0] if "=" in line and not line.lstrip().startswith("#") else None
    if key in updates:
        if key not in seen:
            out.append(f"{key}={updates[key]}")
            seen.add(key)
        continue
    out.append(line)
for key, value in updates.items():
    if key not in seen:
        out.append(f"{key}={value}")
path.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
PY
chmod 600 "$ENV_FILE" 2>/dev/null || true
say "✓ Docker: localhost:3000 сохранён, Synology backend добавлен на ${SITE_BIND_IP}:${SITE_PORT}"

# :9000 раньше использовался как второй TLS-listener nginx. При прямом backend
# Synology он должен стать обычным HTTP-портом Docker. Удаляем только listen,
# proxy_pass и серверы :443 не затрагиваем.
as_root python3 - "$NGINX_SITE" "$SITE_PORT" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
port = re.escape(sys.argv[2])
pattern = re.compile(rf"^\s*listen\s+(?:\[::\]:)?{port}(?:\s|;)")
lines = path.read_text(encoding="utf-8").splitlines(True)
kept = [line for line in lines if not pattern.match(line)]
path.write_text("".join(kept), encoding="utf-8")
PY
as_root nginx -t
as_root systemctl reload nginx

# Старые worker-процессы nginx могут держать listener доли секунды.
for _ in $(seq 1 20); do
  port_is_listening "$SITE_PORT" || break
  sleep 0.25
done
port_is_listening "$SITE_PORT" && die "порт $SITE_PORT всё ещё занят; найдите конфиг: sudo nginx -T | grep -n 'listen.*$SITE_PORT'"
say "✓ nginx освободил :${SITE_PORT}"

cd "$REPO_ROOT"
WEB_URL="http://127.0.0.1:3000/api/health" bash deploy/start-docker.sh --restart

SITE_HEALTH="http://${SITE_BIND_IP}:${SITE_PORT}/api/health"
SITE_STATUS="$(http_code "$SITE_HEALTH")"
[ "$SITE_STATUS" = 200 ] || die "сайт не ответил на $SITE_HEALTH (HTTP $SITE_STATUS)"
SUPABASE_STATUS="$(http_code "$SUPABASE_HEALTH")"
[ "$SUPABASE_STATUS" != 000 ] || die "после переключения Supabase перестал отвечать на :${SUPABASE_PORT}"

DONE=1
say
say "✓ ГОТОВО"
say "  сайт:     Synology HTTPS :443 → HTTP ${SITE_BIND_IP}:${SITE_PORT} → web :3000"
say "  Supabase: Synology HTTPS :443 → HTTP ${SITE_BIND_IP}:${SUPABASE_PORT}"
say "  локально: http://127.0.0.1:3000 (health-check сохранён)"
say
say "В Synology для обоих назначений нужен протокол HTTP, не HTTPS."
