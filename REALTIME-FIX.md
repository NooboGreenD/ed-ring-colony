# Supabase Realtime: WebSocket connection failed

Адрес `wss://supabase.edringcolony.ru/realtime/v1/websocket?...&vsn=2.0.0`
правильный. Номер строки минифицированного `7197-….js` показывает место вызова
SDK, но не причину отказа. REST/Auth по HTTPS могут работать при сломанном Upgrade.

## Что исправлено в приложении

Раньше глобальный `NotificationBell` открывал канал **до входа**, отправляя
фильтры `user_id=eq.undefined`. Теперь он и `UnreadBadge`:

- не создают WebSocket и приватный polling для гостя;
- реагируют на вход/выход без перезагрузки страницы;
- используют отдельный канал и фильтр сообщений для текущего UUID;
- не переподписываются при обновлении токена того же пользователя;
- закрывают канал при выходе, смене аккаунта и размонтировании;
- отбрасывают запоздалые результаты предыдущей сессии.

Polling уведомлений/счётчика остаётся резервом при недоступности Realtime.
Это исправляет ошибку жизненного цикла, **но не чинит недоступный серверный WSS**.
Realtime для вошедшего пользователя не отключается и ошибки браузера не скрываются.

## 1. Безопасная проверка на Ubuntu 20.04

Запустите **на самом сервере с Docker**. Никаких ключей вводить или присылать
не нужно. Скрипт читает только существующие контейнеры/config, проверяет Upgrade и
Phoenix heartbeat, не подписывается на таблицы и не меняет данные или настройки.

```bash
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  https://raw.githubusercontent.com/NooboGreenD/ed-ring-colony/97507eb2e0de1a13aff0e44d88ce8cf25b595ec0/deploy/selfhost/realtime-check.py \
  --output /tmp/edrc-realtime-check.py && \
sudo python3 /tmp/edrc-realtime-check.py
```

Проверяются три участка:

1. `realtime_direct` → контейнер Realtime `/socket/websocket`, с его tenant Host;
2. `kong` → фактический локальный адрес Kong `/realtime/v1/websocket`;
3. `public_https` → `https://supabase.edringcolony.ru`, с проверкой TLS.

Успех транспорта: `http_status: 101`, `upgrade_valid: true`,
`phoenix_heartbeat: true`. Один HTTP 101 без корректного handshake/heartbeat
не считается успешной проверкой. `tenant_health_http` — отдельная проверка tenant.
Она не доказывает наличие таблиц в публикации или правильность всех RLS-политик.

Отчёт **не содержит ключи, env, JWT claims, тела ответов или логи**. Этот JSON
можно прислать для определения следующего шага. Код выхода 1 означает, что найден
проблемный участок; это не ошибка запуска скрипта.

Если несколько стеков или другое имя web-сервиса:

```bash
sudo python3 /tmp/edrc-realtime-check.py \
  --kong-container ИМЯ_KONG --web-container ИМЯ_WEB
```

| `diagnosis` / признак | Что проверять |
|---|---|
| `PUBLIC_PROXY_OR_TLS` | Kong отвечает правильно, публичный WSS — нет. Проверить HTTPS reverse proxy, балансировщик/Cloudflare и TLS. Это ещё не доказательство вины именно nginx. |
| `KONG_ROUTE_OR_APIKEY` | Прямой Realtime работает, Kong — нет. Проверить Kong route, upstream и ключ приложения. |
| `REALTIME_NOT_RUNNING` | Контейнер Realtime остановлен. Проверить его локальные логи/причину выхода. |
| `REALTIME_JWT_SECRET_MISMATCH` | Публичный legacy JWT не подписан текущим `API_JWT_SECRET` Realtime. Согласовать конфиг с работающим Auth; не менять JWT_SECRET наугад. |
| `PUBLIC_KEY_EXPIRED` | Проверить актуальный anon-ключ и build args сайта. |
| `REALTIME_OR_LOCAL_NETWORK` | Проверить health контейнера, tenant, сеть Docker и соединение с БД. |
| `TRANSPORT_OK_CHECK_BROWSER_AND_SUBSCRIPTIONS` | Проверить браузерную сеть/расширения, кэш старого JS, фактическую подписку и права. Сравнение ключа использует env web, не содержимое закэшированного бандла. |

HTTP 301/302 обычно означает перенаправление; 400/426 — отсутствие/искажение
Upgrade; 401/403 — ключ/ограничение доступа; 404 — маршрут; 502/503 — upstream.
Это ориентиры, не окончательный диагноз по одному статусу.

## 2. Если не работает только публичный участок: HTTPS nginx

Скрипт показывает `nginx.candidate_config_files`, если nginx установлен на хосте.
Править нужно **действующий `server`, слушающий 443 для
`supabase.edringcolony.ru`**, не `edringcolony.ru` и не только HTTP redirect на 80.

Сначала сохраните выбранный файл **вне включаемых каталогов nginx**:

```bash
# Подставьте реальный путь из отчёта (ниже типичный путь исходного installer).
FILE=/etc/nginx/sites-available/ed-ring-colony
sudo install -d -m 700 /var/backups/edrc-realtime
sudo cp -a "$FILE" "/var/backups/edrc-realtime/nginx-$(date -u +%Y%m%dT%H%M%SZ).conf"
sudoedit "$FILE"
```

Готовый блок: [`deploy/selfhost/nginx-realtime-location.conf`](deploy/selfhost/nginx-realtime-location.conf).
Для стандартного публичного Supabase gateway на **хостовом** nginx:

```nginx
location ^~ /realtime/v1/ {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
    proxy_cache off;
    access_log off;
}
```

**Важные ограничения:**

- Если такой `location` уже есть, исправьте его, не создавайте второй.
- `proxy_pass` выше **без `/` после порта**: префикс `/realtime/v1/` должен дойти
  до Kong. В `/socket/` его переписывает **Kong**, не nginx.
- Используйте фактический `kong_local_origin` из отчёта, если порт не 8000.
- Для **nginx в Docker** `127.0.0.1` — сам nginx. Используйте `http://kong:8000`
  или фактическое имя сервиса на общей сети, не открывая Realtime:4000 наружу.
- Сохраните существующие access controls и proxy headers. Новый `location` не
  наследует ограничения из соседнего `location /`; пользовательские `allow/deny`,
  `auth_request`, `auth_basic` и т.п. необходимо перенести по вашей политике, а
  не обходить. Добавление `proxy_set_header` также меняет правила наследования.
- Сертификаты, остальные маршруты `/auth`, `/rest`, `/storage` и JWT-ключи не менять.
- Если reverse proxy — Caddy/Traefik/Nginx Proxy Manager, не устанавливайте второй
  nginx. Проверьте WebSocket support и маршрутизацию в существующем proxy.

Проверка и применение без остановки nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo python3 /tmp/edrc-realtime-check.py
```

При ошибке верните **свой сохранённый файл** и повторите `nginx -t`/reload.
Не складывайте `.bak` в `sites-enabled` или `conf.d`: glob может подключить backup
как второй виртуальный хост. `access_log off` выше относится только к Realtime,
поскольку WebSocket URL содержит `apikey`.

## 3. Если проблема внутри Supabase

- Ожидаемый Kong WS service: upstream
  `http://realtime-dev.supabase-realtime:4000/socket`, protocol `ws`, path
  `/realtime/v1/`, `strip_path: true`. Не перезаписывайте весь `kong.yml` новым
  примером: версии Kong и auth/key-transformer plugins могут отличаться.
- Имя `realtime-dev.supabase-realtime` намеренное: Realtime определяет tenant
  по Host. Произвольное переименование контейнера/upstream может сломать поиск tenant.
- В стандартном Compose `API_JWT_SECRET` использует тот же существующий
  `JWT_SECRET`, что Auth, и `SEED_SELF_HOST=true`. После переноса `_realtime`
  из другой установки может потребоваться отдельная проверка tenant/encryption key.
  Не удаляйте `_realtime.tenants`, replication slots или тома вслепую.
- Логи `realtime`/`kong` смотрите локально; не присылайте полный env/config или
  JWT. Если нужна перезагрузка, применяйте свой фактический Compose-контекст
  только к проблемному сервису (`up -d --no-deps …`), не `down` всей базы.
- Отсутствующая таблица в `supabase_realtime` или RLS могут блокировать события,
  но не исправляются nginx и не являются доказанной причиной отказа TLS/Upgrade.
  После исправления транспорта проверьте получение уведомлений у двух
  собственных тестовых аккаунтов. Не применяйте `full_schema.sql` для ремонта WSS.

**Из среды разработки:** TLS-соединения к обоим production-доменам обрываются,
поэтому успешный живой WSS здесь не подтверждён. Это не основание объявлять
ваши сертификаты недействительными или отключать проверку TLS. Нужен результат
диагностики с сервера / проверка в реальном браузере после применения изменений.
