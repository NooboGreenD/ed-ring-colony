#!/usr/bin/env bash
# Диагностика HTTP 413 при загрузке базового ColonialHelper.exe из админки.
#
#   bash deploy/selfhost/check-release-upload-limit.sh [https://ваш-домен]
#
# Только чтение: конфиг не правится, nginx не перезапускается, файлы на диске
# не создаются. Аргументом можно передать публичный адрес сайта — тогда скрипт
# дополнительно отправит на /api/admin/uploader/release заведомо «неудобный»
# пустой корпус (27 МиБ, без cookie) и посмотрит, кто именно его отрежет.
#
# Почему корпус 27 МиБ: базовая сборка весит ~25,2 МиБ, глобальный лимит
# проекта — 25m (26 214 400 байт), а отдельный location выдаёт 200m. Значит
# запрос размером 27 МиБ отвечает «той самой» границей: 413 = кто-то режет,
# 401/403 = прокси пропустили тело до приложения (там его отвергнет авторизация).
#
# Переменные окружения для разбора сохранённого вывода (без root):
#   CHECK_NGINX_T_OUTPUT=/path/nginx-T.txt   читать конфиг из файла
#   CHECK_NGINX_ERROR_LOG=/path/error.log    разбор error.log из файла
set -euo pipefail

URL="${1:-}"
TARGET_PATH="/api/admin/uploader/release"
PROBE_BYTES=$((27 * 1024 * 1024))
NGINX_T_OUTPUT="${CHECK_NGINX_T_OUTPUT:-}"
NGINX_ERROR_LOG="${CHECK_NGINX_ERROR_LOG:-/var/log/nginx/error.log}"

ok=0
warn=0
fail=0
note() { printf '%s\n' "$*"; }
pass() { printf '  [OK]   %s\n' "$*"; ok=$((ok + 1)); }
hint() { printf '  [!]    %s\n' "$*"; warn=$((warn + 1)); }
bad()  { printf '  [FAIL] %s\n' "$*"; fail=$((fail + 1)); }

# sudo нужен только для `nginx -T` и чтения error.log.
as_root() {
  if [ "$(id -u)" = "0" ]; then "$@"; return $?; fi
  if command -v sudo >/dev/null 2>&1; then sudo -n "$@"; return $?; fi
  "$@"
}

# ── 1. активная конфигурация nginx ──────────────────────────────────────────
note "Активная конфигурация nginx: каждый server-блок, который отдаёт сайт"
note ""

if [ -n "$NGINX_T_OUTPUT" ]; then
  dump="$(cat "$NGINX_T_OUTPUT")"
elif command -v nginx >/dev/null 2>&1 || command -v sudo >/dev/null 2>&1; then
  if ! dump="$(as_root nginx -T 2>&1)"; then
    bad "не удалось получить вывод 'nginx -T' — запустите: sudo bash deploy/selfhost/check-release-upload-limit.sh"
    dump=""
  fi
else
  bad "nginx не найден в PATH — на этом хосте прокси не nginx?"
  dump=""
fi

# awk раскладывает вывод на server-блоки, считая фигурные скобки: лимит уровня
# server и лимит внутри `location = /api/admin/uploader/release` — это разные
# границы, а комментарии nginx и shell-heredoc в install.sh одинаково игнорируются.
blocks="$(printf '%s\n' "$dump" | awk -v target="$TARGET_PATH" '
  function mib(v,   n, unit) {
    if (v == "") return -1
    n = v + 0
    unit = v
    gsub(/[0-9.[:space:]]/, "", unit)
    if (unit == "k" || unit == "K") return n / 1024
    if (unit == "g" || unit == "G") return n * 1024
    return n
  }
  function clean(s) {
    sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]*;[[:space:]]*$/, "", s)
    sub(/^listen[[:space:]]+/, "", s); sub(/^server_name[[:space:]]+/, "", s)
    return s
  }
  function limitof(s,   l) { l = s; sub(/.*client_max_body_size[[:space:]]+/, "", l); return clean(l) }
  /^# configuration file / {
    f = $0
    sub(/^# configuration file /, "", f)
    sub(/:[[:space:]]*$/, "", f)
    curfile = f
    next
  }
  {
    line = $0
    sub(/#.*$/, "", line)
    if (!inserver) {
      if (line ~ /(^|[[:space:]])server[[:space:]]*\{/) {
        inserver = 1; depth = 1; n += 1
        listen = "-"; name = "-"; srule = ""; locrule = "-"; site = 0; locdepth = 0
        file = (curfile == "" ? "-" : curfile)
      }
      next
    }
    opened = gsub(/\{/, "{", line)
    closed = gsub(/\}/, "}", line)
    if (line ~ /proxy_pass[[:space:]]+[^;]*:3000/) site = 1
    if (depth == 1) {
      if (line ~ /client_max_body_size/) srule = limitof(line)
      if (line ~ /(^|[[:space:]])listen([[:space:]]|$)/) { t = clean(line); listen = (listen == "-" ? t : listen ", " t) }
      if (line ~ /(^|[[:space:]])server_name([[:space:]]|$)/) name = clean(line)
      if (line ~ ("(^|[[:space:]])location[[:space:]]*=[[:space:]]*" target)) locdepth = depth + 1
    } else if (locdepth > 0 && line ~ /client_max_body_size/) {
      locrule = limitof(line)
    }
    depth += opened - closed
    if (locdepth > 0 && depth < locdepth) locdepth = 0
    if (depth <= 0) {
      inserver = 0
      printf "%d\037%s\037%s\037%s\037%d\037%d\037%s\n", n, file, listen, name, site, \
             mib(srule), (locrule == "-" ? -1 : mib(locrule))
    }
  }
' | sort -t"$(printf '\037')" -k1,1n)"

if [ -z "$blocks" ]; then
  if [ -n "$dump" ]; then bad "в выводе nginx -T нет ни одного server-блока"; fi
else
  site_blocks=0
  SEP="$(printf '\037')"
  while IFS="$SEP" read -r idx file listen name site srule lrule; do
    [ "$site" = "1" ] || continue
    site_blocks=$((site_blocks + 1))
    # awk уже перевёл значения в MiB; дробные (kilobyte-запись) округляем вниз,
    # чтобы целочисленные сравнения ниже не падали на «invalid arithmetic».
    srule="${srule%%.*}"; lrule="${lrule%%.*}"
    note "  server-блок #$idx  ← $file"
    note "    listen:        ${listen:-—}"
    note "    server_name:   ${name:-—}"
    note "    server-level:  client_max_body_size $( [ "$srule" = "-1" ] && echo "не задан (nginx ограничивает 1m по умолчанию)" || echo "≈${srule} MiB")"
    if [ "$lrule" = "-1" ]; then
      note "    location:      отсутствует"
      bad "в этом блоке нет location = $TARGET_PATH → 413 вернёт nginx ещё до приложения"
    else
      note "    location:      client_max_body_size ≈${lrule} MiB"
      if [ "$lrule" -ge 200 ]; then
        pass "location разрешает ≈${lrule} MiB — хватает на exe 25,2 МиБ и multipart-обёртку"
      elif [ "$lrule" -le 26 ]; then
        bad "location разрешает только ≈${lrule} MiB — базовая сборка 25,2 МиБ не пройдёт"
      else
        hint "location разрешает ≈${lrule} MiB — ниже проектных 200m, проверьте смысл правки"
      fi
      if [ "$srule" != "-1" ] && [ "$srule" -lt "$lrule" ]; then
        note "    (лимит location перекрывает server-level ≈${srule} MiB — так и должно быть)"
      elif [ "$srule" = "-1" ]; then
        hint "пока location не сработал (другой server-блок, другой Host), лимит будет 1m"
      fi
    fi
    note ""
  done <<< "$blocks"
  [ "$site_blocks" = "0" ] && hint "ни один server-блок не проксирует сайт на :3000 — проверьте, что конфиг включён в sites-enabled"
fi

# ── 2. что говорит error.log ────────────────────────────────────────────────
note "Последние отказы по размеру в error.log"
note ""
if [ -f "$NGINX_ERROR_LOG" ] || as_root test -f "$NGINX_ERROR_LOG" 2>/dev/null; then
  large="$(as_root tail -n 2000 "$NGINX_ERROR_LOG" 2>/dev/null | grep -c 'client intended to send too large body' || true)"
  if [ "${large:-0}" != "0" ]; then
    bad "nginx сам отклонял запросы по размеру ($large раз): location не применяется к запросу"
    as_root tail -n 2000 "$NGINX_ERROR_LOG" 2>/dev/null | grep 'client intended to send too large body' | tail -n 2 | sed 's/^/         /' || true
  else
    pass "строк «client intended to send too large body» нет → 413 выдал не этот nginx"
  fi
else
  hint "нет доступа к $NGINX_ERROR_LOG (запустите с sudo), пропускаю"
fi
note ""

# ── 3. реальный зонд (только если передан адрес сайта) ──────────────────────
if [ -n "$URL" ]; then
  note "Зонд $URL$TARGET_PATH телом $((PROBE_BYTES / 1024 / 1024)) МиБ (без авторизации, корпус — нули)"
  note ""
  if ! command -v curl >/dev/null 2>&1; then
    hint "curl не найден — пропускаю зонд"
  else
    base="${URL%/}"
    hdrs="$(curl -sS -o /dev/null -D - -X POST -H 'Content-Type: application/octet-stream' \
      -H 'Expect:' --data-binary "$(printf 'x')" "$base$TARGET_PATH" 2>/dev/null | tr -d '\r' || true)"
    server_hdr="$(printf '%s\n' "$hdrs" | grep -i '^server:' | tail -n 1 || true)"
    note "  заголовок Server у ближайшего прокси: ${server_hdr:-не представлен}"
    code="$(head -c "$PROBE_BYTES" /dev/zero | curl -sS -o /dev/null -w '%{http_code}' -X POST \
      -H 'Content-Type: application/octet-stream' -H 'Expect:' \
      --data-binary @- "$base$TARGET_PATH" 2>/dev/null || echo '000')"
    case "$code" in
      413) bad "получен 413 на теле $((PROBE_BYTES / 1024 / 1024)) МиБ → лимит стоит до location (или перед nginx)" ;;
      000) hint "запрос не дошёл (сеть/TLS/адрес) — проверьте URL" ;;
      404|405) hint "код $code: путь не совпал с приложением; location = … срабатывает только на точный путь без слэша" ;;
      *) pass "код $code: тело в $((PROBE_BYTES / 1024 / 1024)) МиБ прокси пропустили (401/403 — отказ приложения, это хорошо)" ;;
    esac
    note ""
  fi
else
  note "Зонд пропущен: передайте адрес сайта, чтобы проверить цепочку прокси целиком:"
  note "  bash deploy/selfhost/check-release-upload-limit.sh https://ваш-домен"
  note ""
fi

# ── 4. что делать ───────────────────────────────────────────────────────────
note "Применение и проверка"
note "  1) правьте ТОТ server-блок, который принимает HTTPS (listen 443 ssl):"
note "     локации не наследуются между server-блоками;"
note "     готовый location — в deploy/nginx.conf или deploy/selfhost/nginx-selfhost.conf"
note "  2) sudo nginx -t && sudo systemctl reload nginx"
note "  3) если там уже 200m, а 413 остаётся — ограничивает внешний прокси/CDN"
note "     (Synology Application Portal, Cloudflare, Kong: см. GALAXY-POINTS-PUBLISH-FIX.md)"
note ""
printf 'итоги: %s ok, %s предупреждений, %s проблем\n' "$ok" "$warn" "$fail"
[ "$fail" = "0" ] || exit 1
