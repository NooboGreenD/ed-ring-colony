# ED Ring Colony как единый механизм: анализ и план

> **19.10.2026**, сайт **2.22.0**, Colonial Helper **2.17.0**.
> Задача: «проанализировать проект, все модули и функции, и проработать
> исправления, чтобы проект был целостным механизмом: сейчас это набор зависимых
> механизмов, и часть из них обособлены».
> Справочник по устройству остаётся в [CONTEXT.md](CONTEXT.md), карта всех
> документов — в [DOCS.md](DOCS.md). Здесь — сквозной взгляд: как разделы
> связаны между собой, где связи рвались, что исправлено и что дальше.

## 1. Итог в двух абзацах

Почти все функции проекта крутятся вокруг одной сущности — **звёздной
системы**: стройки, проекты, кольцо, станции, фракции, PowerPlay, авианосцы,
сканы, поставки, цели сообщества. При этом у каждого раздела была своя картина
системы. Ключи разные: имя в трёх видах нормализации, id64 то TEXT, то BIGINT,
MarketID то TEXT, то BIGINT. Были свои пути приёма данных и свои страницы,
и разделы почти не знали друг о друге. Данные, которые уже приходили в
проект (журналы пилотов), доходили только до части разделов.

В этой версии появилась общая основа:
* один ключ системы;
* одно «наблюдение системы» из журнала, которое питает все слои;
* одна реакция на стройки из журнала для всех путей загрузки;
* один расчёт прогресса системы;
* один канал уведомлений;
* одна карточка системы, где сходятся все разделы, со ссылками туда и обратно.

Остальные разрывы описаны в §4 с планом в §6.

## 2. Из чего состоит проект

| Часть | Объём | Где |
|---|---|---|
| Сайт (Next.js 16, React 19) | 59 страниц, 231 маршрут API, 238 модулей `src/lib`, 169 компонентов | `src/` |
| База (Supabase / PostgreSQL) | 128 таблиц, 90 миграций, SQL-функции для тяжёлой логики | `supabase/` |
| Фоновые задачи | 10 задач (9 по умолчанию) | `scripts/job-schedule.mjs`, контейнер `jobs` |
| Colonial Helper (Python, Windows) | 36 модулей: журнал, оверлеи, Raven, EDSM/Inara/EDDN, авианосец, фракции, станции | `uploader/` |
| Мобильная админка и Android | PWA `/m-admin`, приложение (сейчас не собирается) | `src/app/m-admin`, `android-app/` |
| Развёртывание | Docker Compose, агент обновлений, мониторинг | `docker-compose.yml`, `deploy/` |
| Автотесты | 147 файлов (`node --test`), 44 файла Python | `scripts/tests/`, `uploader/tests/` |

### 2.1 Разделы и их данные

| Раздел | Таблицы | Пишут | Читают |
|---|---|---|---|
| Каталог систем | `galaxy_systems` (~2×10⁸), `galaxy_systems_meta` | импорт Spansh (админка, задача `galaxy-import`) | Атлас, поиски, координаты, карточка системы |
| Кольцо колонизации | `hubs`, `route_systems`, `route_tracks`, `system_progress` (кэш Raven) | админка, задача `update-progress` (Raven) | `/map`, `/systems`, проекты эскадрилий, карточка системы |
| Площадки строек | `colonisation_sites`, `construction_depot_snapshots` | журналы: Helper, сайт, CAPI | «Проекты систем», карточка системы, обогащение Raven, **теперь и проекты эскадрилий** |
| Проекты эскадрилий | `projects`, `project_systems`, `project_members` | страница проекта, Атлас «Кольцо», **журналы (реакция)** | `/projects/[id]`, Атлас «Маршрут», карточка системы |
| Архитектор и «Проекты систем» | `system_plans`, `system_architects`, `architect_project*` | `/architect`, `/architect/projects` | там же, карточка системы |
| Журналы и досье | `deliveries` (`source_hash`), `system_scans`, `pilot_stats`, `journal_imports` | `/api/logs/*` (сайт и Helper), CAPI | досье, лидерборд, кольцо, «Проекты систем» |
| Авианосцы | `fleet_carriers`, `fleet_carrier_cargo`, `fleet_carrier_events` | Helper, сайт, отчёты станций | слой карты, кабинет, «Проекты систем», карточка системы |
| Станции и рынки | `station_commerce`, `station_inventory_snapshots`, `commerce_systems`; старые `market_prices`, `eddn_messages`, `commodity_needs` | Helper, EDDN, EDSM, Spansh | `/station-search`, Атлас «Рынок», Архитектор, карточка системы |
| Минорные фракции | `bgs_*` | дамп EDSM, **наблюдения из журналов**, EDDN (по желанию, web 2.23.0) | Атлас «Фракции», карточка системы |
| PowerPlay | `powerplay_systems` | дамп EDSM (у спорных систем — без владельца, web 2.23.0), **наблюдения из журналов**, EDDN (по желанию) | Атлас «PowerPlay», карточка системы |
| Сообщество | эскадрильи, чат/голос, друзья, сообщения, форум, вики, новости, Galnet, цели | страницы и API разделов | там же |
| Уведомления | `user_notifications` (колокольчик), `forum_notifications`, `notifications` (старое), `push_subscriptions` | друзья, чат эскадрильи, триггер форума, **реакция на стройки** | колокольчик, push |
| Аккаунт, магазин, верфь | `profiles`, `api_tokens`, биллинг, `outfitting_*` | свои страницы | свои страницы |

## 3. Потоки данных

### 3.1 Было

```
Helper ──/api/logs/upload──► доставки, площадки, сканы, сводка ─┐
Helper ──/api/factions/sync─► фракции (поля PowerPlay выброшены)│   проекты эскадрилий
Сайт   ──/api/logs/import──► то же, копия кода маршрута ────────┤   двигал только CAPI;
Сайт   ──/api/journal/*────► площадки (третий, свой парсер)     │   PowerPlay — только
CAPI   ──syncPilot─────────► площадки + проекты эскадрилий ─────┘   дамп EDSM (12 ч)
EDSM-дампы ─► фракции, PowerPlay       EDDN: два слушателя, не запущены

/system/[name]: Raven + тела + каталог. Слои Атласа ссылаются на неё как на тупик.
```

### 3.2 Стало (2.22.0)

```
                ┌───────────── src/lib/systemIdentity.ts — один ключ системы, одинаковые ссылки ─────────────┐
Helper ─┐
Сайт  ──┼─ /api/logs/{upload,import} ─► journalIngest.ts ─► доставки · площадки · сканы · сводка
        │                                        └─► projects/projectSync.ts ─► статусы проектов эскадрилий
CAPI  ──┤   syncPilot (площадки) ───────────────────────────┘                └─► notify.ts (колокольчик + push)
        │
        ├─ /api/factions/sync ─────────► systemObservations.ts ─► фракции (bgs_apply_snapshots)
CAPI  ──┘   журнал за день ────────────┘                        └► PowerPlay (powerplay_apply_observations)
EDSM-дампы ─► фракции, PowerPlay (свежие данные пилотов дамп не перетирает)

Чтение: system_overview_sources (SQL) + авианосцы → systemOverview.ts → GET /api/systems/overview
        → /system/[name]: стройка (тот же расчёт, что у «Проектов систем»), проекты, кольцо, станции,
          фракции, PowerPlay, авианосцы, цели, поставки, свежесть источников, ссылки во все разделы
Обратно: Атлас ?tab=factions|powerplay&focus_id64=… открывает систему на слое; поиск станций и
          проекты ведут в карточку системы.
```

## 4. Найденные разрывы

Статус: ✅ закрыто в 2.22.0, ◐ закрыто частично, ☐ в плане (§6).

| № | Разрыв | Доказательство | Статус |
|---|---|---|---|
| G1 | **Нет общего ключа системы.** Десять копий функции «ключ имени», три нормализации в SQL (`lower`, `lower(btrim)`, `regexp_replace`), id64 — TEXT в `galaxy_systems`, BIGINT в `bgs_*`/`powerplay_*`, MarketID — TEXT в `station_commerce`, BIGINT в `colonisation_sites` | `systemNameKey`, `carrierSystemKey`, `coordinateNameKey`, `normalizeSystemKey`, `nearbyNameKey`, `systemKey` в Архитекторе/лидерборде/парсере | ◐ код — один `systemIdentity.ts` (старые имена — ссылки на него, тест следит), индексы ключа добавлены; колонки `system_id64` — ☐ |
| G2 | **Страница системы — тупик.** Показывала Raven, тела и каталог; фракции, PowerPlay, станции, проекты, авианосцы, цели — нигде вместе | `src/app/system/[name]/page.tsx` читал 3 маршрута | ✅ карточка системы (`/api/systems/overview`), ссылки во все разделы |
| G3 | **PowerPlay обособлен.** Только ночной дамп EDSM (а до EDSM сервер доходит не всегда), поля PowerPlay из журналов отбрасывались на клиенте | `BGS_SYSTEM_FIELDS` без `ControllingPower`/`PowerplayState`, Python-тест даже запрещал `Powers` | ✅ одно наблюдение → фракции и PowerPlay (сайт сразу, Helper с 2.17.0, CAPI) |
| G4 | **Журналы не доходили до проектов эскадрилий.** Статусы систем двигал только CAPI; `commodity_needs` пишется, но не читается | `updateProjectProgress` вызывался только из `capi/syncPilot.ts`; нет ни одного читателя `commodity_needs` | ✅ реакция для всех путей; `commodity_needs` — ☐ удалить |
| G5 | **CAPI — отдельный конвейер.** Из журнала дня брались только площадки | `syncPilot.ts` | ◐ площадки, проекты, фракции, PowerPlay — тем же путём; доставки из CAPI — ☐ (нужно сверить побайтность строк для `source_hash`) |
| G6 | **Два маршрута приёма журнала — копии.** `/api/logs/upload` и `/api/logs/import` повторяли сброс, ник, доставки, телеметрию | оба `route.ts` | ✅ общий `journalIngest.ts`, ответы прежние |
| G7 | **Третий путь журнала.** `/account/journal` → `/api/journal/{parse,import}` со своим парсером | `parseColonisationEvents` | ◐ получил те же реакции; свести страницу в общий загрузчик — ☐ |
| G8 | **Уведомления разрознены.** Три таблицы; web-push с функциями для проектов и эскадрилий, которые никто не вызывал | `pushNotifications.ts` вызывается только из `/api/push/send` | ◐ `notify.ts` (колокольчик + push) для проектов; друзья, чат, поддержка, форум — ☐ |
| G9 | **EDDN не работает.** Два несвязанных слушателя: TS (рынки) и Python (сырые события в `eddn_messages`, их никто не обрабатывает); оба закомментированы в compose | `scripts/eddn-worker.ts`, `scripts/eddn_listener.py` | ◐ web 2.23.0: слушатель в веб-процессе (`src/lib/eddn/`, без нативных модулей) → `systemObservations` (PowerPlay с владельцем + фракции), включает админ, сторож тишины против «заморозки» ТСПУ. Осталось: станции и рынки из EDDN, удалить два старых слушателя |
| G10 | **Рынки в трёх хранилищах.** `station_commerce` (новое), `market_prices` (старое EDDN), `colonisation_market_systems`; Архитектор берёт цены из старого | `api/architect/sourcing` читает `market_prices` | ☐ |
| G11 | **Две модели проектов колонизации.** Проекты эскадрилий и «Проекты систем» — разные таблицы, права и расчёты | `projects*` и `architect_project*` | ◐ общий расчёт прогресса (`system_progress_sources` + `buildSystemProgress`): у проектов эскадрилий теперь тот же процент по каждой системе (`GET /api/projects/[id]/progress`), карточка системы показывает оба вида. Сведение моделей — решение за владельцем проекта |
| G12 | **Нет навигации между разделами.** Поиск станций и проекты вели только во внешние сервисы, Атлас не открывал систему на слое по ссылке | `station-search/page.tsx`, `projects/[id]/page.tsx` | ✅ ссылки «Система», `focus_id64` для вкладок «Фракции» и PowerPlay, поиск станций принимает `?reference=` |
| G13 | **Права проверяются по-разному.** В `/api/logs/*` своя копия проверки API-токена; модули прав `helperAuth`, `requestUser`, `cronAuth`, `billing/auth`, `wikiAuth`, `catalogAuth` | маршруты `logs` | ☐ |
| G14 | **Три реализации «хода загрузки».** Каталог, PowerPlay и фракции — свои этапы, проценты и журналы | `galaxyCatalogStatus.ts`, `powerplayProgress.ts`, `bgsProgress.ts` | ◐ web 2.24.0: PowerPlay и фракции — один механизм импорта дампа (`importProgress.ts` — этапы, проценты, журнал; `dumpArchive.ts`, `dumpShards.ts`, `dumpUpload.ts` — архив, куски, архив с компьютера). Осталось: каталог систем |
| G15 | **Helper не видит знаний сайта о системе.** Проекты и карту системы он берёт у Raven напрямую | `uploader/system_map.py`, `raven_colonial_api.py` | ☐ Helper читает карточку системы сайта |
| G16 | **Верфь не знает корабль пилота.** `Loadout` есть в журнале и CAPI, до `/outfitting` не доходит | `ship_tracker.py`, `capi/profile.ts` | ☐ |
| G17 | **Android не собирается**, мобильная админка — свой набор маршрутов | `android-app/README.md` | ☐ |

## 5. Что сделано в 2.22.0 / Helper 2.17.0

| Механизм | Файлы | Что даёт |
|---|---|---|
| Один ключ системы и ссылки | `src/lib/systemIdentity.ts` | `systemKey`, `cleanSystemName`, `systemId64`, `systemPageHref`, `atlasSystemHref`, `stationSearchHref`, `externalSystemLinks`. Старые функции ключа — ссылки на него (`system-identity.test.mjs`) |
| Наблюдение системы → все слои | `src/lib/systemObservations.ts`, `src/lib/powerplayJournal.ts`, `bgsJournal.ts`, `uploader/bgs_sync.py` | FSDJump/Location/CarrierJump обновляют фракции **и** PowerPlay; источник — Helper, загрузчик на сайте, CAPI. Сбой PowerPlay не роняет фракции |
| PowerPlay: дамп и пилоты вместе | миграция `20261020120000`: `powerplay_apply_observations`, новые `powerplay_apply_batch` / `powerplay_finish_sync` / `powerplay_layer_rows` / `powerplay_admin_summary` | Побеждает свежее наблюдение; дамп не перетирает пилотов и не удаляет системы, которые пилоты видели после дампа; `Unoccupied` снимает систему со слоя; PowerPlay 1.0 и журналы до 29.10.2024 не принимаются. Колонки `powers`, `control_progress`, `reinforcement`, `undermining`. В админке — сколько систем свежее дампа |
| Единый приём журнала | `src/lib/journalIngest.ts` | Оба маршрута `/api/logs/*` делают одно и то же одним кодом; формат ответов прежний, добавлено поле `projects` |
| Стройки → проекты эскадрилий | `src/lib/projects/projectSync.ts`, SQL `sync_project_systems_from_sites` | Журнал (Helper, сайт, страница журнала, CAPI) двигает статусы систем проектов только вперёд: planned → building → done |
| Один канал уведомлений | `src/lib/notify.ts` | Строка в колокольчике (Realtime) и push, если настроен VAPID. Участники проекта узнают, что стройка началась или завершена |
| Один расчёт прогресса | SQL `system_progress_sources(keys)` + `architect/projectProgress.buildSystemProgress`, `systemOverview.loadSystemsProgress`, `GET /api/projects/[id]/progress` | Тот же расчёт, что у «Проектов систем», для любых систем. Страница проекта эскадрильи показывает процент по каждой системе, в подсказке — площадки и остаток |
| Карточка системы | SQL `system_overview_sources`, `src/lib/systemOverview.ts`, `GET /api/systems/overview`, `src/components/System/SystemOverviewSections.tsx`, `/system/[name]` | Всё о системе одним запросом с правами зрителя. Чужие «Проекты систем» и черновики планов не видны даже числом. Авианосцы показываются по правилам слоя карты. Есть свежесть каждого источника и ссылки во все разделы |
| Навигация туда и обратно | `atlas/page.tsx`, `station-search/page.tsx`, `projects/[id]/page.tsx`, `carrierMapStore.loadSystemCarriers` | Атлас открывает систему на слое по `focus_id64`. Поиск станций принимает `?reference=&kind=&q=` (с web 2.25.0 и `&item=` — точный выбор). Строки результатов поиска и проекты ведут в карточку, в Атлас — через `atlasSystemHref` |

Тесты: `system-identity.test.mjs`, `unified-system-data.test.mjs` (PGlite
с настоящими миграциями), `system-overview-ui.test.mjs` (jsdom), Python
`test_bgs_sync.py`.

## 6. План следующих шагов

По порядку пользы. Каждый пункт — отдельный PR с тестами.

### 6.1 Данные
1. **`system_id64` в таблицах, где система хранится только именем**
   (`colonisation_sites`, `station_commerce`, `system_scans`,
   `architect_project_systems`, `project_systems`, `system_plans`): колонка
   BIGINT без перезаписи таблицы, заполнение задачей пачками по каталогу,
   индекс. После этого все разделы связываются по адресу, а не по имени.
2. **Доставки из журнала CAPI** — после проверки, что строки журнала CAPI
   побайтно совпадают с локальным файлом. От этого зависит `source_hash`,
   иначе появятся дубли, как было при загрузке с сайта и из Helper'а.
3. **Рынки — одно хранилище**: Архитектор, `market/find` и наличие на стройку
   читают `station_commerce`. `market_prices` и `colonisation_market_systems`
   остаются только для совместимости, потом удаляются. `commodity_needs`
   удаляется (нет читателей).
4. **«Что ещё нужно» в проектах эскадрилий** — список товаров по системе и
   проекту целиком (процент уже есть, 2.22.0) и ссылка «где купить» в Атлас.

### 6.2 Механизмы
5. **Все уведомления через `notify.ts`**: друзья, чат эскадрильи, ответы
   поддержки, форум (триггер → функция), события авианосцев («носитель
   эскадрильи прыгнул», «груз продан на ваш носитель»).
6. **Один модуль прав**: `resolveRequestUser` + `requireStaff/requireAdmin`
   во всех маршрутах. Копии проверки токена в `/api/logs/*` уходят.
7. **Один модуль хода импорта** для каталога, PowerPlay и фракций: этапы,
   проценты, журнал, остановка. Сейчас это три реализации.
   **Сделано в web 2.24.0 (PowerPlay и фракции):** загрузка дампа PowerPlay
   устроена как у фракций — архив скачивается на сервер целиком, разбивается
   на куски, куски пишутся в базу; архив можно загрузить с компьютера. Общие
   модули: `importProgress.ts` (этапы, виды запуска, проценты, журнал, разбор
   сохранённого хода), `dumpArchive.ts` (архив на диске и его метка),
   `dumpShards.ts` (куски и манифест), `dumpUpload.ts` +
   `archiveUploadClient.ts` + `ArchiveUploadControl.tsx` (архив с компьютера).
   `bgs*` и `powerplay*` — тонкие обёртки со своими названиями и проверками.
   Каталог систем (`galaxyCatalogStatus.ts`) — следующим шагом.
8. **Страница `/account/journal`** сводится в общий загрузчик `/account`
   (тот же разбор, те же 4 маршрута, один экран прогресса).

### 6.3 Внешние источники
9. **EDDN — один воркер** (опциональный профиль compose `eddn`): схемы
   `commodity/outfitting/shipyard` → станции, `journal` (FSDJump, Location,
   CarrierJump, Docked) → `systemObservations` и станции. Пачки по 10–30 с,
   по одной записи на систему. **Оговорка:** сервер в России, а реле EDDN —
   иностранный хостинг; длинная TCP-сессия ZeroMQ попадает под «заморозку»
   ТСПУ так же, как скачивание дампов EDSM. Нужен замер с сервера до
   включения по умолчанию.
   **Сделано в web 2.23.0 (часть `journal`):** слушатель живёт в веб-процессе
   (`src/lib/eddn/listener.ts`, ZMTP без нативных модулей), берёт FSDJump /
   Location / CarrierJump живой игры и раз в минуту отдаёт их
   `applySystemObservations` (источник `eddn`). Включает администратор
   («Игровые данные → PowerPlay»), по умолчанию выключен; сторож тишины
   переподключается при «заморозке» и пишет в журнал, сколько данных успело
   прийти — это и есть замер. Нужен он из-за PowerPlay: дамп EDSM не знает
   владельца спорных систем (POWERPLAY.md → «Чья система»). Станции и Docked —
   следующим шагом.
10. **Helper читает карточку системы сайта** (`/api/systems/overview`) для
    вкладки «Карта системы» и оверлея: проекты, площадки, планы, фракции,
    PowerPlay с сайта, Raven — запасной источник.

### 6.4 Решения владельца проекта
11. **Сведение двух моделей проектов** (эскадрилий и «Проекты систем») в одну:
    проект эскадрильи = «Проект системы» с владельцем-эскадрильей. Меняет
    права и страницы, поэтому нужно решение.
12. **Верфь из корабля пилота**: импорт `Loadout` (журнал/CAPI) в `/outfitting`.
13. **Android**: починка сборки или отказ в пользу PWA `/m-admin`.

## 7. Правила единого механизма

Новая функция становится частью механизма, а не ещё одним островом:

1. **Система — только через `systemIdentity.ts`.** Ключ — `systemKey`, адрес —
   `systemId64` (строкой, BIGINT в базе). Ссылки — `systemPageHref` /
   `atlasSystemHref` / `stationSearchHref`. Своих копий нормализации не писать.
2. **Новая таблица о системе** хранит `system_name` и индекс
   `lower(btrim(system_name))`, а где возможно — `system_id64 BIGINT`.
3. **Данные из журнала** — через общий приём: доставки, площадки, сканы —
   `journalIngest.ts`; состояние системы — `systemObservations.ts`. Новый слой
   подключается там, а не отдельным маршрутом с отдельным парсером.
4. **Паритет TS ↔ Python.** `source_hash` побайтно одинаков у парсера сайта и
   Helper'а, списки полей проекций совпадают (тесты `factions-lib`,
   `test_bgs_sync`). Поменял парсер — поменяй оба.
5. **Прогресс системы** — только `buildSystemProgress`. Своих формул процентов
   нет.
6. **Уведомление** — только `notifyUsers`.
7. **Новая сущность о системе** получает раздел в карточке системы
   (`systemOverview.ts` + `SystemOverviewSections.tsx`). Её страница ведёт в
   карточку системы, а карточка — к ней.
8. **Права зрителя** решает сервер. Закрытое не показывается даже числом.
9. **Миграции идемпотентны**, а снимок `supabase/full_schema.sql` дополняется
   в том же порядке (`migrations-sql.test.mjs`).

## Приложение А. Модули `src/lib` по разделам (236)

Разобраны все модули серверной и общей логики. Чистые модули без
node-зависимостей (их берут и браузер, и маршруты, и `node --test`)
импортируются с расширением `.ts`.

| Раздел | Модулей | Модули |
|---|---|---|
| Единый механизм (ключ системы, наблюдения, приём журнала, карточка, уведомления) | 5 | `journalIngest.ts`, `notify.ts`, `systemIdentity.ts`, `systemObservations.ts`, `systemOverview.ts` |
| Импорт дампов: архив → куски → база, архив с компьютера (общий для фракций и PowerPlay, web 2.24.0) | 5 | `archiveUploadClient.ts`, `dumpArchive.ts`, `dumpShards.ts`, `dumpUpload.ts`, `importProgress.ts` |
| Каталог систем и координаты | 25 | `coordinateResolveHandler.ts`, `ed3dCanon.ts`, `galaxyArchiveStore.ts`, `galaxyCatalogStatus.ts`, `galaxyCopyWriter.ts`, `galaxyDumpVariants.ts`, `galaxyImport.ts`, `galaxyImportJob.ts`, `galaxyImportSchedule.ts`, `galaxyNebulae.ts`, `galaxyPointsPick.ts`, `galaxyPointsPublish.ts`, `galaxyRegions.ts`, `galaxyShards.ts`, `galaxySpanshStream.ts`, `galaxySystems.ts`, `galaxySystemsDb.ts`, `nebulaClouds.ts`, `pgModule.ts`, `pgReachability.ts`, `readAllRows.ts`, `spanshClient.ts`, `systemCoordinateTypes.ts`, `systemCoordinates.ts`, `updateSystemCoordinates.ts` |
| Атлас: поиски и кольцо | 12 | `atlas.ts`, `atlasNearby.ts`, `atlasNearbySearch.ts`, `atlasRingGeometry.ts`, `atlasRingHubSearch.ts`, `atlasRingMapGeometry.ts`, `atlasRingParams.ts`, `atlasRingPreview.ts`, `atlasRingSearch.ts`, `atlasSearchProgress.ts`, `atlasSystemCache.ts`, `atlasWorldSearch.ts` |
| Кольцо колонизации, прогресс Raven | 7 | `raven/client.ts`, `raven/keyStore.ts`, `raven/keyVault.ts`, `ravenColonial.ts`, `ravenDepotSnapshots.ts`, `routeEngine.ts`, `systemProgress.ts` |
| Площадки строек и журналы | 14 | `achievements.ts`, `bodySignals.ts`, `cargoScope.ts`, `colonisationEvents.ts`, `commodities.ts`, `constructionBlueprints.ts`, `deliveryImport.ts`, `dossierCargo.ts`, `importRetry.ts`, `journalParser.ts`, `journalReset.ts`, `journalTelemetry.ts`, `pilotDossier.ts`, `privacy.ts` |
| Проекты эскадрилий и эскадрильи | 5 | `projects/autoProgress.ts`, `projects/projectSync.ts`, `squadronConstants.ts`, `squadronData.ts`, `squadronForm.ts` |
| Архитектор и «Проекты систем» | 19 | `architect/bodyNames.ts`, `architect/bodySync.ts`, `architect/catalogue.ts`, `architect/dataQuality.ts`, `architect/economy.ts`, `architect/existing.ts`, `architect/governance.ts`, `architect/insights.ts`, `architect/planner.ts`, `architect/progress.ts`, `architect/projectLeaders.ts`, `architect/projectProgress.ts`, `architect/projectRouteKit.ts`, `architect/projectStore.ts`, `architect/projects.ts`, `architect/ravenCreate.ts`, `architect/sourcing.ts`, `architect/store.ts`, `architect/types.ts` |
| Авианосцы | 7 | `carrierMap.ts`, `carrierMapStore.ts`, `carrierMapView.ts`, `carrierTags.ts`, `fleetCarrierCollector.ts`, `fleetCarrierStore.ts`, `fleetCarriers.ts` |
| Станции и рынки | 8 | `eddn/subscriber.ts`, `eddnClient.ts`, `marketDiscovery.ts`, `marketUpstream.ts`, `stationCommerce.ts`, `stationSearch.ts`, `stationSearchCatalog.ts`, `stationSearchOptions.ts` (быстрый выбор: формат, отбор и ранжирование подсказок — для браузера и сервера, web 2.25.0) |
| Минорные фракции | 9 | `bgs.ts`, `bgsDump.ts`, `bgsJournal.ts`, `bgsProgress.ts`, `bgsShards.ts`, `bgsStore.ts`, `bgsSync.ts`, `bgsUpload.ts`, `bgsWriter.ts` |
| PowerPlay | 9 | `powerplay.ts`, `powerplayDump.ts`, `powerplayJournal.ts`, `powerplayProgress.ts`, `powerplayShards.ts`, `powerplayStore.ts`, `powerplaySync.ts`, `powerplayUpload.ts`, `powerplayWriter.ts` |
| Frontier CAPI, Inara | 16 | `capi/client.ts`, `capi/entitlement.ts`, `capi/failure.ts`, `capi/fleetCarrier.ts`, `capi/journal.ts`, `capi/linkState.ts`, `capi/locationSync.ts`, `capi/messages.ts`, `capi/oauth.ts`, `capi/persist.ts`, `capi/platform.ts`, `capi/profile.ts`, `capi/profileBinding.ts`, `capi/session.ts`, `capi/syncPilot.ts`, `inara/client.ts` |
| Орери системы | 9 | `orrery3d/camera.ts`, `orrery3d/index.ts`, `orrery3d/motion.ts`, `orrery3d/palette.ts`, `orrery3d/payload.ts`, `orrery3d/scene.ts`, `orrery3d/types.ts`, `orrery3d/viewer.ts`, `systemOrrery.ts` |
| Вход, аккаунт, права | 24 | `authProfile.ts`, `authProviders/registry.ts`, `authProviders/settings.ts`, `avatarUrl.ts`, `cronAuth.ts`, `discordOAuth.ts`, `emailAuth.ts`, `ensureProfile.ts`, `helperAuth.ts`, `oauthFlow.ts`, `oauthProviders.ts`, `passwordPolicy.ts`, `passwordRecovery.ts`, `rateLimit.ts`, `requestUser.ts`, `userDisplay.ts`, `vkAccount.ts`, `vkId.ts`, `vkShared.ts`, `wikiAuth.ts`, `yandexAccount.ts`, `yandexId.ts`, `yandexShared.ts`, `zodSchemas.ts` |
| Supabase-клиенты | 5 | `supabaseAdmin.ts`, `supabaseClient.ts`, `supabaseServer.ts`, `supabaseServerUrl.ts`, `supabaseUrl.ts` |
| Магазин и платежи | 7 | `billing/auth.ts`, `billing/catalogSeed.ts`, `billing/profiles.ts`, `billing/providers.ts`, `billing/storage.ts`, `billing/tbank.ts`, `billingData.ts` |
| Верфь и инженеры | 24 | `engineers/data.ts`, `engineers/i18n.ts`, `engineers/locales/de.ts`, `engineers/locales/en.ts`, `engineers/locales/it.ts`, `engineers/locales/ja.ts`, `engineers/locales/ko.ts`, `engineers/locales/zh.ts`, `outfitting/analysis.ts`, `outfitting/build.ts`, `outfitting/calc.ts`, `outfitting/catalog.ts`, `outfitting/catalogAuth.ts`, `outfitting/catalogStore.ts`, `outfitting/exchange.ts`, `outfitting/factory.ts`, `outfitting/fdnames.ts`, `outfitting/i18n.ts`, `outfitting/merccoin.ts`, `outfitting/origins.ts`, `outfitting/specials.ts`, `outfitting/specs.ts`, `outfitting/types.ts`, `outfitting/useOutfittingData.ts` |
| Контент, i18n, перевод | 15 | `discordWebhook.ts`, `i18n/I18nContext.tsx`, `i18n/engineers.ts`, `i18n/outfitting.ts`, `i18n/outfittingAnalysis.ts`, `i18n/outfittingSpecials.ts`, `i18n/translations.ts`, `i18n/types.ts`, `localizedContent.ts`, `markdown.tsx`, `pushNotifications.ts`, `siteFooter.ts`, `siteUrl.ts`, `supportTickets.ts`, `translate.ts` |
| Обслуживание, обновления, мониторинг | 11 | `freshFetch.ts`, `helperReleaseJobs.ts`, `launcherChunkUpload.ts`, `launcherUploadProtocol.ts`, `launcherUploadSessions.ts`, `maintenance.ts`, `maintenanceEdge.ts`, `maintenanceFlag.ts`, `serverMonitor.ts`, `updateAgent.ts`, `uploaderStore.ts` |

## Приложение Б. Модули Colonial Helper (36)

| Группа | Модули | Связь с сайтом |
|---|---|---|
| Приложение и интерфейс | `colonial_helper.py` (окно, вкладки, наблюдение за журналом), `screens.py`, `hotkeys.py`, `site_config.py`, `http_errors.py` | — |
| Разбор журнала | `journal_parser.py` (`PARSER_VERSION = 5`, `source_hash` побайтно как у сайта) | `POST /api/logs/upload` → `journalIngest.ts` |
| Отправка на сайт | `api_client.py` (все маршруты сайта), `bgs_sync.py` (наблюдения систем: фракции + PowerPlay), `carrier_sync.py`, `station_commerce.py` | `/api/factions/sync`, `/api/carriers/*`, `/api/stations/report`, `/api/atlas/system-bodies`, `/api/cmdr/stats`, `/api/capi/token` |
| Авианосец | `carrier.py` (оверлей CARRIER, сверка груза) | читает `/api/carriers/mine` |
| Колонизация и Raven | `colonisation.py`, `colony_build_types.py`, `raven_colonial_api.py` | Raven напрямую (план §6.3, п. 10 — карточка системы сайта) |
| Карта системы | `system_map.py`, `system_view.py`, `orrery.py` (зеркало `src/lib/systemOrrery.ts`), `tk_orrery.py`, `map_export.py`, `map_font.py` | `/api/atlas/system-bodies` |
| Оверлей HUD | `overlay.py`, `ship_hud.py`, `game_monitor.py` | — |
| Трекеры | `route_tracker.py`, `ship_tracker.py`, `exobiology.py` | — (верфь сайта корабль не получает — G16) |
| Внешние сервисы | `event_dispatch.py` (очереди отправки), `edsm_api.py`, `inara_api.py`, `eddn_api.py`, `companion_api.py` (Frontier CAPI) | — |
| Обновление | `launcher.py`, `bundle.py`, `bundle_updater.py`, `build_bundle.py`, `build_exe.py` | `/api/uploader/*`, публикация из админки |
