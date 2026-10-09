# Журналы колонизации: почему `colonisation_events` стала 12+ ГБ и что сделано

Дата: 2026-10-09. Ветка: `arena/a4da2815-ed-ring-colony`.

Предыдущие работы: [COLONISATION-EVENTS-AUDIT.md](COLONISATION-EVENTS-AUDIT.md) (дубли, 24.09),
[LOG-UPLOAD-OPTIMIZATION.md](LOG-UPLOAD-OPTIMIZATION.md) (урезание `raw_event`, прунинг, 01.10).
Этот документ отвечает на жалобу: после загрузки ~3 ГБ журналов таблица весит 12+ ГБ, и
прежние меры до этого не довели.

---

## 1. Итог в двух абзацах

Таблица `colonisation_events` хранила **историю** наблюдений строек: строку на каждое
изменение состояния и на каждого командира, который его прислал, с полным списком ресурсов.
Читает её одно место — обогащение Raven Colonial, и ему нужна только **последняя известная
картина каждой площадки**. Всё остальное было мусором.

Теперь состояние каждой площадки хранится **одной строкой** в таблице `colonisation_sites`
(ключ — MarketID). Запись «новее побеждает» по метке времени журнала, список ресурсов
компактный (без `Payment`, `raw_event`, `source_hash`, `journal_import_id`), вклады не пишутся.
История прогресса для графиков остаётся в `construction_depot_snapshots` и пишется только при
реальном изменении состояния. Старая таблица переносится и удаляется отдельным maintenance-
шагом (`supabase/maintenance/colonisation_sites_cutover.sql`), он освобождает место сразу.

Вторая часть задачи — отправка в Spansh. У Spansh нет API для записи, а его данные приходят
через EDDN. Uploader теперь публикует в EDDN **только исследовательские события, которые
принимает схема `journal/1`**, и только поля, разрешённые схемой. Колонизация в EDDN схем не
имеет и не отправляется.

---

## 2. Что писал каждый клиент в `colonisation_events` (до изменений)

| Клиент | Путь записи | Что попадало в таблицу |
|---|---|---|
| Браузер, `/account` → `/api/logs/import` | `persistJournalTelemetry` | строка на каждое `ColonisationConstructionDepot` (после сигнатурного отсева в сессии), полный `ResourcesRequired`, `raw_event`, `source_hash` |
| Colonial Helper (десктоп) → `/api/logs/upload` | `persistJournalTelemetry` | то же, пачками по 500; у каждого командира свой набор строк |
| Страница журнала → `/api/journal/import` | `depotEventRow` + вклады | депо-строки с `journal_import_id`; до 01.10 — ещё `ColonisationContribution`, по строке на каждую позицию груза |
| CAPI → `syncPilot`, cron `capi-sync` | `depotEventRow` | депо-события из окна журнала CAPI на каждом синке |

Uploader (Colonial Helper) отправлял по сути то же, что браузер: `ConstructionSnapshotCollector`
отсекал повторы в процессе, но не между запусками и не между командирами. Серверная сторона
писала строки с полным `ResourcesRequired` (в нём `Payment` и `Name_Localised` для каждого
ресурса) и дублирующий `raw_event`.

## 3. Почему таблица раздулась

1. **Копия на каждого командира.** Ключ дедупликации был `(user_id, source_hash)`. Одно и то же
   состояние площадки, которое прислали пять пилотов, лежало пятью строками.
2. **История без смысла для читателя.** Каждое изменение состояния — новая строка. Читателю
   нужна одна строка на площадку; при 60-дневном окне (введено 01.10) строки за это окно
   всё равно хранились все.
3. **Полный список ресурсов в каждой строке.** Примерно 20 ресурсов на стройку, в каждом
   `Payment` и `Name_Localised`, которые читатель не использует. Оценка по структуре:
   порядка 2 КБ на строку против нескольких сотен байт нужных данных.
4. **Вклады.** До 01.10 строка на каждую позицию груза — самая массовая часть таблицы.
5. **`raw_event`.** До 01.10 — полная копия события, то есть вторая копия того же
   `ResourcesRequired`. Урезание до `{"event": …}` это исправило, но уже набранное осталось.
6. **Индексы по текстам.** `UNIQUE(user_id, event_timestamp, system_name, construction_id)`
   с `system_name TEXT`, индексы по `system_name`, по `event_timestamp`, по
   `(user_id, market_id, event_timestamp)`, частичный по `market_id`, уникальный по
   `(user_id, source_hash)`. На миллионах строк индексы сопоставимы с данными.
7. **Строки без MarketID.** Читатель работает по MarketID, такие строки бесполезны.

Поэтому прунинг и урезание `raw_event` не могли вернуть таблицу к нормальному размеру:
структура хранения оставалась прежней.

---

## 4. Новая модель

### 4.1. Таблица `colonisation_sites`

Миграция `supabase/migrations/20261009010000_colonisation_sites.sql`.

| Колонка | Тип | Смысл |
|---|---|---|
| `market_id` | `BIGINT PRIMARY KEY` | MarketID площадки; ключ, по которому читает Raven |
| `system_name` | `TEXT NOT NULL` | система (для диагностики) |
| `construction_id` | `BIGINT` | ConstructionID, если журнал его дал |
| `construction_name` | `TEXT` | название стройки |
| `construction_progress` | `NUMERIC(5,2)` | прогресс в процентах |
| `resources_total` | `JSONB` | компактный список: `Name`, `Name_Localised` (если есть), `RequiredAmount`, `ProvidedAmount` |
| `event_timestamp` | `TIMESTAMPTZ NOT NULL` | момент журнала, которому соответствует состояние |
| `user_id` | `UUID` → `auth.users` `ON DELETE SET NULL` | кто прислал состояние последним |

Удалены: `raw_event`, `source_hash`, `journal_import_id`, `created_at`, все индексы кроме PK.
Строка одна на площадку, поэтому индексы по командиру и по времени не нужны.
`ON DELETE SET NULL`: удаление аккаунта не стирает состояние площадки, которое нужно карте Raven.

Доступ: RLS включён, права и политика только у `service_role`. Клиенты (`anon`, `authenticated`)
не читают и не пишут таблицу.

### 4.2. Запись: `colonisation_sites_write(jsonb)`

- Пачка строк. Внутри пачки на площадку остаётся самое новое состояние (при равной метке —
  последнее в пачке).
- Строка в базе обновляется **только если метка времени новее**. Повтор старого состояния
  ничего не меняет, а повтор нового обновляет метку и командира.
- Возвращает `(market_id, changed)`. `changed = true`, если площадка новая или изменился
  прогресс либо состав ресурсов (имена и суммы). Смена языка журнала и `Payment` не считаются
  изменением. Только такие состояния дают снимок прогресса.
- Список ресурсов сжимается **и на клиенте, и на сервере** (`colonisation_compact_resources`).
  Старые версии Helper'а присылают полный `ResourcesRequired`, и таблица остаётся лёгкой и при них.
- Права: `EXECUTE` закрыт от `PUBLIC`, `anon`, `authenticated` (иначе PostgREST отдал бы
  функцию публичному ключу).

Клиентский код: `src/lib/colonisationEvents.ts`. Функции `siteRowFromDepot` (парсер сайта, CAPI),
`siteRowFromTelemetry` (Helper и браузер), `persistColonisationSites` (пачки по 100, при
таймауте базы пачка делится пополам), `snapshotRowsForChangedSites` (один снимок на стройку
по изменившимся площадкам).

### 4.3. Чтение

`src/lib/ravenDepotSnapshots.ts`: один запрос `in('market_id', …)` на 200 площадок вместо
запроса на каждую. Фильтр `construction_id IS NOT NULL` убран: он отбрасывал депо-события без
ConstructionID, а вкладов в таблице больше нет.

### 4.4. Снимки прогресса

`construction_depot_snapshots` остаётся для графиков. Изменения:

- снимок пишется только при `changed` (раньше — при «новом хеше», то есть почти всегда);
- `resources_total` в снимке тоже компактный;
- снимок из `autoProgress` (CAPI, обновление прогресса проекта) использует тот же отпечаток
  состояния, без `Payment` и локализации, поэтому не дублирует историю из-за смены языка.

Чистка: `colonisation_retention_prune(days)` (cron `colonisation-cleanup`, окно
`COLONISATION_RETENTION_DAYS`, по умолчанию 60) удаляет снимки старше окна. Состояния площадок
не чистятся: их одна строка на площадку.

### 4.5. Старые клиенты и Python-загрузчик

- `uploader/journal_parser.py`: `compact_construction_resources` и `_construction_event_from`
  отправляют компактный список. `Payment` в сеть не уходит.
- `PARSER_VERSION` **не менялся**. Кэш импорта Helper'а сбрасывается при смене версии парсера,
  то есть все уже загруженные файлы (~3 ГБ) переотправились бы. Серверу всё равно, полный или
  компактный список он получил.

---

## 5. Развёртывание и перенос

### 5.1. Что делает обновление автоматически

Миграция `20261009010000_colonisation_sites.sql` ничего не удаляет и не переписывает большие
таблицы: создаёт `colonisation_sites`, функции и права. Старая таблица на этом этапе не трогается,
так что старый код в окне деплоя продолжает работать. Если таблица `colonisation_events`
**пуста** (новая установка), миграция удаляет её сама. Блокировка берётся с `NOWAIT`:
если в таблицу сейчас пишут, миграция её не ждёт и не удаляет.

### 5.2. Перенос (вручную, после обновления)

Файл: `supabase/maintenance/colonisation_sites_cutover.sql`. Запускать, когда работает новый код
(старый не должен писать в `colonisation_events`), в тихое окно, после резервной копии
(`deploy/db-backup.sh` или `pg_dump`):

```bash
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < supabase/maintenance/colonisation_sites_cutover.sql
```

Шаги файла:

0. Префлайт: миграция применена, размеры и число строк.
1. Перенос последнего состояния каждой площадки (по MarketID, самое новое по времени).
   Контрактные строки `ColonisationContribution` и строки без системы или MarketID не переносятся.
   Повтор безопасен: `ON CONFLICT` обновляет строку только при более новой метке времени, так что
   состояние, записанное новым кодом во время переноса, не затирается.
2. Проверка: у каждой площадки из старой таблицы есть строка в новой. Иначе шаг 3 не выполняется.
3. Переименование `colonisation_events` → `colonisation_events_legacy` (обратимо).
4. **Удаление** `DROP TABLE public.colonisation_events_legacy` — закомментировано. Выполнить
   после проверки карты Raven. Освобождает место сразу, без `VACUUM FULL`.

Откат до шага 4: `ALTER TABLE public.colonisation_events_legacy RENAME TO colonisation_events;`
и возврат предыдущего релиза сайта. Откат после шага 4 возможен только из резервной копии.

### 5.3. Что остаётся вручную

- Перенос и удаление старой таблицы (п. 5.2). Без него 12 ГБ остаются на диске.
- `VACUUM (ANALYZE) construction_depot_snapshots` один раз, если таблица была большой.
- Старый файл `supabase/maintenance/colonisation_events_source_hash_dedup.sql` помечен как
  устаревший; запускать его не нужно.

---

## 6. Spansh: что выяснено и что сделано

### 6.1. Что выяснено

- У spansh.co.uk **нет документированного API для записи**. Публичный API (docs.spansh.co.uk)
  содержит только GET-запросы.
- Spansh использует данные **EDDN** — открытой ленты сообщества. В README EDDN (раздел
  «Utilising data») Spansh перечислен среди инструментов, которые используют данные EDDN.
  Прямой загрузки от сторонних программ Spansh не принимает (по доступной документации).
- В EDDN **нет схем для колонизации**: ни стройплощадок, ни вкладов. Поэтому колонизационные
  данные через EDDN до Spansh не дойдут в любом случае.

### 6.2. Что сделано (вариант, выбранный пользователем: «публиковать только исследовательские события»)

Модуль `uploader/eddn_api.py`, интеграция в `uploader/event_dispatch.py`, переключатель в
настройках Helper'а. По умолчанию **выключено**: публикация открытая и необратимая, её включает
пользователь сам.

Что уходит в EDDN (схема `journal/1`, live-адрес `https://eddn.edcd.io:4430/upload/`):
`Location`, `FSDJump`, `CarrierJump`, `Scan`, `SAASignalsFound`, `Docked`.

Что **не** уходит:
- колонизация, вклады, грузы, рынок, всё, что не входит в перечисленные события;
- `CodexEntry` — у него своя схема `codexentry/1`, её в этом проходе не реализовал;
- FSS-события (`FSSDiscoveryScan`, `FSSAllBodiesFound`, `FSSBodySignals` и др.) — у каждого своя
  схема; это следующий шаг, если нужно больше данных для Spansh;
- сообщения, которые нельзя честно дополнить (см. правила ниже);
- события при бета/альфа-версии игры, при неизвестной версии, без имени командира;
- историческая загрузка журналов (только живые события, как и у EDSM/Inara).

Правила, которые соблюдает код (из `docs/Developers.md` и `schemas/journal-README.md` EDDN):

- **Только live**: `$schemaRef` без `/test`; версия игры известна и не бета/альфа.
- **Никаких данных командира**, кроме `uploaderID` (имя командира) и флагов `horizons` / `odyssey`.
  Флаги берутся только из `LoadGame` и только если поле там есть, никогда не выдумываются.
- **Удаляются** все ключи с суффиксом `_Localised` (на любой глубине) и запрещённые схемой ключи:
  `Wanted`, `ActiveFine`, `CockpitBreach`, `BoostUsed`, `FuelLevel`, `FuelUsed`, `JumpDist`,
  `Latitude`, `Longitude` и персональные поля элементов `Factions`
  (`HappiestSystem`, `HomeSystem`, `MyReputation`, `SquadronFaction`).
- **Дополнение локации** (`StarSystem`, `SystemAddress`, `StarPos`) — только со сверкой с
  последним `Location`/`FSDJump`/`CarrierJump`. Если имя или адрес в событии не совпадают с
  последней локацией, либо сверять не с чем, сообщение **не отправляется**. Это требование EDDN
  (игра иногда перестаёт писать журнал и продолжает с пропусками).
- **Версия**: `softwareName` = «ED Ring Colony Uploader», `softwareVersion` = версия Helper'а
  (semver). `gameversion` и `gamebuild` берутся из `Fileheader`, иначе из `LoadGame`.
- **Повторы**: 400 и 426 не повторяются. Автоматических повторов нет вовсе (EDDN это допускает:
  «No data is better than bad data»). Ошибки пишутся в лог и счётчик `failed`.

Проверка по **настоящей схеме**: тест `RealSchemaTests` валидирует собранные сообщения по
`journal-v1.0.json` из клона `github.com/EDCD/EDDN` (запускается при `EDDN_SCHEMA_DIR`). Прогнано
локально: все сообщения проходят.

**Что не проверено**: реальная отправка в EDDN. Из песочницы доступны только GitHub, npm и PyPI,
а EDDN недоступен. Перед включением для пользователей стоит один раз отправить тестовое
сообщение на beta-адрес EDDN (`beta.eddn.edcd.io:4431`), если он доступен.

---

## 7. Проверки

| Набор | Команда | Результат |
|---|---|---|
| Node: колонизация | `node --test scripts/tests/colonisation-events.test.mjs` | 19 из 19 |
| Node: телеметрия | `node --test scripts/tests/journal-telemetry.test.mjs` | 37 из 37 |
| Node: SQL-миграции (libpg-query, `full_schema.sql`) | `node --test scripts/tests/migrations-sql.test.mjs` | 14 из 14 |
| Node: весь набор | `node --test scripts/tests/*.test.mjs` | 1017 тестов, 1016 проходят. Один файл, `outfitting-ui.test.mjs`, зависает по таймауту в песочнице; на базовом коммите зависает так же (не связан с изменениями) |
| TypeScript | `npx tsc --noEmit` | без ошибок |
| Python: загрузчик и EDDN | `python -m unittest discover -s uploader/tests` | 1376 тестов; падения те же, что до изменений (см. ниже) |
| SQL на настоящем Postgres (PGlite, вне репозитория) | миграция, запись, права, чистка, перенос | все сценарии проходят |

SQL проверен на PGlite (WASM-сборка PostgreSQL) отдельными сценариями, которые в репозиторий
не вошли: компактация ресурсов (в том числе нечисловые и пустые значения), «новее побеждает»,
порядок внутри пачки, изменение `changed` (локализация и `Payment` не в счёт), мусорные строки,
запрет записи для `anon` и `authenticated`, чистка снимков, перенос с историей и
контрактными строками, идемпотентность переноса, защита от потери площадки (перенос не
переименовывает таблицу, если строка пропала).

**Падения, которые были до изменений и остались** (окружение песочницы, не колонизация):
`test_build_workflow` (проверяет GitHub-workflow, ожидает PyYAML и секреты), `test_updater`
(интерфейс обновления требует дисплей), `test_system_map.ProjectDueTests.test_report_shows_deadline`.
Имена упавших тестов совпадают с базовым прогоном на `feca9db`.

---

## 8. Файлы

Новые:
- `supabase/migrations/20261009010000_colonisation_sites.sql`
- `supabase/maintenance/colonisation_sites_cutover.sql`
- `uploader/eddn_api.py`
- `uploader/tests/test_eddn.py`
- `COLONISATION-SITES-REWORK.md` (этот файл)

Изменённые:
- `src/lib/colonisationEvents.ts` — переписан: одна строка на площадку, компактный список, запись через RPC
- `src/lib/journalTelemetry.ts`, `src/app/api/journal/import/route.ts`, `src/lib/capi/syncPilot.ts`
- `src/lib/projects/autoProgress.ts`, `src/lib/ravenDepotSnapshots.ts`
- `src/app/api/cron/colonisation-cleanup/route.ts`
- `uploader/journal_parser.py`, `uploader/event_dispatch.py`, `uploader/colonial_helper.py`
- `supabase/full_schema.sql` (блок новой миграции), `supabase/DATABASE.md`
- `README.md`, `uploader/README.md`, `.env.example`
- тесты: `scripts/tests/colonisation-events.test.mjs`, `scripts/tests/journal-telemetry.test.mjs`,
  `uploader/tests/test_upload_performance.py`

Старые файлы, которые больше не используются: `supabase/maintenance/colonisation_events_source_hash_dedup.sql`
(помечен как устаревший).
