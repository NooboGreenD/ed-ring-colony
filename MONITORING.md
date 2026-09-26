# Мониторинг сервера — веб, мобильная админка и Android-приложение

В проект добавлены три взаимосвязанных интерфейса мониторинга:

1. **Админка → Мониторинг** (`/admin?tab=monitor`) — десктопная панель, отвечает на вопросы «жив ли сайт», «доступна ли БД», «сколько база весит», «выполняются ли фоновые задачи», «запущены ли контейнеры», «сколько статей ждут перевода», «отличается ли версия от `main`». Отсюда же — ручное обновление проекта с прогрессом в шапке сайта для всех посетителей.
2. **Мобильная админка `/m-admin`** — PWA-ready, полностью адаптированная под телефон, 9 вкладок по всем пунктам админки (Обзор, Монитор, Биллинг, Системы, Контент, Юзеры, Поддержка, Бэкапы, Auth), bottom nav в стиле HUD, автообновление 20с, использует агрегатор `/api/mobile/admin-summary`.
3. **Android-приложение `android-app/`** — нативное Kotlin + Compose, повторяет все пункты админки, Bearer JWT, EncryptedSharedPreferences, Retrofit, 9 экранов, APK через Gradle. Документация: `MOBILE-ADMIN.md`.

Все три используют единый бэкенд `getServerMonitorSnapshot()` (`src/lib/serverMonitor.ts`) и агрегатор `/api/mobile/admin-summary`.

Панель `/admin?tab=monitor` и API `/api/admin/monitor` доступны только роли `admin`. Мобильные API `/api/mobile/*` — роли `admin`, `moderator`, `support_manager`. На них нет Docker-сокета, секретов, логов, переменных окружения или данных пользователей. Docker-agent в opt-in Compose-профиле `monitoring`.

## Одна команда (Ubuntu 20.04 Desktop)

Для свежего сервера (или сервера, где этим никогда не занимались) — одна
команда: ставит Docker, клонирует репозиторий, включает и мониторинг, и
кнопку «Обновить сейчас», и управление API-ключами из панели:

```bash
curl -fsSL https://raw.githubusercontent.com/NooboGreenD/ed-ring-colony/main/deploy/monitoring-setup.sh | sudo bash
```

или, если клон уже есть на машине, из его корня:

```bash
sudo bash deploy/monitoring-setup.sh
```

Что делает скрипт (идемпотентный — повторный запуск безопасен):

- ставит `git`, `curl`, `ca-certificates` и Docker Engine
  (`get.docker.com`), добавляет выполняющего пользователя в группу `docker`;
- при отсутствии клона клонирует `NooboGreenD/ed-ring-colony` в
  `/opt/ed-ring-colony/src`; при повторном запуске делает `git fetch` +
  `merge --ff-only` текущей ветки;
- `deploy/start-monitoring.sh` — создаёт `.env.production`, вставляет ключи
  `MONITOR_AGENT_TOKEN` и `CRON_SECRET`, зеркалирует `MONITOR_DB_URL` из
  `DATABASE_URL`/`SUPABASE_DB_URL`, собирает и поднимает `web`, `jobs` и
  `monitor-agent` (профиль `monitoring`);
- `deploy/start-update-agent.sh` — генерирует `UPDATE_AGENT_TOKEN` и запускает
  апдейтер (контейнер `update-agent` или хостовый unit `ed-ring-colony-update`);
- в конце печатает, какие ключи ещё осталось задать вручную (например
  `SUPABASE_SERVICE_ROLE_KEY`, `YANDEX_TRANSLATE_API_KEY`) и где открыть
  панель.

Существующие значения в `.env.production` скрипт не перезаписывает, к базе и
к данным не лезет. Флаги:

```bash
sudo bash deploy/monitoring-setup.sh \
  --repo-dir /var/www/ed-ring-colony \
  --branch main \
  --env-file /var/www/ed-ring-colony/.env.production \
  --no-docker-install   # Docker уже стоит
  --no-update-agent     # только мониторинг, без кнопки обновления
  --no-pull             # не делать git fetch/pull
```

## Что показывает панель (десктоп + мобильная + Android — одинаковые данные)

Все три интерфейса показывают один и тот же снапшот `ServerMonitorSnapshot`, только в разной вёрстке:

- **Приложение** — ответ текущего Next.js-процесса, его uptime, Node и память. В `/m-admin` и Android — карточка «Приложение» с UPTIME/NODE/RSS/HEAP monospace.
- **База данных** — короткий запрос к `profiles` через Supabase REST под service-role; ответ и строки БД не сохраняются. + размер БД (`pg_database_size`) и топ таблиц. В мобильной версии — карточка «База данных» с SIZE/LATENCY/LARGEST + pill статуса.
- **Docker** — `web`, `jobs`, `monitor-agent`: состояние, healthcheck, время старта, число рестартов, память и CPU. В `/m-admin` и Android — список контейнеров с цветным левым бордером (зелёный=running healthy, красный=stopped/unhealthy) + pill.
- **Фоновые задачи** — время последнего успешного запуска, следующий слот и, если задача падает, её последняя ошибка из `jobs-state.json` (`lastError`/`lastFailureAt`/`failures`). В мобильной — карточка «Фоновые задачи» с jobs, last/next monospace + ошибка на жёлтом фоне WarningBg.
- **Версия** — хеш развёрнутой сборки и хеш `main` на GitHub, кэш 5 минут. В мобильной — CURRENT (оранжевый) / UPSTREAM (cyan) / AHEAD / MIGRATIONS, список миграций на красном фоне если есть.
- **Место на диске** — реальный вес БД (`pg_database_size`), данные/индексы/TOAST по 12 таблицам, свободное место (statfs от monitor-agent), `Замерено:` и предупреждение <5GiB. В мобильной — USED/FREE + thin progress bar 6px, Line bg, fill orange/red если >90%.
- **Контент и переводы** — последняя синхронизация Galnet (`galnet_sync_log`), сколько статей ждут перевода, `YANDEX_TRANSLATE_API_KEY` configured, кнопки «Синхронизировать Galnet сейчас» / «Добить переводы». В мобильной — TRANSLATE configured + PENDING total + lastSync + queue.
- **Обновление проекта** — текущая/ upstream ревизия, aheadBy, pendingMigrations, прогресс ручного обновления по стадиям, лог, кнопки «Обновить сейчас»/«Остановить». В мобильной — карточка «Обновление проекта» + updater connected/active.
- **API-ключи сайта** — `.env.production` в маскировке + «Применить (пересоздать web)». В мобильной пока только просмотр через app_flags, действия — в десктопной.
- **Дополнительно для мобильной агрегатор** (`/api/mobile/admin-summary`):
  - Overview counts: profiles, hubs, routeSystems, news, forumThreads/Posts, comments, ticketsOpen/Total, apiTokens, galaxySystems, galnetPending
  - Billing: revenue total/avgCheck/arpu, transactions total, subs active/churn, telemetry (pilots/systems/facilities/tonnage/tickets/tokens), topProducts
  - Lists: hubs (100), routeSystems (30), recentNews (10), backupLog (5)
  - Content: site_content row, app_flags
  - Health: overall/app/database/docker/disk/project — для pills в topbar

### Мобильная специфика

- **Веб `/m-admin`**: React Client Component, `authFetch` + `supabase.auth.getUser()` для роли, `useState` + `useCallback` load + `setInterval 20s` auto-refresh, bottom nav 9 вкладок (HUD icons ◧◍₿⬡☰👤🎧💾🔒), HudCard/StatCard/StatusPill компоненты, PWA manifest-mobile.json.
- **Android**: Kotlin Compose, `TokenManager` EncryptedSharedPreferences, `RetrofitClient` + `AuthInterceptor` Bearer, `MonitorRepository.getSummary(period)`, `MainActivity` Scaffold TopBar (56dp) + BottomBar (64dp) + `NavHost` 9 screens + `LaunchedEffect delay 20s` polling, `LoadingView`/`ErrorView`.
- **Безопасность**: токены excluded from backup (backup_rules.xml), `usesCleartextTraffic=false`, API требует admin роль, никаких секретов в APK.

## Включение на Docker Compose сервере

### Автоматически (рекомендуется)

Одна идемпотентная команда из корня репозитория:

```bash
bash deploy/start-monitoring.sh      # то же самое: npm run monitoring:up
```

Скрипт сам:

- создаёт `.env.production` из `.env.example`, если файла ещё нет;
- генерирует и вставляет недостающие ключи `MONITOR_AGENT_TOKEN` и
  `CRON_SECRET` (существующие значения не трогают, поэтому повторный запуск
  безопасен), дописывает `PROJECT_REPOSITORY` / `PROJECT_UPDATE_BRANCH`;
- находит стек self-hosted Supabase (контейнер `supabase-db`) и:
  - записывает имя его docker-сети в `SUPABASE_NETWORK` и подключает
    `web` + `monitor-agent` к ней (`deploy/compose.supabase-net.yml`) — после
    этого ссылка `postgresql://postgres:ПАРОЛЬ@db:5432/postgres` в
    `SUPABASE_DB_URL`/`MONITOR_DB_URL` работает из контейнеров, и ошибки
    «getaddrinfo EAI_AGAIN db» больше нет;
  - при пустом `SUPABASE_DB_URL` собирает его сам из `POSTGRES_PASSWORD`
    стека Supabase (значение не выводится);
  - в конце проверяет, что хост `db` резолвится из `web` и `monitor-agent`;
- передаёт в сборку метаданные ревизии `APP_GIT_SHA`, `APP_GIT_REF`,
  `APP_BUILD_TIME` (вне Git-клона — безопасное значение `unknown`) и
  записывает их в `.env.production`: ручная пересборка `docker compose up
  -d --build` тоже подхватит их из `${APP_GIT_SHA:-unknown}` — блок
  «Версия проекта» сможет выполнить очную сверку;
- поднимает `web`, `jobs` и `monitor-agent` с профилем `monitoring`;
- проверяет `/health` и аутентифицированный `/status` изнутри контейнера
  `web`, не раскрывая токен ни в выводе, ни в списке процессов.

Режимы скрипта:

```bash
bash deploy/start-monitoring.sh --keys-only   # только вставить ключи
bash deploy/start-monitoring.sh --check       # только проверить агент
bash deploy/start-monitoring.sh --no-build    # пересоздать без пересборки
bash deploy/start-monitoring.sh --stop        # остановить monitor-agent
```

Свежая установка `deploy/selfhost/install.sh` включает мониторинг сама
(ключ сохраняется в `/opt/ed-ring-colony/credentials.txt`); пропустить его
можно флагом `--no-monitor`.

После запуска откройте **Админка → Мониторинг** под пользователем с ролью
`admin`. Страница обновляется раз в 20 секунд; кнопка «Обновить» выполняет
ручную проверку.

### Вручную (без скрипта)

1. После получения этой версии добавьте в закрытый `.env.production`:

   ```bash
   # Не переиспользуйте CRON_SECRET: это отдельный ключ только для web → agent.
   MONITOR_AGENT_TOKEN=$(openssl rand -hex 32)
   PROJECT_REPOSITORY=NooboGreenD/ed-ring-colony
   PROJECT_UPDATE_BRANCH=main
   ```

2. Перед пересборкой передайте метаданные текущей ревизии. Они не являются
   секретами, попадают только в runtime-образ сайта и видны только админу:

   ```bash
   export APP_GIT_SHA="$(git rev-parse HEAD)"
   export APP_GIT_REF="$(git branch --show-current)"
   export APP_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

   docker compose --env-file .env.production --profile monitoring up -d --build web jobs monitor-agent
   ```

   Если сборка выполняется не из Git-клона, можно указать `unknown`: сайт и
   остальной мониторинг продолжат работать, но сверка версии будет помечена
   как недоступная.

3. Откройте **Админка → Мониторинг** под пользователем с ролью `admin`.

Проверить запуск на сервере можно без раскрытия конфигурации:

```bash
docker compose --env-file .env.production --profile monitoring ps
docker compose --env-file .env.production --profile monitoring logs --tail=50 monitor-agent
```

Не публикуйте порт `monitor-agent` в `ports:` и не проксируйте его через nginx.
Он доступен только внутри Docker-сети и дополнительно принимает отдельный
Bearer-токен.

## Ручное обновление проекта

Кнопка **«Обновить сейчас»** в Админка → Мониторинг прогоняет тот же цикл, что и
штатный `git pull && docker compose up -d --build`, но с прогрессом, журналом и
проверкой доступности сайта в конце. Ждать крон-пересборки не нужно.

Перед запуском панель предлагает три флажка — **с тестами**, **с бэкапом БД**,
**с миграциями**; каждый переключает свой шаг цикла на этот прогон. Рядом
кнопка **«Применить только миграции»** — тот же `fetch`/`compare` и накат
базы, но без сборки, переключения контейнеров и перезапуска: код сайта не
меняется, в стадиях нет `build`/`switch`/`verify`.

Что делает `deploy/update-project.sh`:

1. `prepare` — блокировка (`flock`) и проверка, что каталог действительно
   git-клон;
2. `fetch` — `git fetch --prune` той ветки, что указана в `PROJECT_UPDATE_BRANCH`;
3. `compare` — сверка ревизий. Локальные коммиты сверх ветки — остановка, а
   не «разлить ветку за вас». Отставание 0 **не отменяет** обновление: кнопка
   всё равно донашивает недостающие миграции и пересобирает стек — так
   восстанавливаются сорвавшиеся сборки и пропущенные миграции (раньше такой
   прогон отвечал «уже актуально» и не делал ничего);
4. `compare 35` — перемотка исходников (пропускается, если отставания нет):
   незакоммиченные правки на время `git merge --ff-only` уносятся в
   `git stash push -u` (не удаляются) и сразу возвращаются `stash pop --index`
   с явным предупреждением, если вернуть не вышло. Спрятано и возвращено
   ровно вокруг merge — правки не остаются в stash;
5. `backup` — `pg_dump -Fc` в `UPDATE_BACKUP_DIR` (или в
   `$UPDATE_STATE_DIR/backups`, если он недоступен) перед обновлением — по
   флажку **«с бэкапом БД»** (`UPDATE_BACKUP_BEFORE`, по умолчанию включён);
   выключенный флажок пропускает дамп целиком. Хранится 5 последних копий,
   а если `pg_dump` недоступен — это видно в журнале. Это страховка перед
   обновлением, а не еженедельная копия — её делает `POST /backup` (см.
   «Резервная копия базы» ниже);
6. `migrate` — применяются **все неприменённые** `supabase/migrations/*.sql`
   (флажок **«с миграциями»**, `UPDATE_APPLY_MIGRATIONS`): список считается
   сверкой дерева с `migrations.mark`, поэтому доезжают и новые файлы между
   ревизиями, и те, что остались неприменёнными после сбоя
   либо пропуска прошлых прогонов. Повторный запуск ничего не накатывает
   второй раз. Ошибка миграции останавливает обновление **до** пересборки и
   переключения кода — сайт остаётся на рабочей версии. Исключение — ошибка
   «already exists»: база, залитая снимком `supabase/full_schema.sql` или
   чинённая руками, уже содержит объекты старых миграций; такой файл помечается
   применённым и не блокирует обновление. Если файл помечен применённым
   ошибочно — удалите его строку из `$UPDATE_STATE_DIR/migrations.mark`,
   и следующий прогон попробует его снова. Кнопка **«Применить только
   миграции»** (`UPDATE_MIGRATIONS_ONLY=1`) завершает прогон здесь же:
   образы не пересобираются, контейнеры не трогаются. Старый агент этого
   режима не знает и честно отвечает `503 migrations-only-unsupported`
   вместо тихой полной пересборки — обновите агента (см. самоперезапуск выше);
7. `build` + `switch` — `docker compose --profile monitoring up -d --build
   web jobs monitor-agent` (тесты в образе идут по флажку **«с тестами»** —
   `RUN_TESTS` в build-args; в systemd-режиме — `npm ci`, `npm test`
   (тоже по флажку), `npm run build`, `prepare-standalone.sh`,
   `systemctl restart`), затем `docker image prune -f`.
   Сам контейнер `update-agent` не пересоздаётся: иначе обновление убило бы
   собственный процесс; его образ обновляется явным `build update-agent`.
   Чтобы новый код агента всё-таки заработал, контейнер запускает агента не из
   образа, а из смонтированного клона (`deploy/update-agent-entrypoint.sh`), и
   после успешного обновления агент **сам перезапускается**: замечает, что
   файлы в клоне новее запущенного процесса, и выходит с кодом 0 — Docker
   (`restart: unless-stopped`) или systemd поднимают его заново уже с новым
   кодом. Задержка перед выходом — `UPDATE_AGENT_RESTART_DELAY_SECONDS`
   (12 секунд, чтобы панель успела забрать финальный статус), выключатель —
   `UPDATE_AGENT_SELF_RESTART=0`. В панели рядом с кнопкой обновления есть
   **«Перезапустить агент»** — на случай, если автоперезапуск отключён. Сам
   флаг запрещает только автоматику и не блокирует явную команду администратора.
   При переходе со старого агента протокола v2 и значении `0` нужен последний
   однократный ручной рестарт; все следующие обновления можно обслуживать этой
   кнопкой;
8. `verify` — опрос `UPDATE_HEALTH_URL` (по умолчанию `/api/health`) до 4
   минут: если сайт не ответил, обновление помечается ошибкой, а причина —
   в журнале панели.

Режим выбирается сам (`PROJECT_DEPLOY_MODE=auto`): есть `docker-compose.yml` и
Docker — Compose, иначе — systemd. Переопределить: `PROJECT_DEPLOY_MODE=compose`
или `systemd`.

### Длительность стадии `build`

Стадия `build` — самая долгая: это `npm ci` (только если сменился
`package-lock.json`), `npm test` и `next build` (Turbopack, дефолт Next 16 —
быстрее старого webpack вдвое). На 2 vCPU / 4 ГБ это 10–20 минут для
теплой сборки и до 40–60 минут для холодной. Это **не зависание**: прогресс
перестаёт расти, пока docker build работает, и движение вернётся после него.

Лимита времени на полное обновление **нет вообще**: бэкап большой базы,
`npm test` и холодная сборка могут суммарно идти несколько часов. Устаревшая
переменная `UPDATE_TIMEOUT_MINUTES` игнорируется даже при значении `45`, поэтому
старую строку можно просто удалить. Остановить живой прогон можно только явной
кнопкой **«Остановить»**. Быстрый режим — флажок «с тестами» в панели или
`RUN_TESTS=0` (пропустить тесты в образе).

### Включение

```bash
sudo bash deploy/start-update-agent.sh     # то же самое: npm run update:enable
```

Скрипт идемпотентен: генерирует `UPDATE_AGENT_TOKEN` (существующее значение не
перезаписывает), дописывает `PROJECT_REPOSITORY`, `PROJECT_UPDATE_BRANCH`,
`PROJECT_DEPLOY_MODE`, `UPDATE_APPLY_MIGRATIONS`, `UPDATE_AGENT_URL`, ставит
права `600` на `.env.production` и запускает апдейтер:

- **Docker-стек** — сервис `update-agent` в профиле `monitoring`
  (`deploy/Dockerfile.update-agent`). Скрипт собирает только маленький образ
  агента, не повторяя долгую сборку `web`; существующий `web` при необходимости
  лишь пересоздаётся из уже готового образа, чтобы получить новый токен. Агент
  единственный получает `/var/run/docker.sock` на запись, и репозиторий
  примонтирован в него **под тем же путём, что и на хосте**
  (`PROJECT_HOST_DIR`), иначе докер-демон не найдёт контекст сборки. Публичного
  порта у него нет.
- **Без Docker (systemd)** — хостовый unit `ed-ring-colony-update.service`
  (`UPDATE_AGENT_HOST=127.0.0.1`, порт 8092). Агент отказывается стартовать на
  непривычном интерфейсе без токена.

Другие режимы скрипта:

```bash
bash deploy/start-update-agent.sh --keys-only  # только ключи в env-файл
bash deploy/start-update-agent.sh --check      # проверить связность
bash deploy/start-update-agent.sh --status     # состояние сервиса/контейнера
bash deploy/start-update-agent.sh --stop       # выключить кнопку
bash deploy/start-update-agent.sh --compose    # / --host-unit — задать режим вручную
bash deploy/start-update-agent.sh --no-migrations  # миграции — только кнопкой в панели
```

### Миграции: поведение по умолчанию

Новые `supabase/migrations/*.sql`, приехавшие из ветки, применяются
автоматически — с предварительным `pg_dump`. Отключается флагом
`--no-migrations` (или `UPDATE_APPLY_MIGRATIONS=0`); тогда в панели появляется
отдельная кнопка «Применить миграции». Перед migrations с блокирующими
`ALTER TABLE` (напр. крупные `UPDATE`/`CREATE INDEX CONCURRENTLY`) снимайте
нагрузку вручную: `pg_dump` — страховка, а не откат нажатием кнопки.

### Прогресс в шапке сайта для всех посетителей

Пока идёт пересборка, `System Online` в верхней части меняется на
**`System Update`** с анимированными часиками, процентом и полосой прогресса под
шапкой; на мобильном статус тоже показывается (иначе посетитель видит
«свалившийся» сайт). Это `src/components/SiteStatusBar.tsx`, который опрашивает
публичный `GET /api/status`:

- наружу уходят ровно стадия, процент и отметка времени — имена стадий заданы
  кодом, а не текстом с сервера; путей, хостов, имён контейнеров, ревизий и
  строк журнала там нет (всё это остаётся на
  `GET /api/admin/monitor/update`, который закрыт `requireAdmin`);
- ответы кэшируются на 2 секунды на сервере, поэтому опрос шапки не
  умножается по числу открытых вкладок; фоновые вкладки опрашивают статус
  реже, а скрытый браузер вообще не долбит API;
- если во время пересборки сайт на секунду пропал, шапка пишет
  «Сервис перегружается» и не переключается обратно на `System Online`;
- после успеха 12 секунд показывается «обновление завершено», затем — обычный
  UTC-часы. `System Update` не может «залипнуть»: `publicUpdateView` отдаёт
  активным только состояние `running`/`queued`.

Анимация уважает `prefers-reduced-motion`; при `update-agent` не настроен или
недоступен шапка ведёт себя как раньше.

### Если в панели «Update-агент недоступен»

| Сообщение | Что проверить |
|---|---|
| `UPDATE_AGENT_URL не задан` / `UPDATE_AGENT_TOKEN не задан` | `.env.production` и пересоздание `web`: `docker compose --env-file .env.production up -d web` |
| `update-agent не отвечает` | `docker compose --profile monitoring ps update-agent` или `systemctl status ed-ring-colony-update`; `journalctl -u ed-ring-colony-update -n 50` |
| `apk add`: `DNS: transient error`, затем пакеты `no such package` | Не загрузился индекс Alpine, а пакеты не исчезли. Dockerfile делает до 5 попыток. Если все неудачны, проверьте DNS именно внутри Docker (`docker run --rm node:22-alpine nslookup dl-cdn.alpinelinux.org`) и настройку DNS демона, затем повторите запуск. |
| 401 в ответ | токены в `web` и в агенте разошлись: перезапустите агента после правки env |
| агент слушает, но из `web` не виден | для Docker-режима нужен `UPDATE_AGENT_HOST=0.0.0.0` и сеть Compose; для хостового — `extra_hosts: host.docker.internal:host-gateway` (уже в `docker-compose.yml`) |
| обновление началось и пропало | состояние живёт в `UPDATE_STATE_DIR/update-state.json`, журнал — в `update.log`; панель подхватит их после перезапуска агента |
| в ошибке текст стадии («Пересобираю docker-образы… (код 1)») | так выглядел старый агент: он подставлял последнее сообщение прогресса вместо причины. Новый берёт причину из вывода упавшего шага («не хватило места на диске (update-project.sh, код 1)»), а стадию оставляет в журнале. Если текст стадии всё ещё виден — агент не перезапустился с новым кодом |
| журнал обновления мигает: то есть, то нет | тоже лечится обновлением агента и `web`: короткий ответ из кэша больше не затирает полный журнал в панели |

Апдейтер не хранит секреты в браузере и не принимает запросы без Bearer-токена;
`GET /health` открыт намеренно — он отвечает только `{ ok, active }`.

## API-ключи сайта

**Админка → Мониторинг → «API-ключи сайта»** — управление содержимым
`.env.production` без терминала:

- текущие ключи видны в маскировке (длина + последние 4 символа); сырое
  значение не доставляется браузеру, не лежит в логах роута и в state-файлах;
- «Изменить» перезаписывает значение на месте, «Добавить» — новый ключ
  (форма предлагает известные ключи проекта и принимает свободное имя вида
  `UPPER_CASE`), «Удалить» — стирает строку;
- «Применить (пересоздать web)» — новый ключ начинает действовать только
  после этого: апдейтер пересоздаёт `web` (опционально вместе с `jobs` и
  `monitor-agent`) через `docker compose up -d --force-recreate` — без
  пересборки образов и миграций, окно недоступности — секунды. В
  systemd-режиме это `systemctl restart` сервиса.

Как это работает: панель шлёт запрос в админские роуты `/api/admin/env`
и `/api/admin/env/apply` (закрыты `requireAdmin`), те по
`UPDATE_AGENT_TOKEN` ходят на хостовый update-agent. Только агент пишет
ключи в `.env.production` (права `600`, значение — одна строка до 8192
байт) и запускает `deploy/apply-env.sh`. Контейнер `web` не видит ни файл,
ни сырые значения; в журнале операции строка записывается как
`file=[файл окружения]`.

Операция «Применить» идёт в тот же слот, что и «Обновить сейчас» и бэкап:
пока применяются ключи, ничего другого нельзя запустить, и наоборот.
Стадии операции — `ENV_STAGES` (определение режима → пересоздание →
проверка, что сайт отвечает). Изменить ключ и не применить — безопасно:
зависимые сервисы продолжат работать со старым значением до применения.

Если в блоке показывается «Update-агент не настроен» — включите апдейтер
(`sudo bash deploy/start-update-agent.sh`, см. раздел выше); панель без
агента читать и менять ключи не умеет намеренно — иначе `web` пришлось бы
давать доступ к файлу с секретами.

## Резервная копия базы: раз в неделю, вручную

**Админка → Бэкапы** — единственное место, откуда делается копия базы.
Расписания на сервере нет: раньше её ставил cron в 04:00, но дамп базы — это
нагрузка и (при полном дампе) долгое окно недоступности, поэтому решение о
моменте принимает админ. Панель сама напоминает: через неделю после последней
копии появляется плашка «пора».

Как это работает:

1. Админ нажимает **«Сделать бэкап»** (или «Полный дамп»);
2. веб-процесс ставит признак техработ в `public.app_flags` и просит
   update-agent выполнить `deploy/db-backup.sh` (`POST /backup`);
3. пока агент работает, посетители видят заглушку **«Ведутся технические
   работы»** (вращающееся кольцо-колония) вместо сайта; **`/admin`, `/api/*` и
   вход остаются доступными**, иначе нельзя ни увидеть прогресс, ни отменить
   дамп;
4. агент пишет `pg_dump -Fc` в `UPDATE_BACKUP_DIR`
   (по умолчанию `/opt/ed-ring-colony/backups`), проверяет архив через
   `pg_restore --list`, удаляет всё сверх `UPDATE_BACKUP_KEEP` (по умолчанию 4
   копии = месяц) и рапортует имя файла и размер;
5. веб-процесс видит завершение, снимает заглушку и записывает отметку о копии
   (`db_backup` в той же таблице). Если процесс перезапустился посреди дампа,
   заглушку снимает срок `expires_at` (потолок — 3 часа), а панель — при
   следующем опросе.

**Обычная копия не содержит `public.galaxy_systems`**: каталог систем — это
десятки гигабайт, и он полностью восстанавливается импортом дампа Spansh
(Админка → Каталог систем). Благодаря этому окно техработ измеряется минутами.
**«Полный дамп»** снимает это исключение — нужен перед переносом сервера или
крупными миграциями; он доступен только после явного чекбокса в панели и идёт
заметно дольше (`BACKUP_TIMEOUT_MINUTES`, по умолчанию 120).

Переменные (`.env.production`, сервис `update-agent`):
`UPDATE_BACKUP_DIR`, `UPDATE_BACKUP_KEEP`, `BACKUP_TIMEOUT_MINUTES`,
`BACKUP_EXCLUDE_TABLE`.

### Переменные самого агента

| Переменная | По умолчанию | Зачем |
|---|---|---|
| `UPDATE_AGENT_SELF_RESTART` | `1` | Перезапускать агента после успешного обновления, чтобы он работал на новом коде. `0` — только вручную кнопкой «Перезапустить агент» |
| `UPDATE_AGENT_RESTART_DELAY_SECONDS` | `12` | Пауза перед выходом: панель успевает забрать финальный статус. Допустимо 1–120 |
| `UPDATE_AGENT_FROM_REPO` | `1` | Запускать агента из смонтированного клона, а не из образа. `0` — старое поведение (код из образа) |
| `UPDATE_AGENT_ENTRY` | `scripts/update-agent.mjs` | Путь к агенту внутри клона |

Восстановление (на хосте):

```bash
docker exec -i supabase-db pg_restore -U postgres -d postgres --clean --if-exists \
  < /opt/ed-ring-colony/backups/edrc-db-20260927T030000Z.dump
```

После восстановления из обычной копии каталог систем пуст — запустите импорт
заново (см. `SPANSH-IMPORT.md`).

Отдельно от этой кнопки существует страховочный `pg_dump` **перед миграциями**
внутри `deploy/update-project.sh` (файлы `edrc-before-update-*.dump`, хранится
5 штук): он делается автоматически при обновлении проекта и не заменяет
еженедельную копию.

## Модель безопасности

Docker не предоставляет по-настоящему безопасного «только чтение» сокета:
доступ к `/var/run/docker.sock` потенциально привилегирован. Поэтому сокет
**не монтируется в `web`**, где обрабатываются браузерные запросы. Его получает
только отдельный `monitor-agent`, который:

- не имеет опубликованного порта;
- принимает ровно `GET /health` и аутентифицированный `GET /status`;
- сам делает только жёстко заданные Docker `GET`-запросы;
- отбрасывает IDs, labels, environment, mounts, образы, логи и тексты ошибок;
- запускается с read-only root FS, `cap_drop: ALL`, `no-new-privileges` и
  ограниченным tmpfs.

Не добавляйте Docker-сокет в сервис `web`, не отключайте эти ограничения и не
передавайте `MONITOR_AGENT_TOKEN` в браузер. При подозрении на компрометацию
смените этот токен и пересоздайте `web` и `monitor-agent`.

## Если статус Docker показывает «контейнер не найден»

Агент определяет Compose-проект по собственной Docker label, поэтому работает
также с `docker compose --project-name ...`. Если у контейнера задан вручную
нестандартный hostname и label недоступен, задайте в `.env.production` имя
Compose-проекта:

```bash
MONITOR_COMPOSE_PROJECT=your-project-name
```

Затем пересоздайте `monitor-agent`. Для запуска без Docker (systemd) панель
всё равно покажет приложение, БД и версию, но Docker и state-файл планировщика
намеренно останутся недоступны.

## Мобильный мониторинг — /m-admin и Android-приложение

### Веб-версия /m-admin

```bash
# Локально
npm run dev
# открыть http://localhost:3000/m-admin — в preview доступен как CMDR Admin (Preview)

# Прод
https://edringcolony.ru/m-admin
```

- Требует роль `admin`/`moderator`/`support_manager` (проверка через `supabase.auth.getUser()` + `profiles.role`)
- Использует `GET /api/mobile/admin-summary?period=30d` — один запрос вместо 5-6
- Автообновление каждые 20с + кнопка ↻ в topbar
- PWA: `public/manifest-mobile.json` — установка на домашний экран Chrome → "Установить приложение"
- Ссылка из десктопной админки: `/admin` → баннер 📱 Мобильная админка / Android → `/m-admin`

### Android-приложение android-app/

```bash
cd android-app
./gradlew assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk
# Установка: adb install app/build/outputs/apk/debug/app-debug.apk

# Для локальной разработки с npm run dev:
# В эмуляторе: baseUrl = http://10.0.2.2:3000
# На устройстве в той же Wi-Fi: http://192.168.x.x:3000
```

- **Логин**: `LoginScreen` → `POST /api/mobile/auth` с email/password → access_token → EncryptedSharedPreferences
- **Токены**: хранятся в `secure_prefs` (EncryptedSharedPreferences), исключены из backup (backup_rules.xml + data_extraction_rules.xml), `usesCleartextTraffic=false`
- **Сеть**: Retrofit + OkHttp + Gson, `AuthInterceptor` добавляет Bearer, logging interceptor BODY
- **UI**: `MainActivity` Scaffold TopBar 56dp + BottomBar 64dp + NavHost 9 screens + `LaunchedEffect delay 20s` polling
- **Экраны**: Dashboard (health pills + stats grid), Monitor (Docker + jobs + content + топ таблиц), Billing (revenue + telemetry + топ товары), Systems (хабы + маршрут), Content, Users, Support, Backup, Auth — все в стиле DESIGN.md
- **Безопасность**: API требует admin роль, никаких секретов в APK, только anon key как в веб-клиенте

### Будущее

- Кнопки действий из мобильного: "Обновить сейчас" (`POST /api/admin/monitor/update`), "Синхронизировать Galnet" (`POST /api/admin/content?action=sync`), "Добить переводы"
- Push через FCM при critical (опрос `/api/status` — public, только stage+percent)
- Виджет на рабочий стол с overall статусом
- Графики MPAndroidChart для выручки и размера БД
- Room offline cache + biometric login

Подробности: `MOBILE-ADMIN.md` и `android-app/README.md`.
