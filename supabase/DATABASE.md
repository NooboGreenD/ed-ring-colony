# База данных ED Ring Colony — полный комплект

Комплект для развёртывания БД с нуля (новый проект Supabase или свой
Postgres) и для приведения существующей базы в соответствие с кодом.

## Что здесь лежит

| Файл | Назначение |
|---|---|
| `full_schema.sql` | **Полная схема одним файлом** — конкатенация всех миграций в порядке применения. Для развёртывания с нуля через SQL Editor / psql |
| `migrations/000_base_schema.sql` | Базовая схема: ~45 таблиц, которые код использует, но которые раньше не были описаны ни в одной миграции (создавались вручную в SQL Editor) + 5 RPC-функций + форумные триггеры + realtime/storage |
| `migrations/001_rls_policies.sql` | RLS-политики всех «старых» таблиц (49 секций) |
| `migrations/2025…-2026…_*.sql` | Инкрементальные миграции (wiki, support, CAPI, галнет-переводы, приватность досье и т.д.) |
| `migrations/20260920000000_site_content_translations.sql` | Переводы site_content (раньше жила неучтённой в `migrations/` в корне репо) |
| `maintenance/create_delivery_source_hash_unique_index_concurrently.sql` | Уникальный индекс deliveries.source_hash. `CREATE INDEX CONCURRENTLY` — выполняется **отдельно, вне транзакции** |
| `maintenance/colonisation_events_source_hash_dedup.sql` | Разбор накопленных дублей `colonisation_events` (префлайт → копия лишних строк → удаление) и уникальный индекс по `(user_id, source_hash)`. Тоже **отдельно, вне транзакции**, в тихое окно |
| `route_systems.sql`, `add_site_content_translations.sql` | Исторические разовые скрипты; их содержимое уже покрыто миграциями, оставлены для справки |

## История: почему понадобился 000_base_schema.sql

Проект развивался прямо в SQL Editor Supabase, поэтому в репозитории
не было DDL для ~27 таблиц, которые активно использует код
(`messages`, `project_systems`, `squadron_ranks`, `squadron_voice_*`,
`user_notifications`, `forum_subscriptions`, `forum_notifications`,
`market_search_jobs`, `hub_goals`, `atlas_routes` и др.), и для
5 RPC-функций (`get_project_route`, `get_cmdr_rank`,
`increment_thread_views`, `increment_forum_posts`,
`get_route_delivery_stats`). Базовые таблицы в
`20260830102924_rls_policies.sql` лежали закомментированными.

`000_base_schema.sql` восстанавливает всё это. Колонки выведены из
фактических обращений кода (insert/select/upsert в `src/`) и из условий
RLS-политик. Файл идемпотентен: на живой продовой базе он ничего не
сломает — существующие таблицы пропустит, недостающие досоздаст.

## Сценарий А: развернуть с нуля (новый Supabase-проект)

1. Создайте проект на supabase.com (или self-hosted Supabase).
2. SQL Editor → вставьте содержимое `supabase/full_schema.sql` → Run.
   Либо через psql:
   ```bash
   psql "$SUPABASE_DB_URL" -f supabase/full_schema.sql
   ```
3. Отдельно (вне транзакции) выполните maintenance-индексы:
   ```bash
   psql "$SUPABASE_DB_URL" -f supabase/maintenance/create_delivery_source_hash_unique_index_concurrently.sql
   psql "$SUPABASE_DB_URL" -f supabase/maintenance/colonisation_events_source_hash_dedup.sql
   ```
4. Проверьте Storage-бакеты: `avatars`, `news-covers`,
   `support-attachments` (первые создаются миграциями; если прав не
   хватило — создайте в Dashboard → Storage, политики в миграциях).
5. Authentication → Providers: включите Email и Discord (+ Manual linking,
   если пилоты привязывают Discord к существующим аккаунтам).
6. Authentication → URL Configuration: Site URL и Redirect URLs
   (`https://<домен>/api/auth/callback`).
7. Database → Replication (или SQL): таблица `messages` должна быть в
   публикации `supabase_realtime` — 000-миграция добавляет её сама, если
   публикация существует.

## Сценарий Б: канонический путь через Supabase CLI

```bash
supabase login                # SUPABASE_ACCESS_TOKEN
supabase link --project-ref <ref>
supabase db push              # применит supabase/migrations/* по порядку
```

Порядок применения = лексикографический порядок имён файлов:
`000_…` → `001_…` → `2025…` → `2026…` — именно поэтому базовая схема
названа `000_`.

## Сценарий В: существующая продовая база

Ничего перезаливать не нужно. Если код падает на отсутствующей
таблице/колонке — примените только `000_base_schema.sql`: он идемпотентен
и досоздаст недостающее, не тронув данные.

## Сценарий Г: свой Postgres без Supabase

Приложение завязано на Supabase Auth (`auth.users`, `auth.uid()`),
PostgREST и Realtime — «просто Postgres» недостаточен. Варианты:

- **Self-hosted Supabase** (docker compose от Supabase) — тогда всё
  применяется как в сценарии А;
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

Пользователи Auth переносятся отдельно: Supabase Dashboard →
Authentication → Users → экспорт, либо `pg_dump --schema=auth`
(на managed-Supabase для этого нужен `supabase db dump --db-url … -s auth`).
Файлы Storage скачиваются/заливаются через API (например,
`supabase storage cp --recursive`) или rclone-совместимый S3-доступ.

## Как пересобрать full_schema.sql после новых миграций

```bash
python3 - <<'EOF'
import os
mig = 'supabase/migrations'
files = sorted(f for f in os.listdir(mig) if f.endswith('.sql'))
with open('supabase/full_schema.sql', 'w') as out:
    out.write('-- ED Ring Colony — полная схема (автосборка, см. supabase/DATABASE.md)\n')
    for f in files:
        out.write(f'\n-- ═══ MIGRATION: {f} ═══\n\n')
        out.write(open(os.path.join(mig, f)).read().rstrip() + '\n')
EOF
```

## Проверка после развёртывания

```sql
-- Все ли таблицы на месте (ожидается ≥ 70 в public)
SELECT count(*) FROM pg_tables WHERE schemaname = 'public';

-- RPC-функции, которые вызывает код
SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND proname IN
 ('get_project_route','get_cmdr_rank','get_route_delivery_stats',
  'increment_thread_views','increment_forum_posts',
  'resolve_delivery_system_placements');

-- RLS включён везде, где есть политики
SELECT tablename FROM pg_tables t WHERE schemaname='public'
AND NOT rowsecurity AND EXISTS
 (SELECT 1 FROM pg_policies pp WHERE pp.tablename = t.tablename);
```

И функционально: регистрация (создаётся строка в `profiles` триггером
`on_auth_user_created`), создание эскадрильи (триггер насоздаёт звания и
голосовые комнаты), сообщение на форуме (обновится `last_post_*` у темы).
