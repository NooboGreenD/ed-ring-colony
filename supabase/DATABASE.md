# База данных ED Ring Colony — полный комплект

> Обновлено 19.10.2026: 90 миграций, ~128 таблиц в `public`. Таблицы по
> разделам — [CONTEXT.md §4](../CONTEXT.md#4-database-schema), карта документов —
> [DOCS.md](../DOCS.md). `20261020120000_unified_system_data.sql` добавляет общие
> для разделов функции: карточку системы, прогресс любых систем, журнал →
> проекты эскадрилий и PowerPlay из журналов пилотов
> ([ARCHITECTURE.md](../ARCHITECTURE.md)). Последние —
> `20261021120000_powerplay_owner.sql` (владелец системы PowerPlay: основание
> `power_basis`, `power` NULL — «не определена») и
> `20261021130000_eddn_listener.sql` (таблица `eddn_listener_state` для живых
> данных EDDN) — [POWERPLAY.md](../POWERPLAY.md).

Комплект для развёртывания БД с нуля (новый Supabase или self-hosted
Supabase) и для приведения существующей базы в соответствие с кодом.

## Что здесь лежит

| Файл | Назначение |
|---|---|
| `migrations/*.sql` | **Все изменения схемы**, применяются по алфавиту имён файлов. Первые — `000_base_schema.sql` (≈45 таблиц, которые раньше жили только в SQL Editor, 5 RPC, форумные триггеры, realtime/storage) и `001_rls_policies.sql`; дальше — `2025…`/`2026…_<имя>.sql` |
| `full_schema.sql` | **Снимок всех миграций одним файлом** (шапка + блоки `MIGRATION: <файл>` в том же порядке). Для развёртывания с нуля через SQL Editor / psql. Полноту и порядок проверяет `scripts/tests/migrations-sql.test.mjs` |
| `maintenance/create_delivery_source_hash_unique_index_concurrently.sql` | Уникальный индекс `deliveries.source_hash`. `CREATE INDEX CONCURRENTLY` — выполняется **отдельно, вне транзакции** |
| `maintenance/colonisation_events_source_hash_dedup.sql` | **УСТАРЕЛО** — заменён `colonisation_sites_cutover.sql`: старая схема с ключом `source_hash` больше не используется. Не запускать |
| `maintenance/colonisation_sites_cutover.sql` | Перенос последнего состояния каждой площадки из старой `colonisation_events` в `colonisation_sites`, проверка полноты, переименование старой таблицы; её **удаление** — отдельным шагом (освобождает ~12 ГБ). Запускать вручную после обновления. См. [COLONISATION-SITES-REWORK.md](../COLONISATION-SITES-REWORK.md) |
| `maintenance/galaxy_systems_bulk_load.sql` | Снять GIN/GiST-индексы `galaxy_systems` **перед холодной заливкой каталога** (поддержка индексов на лету — главный тормоз вставки 2×10⁸ строк). `DROP INDEX CONCURRENTLY` — вне транзакции |
| `maintenance/galaxy_systems_rebuild_indexes.sql` | Парный файл: вернуть `idx_galaxy_systems_coord` и `idx_galaxy_systems_name_trgm` после заливки + `ANALYZE`. См. [GALAXY-IMPORT-SPEED.md](../GALAXY-IMPORT-SPEED.md) |
| `templates/wiki_colonization_guide.sql.template` | Ручная вставка гайда по колонизации в вики (см. `public/wiki/colonization-guide/README.md`) |
| `route_systems.sql`, `add_site_content_translations.sql` (и `migrations/` в корне репозитория) | Исторические разовые скрипты; их содержимое покрыто миграциями, оставлены для справки |

## Миграции последних недель

| Миграция | Что добавляет | Документ |
|---|---|---|
| `20261009010000_colonisation_sites.sql` | `colonisation_sites` (одна строка на площадку), RPC `colonisation_sites_write`, `colonisation_retention_prune` | COLONISATION-SITES-REWORK.md |
| `20261010000000_pilot_stats_source.sql` | `pilot_stats.stats_source` | CAPI-STABILITY-AND-STATS-SOURCE.md |
| `20261010010000_outfitting_catalog.sql` | правки справочника верфи из админки | OUTFITTING-ADMIN.md |
| `20261010020000_raven_keys.sql` | ключи Raven Colonial пилотов (шифруются `RAVEN_KEY_SECRET`) | ARCHITECT.md |
| `20261011000000_atlas_search_caches.sql`, `20261012000000_atlas_ring_cache_near.sql` | кэш систем и тел Atlas, сессии кольца | ATLAS-SEARCH-REWORK.md |
| `20261013000000…20261013020000_ring_*.sql` | ключевые системы, отклонение, наклон и центр кольца | ATLAS-RING-RESULT-FIX.md |
| `20261013030000_market_construction_blueprints.sql` | поиск рынка по рецепту выбранной стройки, цена покупки | ATLAS-MARKET-FIX.md |
| `20261014000000_station_commerce.sql`, `20261014010000_station_search.sql` | станции, рынки, снимки ассортимента, поиск `/station-search` | STATION-COMMERCE.md |
| `20261015000000_profiles_rls_hardening.sql` | `profiles` только владельцу и персоналу, представление `public_profiles`, защита `role`/`email` | PROFILES-PII-RLS-FIX.md |
| `20261016000000_credentials_and_views_hardening.sql` | `capi_tokens`, `inara_profiles` — только service_role; `api_tokens` без чтения `token_hash`; `security_invoker` у представлений | CONTEXT.md §8.22 |
| `20261017000000_fleet_carriers.sql`, `20261018000000_fleet_carrier_squadron_claims.sql` | учёт авианосцев, привязка эскадренных носителей | FLEET-CARRIERS.md |
| `20261017120000_architect_projects.sql` | «Проекты систем» | ARCHITECT.md |
| `20261018120000_powerplay_systems.sql`, `20261018180000_powerplay_sync_progress.sql` | слой PowerPlay, прогресс и журнал загрузки | POWERPLAY.md |
| `20261019120000_minor_factions.sql` | минорные фракции (`bgs_*`) | FACTIONS.md |
| `20261020120000_unified_system_data.sql` | общие функции разделов: карточка системы, прогресс, журнал → проекты, PowerPlay из журналов | ARCHITECTURE.md |
| `20261021120000_powerplay_owner.sql`, `20261021130000_eddn_listener.sql` | владелец системы PowerPlay (`power_basis`, «не определена»), живые данные EDDN (`eddn_listener_state`) | POWERPLAY.md |
| `20261022120000_station_search_by_station.sql` | поиск по станциям списком: `station_catalog_matches` (общий подбор), `search_station_catalog_stations` (станция + совпадения, общее число), точный выбор `exact_keys` / `station_item_key`; прежний `search_station_catalog` — тот же ответ | STATION-COMMERCE.md |
| `20261029090000_capi_sync_jobs.sql` | durable очередь ручной CAPI-синхронизации, атомарный RPC claim и журналирование этапов/времени | CAPI-STABILITY-AND-STATS-SOURCE.md |

## Как применяются миграции на рабочем сервере

Миграции накатывает сам сервер — `deploy/update-project.sh`, который запускает
update-agent:

* кнопка **«Обновить сейчас»** с флажком «с миграциями» (по умолчанию
  `UPDATE_APPLY_MIGRATIONS=1`) или **«Применить только миграции»** (без
  пересборки) в Админка → Мониторинг;
* применяются **все** файлы `supabase/migrations/*.sql`, которых ещё нет в
  `UPDATE_STATE_DIR/migrations.mark` — и новые между ревизиями, и не
  доехавшие после сбоя прошлого прогона; порядок — алфавитный;
* перед миграциями делается pg_dump (флажок «с бэкапом БД»; каталог
  `galaxy_systems` в копию по умолчанию не входит);
* упавшая миграция остаётся неотмеченной и повторится при следующем запуске.

Поэтому **каждая миграция обязана быть идемпотентной**: `IF NOT EXISTS`,
`CREATE OR REPLACE`, проверки в `DO`-блоках. Её может применить и сервер, и
`full_schema.sql` на базе, развёрнутой из снимка.

## Сценарий А: развернуть с нуля (новый Supabase)

1. Создайте проект Supabase (облачный или self-hosted — `deploy/selfhost/install.sh`,
   см. [SELFHOST.md](../SELFHOST.md)).
2. SQL Editor → вставьте содержимое `supabase/full_schema.sql` → Run.
   Либо через psql:
   ```bash
   psql "$SUPABASE_DB_URL" -f supabase/full_schema.sql
   ```
3. Отдельно (вне транзакции) выполните maintenance-индекс:
   ```bash
   psql "$SUPABASE_DB_URL" -f supabase/maintenance/create_delivery_source_hash_unique_index_concurrently.sql
   ```
   Перенос площадок на новой установке не нужен: миграция
   `20261009010000_colonisation_sites.sql` сама удаляет пустую старую таблицу
   `colonisation_events`.
4. Storage-бакеты: `avatars`, `support-attachments` и `galaxy-data` (облако точек
   каталога) создают миграции; `news-covers` (обложки новостей) создайте в
   Studio → Storage, если он нужен.
5. Authentication → Providers: включите Email и Discord (+ Manual linking, если
   пилоты привязывают Discord к существующим аккаунтам). Для self-hosted —
   `deploy/selfhost/supabase-auth.override.yml`; SMTP — Админка → Авторизация.
6. Authentication → URL Configuration: Site URL и Redirect URLs
   (`https://<домен>/api/auth/callback`).
7. Realtime: таблица `messages` должна быть в публикации `supabase_realtime` —
   000-миграция добавляет её сама, если публикация существует (подписки сайта —
   CONTEXT.md §3.5).
8. Каталог всех систем (`galaxy_systems`) заполняется отдельно — Админка →
   «Каталог систем» ([SPANSH-IMPORT.md](../SPANSH-IMPORT.md)); PowerPlay и фракции —
   своими вкладками «Игровые данные».

## Сценарий Б: Supabase CLI

```bash
supabase login                # SUPABASE_ACCESS_TOKEN
supabase link --project-ref <ref>
supabase db push              # применит supabase/migrations/* по порядку
# self-hosted: npx supabase db push --db-url "$SUPABASE_DB_URL"
```

Порядок применения = лексикографический порядок имён файлов:
`000_…` → `001_…` → `2025…` → `2026…` — именно поэтому базовая схема
названа `000_`.

## Сценарий В: существующая рабочая база

Ничего перезаливать не нужно и **нельзя** запускать `full_schema.sql` поверх
живых данных (исторические миграции `20260904*` создают таблицы без
`IF NOT EXISTS`). Недостающее применяет сервер (см. выше). Если код падает на
отсутствующей таблице/колонке, а обновление ещё не запускалось, —
«Применить только миграции» в админке или вручную по одной:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/<файл>.sql
```

## Сценарий Г: свой Postgres без Supabase

Приложение завязано на Supabase Auth (`auth.users`, `auth.uid()`), PostgREST,
Realtime и Storage — «просто Postgres» недостаточен. Варианты:

- **Self-hosted Supabase** (docker compose от Supabase, `deploy/selfhost/`) —
  тогда всё применяется как в сценарии А;
- полный отказ от Supabase потребует переписать `src/lib/supabase*` и
  авторизацию — это отдельный проект, не покрывается этим комплектом.

## Перенос ДАННЫХ со старого проекта (не только схемы)

```bash
# 1. Дамп только данных (без схемы) со старого проекта
pg_dump "$OLD_DB_URL" \
  --data-only --schema=public --schema=storage \
  --exclude-table-data='storage.objects' \
  -Fc -f data.dump

# 2. Восстановление в новый (схема уже развёрнута по сценарию А)
pg_restore -d "$NEW_DB_URL" --data-only --disable-triggers data.dump
```

Пользователи Auth переносятся отдельно: `pg_dump --schema=auth` (на
managed-Supabase — `supabase db dump --db-url … -s auth`). Файлы Storage
скачиваются/заливаются через API (например, `supabase storage cp --recursive`)
или rclone-совместимый S3-доступ. Каталог `galaxy_systems` выгодней не
переносить, а загрузить заново из дампа Spansh.

Резервная копия рабочей базы — Админка → Бэкапы (`deploy/db-backup.sh`,
`pg_dump -Fc` без `galaxy_systems`, проверка `pg_restore --list`, ротация
`UPDATE_BACKUP_KEEP`) — [MONITORING.md](../MONITORING.md); восстановление после
сбоя сервера — `deploy/db-recover.sh`.

## Новая миграция: что сделать

1. Файл `supabase/migrations/<YYYYMMDDHHMMSS>_<имя>.sql`, идемпотентный.
2. Тот же SQL — блоком в конец `supabase/full_schema.sql`:
   ```sql
   -- ┌────────────────────────────────────────────────────────────────┐
   -- │ MIGRATION: <YYYYMMDDHHMMSS>_<имя>.sql                          │
   -- └────────────────────────────────────────────────────────────────┘
   <содержимое миграции>
   ```
   Тест ищет маркеры `MIGRATION: <файл>.sql` и сверяет их список и порядок с
   каталогом `migrations/`.
3. `npm test`: `migrations-sql.test.mjs` разбирает каждый файл настоящим
   парсером PostgreSQL (libpg-query), тесты фич гоняют SQL в PGlite.
4. Таблицы — в CONTEXT.md §4 и в таблицу «Миграции последних недель» выше.

## Проверка после развёртывания

```sql
-- Сколько таблиц в public (ожидается ~125 и больше)
SELECT count(*) FROM pg_tables WHERE schemaname = 'public';

-- RPC-функции, которые вызывает код (выборочно)
SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND proname IN
 ('get_project_route','get_cmdr_rank','get_route_delivery_stats',
  'increment_thread_views','increment_forum_posts',
  'resolve_delivery_system_placements','colonisation_sites_write',
  'apply_fleet_carrier_batch','save_station_commerce',
  'powerplay_layer_rows','bgs_apply_snapshots');

-- RLS включён везде, где есть политики
SELECT tablename FROM pg_tables t WHERE schemaname='public'
AND NOT rowsecurity AND EXISTS
 (SELECT 1 FROM pg_policies pp WHERE pp.tablename = t.tablename);
```

И функционально: регистрация (создаётся строка в `profiles` триггером
`on_auth_user_created`), создание эскадрильи (триггер создаёт звания и
голосовые комнаты), сообщение на форуме (обновится `last_post_*` у темы).
