#!/bin/sh
# ED Ring Colony — проверка пределов на размер заголовка Cookie.
#
# Зачем: сессия Supabase живёт в cookie и режется на куски по 3180 символов;
# у пилота с несколькими привязанными провайдерами заголовок `Cookie` переходит
# за 8 КиБ. Предел nginx по умолчанию (`large_client_header_buffers 4 8k`) и
# предел Node по умолчанию (16 КиБ) отдают такому запросу 400/431 — сайт не
# открывается вовсе, а в инкогнито открывается (там cookies ещё нет).
#
# Что делает скрипт:
#   1. смотрит действующий конфиг nginx (если он есть на этой машине);
#   2. смотрит предел Node, которым запущен веб-процесс;
#   3. посылает сайту запрос с подставным заголовком Cookie на 9 КиБ и 30 КиБ
#      и показывает, что отвечает сервер.
#
# Использование:
#   sh deploy/diag-cookies.sh                       # проверяет публичный адрес
#   sh deploy/diag-cookies.sh https://example.org
#   sh deploy/diag-cookies.sh http://127.0.0.1:3000 # только приложение
#
# Ничего не меняет: только читает и печатает вердикт.

set -u

SITE="${1:-${NEXT_PUBLIC_SITE_URL:-https://edringcolony.ru}}"
STATUS=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; STATUS=1; }
note() { printf '    %s\n' "$1"; }

# Значение нужной длины без seq: он есть не в каждом минимальном образе.
blob() {
  head -c "$1" /dev/zero | tr '\0' 'x'
}

# Код ответа на запрос с подставным Cookie. 000 — сервер не ответил вовсе.
probe() {
  code=$(curl -s -o /dev/null --max-time 20 -w '%{http_code}' \
    -H "Cookie: edrc_probe=$(blob "$1")" "$SITE/" 2>/dev/null)
  [ -n "$code" ] || code=000
  printf '%s' "$code"
}

echo "Проверка пределов заголовка Cookie для $SITE"

# ── 1. Приложение ────────────────────────────────────────────────────────
echo
echo "1. Приложение (Node)"

for size in 9000 30000; do
  code=$(probe "$size")
  case "$code" in
    400|431)
      bad "Cookie на $size Б → HTTP $code: предел ещё не поднят, сайт не откроется"
      ;;
    000)
      note "Cookie на $size Б → нет ответа (сервер недоступен или таймаут)"
      ;;
    *)
      ok "Cookie на $size Б → HTTP $code"
      ;;
  esac
done

if command -v node >/dev/null 2>&1; then
  limit=$(node -p "require('http').maxHeaderSize" 2>/dev/null || echo "?")
  case "$limit" in
    16384) bad "Node: maxHeaderSize=$limit (по умолчанию; нужен --max-http-header-size=32768)" ;;
    \?)    note "Node: не удалось прочитать maxHeaderSize" ;;
    *)     ok "Node: maxHeaderSize=$limit" ;;
  esac
else
  note "Node на этой машине не установлен — проверьте процесс контейнера:"
  note "  docker compose exec web node -p \"require('http').maxHeaderSize\""
fi

# ── 2. nginx на этой же машине ───────────────────────────────────────────
echo
echo "2. nginx (если установлен здесь)"

NGINX_CONF=""
for candidate in /etc/nginx/nginx.conf /etc/nginx/sites-enabled/*; do
  [ -f "$candidate" ] && NGINX_CONF="$NGINX_CONF $candidate"
done

if [ -z "$NGINX_CONF" ]; then
  note "nginx на этой машине не найден — сайт за другим прокси или контейнером"
else
  found=0
  for file in $NGINX_CONF; do
    # Берём только действующие строки: закомментированное не считается.
    line=$(grep -E '^[[:space:]]*large_client_header_buffers[[:space:]]+[0-9]+' "$file" 2>/dev/null | tail -1)
    [ -z "$line" ] && continue
    found=1
    size=$(printf '%s' "$line" | sed -E 's/.*[[:space:]]([0-9]+)k.*/\1/')
    if [ "${size:-0}" -ge 32 ] 2>/dev/null; then
      ok "$file: $line"
    else
      bad "$file: $line — нужно не меньше 32k"
    fi
  done
  if [ "$found" = 0 ]; then
    bad "в конфигах nginx нет large_client_header_buffers (действует предел 8k)"
    note "Добавьте в блок server:"
    note "  client_header_buffer_size 8k;"
    note "  large_client_header_buffers 8 32k;"
    note "затем nginx -t && systemctl reload nginx"
  fi
fi

echo
if [ "$STATUS" = 0 ]; then
  echo "Итог: пределы подняты, длинная cookie сайт не блокирует."
else
  echo "Итог: есть места, где заголовок ещё режется — см. строки с ✗ выше."
fi
echo "Подробности: COOKIE-SIZE-FIX.md"

exit "$STATUS"
