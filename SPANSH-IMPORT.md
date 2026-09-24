# Spansh: полная таблица всех систем галактики

Проект хранит **все известные системы Elite Dangerous** (ночной дамп
[Spansh](https://spansh.co.uk/dumps), файл `systems.json.gz`, ~6 GiB) в
таблице `galaxy_systems`. Она используется:

1. **Поиск в Атласе** — координаты опорной системы и звёздные кандидаты
   (нейтроны, чёрные дыры, белые карлики, Вольф–Райе, Herbig Ae/Be, T Tauri,
   углеродистые, гиганты, супергиганты) берутся из локальной БД вместо
   онлайн-запросов EDSM/Spansh. Планетные кандидаты (телескоп-классы и
   скалы) продолжают приходить из Spansh bodies-search, но координаты их
   систем тоже резолвятся из БД.
2. **Поиск системы на карте** (поле «Поиск системы») — сначала локальная
   таблица (вся галактика, ~2×10⁸ систем), потом EDSM.
3. **Слой «Все системы ⚗»** на 3D-карте — облако точек (равномерная выборка
   каталога, `GALAXY_POINTS_MAX`). Цвет по
   классу звезды, фильтр классов, клик (не наведение) открывает карточку
   каталога: имя, класс, permit, расстояния, ссылки. Это не статус
   стройки. Файл `edgs-v1` (~36 МБ) отдаёт `/api/galaxy/all-systems`
   по цепочке источников: локальный `public/data` → storage `galaxy-data`
   → прямая сборка из Postgres (`DATABASE_URL`/`SUPABASE_DB_URL`) →
   сборка через PostgREST страничным чтением (keyset-пагинация по `id`,
   с проверкой по `COUNT(*)`: неполное облако не отдаётся). Пустой каталог
   возвращает **503** с подсказкой, а не 404: маршрут существует, данных
   пока нет. Карта перед скачиванием бинарника спрашивает
   `/api/galaxy/stats`, поэтому в консоли больше не появляется ошибка.

Формат дампа (schema `BriefDumpSystem`,
[spansh/elite_dangerous_schemas](https://github.com/spansh/elite_dangerous_schemas)):
одна система на строку — `{ id64, name, mainStar, coords{x,y,z}, needsPermit,
updateTime }`. Координаты — в Sol-centered frame сайта (Sol = 0,0,0;
SgrA = 25.21875, −20.90625, 25899.96875), конвертация не требуется.

## Как запустить импорт

### Вариант 1 — из веб-приложения (рекомендуется для сервера)

Production-образ Next.js (standalone) не содержит `scripts/`, поэтому CLI-импорт
на боевом сервере требует отдельного контейнера с клоном репозитория. Тот же
конвейер встроен в само приложение (`src/lib/galaxyImport.ts` +
`src/lib/galaxyImportJob.ts`) и работает внутри web-контейнера:

- **Админка → вкладка «Каталог систем»** (`/admin?tab=galaxy`, только роль
  `admin`): статус каталога, карточка архива на диске (кнопки «Скачать архив»
  / «Остановить скачивание», прогресс в процентах и байтах), кнопки
  «Запустить импорт» / «Продолжить» / «Остановить», прогресс в процентах и
  байтах, хвост лога.
- **`POST /api/admin/galaxy`** — то же самое по API (нужна сессия админа);
  `GET` возвращает состояние (включая `archive`), `{"action":"cancel"}`
  останавливает импорт, `{"action":"download"}` / `{"action":"cancel-download"}`
  управляют скачиванием архива.
- **`POST /api/cron/galaxy-import`** — запуск по `CRON_SECRET`
  (`Authorization: Bearer <CRON_SECRET>`); задача `galaxy-import` в
  `scripts/server-jobs.mjs` (по умолчанию выключена — добавьте её в
  `JOBS_ENABLED`).

Запрос только **запускает** импорт и сразу отвечает: скачивание ~6 ГиБ и запись
~2×10⁸ строк идут фоном в веб-процессе, иначе nginx оборвал бы запрос на
310-й секунде. Прогресс виден в `GET /api/galaxy/stats` (поле `import`) и в
админке; страница браузера может быть закрыта.

```bash
# ручной запуск на сервере (без браузера)
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://edringcolony.ru/api/cron/galaxy-import
# и наблюдение за прогрессом
watch -n 15 'curl -s https://edringcolony.ru/api/galaxy/stats | python3 -m json.tool'
```

Требования: доступ веб-контейнера в интернет (`downloads.spansh.co.uk`) и один
из двух режимов БД (см. ниже). Ничего устанавливать не нужно — `pg` и
`@supabase/supabase-js` уже есть в образе.

**Архив на диске (пре-даунлоад).** Импорт работает в две фазы. Сначала
`systems.json.gz` скачивается на диск в `GALAXY_ARCHIVE_DIR` (по умолчанию
`data/spansh`; в контейнере это том `galaxy-dump` на `/app/data/spansh`), затем
импорт читает его с диска. Скачивание возобновляемое по HTTP Range: при обрыве
(включая ошибку `terminated`) скачанные байты остаются, а следующая попытка
продолжает с сохранённого места; повторные обрывы ретраятся с паузами 5–60 с.
Готовый gzip проверяется по CRC — повреждённый файл удаляется и скачивается
заново. Архив можно скачать заранее, не запуская импорт (кнопка «Скачать архив»
или `{"action":"download"}`), а «Продолжить импорт» больше не перескачивает
6 ГиБ — он перечитывает локальный файл.

**Прерывание и продолжение.** Состояние импорта (фаза, счётчики, точка
продолжения) и состояние архива сохраняются в `galaxy_systems_meta` (keys
`import` и `archive`), поэтому перезапуск контейнера не обнуляет ни прогресс
записи, ни скачанные байты. Дамп — это gzip, его нельзя декодировать с
середины, поэтому точка продолжения — смещение в распакованном потоке, а
«Продолжить» **пропускает уже записанные системы** (записи до смещения уже в
таблице), перечитывая локальный файл. Повторная запись строк при этом не
выполняется. Записи идемпотентны (upsert по `name_lc`).

**Своё зеркало / свой файл дампа.** Если сервер не может скачать файл с
`downloads.spansh.co.uk`:

- `GALAXY_IMPORT_URL` — адрес своего зеркала (формат тот же:
  `systems.json.gz`); скачивание идёт с него так же, с возобновлением;
- `GALAXY_IMPORT_FILE=/path/to/systems.json.gz` — готовый файл на диске: импорт
  читает его напрямую и вообще ничего не скачивает. Файл можно принести
  вручную: `docker cp systems.json.gz <web-контейнер>:/app/data/spansh/`.
  МTIME файла считается «свежестью» дампа для ночного обновления;
- `GALAXY_ARCHIVE_DIR` — другая папка для архива (по умолчанию `data/spansh`).

### Вариант 2 — CLI (`npm run spansh:import`)

Импорт можно выполнить на любой машине с доступом в интернет
(`downloads.spansh.co.uk`) и к Supabase. На сервере (где лежит клон
репозитория) удобно делать это одноразовым контейнером node:

```bash
cd /path/to/ed-ring-colony
docker run --rm --env-file .env.production \
  -v "$(pwd)":/work -w /work node:22-alpine \
  sh -c "npm ci --no-audit --no-fund && node scripts/import-spansh-systems.mjs"
```

(`.env.production` содержит `NEXT_PUBLIC_SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` — этого достаточно; при наличии `DATABASE_URL`
используется быстрый прямой режим.) Любая другая машина с Node ≥ 22.18
работает так же: `npm ci && npm run spansh:import`. CLI-скрипт и импорт из
приложения используют один парсер и один SQL (`src/lib/galaxySpanshStream.ts`,
`src/lib/galaxyImport.ts`), поэтому результаты идентичны.

Поддерживаемые режимы подключения к БД (по приоритету, в обоих вариантах):

- `DATABASE_URL` или `SUPABASE_DB_URL` — прямой Postgres (быстрее: крупные
  `INSERT … ON CONFLICT` пачками по 2000 строк, поддерживается `--truncate`);
- `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — через PostgREST
  (upsert пачками по 200 строк; PostgREST даёт каждому запросу лишь несколько
  секунд, поэтому пачки маленькие, а не уложившиеся в `statement_timeout`
  автоматически делятся пополам и повторяются; строка, которую база не берёт
  даже по одной, откладывается и дописывается в конце прохода).

Быстрая проверка подключения (без скачивания дампа и без записи):

- в браузере: **Админка → «Каталог систем» → «Проверить подключение к БД»**
  (то же самое — `POST /api/admin/galaxy` с `{"action":"check-db"}`). Проверка
  выполняется внутри веб-процесса, то есть ровно там, где падает импорт;
- в клоне репозитория (на сервере или локально):

```bash
npm run spansh:import -- --check-db
```

В production-образе нет папки `scripts/`, поэтому `docker compose exec web node
scripts/…` не сработает — используйте кнопку в админке. Проверка на хосте тоже
полезна, но помните: DNS хоста и DNS контейнера — разные вещи.

### `getaddrinfo EAI_AGAIN db` — хост из `DATABASE_URL` не виден

`db` — это имя сервиса внутри compose-сети self-hosted Supabase (контейнер
`supabase-db`; сеть называется по каталогу стека, для `/opt/supabase` это
`supabase_default`). Контейнер `web` живёт в своей сети Compose — её имя тоже
образуется от каталога проекта: для `/opt/ed-ring-colony/src` это `src_default`.
Точные имена показывает `docker network ls`. Сети разные, поэтому имя не
резолвится, и подключение к Postgres падает ещё до первого запроса:

```text
Postgres недоступен: getaddrinfo EAI_AGAIN db. Хост «db» из DATABASE_URL/SUPABASE_DB_URL не резолвится.
```

Что делает импорт сейчас: несколько раз повторяет подключение с паузами 2/5/10 с
(Docker-овский DNS отвечает `EAI_AGAIN` и на ещё не прогретый резолвер), а если
хост действительно не виден — пишет в лог причину и продолжает через PostgREST,
то есть каталог всё равно импортируется, просто медленнее. В логе вкладки это
выглядит так:

```text
WARNING: прямой Postgres недоступен — Postgres недоступен: getaddrinfo EAI_AGAIN db. Хост «db» …
WARNING: переключаюсь на PostgREST (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY): импорт пойдёт медленнее
Режим записи: supabase
```

Чтобы вернуть быстрый прямой режим, подключите `web` к сети Supabase.
Теперь это делает сам `deploy/start-monitoring.sh`: он находит контейнер
`supabase-db`, записывает имя сети в `SUPABASE_NETWORK` и поднимает стек
с дополнительным файлом `deploy/compose.supabase-net.yml` (тот же `-f`
используют `update-project.sh` и `apply-env.sh`, поэтому сеть не отваливается
после обновлений и «Применить» в панели). Ручной способ — тот же файл:

```bash
docker network ls                       # точное имя сети стека Supabase
echo 'SUPABASE_NETWORK=supabase_default' >> .env.production
docker compose --env-file .env.production --profile monitoring \
  -f docker-compose.yml -f deploy/compose.supabase-net.yml up -d
```

Либо в `docker-compose.yml`:

```yaml
services:
  web:
    networks:
      - default
      - monitor
      - supabase          # ← добавить
  monitor-agent:
    networks:
      - monitor
      - supabase          # ← добавить, иначе замер размера БД не увидит «db»

networks:
  monitor:
    internal: true
  supabase:                  # ← добавить
    external: true
    name: supabase_default   # docker network ls — точное имя сети стека Supabase
```

После `docker compose up -d` имя `db` (или `supabase-db`) станет доступно из
`web`, и `DATABASE_URL=postgresql://postgres:ПАРОЛЬ@db:5432/postgres` заработает.
`start-monitoring.sh` при пустом `SUPABASE_DB_URL` собирает эту ссылку сам из
`POSTGRES_PASSWORD` стека Supabase и зеркалирует её в `MONITOR_DB_URL`.
Альтернативы без общей сети: опубликовать порт Postgres на хосте и указать
`host.docker.internal:5432` (alias уже прописан в `extra_hosts`), либо внешний
адрес БД. Проверка — тот же `--check-db`.

Полезные флаги:

```bash
node scripts/import-spansh-systems.mjs --help
  --file <path>        локальный .gz/.json дамп вместо скачивания
  --limit <n>          обработать только n систем (проверка)
  --truncate           очистить таблицу перед импортом (pg-режим)
  --dry-run            только парсинг, без записи в БД
  --no-points          не генерировать файл точек для карты
  --skip-download      переиспользовать ранее скачанный файл
  --download-only      только скачать архив в --out (без БД и импорта):
                       так можно заранее принести ~6 ГиБ на сервер, а импорт
                       выполнить потом, когда линия свободнее
  --check-db           только проверить подключение к БД и объяснить, почему
                       прямое не работает (без скачивания и записи)
  -v                   прогресс каждые 10 секунд
```

Скрипт:

1. скачивает `systems.json.gz` в `data/spansh/` (с возобновлением по Range и
   повторами при обрывах соединения; тот же `downloadDumpFile`, что и в
   приложении);
2. стримингово парсит JSON-массив (одна запись на строку; понимает и
   minified-формат), без удержания всего дампа в памяти;
3. `id64` (unsigned 64-bit) извлекается как строка из сырых цифр — JS-числа
   теряли бы точность выше 2^53;
4. класс главной звезды нормализуется (`star_type` + `star_giant_class`),
   считаются `distance_from_sols` / `distance_from_sgra`;
5. пишет в `galaxy_systems` (upsert по `name_lc`) + статистику в
   `galaxy_systems_meta` (key `stats`);
6. генерирует `public/data/galaxy-systems-points.bin` (`.meta.json` рядом)
   и, если это полный импорт и заданы ключи Supabase, заливает его в
   bucket `galaxy-data` (миграция `20260924000000_galaxy_systems_finish.sql`,
   лимит 50 МБ). `--limit` файл в storage не заливает, чтобы не затереть
   полное облако. В `galaxy_systems_meta` пишется фактический `COUNT(*)`,
   а не счётчик батча; `points_uploaded` выставляется только после
   успешной заливки и не затирается частичным импортом.

Повторный импорт безопасен (upsert); для полной перезаписи — `--truncate`.

Проверка без интернета и БД:

```bash
npm run spansh:selftest          # синтетический дамп → парсер → БД-строки → точки
npm run test                     # все тесты, включая scripts/tests/spansh-systems.test.mjs
```

## Что в таблице

| колонка | описание |
| --- | --- |
| `id64` | Spansh ID64 (строка, до 2^64) |
| `name` / `name_lc` | каноническое имя / нормализованный ключ поиска |
| `x, y, z` | координаты (ly, Sol-centered frame) |
| `main_star` | сырой класс: `G (White-Yellow) Star`, `Neutron Star`, … |
| `star_type` | `o\|b\|a\|f\|g\|k\|m\|brown_dwarf\|neutron\|black_hole\|white_dwarf\|wolf_rayet\|herbig_ae_be\|t_tauri\|carbon\|unknown\|s_type\|ms_type` |
| `star_giant_class` | `dwarf\|giant\|supergiant` (для обычных классов) |
| `needs_permit` | нужен ли permit |
| `distance_from_sols`, `distance_from_sgra` | расстояния (ly) |
| `updated_at` | `updateTime` из дампа |

## API

- `GET /api/galaxy/stats` — статус каталога (`ready`, `systems_count`,
  `imported_at`, `points.*`) и состояние импорта (`import.*`: фаза, процент,
  байты, записано/пропущено, ошибка). Карта читает его перед скачиванием
  облака, поэтому пустой каталог не превращается в ошибку в консоли;
- `GET /api/galaxy/systems/search?q=…` — автодополнение (exact → prefix → substring);
- `GET /api/galaxy/systems/by-name?name=…` — одна система по имени (страница `/system/:name` открывает каталог, даже если стройки нет);
- `GET /api/galaxy/systems/:id64` — одна система по ID64;
- `GET /api/galaxy/all-systems` — бинарный файл точек (`edgs-v1`, ETag).
  Источники по порядку: `public/data` → storage `galaxy-data` → Postgres →
  PostgREST. Если каталог пуст, отвечает **503** с JSON-подсказкой
  (`error`, `hint`, `catalog`) и `Retry-After: 300` — маршрут существует,
  данных пока нет;
- `GET|POST /api/admin/galaxy` — статус и управление (сессия администратора).
  `GET` возвращает состояние импорта (`state`, `log`, `backends`, `stats`) и
  архива (`archive`: фаза скачивания, байты, путь, `downloaded_at`), плюс
  `archive_dir`. `POST`: `{"action":"start", "fresh?", "truncate?",
  "skip_points?", "url?"}`, `{"action":"cancel"}`,
  `{"action":"download", "url?"}` — скачать архив на диск (с возобновлением,
  без запуска импорта), `{"action":"cancel-download"}`,
  `{"action":"check-db"}` — одна попытка подключения к Postgres из
  веб-процесса и внятный диагноз (`check.direct.message`, `check.backend`);
- `GET|POST /api/cron/galaxy-import` — то же для планировщика
  (`Authorization: Bearer <CRON_SECRET>`): запускает/продолжает импорт и
  отвечает сразу, а при свежем каталоге возвращает `skipped`.

Перед импортом примените миграцию `20260924000000_galaxy_systems_finish.sql`:
функции ближайших звёзд/систем в кубе, триграммный индекс имени и bucket
`galaxy-data`. Без неё атлас и поиск маршрута откатываются к EDSM, а карта
не получит облако в production-образе. Звёздные кандидаты атласа и куб
маршрута берутся из каталога только после полного импорта
(`systems_count` ≥ 1 000 000 и не `--limit`); пробный импорт не подменяет EDSM.
Локальный файл точек, который короче залитого в storage, тоже не перекрывает
полное облако.

Если импорт ещё не выполнялся, все эти эндпоинты возвращают «пусто»
(503 для all-systems), а поиск и Атлас работают в прежнем режиме
через EDSM/Spansh.

## Диагностика: карта не показывает «все системы»

Симптом в консоли браузера:

```
GET https://edringcolony.ru/api/galaxy/all-systems 404 (Not Found)
```

Причина почти всегда одна: таблица `galaxy_systems` пуста, то есть импорт
дампа никогда не выполнялся (или завершился с ошибкой). Порядок проверки:

1. `curl -s https://edringcolony.ru/api/galaxy/stats | python3 -m json.tool`
   - `systems_count: 0` → каталог пуст, запустите импорт (Админка →
     «Каталог систем» либо `POST /api/cron/galaxy-import`);
   - `import.phase: "failed"` → там же текст ошибки (`import.error`).
     Текст `ON CONFLICT DO UPDATE command cannot affect row a second time`
     значит, что в одной пачке upsert было два одинаковых `name_lc` (или
     `id64`): дамп иногда повторяет систему, а нормализация имени схлопывает
     варианты написания. Текущий импорт убирает такие повторы до записи;
     если ошибка всё ещё видна — веб-образ не обновлён, пересоберите его и
     запустите импорт снова;
  - `supabase upsert failed: canceling statement due to statement timeout
    (имя / id64)` значит, что база перестала принимать даже **одну** строку:
    пачки по 200 строк делятся пополам и повторяются с backoff, но когда
    одиночный upsert не проходит и 32 отложенные подряд строки исчерпали бюджет
    (`GALAXY_MAX_CONSECUTIVE_DEFERRED`), проход падает. На практике это выглядит как смерть
    импорта на несколько процентов (прод: 2.7%, ~5.7M записанных строк,
    архив 5.9 ГБ уже на диске) — база не держит темп PostgREST, и «Продолжить»
    повторяет то же самое. Это не случайность, а потолок режима:
    лечится только прямым Postgres — `SUPABASE_DB_URL` веб-процессу плюс сеть
    стека Supabase (`deploy/start-monitoring.sh` делает оба шага сам), проверка
    — «Проверить подключение к БД». Уже записанные строки не теряются:
    «Продолжить импорт» идёт с сохранённой точки. Запуск в PostgREST теперь
    сразу пишет в лог три `WARNING:` с этой ценой и командой исправления, а
    админка показывает то же предупреждение постоянным блоком, а не только в
    хвосте лога. Разово ошибка может быть и случайной (пиковая нагрузка на БД) —
    тогда помогает продолжение с сохранённой точки или импорт в тихое время;
   - `Соединение прервано…`, `…terminated`, `Скачивание не удалось после N
     обрыва(ов)` — обрыв линии при скачивании архива (undici отдаёт `terminated`
     для оборванных сокетов). Текущий импорт это не ошибка, а событие: скачанные
     байты остаются на диске, и скачивание продолжает с сохранённого места
     (HTTP Range) с паузами 5–60 с. Просто дождитесь или нажмите «Продолжить
     скачивание» / «Продолжить импорт». Если линия мёртва полностью (байты не
     идут), скачивание сдается после 10 «пустых» обрывов и покажет это —
     проверьте исходящий трафик и запустите снова;
   - `import.phase: "running"` → импорт идёт, облако появится после завершения;
   - `systems_count > 0`, но `points.uploaded: false` → файл точек не залился
     в storage: карта соберёт его из таблицы при первом включении слоя
     (медленно, один раз), а повторный импорт зальёт его снова.
2. Применены ли миграции `20260921120000_galaxy_systems.sql` и
   `20260924000000_galaxy_systems_finish.sql` (таблица, функции, bucket
   `galaxy-data`)? Без bucket файл точек некуда положить.
   - `Postgres недоступен: getaddrinfo EAI_AGAIN db` (или `ENOTFOUND db`) —
     хост из `DATABASE_URL`/`SUPABASE_DB_URL` не виден из контейнера `web`:
     обычно это имя сервиса чужой compose-сети (см. «getaddrinfo EAI_AGAIN db»
     выше). Импорт повторяет подключение, затем уходит на PostgREST и доводит
     каталог до конца; чтобы вернуть быстрый режим, подключите `web` к сети
     Supabase и проверьте результат через `--check-db`;
3. Есть ли у web-контейнера один из режимов БД: `DATABASE_URL`/`SUPABASE_DB_URL`
   (быстрый) либо `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`?
   Без них импорт не запустится и скажет об этом прямо в ответе.
4. Виден ли серверу `downloads.spansh.co.uk`? Если исходящий трафик закрыт —
   залейте дамп на свой хост и укажите `GALAXY_IMPORT_URL`.

Ответ 404 (а не 503) на этот маршрут означает, что приложение не обновлено:
соберите и перезапустите образ (`docker compose up -d --build`), маршрут
`/api/galaxy/all-systems` присутствует в текущем коде.

## Масштаб каталога: 10⁸ строк, а не миллионы

`systems.json.gz` — это **вся** исследованная галактика. Проверенные цифры
(страница дампов Spansh и EDAstro, сентябрь 2026):

- архив `systems.json.gz` — **5.9 GiB** (для сравнения: `systems_1day.json.gz` —
  2.6 MiB, `galaxy.json.gz` с телами и станциями — 109 GiB);
- систем в агрегированных каталогах — **~2×10⁸**: EDAstro показывает
  203 642 699 систем (99.9M visited + 103.8M route-only).

То есть в `galaxy_systems` после полного импорта будет **порядка 150–200 млн
строк**. Всё, что было посчитано «на миллион строк», на этом масштабе неверно:
облако точек в 40 раз больше памяти веб-процесса, ночной апсерт всего дампа
идёт часами, а три b-tree по x/y/z не вытягивают куб-запросы Атласа.

### Что уже сделано под этот масштаб

- **Миграция `20260925000000_galaxy_systems_scale.sql`**: GiST-индекс по
  `cube(ARRAY[x,y,z])` (куб-фильтр `&&` + KNN-сортировка `<->` одним
  индексным сканированием) вместо трёх b-tree по координатам; функции
  `galaxy_star_candidates` и `galaxy_systems_near` переписаны на него; b-tree по
  `star_type` (16 значений) и `star_giant_class` (3 значения) удалены —
  планировщик их не использует, а место они едят; `fillfactor = 100` и
  `autovacuum_*_scale_factor = 0.01/0.002` вместо дефолтных 20%;
- **облако точек — равномерная выборка**: `GALAXY_POINTS_MAX` (по умолчанию
  1 200 000 точек ≈ 35 МБ) вместо «точка на систему». 2×10⁸ точек — это ~5.5 ГБ
  в формате `edgs-v1`, их не принять ни бакету `galaxy-data` (лимит 50 МБ), ни
  three.js. Шаг выборки пишется в `galaxy_systems_meta.stats`
  (`points_stride`, `points_sampled`, `points_rows`), поэтому слой карты честно
  называется выборкой;
- **импорт**: `synchronous_commit = OFF` на соединении записи (апсерт
  идемпотентен и возобновляем, а fsync на каждой пачке удваивает время) и
  `ANALYZE galaxy_systems` в конце — иначе планировщик оценивает куб по
  статистике пустой таблицы;
- **`--check-db` / «Проверить подключение к БД»** — см. выше.

### Применение миграции на загруженной таблице

Миграция сама строит GiST, только если в таблице меньше 5 млн строк
(`pg_class.reltuples`); иначе она заменит функции, напишет NOTICE и оставит
индекс вам — обычный `CREATE INDEX` на 2×10⁸ строк держит блокировку записи
часами:

```bash
docker exec -i supabase-db psql -U postgres -d postgres \
  < supabase/maintenance/galaxy_systems_spatial_index.sql
# прогресс: SELECT phase, blocks_done, blocks_total FROM pg_stat_progress_create_index;
```

Скрипт работает через `CONCURRENTLY` (запись и чтение не блокируются), удаляет
пять устаревших индексов и в конце печатает `EXPLAIN (ANALYZE, BUFFERS)` и
размеры индексов — оба запроса Атласа должны показать сканирование
`idx_galaxy_systems_coord`, а не `Seq Scan`.

### Оценка места и времени

Оценки порядка величины (точное — только по `pg_relation_size` после загрузки):

| Что | Порядок величины |
| --- | --- |
| Дамп на диске (`GALAXY_ARCHIVE_DIR`) | 6 ГиБ |
| Таблица `galaxy_systems` (~200 Б на строку) | ~40 ГБ |
| Индексы: 2 уникальных + PK + GiST | ~20–30 ГБ |
| Индекс `idx_galaxy_systems_name_trgm` (GIN по `name_lc`) | ~20–40 ГБ |
| Файл точек в `galaxy-data` | ~35 МБ (выборка) |

Триграммный индекс — самая дорогая вещь в таблице: он нужен только для
подстрочного автодополнения (префиксный поиск идёт по b-tree `name_lc`).
Если место важнее поиска по середине имени — удалите его:

```sql
DROP INDEX CONCURRENTLY IF EXISTS public.idx_galaxy_systems_name_trgm;
```

Время полного импорта: скачивание 5.9 ГиБ + разбор ~2×10⁸ записей в
веб-процессе + запись. Через прямой Postgres это **часы**, через PostgREST
(пачки по 200 строк) — **сутки и более**, поэтому PostgREST здесь годится
только как аварийный режим. RAM веб-процесса остаётся < 1 ГБ: дамп читается
потоком, облако точек ограничено `GALAXY_POINTS_MAX`.

### Ночное обновление: дельта вместо полного дампа

Меняется за сутки ничтожная часть каталога — Spansh отдаёт её отдельным файлом
`systems_1day.json.gz` (**2.6 MiB** против 5.9 GiB). Ночью разумно применять
дельту, а полный дамп — раз в неделю/месяц:

```bash
# ночь: только изменения за сутки
GALAXY_IMPORT_URL=https://downloads.spansh.co.uk/systems_1day.json.gz \
  curl -sf -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://ваш-домен/api/cron/galaxy-import
```

Апсерт идемпотентен: строки из дельты обновляют существующие, новые
добавляются. Полный прогон после этого восстанавливает облако точек целиком.

### Проверка после импорта

```sql
SELECT count(*) FROM public.galaxy_systems;
SELECT value FROM public.galaxy_systems_meta WHERE key = 'stats';
SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) AS size, idx_scan
FROM pg_stat_user_indexes WHERE relname = 'galaxy_systems'
ORDER BY pg_relation_size(indexrelid) DESC;
SELECT pg_size_pretty(pg_total_relation_size('public.galaxy_systems'));
```

Если `idx_scan` у `idx_galaxy_systems_coord` растёт, а у остальных индексов
ноль — лишние индексы можно удалить: они только замедляют запись.
