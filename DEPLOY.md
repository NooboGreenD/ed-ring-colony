# Перенос ED Ring Colony с Vercel на VPS / другой хостинг

Инструкция по результатам анализа дистрибутива. Проект подготовлен к переносу:
включён `output: 'standalone'` в `next.config.mjs`, добавлены `Dockerfile`,
`docker-compose.yml`, конфиги nginx/systemd/cron в `deploy/` и расширен
`.env.example`.

---

## 1. Что показал анализ дистрибутива

**Архитектура.** Next.js 14.2.5 (App Router), один Node.js-процесс. Вся
персистентность — во внешнем **Supabase** (Postgres + Auth + Realtime):
на самом хостинге ни базы, ни загруженных файлов нет. Это сильно упрощает
переезд — переносится только веб-приложение.

**Зависимость от Vercel — минимальная.** Проект НЕ использует:
- Vercel Cron (`vercel.json` содержит только настройку git-деплоя, секции
  `crons` нет — все крон-задачи уже идут через **GitHub Actions**);
- Vercel Image Optimization (`images.unoptimized: true`);
- Vercel Blob/KV/Postgres/Edge Config;
- Edge Runtime (все роуты — обычный Node.js runtime).

**Что привязано к Vercel и учтено при переносе:**

| Место | Проблема | Решение |
|---|---|---|
| `vercel.json` | только git-деплой Vercel | на VPS не используется, можно удалить после переезда |
| `src/app/login/actions.ts`, `src/lib/discordOAuth.ts` | fallback на `https://ed-ring-colony.vercel.app`, если не задан `NEXT_PUBLIC_SITE_URL` | задать `NEXT_PUBLIC_SITE_URL` (добавлен в `.env.example`) |
| `src/app/layout.tsx` | жёсткий OG-url | теперь берётся из `NEXT_PUBLIC_SITE_URL` |
| `src/app/api/cron/translate/route.ts`, `api/galnet` | принимают запросы по User-Agent `vercel-cron/` | не мешает: параллельно принимается `Bearer CRON_SECRET` / `x-cron-secret` — так и работают GitHub Actions и `deploy/crontab.example` |
| `.github/workflows/cron-*.yml` | дергают сайт по секрету `VERCEL_URL` | поменять значение секрета `VERCEL_URL` в GitHub на новый домен (переименовывать не обязательно) |
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

Сейчас все задачи идут из GitHub Actions и стучатся на адрес из секрета
`VERCEL_URL`. **Единственное действие:** в GitHub → Settings → Secrets →
Actions поменять значение `VERCEL_URL` на `https://ваш-домен` (без слэша).

Затрагиваются: `cron-capi-sync.yml` (каждые 5 мин), `cron-cg-check.yml`,
`cron-eddn-cleanup.yml` (каждые 6 ч), `auto-translate.yml` (fallback-ветка),
`galnet-sync.yml` (работает с Supabase напрямую — менять не нужно).

Автономная альтернатива без GitHub — локальный crontab на VPS:
готовый шаблон в `deploy/crontab.example`.

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
   сайта — обновить и пересобрать EXE (workflow `build-exe.yml`).
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

## 10. Чек-лист переезда

- [ ] Секреты выгружены из Vercel (`vercel env pull`) → `.env.production`
- [ ] `NEXT_PUBLIC_SITE_URL` = новый домен
- [ ] `FRONTIER_REDIRECT_URI` = новый домен + `/api/capi/callback`
- [ ] Сайт поднят (§3/§4/§5), `curl -I http://127.0.0.1:3000` → 200
- [ ] nginx + certbot, сайт открывается по HTTPS
- [ ] Supabase Redirect URLs обновлены; вход по email и Discord работает
- [ ] GitHub-секрет `VERCEL_URL` → новый домен (или crontab на VPS)
- [ ] Проверены: логин, форум, вики, атлас, карта, push-уведомления, CAPI
- [ ] DNS переключён на VPS; старый деплой Vercel можно перевести в
      режим редиректа или отключить (Project → Settings → Domains)
- [ ] (опц.) EDDN-воркер запущен
- [ ] (опц.) `vercel.json` удалён из репозитория

## 11. Откат

Vercel-проект остаётся рабочим до его удаления. Для отката достаточно
вернуть DNS на Vercel и секрет `VERCEL_URL` на старый адрес. Изменения в
репозитории обратной совместимости не ломают: `output: 'standalone'` не
мешает деплою на Vercel, все новые файлы (`Dockerfile`, `deploy/`) Vercel
игнорирует.
