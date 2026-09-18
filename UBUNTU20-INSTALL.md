# Установка ED Ring Colony на Ubuntu 20.04 (сайт + БД на одной машине)

Подробная инструкция под ваш случай: собственный сервер со статическим
IP, ОС **Ubuntu Server 20.04 LTS**, на машине разворачивается всё —
сайт и база данных (self-hosted Supabase). Перенос файлов — архивом
(`ed-ring-colony-dist.tar.gz`), git и доступ сервера в интернет к GitHub
не обязательны.

> ⚠️ **Важно про Ubuntu 20.04.** Стандартная поддержка закончилась
> 31.05.2025 — без платной подписки Ubuntu Pro (ESM) система не получает
> обновления безопасности. Инструкция полностью рабочая: всё приложение
> живёт в Docker и от возраста ОС не зависит. Но по-хорошему:
> - бесплатно включите Ubuntu Pro (до 5 машин): `sudo pro attach <токен>`
>   (токен на ubuntu.com/pro), **или**
> - запланируйте `do-release-upgrade` до 22.04/24.04 — инструкция
>   останется той же, команды не изменятся.

Смежные документы: `SELFHOST.md` (та же схема, кратко), `SERVER-SETUP.md`
(вариант с облачным Supabase), `supabase/DATABASE.md` (всё про БД).

---

## Часть 0. Что понадобится

| Что | Значение |
|---|---|
| Сервер | Ubuntu 20.04, статический IP, **минимум 4 ГБ RAM** (Supabase-стек ~10 контейнеров), 2+ vCPU, 40+ ГБ SSD |
| Доступ | SSH под root или sudo-пользователем |
| Архив | `ed-ring-colony-dist.tar.gz` (как собрать — Часть 1) |
| Домен | желательно (без него не будет HTTPS и push-уведомлений); работать будет и на голом IP |

Обозначения в командах:
- `ВАШ_IP` — статический IP сервера;
- `[IP]` — шаги для работы по голому IP; `[DOMAIN]` — с доменом.

---

## Часть 1. Собрать архив дистрибутива (на вашем компьютере)

В репозитории есть готовый скрипт:

```bash
cd ed-ring-colony            # корень репозитория
./deploy/make-dist.sh
# → ed-ring-colony-dist.tar.gz (~15–20 МБ) + контрольная сумма
```

В архив входит всё нужное: исходники сайта, `Dockerfile`,
`docker-compose.yml`, полная схема БД (`supabase/full_schema.sql`),
конфиги nginx/cron и эта инструкция. Исключены: `.git`, `node_modules`,
артефакты сборки и файлы с секретами (`.env*`, кроме шаблона
`.env.example`).

Скопируйте архив на сервер:

```bash
scp ed-ring-colony-dist.tar.gz root@ВАШ_IP:/tmp/
# (или через deploy-пользователя, когда создадите его в Части 2)
```

> Нет возможности запустить скрипт? Архив руками:
> `tar czf ed-ring-colony-dist.tar.gz --exclude=ed-ring-colony/.git --exclude=ed-ring-colony/node_modules --exclude=ed-ring-colony/.next --exclude='ed-ring-colony/.env*' ed-ring-colony`
> (из каталога НАД репозиторием).

---

## Часть 2. Подготовка сервера

Подключитесь: `ssh root@ВАШ_IP`.

### 2.1. Обновления и базовые пакеты

```bash
apt update && apt upgrade -y
apt install -y curl ufw ca-certificates gnupg lsb-release
```

### 2.2. Рабочий пользователь

```bash
adduser deploy                 # пароль; на остальные вопросы — Enter
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy   # если вход по ключу
```

Дальше работаем как `deploy`: `ssh deploy@ВАШ_IP`.

### 2.3. Файрвол

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 8000/tcp     # [IP] API Supabase. [DOMAIN] — НЕ открывайте!
sudo ufw enable             # y
sudo ufw status
```

### 2.4. Swap (нужен даже при 4 ГБ — сборка сайта прожорлива)

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 2.5. Docker

На Ubuntu 20.04 версия Docker из apt (`docker.io`) устарела — ставим
официальную, она поддерживает 20.04 (focal):

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy
```

**Перезайдите в SSH** (чтобы группа docker применилась) и проверьте:

```bash
docker --version          # 24+
docker compose version    # v2+
```

> Если `docker compose` (v2, без дефиса) не появился:
> `sudo apt install -y docker-compose-plugin`.

### 2.6. Распаковка архива

```bash
sudo mkdir -p /opt/ed-ring-colony && sudo chown deploy: /opt/ed-ring-colony
tar xzf /tmp/ed-ring-colony-dist.tar.gz -C /opt/ed-ring-colony
mv /opt/ed-ring-colony/ed-ring-colony /opt/ed-ring-colony/src
ls /opt/ed-ring-colony/src     # package.json, Dockerfile, supabase/, deploy/ …
```

---

## Часть 3. База данных (self-hosted Supabase)

### 3.1. Скачать официальный docker-стек Supabase

```bash
cd /tmp
curl -L -o supabase.tar.gz https://github.com/supabase/supabase/archive/refs/heads/master.tar.gz
mkdir -p /tmp/supabase-src && tar xzf supabase.tar.gz -C /tmp/supabase-src --strip-components=1

sudo mkdir -p /opt/supabase && sudo chown deploy: /opt/supabase
cp -r /tmp/supabase-src/docker/* /opt/supabase/
cp /tmp/supabase-src/docker/.env.example /opt/supabase/.env
cd /opt/supabase
```

> Сервер вообще без интернета? Скачайте этот tar.gz на своём компьютере
> и передайте вместе с дистрибутивом; docker-образы тогда переносятся
> через `docker save`/`docker load` — но это заметно сложнее, лучше дать
> серверу исходящий доступ хотя бы на время установки.

### 3.2. Сгенерировать секреты

```bash
/opt/ed-ring-colony/src/deploy/selfhost/generate-keys.sh
```

Скрипт работает и без node на хосте (использует docker). Он напечатает
два блока значений — **сохраните вывод целиком** (например, в файл на
своём компьютере): первый блок пойдёт в `/opt/supabase/.env`, второй —
в `.env.production` сайта. Ключи парные: ANON_KEY/SERVICE_ROLE_KEY
подписаны именно этим JWT_SECRET, менять их по отдельности нельзя.

### 3.3. Заполнить /opt/supabase/.env

`nano /opt/supabase/.env` — замените следующие строки (остальное можно
не трогать):

```env
POSTGRES_PASSWORD=…из генератора…
JWT_SECRET=…из генератора…
ANON_KEY=…из генератора…
SERVICE_ROLE_KEY=…из генератора…
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=…из генератора…

# [IP]:
SITE_URL=http://ВАШ_IP
API_EXTERNAL_URL=http://ВАШ_IP:8000
SUPABASE_PUBLIC_URL=http://ВАШ_IP:8000
ADDITIONAL_REDIRECT_URLS=http://ВАШ_IP/api/auth/callback

# [DOMAIN] (вместо блока выше):
# SITE_URL=https://ваш-домен
# API_EXTERNAL_URL=https://supabase.ваш-домен
# SUPABASE_PUBLIC_URL=https://supabase.ваш-домен
# ADDITIONAL_REDIRECT_URLS=https://ваш-домен/api/auth/callback

# Регистрация по email без своего SMTP: отключаем подтверждение почты
ENABLE_EMAIL_AUTOCONFIRM=true
```

Опционально — вход через Discord (приложение создаётся на
discord.com/developers; Redirect URI в нём = `API_EXTERNAL_URL/auth/v1/callback`):

```env
GOTRUE_EXTERNAL_DISCORD_ENABLED=true
GOTRUE_EXTERNAL_DISCORD_CLIENT_ID=…
GOTRUE_EXTERNAL_DISCORD_SECRET=…
GOTRUE_EXTERNAL_DISCORD_REDIRECT_URI=http://ВАШ_IP:8000/auth/v1/callback
```

### 3.4. Запуск Supabase

```bash
cd /opt/supabase
docker compose pull          # ~2–3 ГБ образов, 5–15 минут
docker compose up -d
docker compose ps            # подождать, пока все Healthy/Running
```

Studio (веб-админка БД): `http://ВАШ_IP:8000` → логин `admin`, пароль
`DASHBOARD_PASSWORD`.

### 3.5. Залить схему ED Ring Colony

```bash
cd /opt/ed-ring-colony/src

docker exec -i supabase-db psql -U postgres -d postgres \
  < supabase/full_schema.sql

docker exec -i supabase-db psql -U postgres -d postgres \
  < supabase/maintenance/create_delivery_source_hash_unique_index_concurrently.sql
```

Проверка (ожидается ~70+ таблиц):

```bash
docker exec supabase-db psql -U postgres -d postgres -c \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public';"
```

> Имя контейнера БД может отличаться в зависимости от версии стека —
> проверьте `docker ps --format '{{.Names}}' | grep db`.

---

## Часть 4. Сайт

### 4.1. Настроить окружение

```bash
cd /opt/ed-ring-colony/src
cp .env.example .env.production
nano .env.production
```

Минимальный набор:

```env
# [IP]
NEXT_PUBLIC_SUPABASE_URL=http://ВАШ_IP:8000
NEXT_PUBLIC_SITE_URL=http://ВАШ_IP
FRONTIER_REDIRECT_URI=http://ВАШ_IP/api/capi/callback

# [DOMAIN] (вместо блока выше)
# NEXT_PUBLIC_SUPABASE_URL=https://supabase.ваш-домен
# NEXT_PUBLIC_SITE_URL=https://ваш-домен
# FRONTIER_REDIRECT_URI=https://ваш-домен/api/capi/callback

NEXT_PUBLIC_SUPABASE_ANON_KEY=…ANON_KEY из шага 3.2…
SUPABASE_SERVICE_ROLE_KEY=…SERVICE_ROLE_KEY из шага 3.2…
CRON_SECRET=…придумайте: openssl rand -hex 32…
```

> ❗ Самая частая ошибка: `NEXT_PUBLIC_SUPABASE_URL` — это адрес, по
> которому Supabase доступен **из браузера посетителя**, НЕ localhost.
> [IP] → `http://ВАШ_IP:8000` (порт открыт в ufw);
> [DOMAIN] → `https://supabase.ваш-домен` (через nginx, порт 8000 закрыт).

Опционально: `YANDEX_TRANSLATE_API_KEY`(+`_FOLDER_ID`) — автопереводы;
`NEXT_PUBLIC_VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` — push
(пара: `docker run --rm node:22-alpine npx web-push generate-vapid-keys`);
`INARA_API_KEY`, `DISCORD_WEBHOOK_URL`.

```bash
ln -s .env.production .env     # docker compose читает build-args отсюда
```

### 4.2. Сборка и запуск

```bash
docker compose up -d --build       # первая сборка 5–10 минут
docker compose ps                  # Up (healthy)
curl -I http://127.0.0.1:3000      # HTTP/1.1 200 OK
```

Сайт слушает только 127.0.0.1:3000 — наружу его выпустит nginx.

---

## Часть 5. Nginx

На Ubuntu 20.04 nginx из apt (1.18) полностью подходит:

```bash
sudo apt install -y nginx
sudo cp /opt/ed-ring-colony/src/deploy/selfhost/nginx-selfhost.conf \
        /etc/nginx/sites-available/ed-ring-colony
sudo ln -s /etc/nginx/sites-available/ed-ring-colony /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
```

**[IP]** — конфиг готов как есть.

**[DOMAIN]** — в файле раскомментируйте второй `server`-блок
(`supabase.ваш-домен` → 127.0.0.1:8000) и подставьте свои домены; DNS:
A-записи `ваш-домен` и `supabase.ваш-домен` → ВАШ_IP.

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Проверка: `http://ВАШ_IP` (или `http://ваш-домен`) — сайт открывается.

### 5.1. [DOMAIN] HTTPS

На Ubuntu 20.04 certbot ставится через snap (apt-версия устарела):

```bash
sudo snap install core && sudo snap refresh core
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/bin/certbot

sudo certbot --nginx -d ваш-домен -d supabase.ваш-домен
sudo certbot renew --dry-run        # автопродление работает

# закрыть прямой доступ к Kong — теперь всё через nginx:
sudo ufw delete allow 8000/tcp
```

После HTTPS проверьте, что в `.env.production` и `/opt/supabase/.env`
везде `https://…`, и пересоберите сайт: `docker compose up -d --build`
(в /opt/ed-ring-colony/src) + `docker compose up -d` (в /opt/supabase).

---

## Часть 6. Крон-задачи и бэкапы

```bash
mkdir -p /opt/backups
crontab -e
```

Вставьте (подставив свой адрес и CRON_SECRET):

```cron
SITE=http://ВАШ_IP
SECRET=ваш_CRON_SECRET

# ── фоновые задачи сайта ──
*/5 * * * *  curl -sf -H "x-cron-secret: $SECRET" "$SITE/api/cron/capi-sync"  > /dev/null
0 */6 * * *  curl -sf -H "x-cron-secret: $SECRET" "$SITE/api/cron/cg-check"   > /dev/null
30 */6 * * * curl -sf -H "x-cron-secret: $SECRET" "$SITE/api/cron/eddn-cleanup" > /dev/null
20 6 * * *   curl -sf -X POST -H "Authorization: Bearer $SECRET" "$SITE/api/galnet" > /dev/null
40 */6 * * * curl -sf -X POST -H "Authorization: Bearer $SECRET" "$SITE/api/cron/translate?limit=10" > /dev/null

# ── бэкапы (база теперь ваша — бэкапы тоже ваши) ──
0 4 * * *  docker exec supabase-db pg_dump -U postgres -d postgres -Fc > /opt/backups/edrc-$(date +\%F).dump
30 4 * * * tar czf /opt/backups/storage-$(date +\%F).tgz /opt/supabase/volumes/storage 2>/dev/null
0 5 * * *  find /opt/backups -mtime +14 -delete
```

Обязательно храните копию бэкапов вне сервера (rclone/scp на другую машину).

---

## Часть 7. Проверка

- [ ] `docker compose ps` в `/opt/supabase` — всё Healthy;
- [ ] Studio (`:8000` или `https://supabase.ваш-домен`) открывается, в
      Table Editor видны таблицы `profiles`, `hubs`, `wiki_articles`…;
- [ ] сайт открывается снаружи;
- [ ] регистрация по email проходит, в `profiles` появляется строка;
- [ ] форум: тема и ответ создаются, у темы обновился «последний ответ»;
- [ ] карта `/map` рендерится, `/systems` грузится;
- [ ] личные сообщения приходят без перезагрузки страницы (Realtime);
- [ ] загрузка аватара в `/account` работает (Storage);
- [ ] `[DOMAIN]` push-уведомления: браузер предлагает подписаться.

### Диагностика

```bash
docker logs -f src-web-1                                   # сайт
docker compose -f /opt/supabase/docker-compose.yml logs -f auth    # регистрация/вход
docker compose -f /opt/supabase/docker-compose.yml logs -f kong    # API-шлюз
docker compose -f /opt/supabase/docker-compose.yml logs -f db      # Postgres
sudo tail -f /var/log/nginx/error.log
```

| Симптом | Причина / решение |
|---|---|
| 502 на сайте | контейнер сайта не поднялся → `docker logs src-web-1` |
| Браузер не может достучаться до Supabase | `NEXT_PUBLIC_SUPABASE_URL` = localhost или порт 8000 закрыт → шаг 4.1 |
| «Invalid JWT» / «JWSError» | ANON_KEY/SERVICE_ROLE_KEY не от этого JWT_SECRET → перегенерировать всё троицей (3.2) |
| «Email not confirmed» при входе | нет SMTP и не включён `ENABLE_EMAIL_AUTOCONFIRM=true` |
| Сообщения только по F5 | [DOMAIN]: в nginx-блоке Supabase нет `Upgrade/Connection` (WebSocket) |
| «relation … does not exist» | схема не залита → шаг 3.5 |
| Сборка сайта: Killed | кончилась RAM → swap (2.4) уже есть? увеличьте до 4G |
| Docker-образы не тянутся | нет исходящего интернета → дать доступ на время установки |

---

## Часть 8. Обновление

Новая версия переносится тем же архивом:

```bash
# на своём компьютере
./deploy/make-dist.sh && scp ed-ring-colony-dist.tar.gz deploy@ВАШ_IP:/tmp/

# на сервере
cd /opt/ed-ring-colony
tar xzf /tmp/ed-ring-colony-dist.tar.gz
rsync -a --delete --exclude='.env*' ed-ring-colony/ src/
rm -rf ed-ring-colony
cd src && docker compose up -d --build

# новые миграции БД (если в supabase/migrations появились новые файлы):
docker exec -i supabase-db psql -U postgres -d postgres \
  < supabase/migrations/ИМЯ_НОВОЙ_МИГРАЦИИ.sql
```

Supabase-стек: раз в квартал `cd /opt/supabase && docker compose pull &&
docker compose up -d` (перед этим — бэкап!).

---

## Шпаргалка (весь путь одним экраном)

| # | Действие |
|---|---|
| 1 | На своём ПК: `./deploy/make-dist.sh` → `scp … root@ВАШ_IP:/tmp/` |
| 2 | Сервер: deploy-пользователь, ufw 22/80/443(+8000 для [IP]), swap, Docker |
| 3 | Распаковать архив в `/opt/ed-ring-colony/src` |
| 4 | Supabase: стек в `/opt/supabase`, `generate-keys.sh`, `.env`, `up -d`, залить `full_schema.sql` |
| 5 | Сайт: `.env.production` (ключи из генератора, URL с ВАШ_IP), `docker compose up -d --build` |
| 6 | nginx из `deploy/selfhost/nginx-selfhost.conf` (+snap-certbot при домене) |
| 7 | crontab: фоновые задачи + ежедневные pg_dump-бэкапы |
| 8 | Чек-лист проверки из Части 7 |
