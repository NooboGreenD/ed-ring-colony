# Перенос ED Ring Colony с Vercel на VPS / другой хостинг

> **Уже работающий сервер Ubuntu 20.04 / Docker Compose:** начните с
> [UBUNTU20-UPGRADE.md](UBUNTU20-UPGRADE.md), не переустанавливайте стек.
> Новые регистрации требуют SMTP и подтверждения; autoconfirm не включать.
> Для исходников нужен Node >=22.18; Docker-образы используют Node 22.


> **Обновление 20.09.2026:** для уже работающего `edringcolony.ru` используйте
> [POST-MIGRATION.md](POST-MIGRATION.md), а не повторную первоначальную установку.
> Фоновые задачи теперь запускает Docker-сервис `jobs`; Actions оставлен только
> для сборки Uploader. OAuth в self-hosted GoTrue требует compose override,
> одного добавления переменных в `.env` недостаточно.

Инструкция по результатам анализа дистрибутива. Проект подготовлен к переносу:
включён `output: 'standalone'` в `next.config.mjs`, добавлены `Dockerfile`,
`docker-compose.yml`, конфиги nginx/systemd/cron в `deploy/` и расширен
`.env.example`.

---

## 1. Что показал анализ дистрибутива

**Архитектура.** Next.js 16.3.5 / React 19.2.8 (App Router), один Node.js-процесс. Вся
персистентность — во внешнем **Supabase** (Postgres + Auth + Realtime):
на самом хостинге ни базы, ни загруженных файлов нет. Это сильно упрощает
переезд — переносится только веб-приложение.

**Зависимость от Vercel — минимальная.** Проект НЕ использует:
- Vercel Cron (`vercel.json` содержит только настройку git-деплоя, секции
  `crons` нет — все фоновые задачи идут через локальный **Docker-сервис jobs**);
- Vercel Image Optimization (`images.unoptimized: true`);
- Vercel Blob/KV/Postgres/Edge Config;

API-роуты используют Node.js runtime; middleware Next.js остаётся в Edge runtime.

**Что привязано к Vercel и учтено при переносе:**

| Место | Проблема | Решение |
|---|---|---|
| `vercel.json` | прежний git-деплой Vercel | теперь выключен: `deploymentEnabled: false` |
| `src/app/login/actions.ts`, `src/lib/siteUrl.ts` | OAuth origin за reverse proxy | канонический HTTPS `NEXT_PUBLIC_SITE_URL`, default edringcolony.ru |
| `src/app/layout.tsx` | жёсткий OG-url | теперь берётся из `NEXT_PUBLIC_SITE_URL` |
| `src/app/api/cron/translate/route.ts`, `api/galnet` | доверяли `vercel-cron/` User-Agent | обход удалён; только `Bearer CRON_SECRET` / `x-cron-secret` |
| старые Actions cron workflows | внешний scheduler | удалены; все 6 задач перенесены в `jobs`, см. POST-MIGRATION.md |
| `api/atlas/ring-route` | `maxDuration = 300` (на Vercel Hobby ограничен 10–60 с) | на VPS ограничений нет; в `deploy/nginx.conf` выставлен `proxy_read_timeout 310s` |
| `scripts/eddn-worker.ts` | ZeroMQ-воркер, на Vercel не запускался вовсе | на VPS можно наконец включить (см. §7) |

**Требования к серверу:** Node.js ≥ 18.17 (рекомендую 22 LTS), 1 vCPU,
1–2 ГБ RAM (сборка требует ~2 ГБ; можно собирать локально/в CI и заливать
готовый артефакт — см. §5). Диск: сборка ~200 МБ, standalone-выхлоп ~40 МБ +
`public/` ~9 МБ.

---

## 2. Переменные окружения

Скопируйте `.env.example` → `.env.production` и заполните. Ключевые:

| Переменная | Обязательна | Назначение |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | да | URL проекта Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | да | публичный anon-ключ |
| `SUPABASE_SERVICE_ROLE_KEY` | да | серверный ключ для привилегированных роутов |
| `NEXT_PUBLIC_SITE_URL` | **да (на VPS)** | публичный адрес сайта, напр. `https://ring.example.com` — иначе OAuth-редиректы уйдут на старый vercel.app |
| `CRON_SECRET` | да | секрет крон-эндпоинтов |
| `MONITOR_AGENT_TOKEN` | для Docker-мониторинга | отдельный ключ web → private monitor-agent; генерируется и вставляется автоматически скриптом `deploy/start-monitoring.sh` (Compose-профиль `monitoring`), настройка в [MONITORING.md](MONITORING.md) |
| `FRONTIER_REDIRECT_URI` | для CAPI | `https://<домен>/api/capi/callback` |
| `YANDEX_TRANSLATE_API_KEY` / `_FOLDER_ID` | для переводов | Yandex Translate |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | для push | `npx web-push generate-vapid-keys` |
| `EDDN_INGEST_SECRET`, `EDDN_INGEST_URL` | для EDDN-воркера | см. §7 |
| `INARA_API_KEY`, `DISCORD_WEBHOOK_URL`, `RAVEN_API_BASE` | опц. | интеграции |

⚠️ Значения текущих секретов возьмите из Vercel: **Project → Settings →
Environment Variables** (или `vercel env pull .env.production` через CLI).

⚠️ `NEXT_PUBLIC_*` вшиваются в бандл **на этапе сборки** — при их смене нужен
пересбор (`npm run build` / `docker compose build`).

---

## 3. Вариант А — Docker (рекомендуется для VPS)

```bash
# На сервере: Ubuntu 22.04+, установлен Docker + compose-plugin
git clone https://github.com/NooboGreenD/ed-ring-colony.git
cd ed-ring-colony

cp .env.example .env.production
nano .env.production            # заполнить значения из Vercel

# docker-compose читает build-args из .env (не .env.production):
ln -s .env.production .env

docker compose up -d --build
curl -I http://127.0.0.1:3000   # → HTTP 200
```

Приложение слушает `127.0.0.1:3000`; наружу его отдаёт nginx (см. §6).
Обновление: `git pull && docker compose up -d --build`.

Если сайт вдруг отдаёт 502 и нужна **ручная полная пересборка** из
актуального `main` (без кэша, с метаданными ревизии и возможностью отката) —
`bash deploy/rebuild-now.sh` (флаги `NO_PULL=1` / `SKIP_TESTS=1`,
откат — `bash deploy/rebuild-now.sh --rollback`). Для сервера, обновлённого
управляющим скриптом `upgrade.py` (UBUNTU20-UPGRADE.md), этот путь не
применяется — используйте его `status` / `logs` / `rollback`.

То же самое можно не руками, а кнопкой в **Админка → Мониторинг → «Обновление
проекта»** — для этого на хосте один раз включается приватный апдейтер:

```bash
sudo bash deploy/start-update-agent.sh   # = npm run update:enable
```

Он поднимает контейнер `update-agent` (профиль `monitoring`), который единственный
получает Docker-сокет на запись; в `web` по-прежнему нет ни git, ни сокета.
Апдейтер умеет применять недостающие `supabase/migrations/*.sql` (сверка с
`migrations.mark`: и новые между ревизиями, и «забытые» после сбоя) с
обязательным `pg_dump` перед ними, а прогресс виден админу в панели и всем
посетителям в шапке (`System Update` + процент). Подробности и отключение —
в `MONITORING.md`.

### Скорость сборки образа

`next build` идёт Turbopack'ом (дефолт Next 16, ~вдвое быстрее и легче по RAM,
чем старый webpack — на нём сборка и проваливалась на малом VPS по таймауту).
Полный цикл `docker compose up -d --build` на 2 vCPU / 4 ГБ:

- тепло (только изменились исходники) — тесты + сборка, порядка 10–20 минут;
- холодно (сменился `package-lock.json`) — ещё и полный `npm ci`, до 40–60 минут.

Рычаги, если нужно быстрее:

- `RUN_TESTS=0` в `.env.production` — пропустить `npm test` внутри образа
  (экстренный режим; по умолчанию проверки обязательны, но в панели есть
  свой флажок «с тестами» на каждый запуск);
- `UPDATE_TIMEOUT_MINUTES` — по умолчанию лимита НЕТ (старые 45 минут
  отменены: сборка не останавливается по времени). Положительное число
  в `.env.production` вернёт ограничение, 0/off снимет его. Если в файле
  осталась строка `UPDATE_TIMEOUT_MINUTES=45` — удалите её;
- если сборка всё равно не влезает в сервер — вариант §5 (собрать локально и
  залить готовый артефакт).

Если вдруг понадобится старый бандлер — верните `--webpack` в `package.json`
(`dev`/`build`), Dockerfile менять не нужно.

## 4. Вариант Б — без Docker (systemd + Node)

```bash
# 1. Node 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx

# 2. Сборка
git clone https://github.com/NooboGreenD/ed-ring-colony.git /opt/ed-ring-colony/src
cd /opt/ed-ring-colony/src
cp .env.example .env.local && nano .env.local   # NEXT_PUBLIC_* нужны при сборке
npm ci
npm run build

# 3. Выкладка standalone-выхлопа
./deploy/prepare-standalone.sh /opt/ed-ring-colony/app

# 4. Секреты и сервис
cp .env.local /opt/ed-ring-colony/.env.production
sudo chown root:www-data /opt/ed-ring-colony/.env.production
sudo chmod 640 /opt/ed-ring-colony/.env.production

sudo cp deploy/ed-ring-colony.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ed-ring-colony
journalctl -u ed-ring-colony -f
```

Обновление: `git pull && npm ci && npm run build &&
./deploy/prepare-standalone.sh /opt/ed-ring-colony/app &&
sudo systemctl restart ed-ring-colony`.

Кнопкой из админки тот же цикл (git pull → сборка → restart) делает хостовый
апдейтер — `sudo bash
deploy/start-update-agent.sh --host-unit` (он же выбирается автоматически, если
в каталоге нет `docker-compose.yml`): `PROJECT_DEPLOY_MODE=auto` различает два
режима по наличию Docker/unit. Агент слушает `127.0.0.1:8092`, доступ к нему —
по `UPDATE_AGENT_TOKEN`.

## 5. Вариант В — хостинг без сборки на сервере (мало RAM / shared)

Соберите локально или в CI, перенесите только артефакт (~50 МБ):

```bash
# локально
npm ci && npm run build
./deploy/prepare-standalone.sh deploy-out
rsync -az --delete deploy-out/ user@server:/opt/ed-ring-colony/app/

# на сервере
cd /opt/ed-ring-colony/app && PORT=3000 node server.js   # или systemd из §4
```

Для PaaS-хостингов (Railway, Render, Fly.io, Coolify, CapRover, Dokploy):
в репозитории уже есть `Dockerfile` — просто подключите репо, пропишите
переменные окружения (NEXT_PUBLIC_* — и как build-args), готово.

## 6. Nginx + HTTPS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/ed-ring-colony
sudo nano /etc/nginx/sites-available/ed-ring-colony   # server_name → ваш домен
sudo ln -s /etc/nginx/sites-available/ed-ring-colony /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# DNS: A-запись домена → IP сервера, затем:
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ваш-домен
```

В конфиге уже учтены: таймаут 310 с для долгого роута
`/api/atlas/ring-route` (`maxDuration = 300`), `client_max_body_size 25m`
для загрузки журналов, кэш `/_next/static/`.

## 7. Крон-задачи

Все шесть задач перенесены в Docker-сервис `jobs`. Отключите старые Actions
на default branch и cron-вызовы API перед включением сервиса. Резервная копия
базы по расписанию не выполняется: её делает админ вручную из
**Админка → Бэкапы** примерно раз в неделю (см. MONITORING.md). Проверки сайта выполняются во время Docker build; сборка Windows EXE
остаётся в Actions. Полный порядок: [POST-MIGRATION.md](POST-MIGRATION.md).

## 8. Внешние сервисы — smена адреса

После смены домена обновите редиректы:

1. **Supabase** → Authentication → URL Configuration:
   - Site URL → `https://ваш-домен`
   - Redirect URLs → добавить `https://ваш-домен/api/auth/callback` и
     `https://ваш-домен/**`
2. **Discord Developer Portal** (если OAuth через Discord настроен на свой
   апп) → OAuth2 → Redirects: колбэк Supabase не меняется, но проверьте.
3. **Frontier** (`user.frontierstore.net`, если создавали свой CLIENT):
   Redirect URI → `https://ваш-домен/api/capi/callback`; и обязательно
   `FRONTIER_REDIRECT_URI` в `.env.production`.
4. **Десктопный uploader / Colonial Helper**: если в нём захардкожен адрес
   сайта — обновить и пересобрать EXE (workflow `build-exe.yml`). Он
   срабатывает на правки `uploader/**`; если адрес поменялся только на стороне
   сайта, запустите workflow вручную через **Run workflow**.
5. Push-подписки браузеров привязаны к домену — пользователи переподпишутся
   автоматически при первом заходе на новый домен (sw.js отдаётся с него же).

## 9. EDDN-воркер (бонус VPS)

На Vercel `scripts/eddn-worker.ts` (ZeroMQ-подписка на рыночные данные EDDN)
работать не мог. На VPS его можно запустить рядом с сайтом:

```bash
cd /opt/ed-ring-colony/src
npm i zeromq esbuild        # zeromq не в package.json — нативный модуль
npx esbuild scripts/eddn-worker.ts --bundle --platform=node \
  --outfile=/opt/ed-ring-colony/eddn-worker.js --external:zeromq

# systemd-юнит по аналогии с ed-ring-colony.service, окружение:
#   EDDN_INGEST_URL=http://127.0.0.1:3000/api/eddn/ingest
#   EDDN_INGEST_SECRET=<тот же, что в .env.production>
```

## 9a. База данных

Полный комплект для развёртывания БД лежит в `supabase/`:

- **`supabase/full_schema.sql`** — вся схема одним файлом (для нового
  Supabase-проекта: SQL Editor → Run, или `psql -f`);
- **`supabase/migrations/`** — тот же набор в виде миграций для
  `supabase db push` (включая новую `000_base_schema.sql`, которая
  восстанавливает ~45 таблиц и 5 RPC-функций, ранее живших только в проде);
- **`supabase/DATABASE.md`** — инструкция: развёртывание с нуля, докат
  существующей базы, перенос данных `pg_dump`/`pg_restore`, перенос
  Auth-пользователей и Storage-файлов, проверочные запросы.

Если Supabase-проект остаётся прежним (меняется только хостинг сайта) —
с базой ничего делать не нужно.

## 10. Мобильная админка и Android-приложение

### Веб-версия /m-admin (уже в составе сайта, деплоится вместе с web)

Никаких дополнительных шагов не требует — страница `/m-admin` уже в Next.js сборке. После деплоя сайта она доступна по:

```
https://ваш-домен/m-admin
```

- Требует роль `admin`/`moderator`/`support_manager`
- Использует агрегатор `GET /api/mobile/admin-summary` (admin only, no-store)
- PWA манифест `public/manifest-mobile.json` — пользователи могут установить как приложение на телефон (Chrome → Установить)
- В `/admin` есть ссылка 📱 Мобильная админка / Android

Для проверки после деплоя:

```bash
curl -H "Authorization: Bearer <admin-jwt>" https://ваш-домен/api/mobile/admin-summary?period=30d | jq '.health'
```

### Android-приложение android-app/ (отдельный артефакт)

Не деплоится на сервер — собирается как APK и раздаётся отдельно:

```bash
cd android-app
./gradlew assembleDebug   # debug APK
./gradlew assembleRelease # release (нужен keystore в app/build.gradle.kts)
```

- **Base URL**: по умолчанию `https://edringcolony.ru` (в `gradle.properties` `api.base.url` и в `TokenManager.kt` fallback). Для эмулятора с локальным `npm run dev` — `http://10.0.2.2:3000`, для устройства в той же Wi-Fi — `http://192.168.x.x:3000` (указывается на экране логина).
- **Логин**: email/password администратора сайта → `POST /api/mobile/auth` → Bearer JWT в EncryptedSharedPreferences
- **Безопасность**: токены в `secure_prefs` (excluded from backup), `usesCleartextTraffic=false`, никаких секретов в APK
- **Распространение**: загрузите APK в релизы GitHub, в Telegram-канал, или в Google Play (требует signing + Play Console). В `README.md` и `MOBILE-ADMIN.md` уже есть инструкция.

### CI/CD для Android (опционально)

Добавьте в `.github/workflows/`:

```yaml
name: Build Android APK
on: [push, workflow_dispatch]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { java-version: '17', distribution: 'temurin' }
      - run: cd android-app && ./gradlew assembleDebug
      - uses: actions/upload-artifact@v4
        with: { name: apk, path: android-app/app/build/outputs/apk/debug/*.apk }
```

## 11. Чек-лист переезда

- [ ] Секреты выгружены из Vercel (`vercel env pull`) → `.env.production`
- [ ] `NEXT_PUBLIC_SITE_URL` = новый домен
- [ ] `FRONTIER_REDIRECT_URI` = новый домен + `/api/capi/callback`
- [ ] Сайт поднят (§3/§4/§5), `curl -I http://127.0.0.1:3000` → 200
- [ ] nginx + certbot, сайт открывается по HTTPS
- [ ] Supabase Redirect URLs обновлены; вход по email и Discord работает
- [ ] jobs включён, старые Actions/cron отключены без удаления backup-задач
- [ ] Проверены: логин, форум, вики, атлас, карта, push-уведомления, CAPI, **/m-admin** (мобильная админка), `/api/mobile/admin-summary`
- [ ] Android APK собран (`android-app/`) и протестирован на эмуляторе/устройстве
- [ ] DNS переключён на VPS; старый деплой Vercel можно перевести в
      режим редиректа или отключить (Project → Settings → Domains)
- [ ] (опц.) EDDN-воркер запущен
- [ ] Vercel git deployment отключён

## 12. Откат

После переноса БД нельзя считать старый Vercel-деплой актуальным резервом.
Откат делается к сохранённому образу сайта и конфигурациям на своём сервере:
сначала остановите `jobs`, затем верните сайт; не включайте два расписания.
Подробности — [POST-MIGRATION.md](POST-MIGRATION.md), раздел «Откат».
