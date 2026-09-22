# ED Ring Colony на ОДНОЙ машине: сайт + база данных (self-hosted Supabase)

> **Уже работающий сервер Ubuntu 20.04 / Docker Compose:** начните с
> [UBUNTU20-UPGRADE.md](UBUNTU20-UPGRADE.md), не переустанавливайте стек.
> Новые регистрации требуют SMTP и подтверждения; autoconfirm не включать.
> Для исходников нужен Node >=22.18; Docker-образы используют Node 22.


> **Обновление 20.09.2026:** для уже работающего `edringcolony.ru` используйте
> [POST-MIGRATION.md](POST-MIGRATION.md), а не повторную первоначальную установку.
> Фоновые задачи теперь запускает Docker-сервис `jobs`; Actions оставлен только
> для сборки Uploader. OAuth в self-hosted GoTrue требует compose override,
> одного добавления переменных в `.env` недостаточно.

Сценарий: собственный сервер со статическим IP, на нём живёт всё —
Next.js-сайт, Postgres, авторизация, realtime и хранилище файлов.
Никаких внешних облаков.

Смежные документы:
- `SERVER-SETUP.md` — вариант с облачным Supabase (проще, если облако допустимо);
- `supabase/DATABASE.md` — всё про схему БД;
- `DEPLOY.md` — анализ проекта и общие варианты переноса.

> ⚡ **Быстрый путь:** вся установка ниже автоматизирована —
> `sudo bash deploy/selfhost/install.sh --ip ВАШ_IP` (или
> `--domain ваш-домен --email you@mail.com`). Подробности и порядок
> запуска — раздел «Быстрый путь» в `UBUNTU20-INSTALL.md`. Ручные шаги
> ниже — для понимания происходящего и нестандартных случаев.
> Установщик сразу запускает и мониторинг (`monitor-agent`, вкладка
> **Админка → Мониторинг**; ключ попадает в `credentials.txt`). Пропустить —
> флаг `--no-monitor`, включить/перезапустить позже —
> `bash deploy/start-monitoring.sh` (см. `MONITORING.md`).

---

## 0. Выбор ОС — прямой ответ

**Ubuntu Server 24.04 LTS — правильный выбор, менять его не нужно.**
Для схемы «БД и проект на одной машине» ничего лучше нет: вся начинка
(и сайт, и Supabase-стек) работает в Docker, поэтому от ОС требуется
только стабильно запускать Docker — Ubuntu LTS делает это образцово,
а по ней больше всего документации и готовых решений.

Альтернативы, если Ubuntu почему-то не подходит:

| ОС | Когда брать | Комментарий |
|---|---|---|
| **Debian 12** | хотите «то же, но консервативнее» | те же команды apt, чуть меньше свежих пакетов |
| AlmaLinux / Rocky 9 | корпоративный стандарт RHEL | замените apt→dnf, ufw→firewalld |
| Proxmox VE поверх железа | свой физический сервер и планы на несколько сервисов | внутри — та же ВМ с Ubuntu |

Не подходят: Windows Server (весь инструментарий линуксовый),
CentOS (мёртв), FreeBSD (нет нормального Docker).

### Железо для «всё в одном»

Supabase-стек — это ~10 контейнеров (Postgres, Kong, GoTrue, PostgREST,
Realtime, Storage, Studio…), ему одному нужно ~2 ГБ RAM.

| Профиль | CPU | RAM | Диск |
|---|---|---|---|
| Минимум | 2 vCPU | **4 ГБ** | 40 ГБ SSD |
| Рекомендуется | 4 vCPU | 8 ГБ | 80 ГБ SSD (база растёт: журналы, EDDN, форум) |

С 2 ГБ RAM «всё в одном» не взлетит — берите либо больше памяти,
либо схему с облачным Supabase (`SERVER-SETUP.md`).

### Домен или голый IP?

Работать будет и на голом статическом IP (`http://203.0.113.10`), но:

- **HTTPS не будет** — Let's Encrypt не выдаёт сертификаты на IP;
- **push-уведомления не заработают** — Service Worker требует HTTPS;
- **Discord OAuth и Frontier CAPI** капризны к http-редиректам.

Рекомендация: купите любой дешёвый домен и направьте A-записи
`ваш-домен` и `supabase.ваш-домен` на ваш статический IP. Инструкция
ниже описывает оба пути: **[IP]** — только IP, **[DOMAIN]** — с доменом.

---

## 1. Подготовка сервера (Ubuntu 24.04)

```bash
# под root после первого входа
apt update && apt upgrade -y
apt install -y curl git ufw

# отдельный пользователь
adduser deploy && usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy   # если вход по ключу

# файрвол
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 8000/tcp        # [IP] API Supabase (Kong). [DOMAIN] — НЕ открывать!
ufw enable
```

Дальше — под пользователем `deploy` (`ssh deploy@ВАШ_IP`).

Docker:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy
# перезайти в SSH, проверить: docker ps
```

Swap не помешает даже при 4 ГБ:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 2. Self-hosted Supabase

### 2.1. Скачать официальный docker-стек

```bash
sudo mkdir -p /opt && cd /opt
git clone --depth 1 https://github.com/supabase/supabase.git supabase-src
sudo mkdir -p /opt/supabase && sudo chown deploy: /opt/supabase
cp -r /opt/supabase-src/docker/* /opt/supabase/
cp /opt/supabase-src/docker/.env.example /opt/supabase/.env
cd /opt/supabase
```

### 2.2. Сгенерировать секреты

В репозитории сайта есть генератор (нужен node; если ещё не ставили —
`curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs`):

```bash
git clone https://github.com/NooboGreenD/ed-ring-colony.git /opt/ed-ring-colony/src
/opt/ed-ring-colony/src/deploy/selfhost/generate-keys.sh
```

Скрипт напечатает `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`,
`SERVICE_ROLE_KEY`, `DASHBOARD_PASSWORD` — **сохраните вывод**, эти же
значения пойдут и в `.env` Supabase, и в `.env.production` сайта.

### 2.3. Заполнить /opt/supabase/.env

Откройте `nano /opt/supabase/.env` и замените как минимум:

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

# [DOMAIN]:
# SITE_URL=https://ваш-домен
# API_EXTERNAL_URL=https://supabase.ваш-домен
# SUPABASE_PUBLIC_URL=https://supabase.ваш-домен

# Разрешённые OAuth-редиректы (вход/привязка Discord)
ADDITIONAL_REDIRECT_URLS=http://ВАШ_IP/api/auth/callback,http://ВАШ_IP/auth/email
# [DOMAIN]: ADDITIONAL_REDIRECT_URLS=https://ваш-домен/api/auth/callback,https://ваш-домен/auth/email

# До настройки настоящего SMTP новые регистрации закрыты.
# Подтверждение email не отключать; см. UBUNTU20-UPGRADE.md, раздел почты.
ENABLE_EMAIL_AUTOCONFIRM=false
DISABLE_SIGNUP=true
```

Для входа через Discord дополнительно (создать приложение на
discord.com/developers, Redirect в нём: `API_EXTERNAL_URL/auth/v1/callback`):

```env
GOTRUE_EXTERNAL_DISCORD_ENABLED=true
GOTRUE_EXTERNAL_DISCORD_CLIENT_ID=…
GOTRUE_EXTERNAL_DISCORD_SECRET=…
GOTRUE_EXTERNAL_DISCORD_REDIRECT_URI=http://ВАШ_IP:8000/auth/v1/callback
```

#### Вход через VK ID

VK не поддерживается GoTrue, поэтому VK ID реализован на стороне сайта
(OAuth 2.1 + PKCE, `src/lib/vkId.ts`). Настройка целиком в `.env.production`
сервиса **web**, в GoTrue ничего менять не нужно:

1. Создайте приложение на <https://id.vk.com/about/business/go> (платформа *Web*),
   укажите базовый домен `edringcolony.ru` и **Redirect URL**
   `https://edringcolony.ru/api/auth/vk/callback`.
2. Примените миграцию `supabase/migrations/20260923000000_vk_identities.sql`
   (таблица соответствия VK ↔ аккаунт; пишет только service role).
3. В `.env.production` сайта:

```env
VK_ID_CLIENT_ID=51234567          # числовой ID приложения
VK_ID_CLIENT_SECRET=              # только если приложение confidential
```

Кнопка «Войти через VK ID» **по умолчанию скрыта**: её включает
администратор на вкладке «Авторизация» в `/admin` (там же можно ввести
Client ID вместо env). Пошагово — `VK-ID-SETUP.md`. Вход выпускает обычную Supabase-сессию через админский
magic-link-хэш (`SUPABASE_SERVICE_ROLE_KEY` обязателен) — письма не
отправляются. Если VK не отдал e-mail, аккаунт создаётся с технической почтой
`vk-<id>@vk.<домен>`; она не считается способом входа при отвязке.
`DISABLE_SIGNUP=true` в GoTrue на VK-регистрацию не влияет (аккаунт создаёт
service role). Слияния аккаунтов по e-mail нет: если почта из VK уже
зарегистрирована, пользователь получит подсказку войти прежним способом и
привязать VK в профиле.

#### Вход через Яндекс ID

Яндекса тоже нет в GoTrue, поэтому поток реализован на стороне сайта
(OAuth 2.0 + PKCE, `src/lib/yandexId.ts`) — полный аналог VK ID:

1. Создайте приложение на <https://oauth.yandex.ru> (платформа *Веб-сервисы*),
   **Callback URI** `https://edringcolony.ru/api/auth/yandex/callback`,
   доступы `login:email`, `login:info`, `login:avatar`.
2. Примените миграцию `supabase/migrations/20260925000000_yandex_identities.sql`.
3. В `.env.production` сайта (или в карточке «Яндекс ID» в админке):

```env
YANDEX_ID_CLIENT_ID=a1b2…f0       # 32 hex-символа
YANDEX_ID_CLIENT_SECRET=…         # обязателен для веб-приложений
```

Кнопка по умолчанию скрыта и включается на вкладке «Авторизация» в `/admin`.
Пошагово — `YANDEX-ID-SETUP.md`. Сессия, техническая почта
(`yandex-<id>@ya.<домен>`), запрет слияния по e-mail и отвязка последнего
способа входа — как у VK ID.

### 2.4. Запуск

```bash
cd /opt/supabase
docker compose pull
docker compose up -d
docker compose ps        # все сервисы healthy/running (первый старт ~1–2 мин)
```

Studio (админка БД): `http://ВАШ_IP:8000` → логин/пароль DASHBOARD_* из .env.

### 2.5. Развернуть схему ED Ring Colony

```bash
cd /opt/ed-ring-colony/src

# вся схема одним файлом (~1650 стейтментов)
docker exec -i supabase-db psql -U postgres -d postgres \
  < supabase/full_schema.sql

# maintenance-индекс (обязательно отдельно — CONCURRENTLY)
docker exec -i supabase-db psql -U postgres -d postgres \
  < supabase/maintenance/create_delivery_source_hash_unique_index_concurrently.sql
```

Проверка:

```bash
docker exec -i supabase-db psql -U postgres -d postgres -c \
  "SELECT count(*) AS tables FROM pg_tables WHERE schemaname='public';"
# ожидается ~70+
```

Бакеты Storage (`avatars`, `news-covers`, `support-attachments`) создаются
миграциями; проверить можно в Studio → Storage.

---

## 3. Сайт

### 3.1. Окружение

```bash
cd /opt/ed-ring-colony/src
cp .env.example .env.production
nano .env.production
```

```env
# [IP]
NEXT_PUBLIC_SUPABASE_URL=http://ВАШ_IP:8000
NEXT_PUBLIC_SITE_URL=http://ВАШ_IP
FRONTIER_REDIRECT_URI=http://ВАШ_IP/api/capi/callback

# [DOMAIN]
# NEXT_PUBLIC_SUPABASE_URL=https://supabase.ваш-домен
# NEXT_PUBLIC_SITE_URL=https://ваш-домен
# FRONTIER_REDIRECT_URI=https://ваш-домен/api/capi/callback

NEXT_PUBLIC_SUPABASE_ANON_KEY=…ANON_KEY из генератора…
SUPABASE_SERVICE_ROLE_KEY=…SERVICE_ROLE_KEY из генератора…
CRON_SECRET=$(openssl rand -hex 32 — сгенерируйте и вставьте)
```

Важно: `NEXT_PUBLIC_SUPABASE_URL` — это адрес, по которому Supabase
доступен **ИЗ БРАУЗЕРА ПОЛЬЗОВАТЕЛЯ**, а не localhost! Именно поэтому
[IP] — `http://ВАШ_IP:8000` (порт 8000 открыт в ufw), а [DOMAIN] —
`https://supabase.ваш-домен` (порт закрыт, ходим через nginx).

```bash
ln -s .env.production .env    # docker compose берёт build-args отсюда
```

### 3.2. Запуск (Docker; сайт и Supabase соседствуют без конфликтов)

```bash
docker compose up -d --build      # первая сборка 5–10 минут
curl -I http://127.0.0.1:3000     # HTTP/1.1 200 OK
```

(Альтернатива без Docker для сайта — путь B в `SERVER-SETUP.md`, шаг 5.)

---

## 4. Nginx

```bash
sudo apt install -y nginx
sudo cp /opt/ed-ring-colony/src/deploy/selfhost/nginx-selfhost.conf \
        /etc/nginx/sites-available/ed-ring-colony
sudo ln -s /etc/nginx/sites-available/ed-ring-colony /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
```

- **[IP]** — конфиг готов как есть (сайт на :80, Supabase на :8000 напрямую).
- **[DOMAIN]** — раскомментируйте в конфиге второй server-блок
  (`supabase.ваш-домен` → 127.0.0.1:8000), пропишите свои домены, затем:

```bash
sudo nginx -t && sudo systemctl reload nginx

# [DOMAIN] — HTTPS на оба имени:
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ваш-домен -d supabase.ваш-домен
# после этого закройте прямой порт Kong:
sudo ufw delete allow 8000/tcp
```

Проверка: сайт открывается по `http://ВАШ_IP` (или `https://ваш-домен`).

---

## 5. Крон-задачи

В Docker работает сервис `jobs` из основного compose. Не добавляйте поверх
него cron-вызовы API. Все шесть задач, секреты, расписание UTC и переключение
описаны в [POST-MIGRATION.md](POST-MIGRATION.md). Для установки без Docker
есть альтернативный `deploy/crontab.example`.

## 6. Резервное копирование (теперь база ваша — бэкапы тоже ваши!)

```bash
# ежедневный дамп БД (добавьте в crontab: 0 4 * * *)
docker exec supabase-db pg_dump -U postgres -d postgres -Fc \
  > /opt/backups/edrc-$(date +%F).dump

# файлы Storage (аватары, вложения)
tar czf /opt/backups/storage-$(date +%F).tgz /opt/supabase/volumes/storage
```

Держите копии и вне сервера (rclone в любое S3/облако). Восстановление:
`pg_restore -d postgres --clean --if-exists <файл>` внутри контейнера db.

## 7. Проверка

- [ ] `docker compose ps` в /opt/supabase — все контейнеры healthy;
- [ ] Studio открывается, в Table Editor видны таблицы (profiles, hubs…);
- [ ] сайт открывается, после настройки SMTP регистрация требует письма подтверждения;
- [ ] после регистрации в profiles появилась строка (триггер);
- [ ] форум: тема + ответ; карта /map рендерится;
- [ ] личные сообщения приходят без перезагрузки (Realtime/WebSocket);
- [ ] загрузка аватара в /account (Storage).

Диагностика:

```bash
docker compose -f /opt/supabase/docker-compose.yml logs -f auth   # GoTrue
docker compose -f /opt/supabase/docker-compose.yml logs -f kong
docker logs -f src-web-1                                          # сайт
sudo tail -f /var/log/nginx/error.log
```

| Симптом | Причина |
|---|---|
| Сайт: «Missing env vars …SUPABASE…» | .env.production не подхвачен при сборке |
| Браузер: запросы к supabase падают CORS/refused | `NEXT_PUBLIC_SUPABASE_URL` указывает на localhost или закрытый порт — см. 3.1 |
| «Email not confirmed» | Настроить SMTP/шаблоны и повторно отправить письмо; автоподтверждение не включать. См. UBUNTU20-UPGRADE.md. |
| Realtime не работает, сообщения по F5 | [DOMAIN] в nginx-блоке Supabase нет заголовков Upgrade/Connection |
| Push-уведомления молчат | нужен HTTPS → нужен домен |
| «relation does not exist» | схема не применена — шаг 2.5 |

## 8. Обновления

### Кнопкой в админке (без SSH)

```bash
# один раз на сервере — включает приватный апдейтер (см. MONITORING.md)
cd /opt/ed-ring-colony/src && sudo bash deploy/start-update-agent.sh
```

После этого в **Админка → Мониторинг → «Обновление проекта»** появляется
кнопка «Обновить сейчас»: она делает `git fetch` нужной ветки, `pg_dump`
перед миграциями, применяет новые `supabase/migrations/*.sql`, пересобирает
`web`/`jobs`/`monitor-agent` и ждёт ответа `/api/health`. Прогресс по стадиям
виден админу в панели, а в шапке сайта всем посетителям на это время
показывается `System Update` с процентом. Остановка обновления — там же.

### Вручную

```bash
# сайт
cd /opt/ed-ring-colony/src && git pull && docker compose up -d --build
# новые миграции БД (если появились):
ls supabase/migrations/          # свежие файлы применить:
docker exec -i supabase-db psql -U postgres -d postgres \
  < supabase/migrations/НОВАЯ_МИГРАЦИЯ.sql

# Supabase-стек (раз в квартал достаточно; перед этим — бэкап из шага 6!)
cd /opt/supabase && docker compose pull && docker compose up -d
```

---

## Шпаргалка

| # | Действие | Результат |
|---|---|---|
| 0 | Ubuntu 24.04 LTS, 4 ГБ RAM, статический IP (+желательно домен) | сервер |
| 1 | deploy-пользователь, ufw (22/80/443[/8000]), Docker, swap | база |
| 2 | Supabase docker-стек + generate-keys.sh + full_schema.sql | своя БД |
| 3 | .env.production → docker compose up -d --build | сайт на :3000 |
| 4 | nginx-selfhost.conf (+certbot при домене) | вход с :80/:443 |
| 5 | Docker-сервис jobs (без дублирующего cron) | фоновые задачи |
| 6 | pg_dump + tar по крону | бэкапы |
| 7 | чек-лист | всё работает |
