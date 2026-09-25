-- ═══════════════════════════════════════════════════════════════════════════
-- colonisation_events: разбор накопленных дублей и уникальный индекс
--
-- Запускать ВРУЧНУЮ, одним файлом, лучше в тихое окно:
--   docker exec -i supabase-db psql -U postgres -d postgres \
--     < supabase/maintenance/colonisation_events_source_hash_dedup.sql
--   # либо с хоста: psql "$DATABASE_URL" -f supabase/maintenance/colonisation_events_source_hash_dedup.sql
--
-- Что делает по шагам:
--   0. диагностика: сколько строк и какие из них мусорные;
--   1. копия всех «лишних» строк в colonisation_events_dedup_backup (её можно
--      выбросить одной командой, когда результат проверен);
--   2. удаление этих строк из colonisation_events;
--   3. уникальный индекс (user_id, source_hash) — уже вне транзакции.
--
-- Файл идемпотентен: повторный запуск ничего не ломает (лишние строки
-- добавляются в копию через ON CONFLICT DO NOTHING, индекс — IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 0. Префлайт: что вообще лежит в таблице ────────────────────────────────
--
-- «Состояние» стройки здесь = система + рынок + конструкция + прогресс +
-- список ресурсов. Всё, что отличается только меткой времени, — один и тот же
-- снимок, повторённый журналом (а метка времени у таких строк новая, поэтому
-- в ограничение схемы они не попадают).
SELECT
  count(*)                                                       AS total_rows,
  count(*) FILTER (WHERE source_hash IS NOT NULL)                 AS written_after_fix,
  count(*) FILTER (WHERE source_hash IS NULL)                     AS written_before_fix,
  count(*) FILTER (WHERE coalesce(construction_id::text, '') = '') AS empty_construction_id,
  count(*) FILTER (WHERE coalesce(system_name, '') = '')           AS empty_system_name,
  count(DISTINCT (user_id, market_id, construction_id))            AS sites
FROM public.colonisation_events;

-- Сколько строк приходится на одно состояние одной площадки одного пилота:
-- всё, что больше одной, — повторы одного и того же снимка.
SELECT
  sum(repeats) AS redundant_rows,
  count(*)     AS states_with_repeats,
  max(repeats) AS worst_case_rows_per_state
FROM (
  SELECT count(*) AS repeats
  FROM public.colonisation_events
  WHERE coalesce(raw_event->>'event', '') = 'ColonisationConstructionDepot'
  GROUP BY user_id,
           lower(btrim(system_name)),
           market_id,
           construction_id,
           round(construction_progress::numeric, 2),
           coalesce(construction_name, ''),
           md5(coalesce(resources_total, '[]'::jsonb)::text)
  HAVING count(*) > 1
) AS grouped;

-- Точные копии строки (тот же момент, та же площадка, тот же `raw_event`).
SELECT count(*) AS exact_duplicate_rows
FROM (
  SELECT row_number() OVER (
           PARTITION BY user_id, event_timestamp, lower(btrim(system_name)),
                        market_id, construction_id, construction_name,
                        construction_progress,
                        md5(coalesce(resources_total, '[]'::jsonb)::text),
                        md5(raw_event::text)
           ORDER BY id
         ) AS rn
  FROM public.colonisation_events
) AS ranked
WHERE rn > 1;

-- Насколько таблица раздута по дням (видно всплески, когда watcher Helper'а
-- отправлял по снимку на каждый тик).
SELECT date_trunc('day', event_timestamp) AS day, count(*) AS rows
FROM public.colonisation_events
GROUP BY 1
ORDER BY 1 DESC
LIMIT 30;

-- Необязательная проверка: вклад командира (`ColonisationContribution`).
-- Эти строки никто не читает — тоннаж живёт в `deliveries` (с `source_hash`),
-- а строка здесь дублируется ещё и по каждому ресурсу. Удаляются отдельным
-- шагом ниже, если решите, что они не нужны.
SELECT count(*) AS contribution_rows
FROM public.colonisation_events
WHERE coalesce(raw_event->>'event', '') = 'ColonisationContribution';


-- ── 1. Копия лишних строк + 2. удаление ───────────────────────────────────
--
-- Копируем ПЕРЕД удалением: разбор истории без возможности откатиться — это
-- единственная необратимая операция во всём файле.

CREATE TABLE IF NOT EXISTS public.colonisation_events_dedup_backup (
  id         integer PRIMARY KEY,
  row_data   jsonb NOT NULL,
  reason     text  NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now()
);

BEGIN;

-- 1a. Повтор одного и того же состояния: оставляем самое раннее наблюдение,
--     остальные (`rn > 1`) — мусор от повторных отправок.
INSERT INTO public.colonisation_events_dedup_backup (id, row_data, reason)
SELECT id, to_jsonb(events) - 'rn', 'repeated-state'
FROM (
  SELECT events.*,
         row_number() OVER (
           PARTITION BY events.user_id, lower(btrim(events.system_name)), events.market_id,
                        events.construction_id, round(events.construction_progress::numeric, 2),
                        coalesce(events.construction_name, ''),
                        md5(coalesce(events.resources_total, '[]'::jsonb)::text)
           ORDER BY events.event_timestamp, events.id
         ) AS rn
  FROM public.colonisation_events AS events
  WHERE coalesce(events.raw_event->>'event', '') = 'ColonisationConstructionDepot'
) AS events
WHERE rn > 1
ON CONFLICT (id) DO NOTHING;

-- 1b. Точные копии строки: тот же момент, та же площадка, тот же raw_event.
INSERT INTO public.colonisation_events_dedup_backup (id, row_data, reason)
SELECT id, to_jsonb(events) - 'rn', 'exact-duplicate'
FROM (
  SELECT events.*,
         row_number() OVER (
           PARTITION BY events.user_id, events.event_timestamp, lower(btrim(events.system_name)),
                        events.market_id, events.construction_id, events.construction_name,
                        events.construction_progress,
                        md5(coalesce(events.resources_total, '[]'::jsonb)::text),
                        md5(events.raw_event::text)
           ORDER BY events.id
         ) AS rn
  FROM public.colonisation_events AS events
) AS events
WHERE rn > 1
ON CONFLICT (id) DO NOTHING;

-- 1c. Строки без имени системы — записаны CAPI-синхронизацией, когда в окне
--     не было ни `Location`, ни `FSDJump`. Площадку по ним не найти, карта и
--     Raven их не читают.
INSERT INTO public.colonisation_events_dedup_backup (id, row_data, reason)
SELECT id, to_jsonb(events), 'empty-system'
FROM public.colonisation_events AS events
WHERE coalesce(btrim(events.system_name), '') = ''
ON CONFLICT (id) DO NOTHING;

-- (Необязательно) 1d. Вклад командира: тоннаж и так лежит в `deliveries`,
--     а эти строки никто не читает. Уберите комментарий, если согласны.
-- INSERT INTO public.colonisation_events_dedup_backup (id, row_data, reason)
-- SELECT id, to_jsonb(colonisation_events), 'contribution-row'
-- FROM public.colonisation_events
-- WHERE coalesce(raw_event->>'event', '') = 'ColonisationContribution'
-- ON CONFLICT (id) DO NOTHING;

-- 2. Удаляем ровно то, что скопировали.
DELETE FROM public.colonisation_events
USING public.colonisation_events_dedup_backup
WHERE colonisation_events.id = colonisation_events_dedup_backup.id;

COMMIT;

-- Что осталось (для отчёта):
SELECT reason, count(*) AS copied_rows
FROM public.colonisation_events_dedup_backup
GROUP BY reason ORDER BY reason;

SELECT count(*) AS remaining_rows FROM public.colonisation_events;

-- Откат (если понадобится): строки лежат целиком в row_data.
-- INSERT INTO public.colonisation_events
-- SELECT (jsonb_populate_record(NULL::public.colonisation_events, row_data)).*
-- FROM public.colonisation_events_dedup_backup WHERE reason = 'repeated-state';
-- После проверки копию можно удалить:  DROP TABLE public.colonisation_events_dedup_backup;


-- ── 3. Уникальный индекс ──────────────────────────────────────────────────
--
-- Выполняйте ОТДЕЛЬНО и вне транзакции (CREATE INDEX CONCURRENTLY нельзя ни в
-- транзакционной обёртке Supabase, ни в BEGIN/COMMIT). Если SQL Editor
-- жалуется на транзакцию — запустите одну строку ниже как отдельный запрос.

-- Дублей «нового» формата быть не должно: запрос обязан вернуть ноль строк.
-- Если строки есть (например, параллельно шла запись старым клиентом) —
-- повторите шаг 1 и проверьте ещё раз.
SELECT user_id, source_hash, count(*) AS duplicate_count
FROM public.colonisation_events
WHERE source_hash IS NOT NULL
GROUP BY user_id, source_hash
HAVING count(*) > 1;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_colonisation_events_user_source_hash_unique
  ON public.colonisation_events (user_id, source_hash)
  WHERE source_hash IS NOT NULL;

-- Проверка: индекс должен быть valid (прерванный CONCURRENTLY оставляет
-- невалидный — тогда DROP INDEX CONCURRENTLY и заново).
SELECT c.relname AS index_name, i.indisvalid, i.indisunique
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname = 'idx_colonisation_events_user_source_hash_unique';

ANALYZE public.colonisation_events;

-- Размер таблицы и индексов — чтобы видеть эффект разбора:
SELECT pg_size_pretty(pg_total_relation_size('public.colonisation_events')) AS total_size;
