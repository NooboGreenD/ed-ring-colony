# Развёртывание ED Ring Colony на собственном сервере — пошагово

Полная инструкция «с нуля до работающего сайта»: выбор ОС и железа,
подготовка сервера, база данных, деплой, домен, HTTPS, автозапуск,
крон-задачи, обновления и диагностика.

Смежные документы:
- `SELFHOST.md` — **всё на одной машине** (сайт + self-hosted Supabase, свой статический IP);
- `DEPLOY.md` — анализ проекта и варианты переноса с Vercel (справка);
- `supabase/DATABASE.md` — всё про базу данных.

---

## Шаг 0. Что понадобится

| Что | Зачем |
|---|---|
| VPS/выделенный сервер | сам сайт (Next.js) |
| Проект Supabase | база, авторизация, realtime (облако supabase.com или self-hosted) |
| Домен | HTTPS и OAuth-редиректы (по «голому» IP сертификат Let's Encrypt не выдаётся) |
| 30–60 минут | по этой инструкции |

---

## Шаг 1. Выбор ОС и характеристик сервера

### Операционная система

**Рекомендуется: Ubuntu Server 24.04 LTS** (поддержка до 2029 года).
Все команды в инструкции написаны под неё.

Также подходят без изменений в командах:
- Ubuntu Server 22.04 LTS;
- Debian 12 «Bookworm» (та же apt-экосистема).

Подходят с поправками (другой пакетный менеджер — dnf, firewalld вместо ufw):
- AlmaLinux / Rocky Linux 9 — если привычнее RHEL-семейство.

Не подходят/не рекомендуются:
- Windows Server — всё заточено под Linux (systemd, nginx, bash-скрипты);
- CentOS 7/8 — сняты с поддержки;
- Alpine в качестве хостовой ОС — можно, но выигрыша нет, а нюансов много
  (Alpine и так используется внутри Docker-образа).

### Характеристики

| Профиль | CPU | RAM | Диск | Комментарий |
|---|---|---|---|---|
| Минимум (сборка вне сервера) | 1 vCPU | 1 ГБ | 10 ГБ SSD | артефакт заливается готовым (вариант В в DEPLOY.md) |
| **Рекомендуется** | 2 vCPU | 2 ГБ | 20 ГБ SSD | сборка прямо на сервере, запас под рост |
| С EDDN-воркером и запасом | 2 vCPU | 4 ГБ | 40 ГБ SSD | комфортно всё сразу |

Важно про RAM: `npm run build` у Next.js требует ~2 ГБ. На сервере с 1 ГБ
либо собирайте локально/в CI, либо добавьте swap (шаг 2.4) — иначе сборка
упадёт по OOM.

Локация: база данных остаётся в Supabase, поэтому сервер выбирайте ближе
к региону вашего Supabase-проекта (меньше задержка API-роутов к базе), а
не обязательно к игрокам — статику браузер всё равно кэширует.

---

## Шаг 2. Первичная настройка сервера

Все команды — под root или через sudo. Подключение: `ssh root@IP_СЕРВЕРА`.

### 2.1. Обновление и базовые пакеты

```bash
apt update && apt upgrade -y
apt install -y curl git ufw
```

### 2.2. Отдельный пользователь (не работать под root)

```bash
adduser deploy                # придумайте пароль, остальное можно пропустить (Enter)
usermod -aG sudo deploy

# перенести SSH-ключ root'а новому пользователю (если входили по ключу)
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

Дальше входите как `ssh deploy@IP_СЕРВЕРА` и используйте `sudo`.

### 2.3. Файрвол

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable            # ответить y
sudo ufw status
```

Порт 3000 наружу НЕ открываем — приложение слушает только localhost,
наружу его отдаёт nginx.

### 2.4. Swap (обязательно при RAM ≤ 2 ГБ)

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 2.5. (Рекомендуется) SSH-гигиена

В `/etc/ssh/sshd_config`: `PermitRootLogin no`, `PasswordAuthentication no`
(только если настроен вход по ключу!), затем `sudo systemctl restart ssh`.

---

## Шаг 3. База данных (Supabase)

Сайт хранит всё в Supabase — на самом сервере базы нет.

**Если Supabase-проект уже существует** (переезжаете только хостингом) —
пропустите этот шаг, понадобятся лишь его URL и ключи.

**Если разворачиваете с нуля:**

1. Создайте проект на [supabase.com](https://supabase.com) (регион — ближе
   к серверу). Бесплатного тарифа для старта достаточно.
2. SQL Editor → New query → вставьте целиком `supabase/full_schema.sql`
   из репозитория → Run. Должно завершиться без ошибок (~1650 стейтментов).
3. Отдельным запросом выполните содержимое
   `supabase/maintenance/create_delivery_source_hash_unique_index_concurrently.sql`.
4. Storage → проверьте бакеты `avatars`, `news-covers`,
   `support-attachments` (создаются миграциями; если нет — создайте вручную,
   `avatars` и `news-covers` публичные).
5. Authentication → Providers → включите **Email**; для входа через Discord —
   включите **Discord** (Client ID/Secret из Discord Developer Portal)
   и опцию Manual linking.
6. Authentication → URL Configuration:
   - Site URL: `https://ваш-домен`
   - Redirect URLs: `https://ваш-домен/api/auth/callback` и `https://ваш-домен/**`
7. Запишите из Settings → API: **Project URL**, **anon key**,
   **service_role key**.

Подробности и другие сценарии (докат живой базы, перенос данных,
self-hosted) — в `supabase/DATABASE.md`.

---

## Шаг 4. DNS

У регистратора домена создайте A-запись:

```
ваш-домен.ru      A      IP_СЕРВЕРА
```

(и при желании `www` → туда же). Проверка: `dig +short ваш-домен.ru`
должен вернуть IP сервера. Обновление DNS занимает от минут до часов —
запустите этот шаг заранее, сертификат на шаге 7 без него не выдастся.

---

## Шаг 5. Установка приложения

Два равнозначных пути. **Путь A (Docker)** — проще обновлять и изолировать.
**Путь B (systemd + Node)** — меньше слоёв, чуть меньше потребление памяти.
Выберите один.

### Путь A: Docker

#### A1. Установка Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy
# перезайдите в SSH-сессию, чтобы группа применилась
docker --version
```

#### A2. Клонирование и настройка

```bash
sudo mkdir -p /opt/ed-ring-colony && sudo chown deploy: /opt/ed-ring-colony
git clone https://github.com/NooboGreenD/ed-ring-colony.git /opt/ed-ring-colony/src
cd /opt/ed-ring-colony/src

cp .env.example .env.production
nano .env.production
```

Заполните (минимальный рабочий набор):

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co     # шаг 3.7
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...                  # anon key
SUPABASE_SERVICE_ROLE_KEY=eyJ...                      # service_role key
NEXT_PUBLIC_SITE_URL=https://ваш-домен                # БЕЗ слэша в конце
CRON_SECRET=длинная_случайная_строка                  # openssl rand -hex 32
FRONTIER_REDIRECT_URI=https://ваш-домен/api/capi/callback
```

Опционально: `YANDEX_TRANSLATE_API_KEY` (+`_FOLDER_ID`) — автопереводы;
`NEXT_PUBLIC_VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` —
push-уведомления (пара генерируется `npx web-push generate-vapid-keys`);
`INARA_API_KEY`, `DISCORD_WEBHOOK_URL`.

```bash
# docker-compose читает build-args из .env:
ln -s .env.production .env
```

#### A3. Сборка и запуск

```bash
docker compose up -d --build      # первая сборка 5–10 минут
docker compose ps                 # STATUS: Up (healthy)
curl -I http://127.0.0.1:3000     # HTTP/1.1 200 OK
```

Переходите к шагу 6.

### Путь B: systemd + Node (без Docker)

#### B1. Node.js 22 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v    # v22.x
```

#### B2. Клонирование, окружение, сборка

```bash
sudo mkdir -p /opt/ed-ring-colony && sudo chown deploy: /opt/ed-ring-colony
git clone https://github.com/NooboGreenD/ed-ring-colony.git /opt/ed-ring-colony/src
cd /opt/ed-ring-colony/src

cp .env.example .env.local
nano .env.local        # заполнить как в A2 (NEXT_PUBLIC_* нужны на этапе сборки)

npm ci
npm run build          # ~1–2 минуты, нужно ~2 ГБ RAM (см. шаг 2.4)

# собрать готовый к запуску каталог из standalone-выхлопа
./deploy/prepare-standalone.sh /opt/ed-ring-colony/app
```

#### B3. Файл секретов и systemd-сервис

```bash
cp .env.local /opt/ed-ring-colony/.env.production
sudo chown root:www-data /opt/ed-ring-colony/.env.production
sudo chmod 640 /opt/ed-ring-colony/.env.production
sudo chown -R www-data:www-data /opt/ed-ring-colony/app

sudo cp deploy/ed-ring-colony.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ed-ring-colony

systemctl status ed-ring-colony     # active (running)
curl -I http://127.0.0.1:3000       # HTTP/1.1 200 OK
```

Логи: `journalctl -u ed-ring-colony -f`.

---

## Шаг 6. Nginx (reverse-proxy)

```bash
sudo apt install -y nginx
sudo cp /opt/ed-ring-colony/src/deploy/nginx.conf /etc/nginx/sites-available/ed-ring-colony
sudo nano /etc/nginx/sites-available/ed-ring-colony
#   → замените server_name your-domain.example на ваш домен

sudo ln -s /etc/nginx/sites-available/ed-ring-colony /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Проверка: `http://ваш-домен` в браузере — сайт должен открыться (пока по HTTP).

В конфиге уже учтены особенности проекта: таймаут 310 с для долгого роута
поиска маршрута, `client_max_body_size 25m` для загрузки журналов пилотов,
кэширование `/_next/static/`.

## Шаг 7. HTTPS (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ваш-домен          # + -d www.ваш-домен, если нужно
```

Certbot сам допишет SSL-блоки в конфиг nginx и настроит автопродление
(проверить: `sudo certbot renew --dry-run`).

Проверка: `https://ваш-домен` открывается с замком.

## Шаг 8. Крон-задачи

Фоновые задачи (CAPI-синк каждые 5 минут, Galnet раз в сутки, переводы,
очистки) уже запускаются из GitHub Actions этого репозитория.

**Если используете GitHub Actions** (форк/оригинальный репо ваш):
GitHub → Settings → Secrets and variables → Actions → секрет `VERCEL_URL`
установить в `https://ваш-домен` (без слэша). Всё.

**Если хотите автономность от GitHub** — локальный cron на сервере:

```bash
crontab -e
# вставьте строки из /opt/ed-ring-colony/src/deploy/crontab.example,
# заменив SITE на https://ваш-домен и SECRET на ваш CRON_SECRET
```

## Шаг 9. Проверка работоспособности

Пройдитесь по чек-листу в браузере:

- [ ] главная страница открывается по HTTPS;
- [ ] регистрация по email → в Supabase (Table Editor → profiles) появилась строка;
- [ ] вход через Discord (если настроен) — редирект возвращает на ваш домен;
- [ ] форум: создание темы и ответа;
- [ ] карта `/map` рендерится (Three.js), системы `/systems` грузятся;
- [ ] `/account` — загрузка журнала работает (лимит 25 МБ в nginx уже стоит);
- [ ] push-уведомления (если VAPID-ключи заданы) — браузер предлагает подписку.

Диагностика, если что-то не так:

```bash
# Путь A
docker compose logs -f web
# Путь B
journalctl -u ed-ring-colony -f
# nginx
sudo tail -f /var/log/nginx/error.log
```

| Симптом | Причина |
|---|---|
| 502 Bad Gateway | приложение не запущено / упало — смотреть логи приложения |
| OAuth уводит на ed-ring-colony.vercel.app | не задан `NEXT_PUBLIC_SITE_URL` при сборке → задать и пересобрать |
| «Missing env vars …SUPABASE…» в логах | .env.production не подхвачен (путь, права) |
| Supabase-ошибки «relation does not exist» | схема не развёрнута → шаг 3 / DATABASE.md |
| Сборка падает без ошибки (Killed) | не хватило RAM → swap (шаг 2.4) или сборка локально |

## Шаг 10. Обновление сайта

```bash
# Путь A (Docker)
cd /opt/ed-ring-colony/src
git pull
docker compose up -d --build

# Путь B (systemd)
cd /opt/ed-ring-colony/src
git pull
npm ci && npm run build
./deploy/prepare-standalone.sh /opt/ed-ring-colony/app
sudo chown -R www-data:www-data /opt/ed-ring-colony/app
sudo systemctl restart ed-ring-colony
```

Новые миграции БД (если появились в `supabase/migrations/`) применяются
через SQL Editor или `supabase db push` — см. `supabase/DATABASE.md`.

## Шаг 11 (опционально). EDDN-воркер

Живой поток рыночных данных Elite Dangerous (ZeroMQ). На Vercel он работать
не мог, на своём сервере — можно:

```bash
cd /opt/ed-ring-colony/src
npm i zeromq esbuild
npx esbuild scripts/eddn-worker.ts --bundle --platform=node \
  --outfile=/opt/ed-ring-colony/eddn-worker.js --external:zeromq
```

Создайте `/etc/systemd/system/eddn-worker.service` по образцу
`deploy/ed-ring-colony.service`, заменив:

```ini
ExecStart=/usr/bin/node /opt/ed-ring-colony/eddn-worker.js
Environment=EDDN_INGEST_URL=http://127.0.0.1:3000/api/eddn/ingest
# EDDN_INGEST_SECRET возьмётся из EnvironmentFile (.env.production)
```

`sudo systemctl enable --now eddn-worker`. Не забудьте задать
`EDDN_INGEST_SECRET` в `.env.production` (и перезапустить сайт).

---

## Итоговая шпаргалка

| # | Шаг | Результат |
|---|---|---|
| 1 | Ubuntu 24.04 LTS, 2 vCPU / 2 ГБ / 20 ГБ SSD | сервер |
| 2 | пользователь deploy, ufw (22/80/443), swap | подготовка |
| 3 | Supabase: full_schema.sql, провайдеры, Redirect URLs, ключи | база |
| 4 | A-запись домена → IP | DNS |
| 5 | Docker compose **или** Node+systemd, `.env.production` | сайт на 127.0.0.1:3000 |
| 6 | nginx из `deploy/nginx.conf` | сайт на :80 |
| 7 | certbot | HTTPS |
| 8 | секрет `VERCEL_URL` в GitHub **или** crontab | фоновые задачи |
| 9 | чек-лист проверки | всё работает |
| 10 | git pull + rebuild | обновления |
| 11 | EDDN-воркер | опционально |
