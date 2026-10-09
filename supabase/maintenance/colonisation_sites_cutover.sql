-- ═══════════════════════════════════════════════════════════════════════════
-- colonisation_sites: перенос последнего состояния площадок и удаление
-- старой таблицы colonisation_events (освобождает ~12 ГБ сразу).
--
-- Запускать ВРУЧНУЮ, одним файлом, ПОСЛЕ обновления сайта и Helper-сервера,
-- когда работает новый код (старый код не должен писать в colonisation_events,
-- иначе свежие строки останутся в старой таблице и будут потеряны при DROP).
-- Перед запуском — резервная копия: deploy/db-backup.sh или pg_dump.
--
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < supabase/maintenance/colonisation_sites_cutover.sql
--   # либо с хоста: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <этот файл>
--
-- Что делает по шагам:
--   0. префлайт: миграция 20261009010000_colonisation_sites.sql применена;
--      размеры и число строк до переноса;
--   1. переносит в colonisation_sites ПОСЛЕДНЕЕ состояние каждой площадки
--      (по MarketID, самое новое по метке времени). Контрактные строки
--      `ColonisationContribution` не переносятся — это не состояние стройки.
--      Повторный запуск безопасен: ON CONFLICT обновляет строку только если
--      метка времени новее;
--   2. проверяет, что у каждой площадки из старой таблицы есть строка в новой,
--      и без этого не продолжает;
--   3. переименовывает старую таблицу в colonisation_events_legacy (обратимо:
--      место пока не освобождено, а код её уже не читает и не пишет);
--   4. ОТДЕЛЬНЫМ шагом (закомментирован) удаляет colonisation_events_legacy —
--      только после того, как карта Raven показала данные по площадкам.
--
-- Повторный запуск до шага 3 безопасен (перенос идемпотентен). После того как
-- таблица переименована, файл остановится на первом обращении к
-- colonisation_events — это ожидаемо: переносить уже нечего.
-- ═══════════════════════════════════════════════════════════════════════════

SET statement_timeout = 0;
SET work_mem = '256MB';

-- ── 0. Префлайт ─────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.colonisation_sites') IS NULL THEN
    RAISE EXCEPTION 'таблицы colonisation_sites нет: сначала примените миграцию 20261009010000_colonisation_sites.sql';
  END IF;
  IF to_regclass('public.colonisation_events') IS NULL THEN
    RAISE NOTICE 'таблицы colonisation_events уже нет — переносить нечего';
  END IF;
END $$;

SELECT
  CASE WHEN to_regclass('public.colonisation_events') IS NULL THEN NULL
       ELSE pg_size_pretty(pg_total_relation_size('public.colonisation_events')) END AS legacy_size,
  (SELECT count(*) FROM public.colonisation_sites) AS sites_rows_before;

-- Сколько строк и площадок в старой таблице (счёт по всей таблице: на десятках
-- миллионов строк это десятки секунд — в тихом окне нормально).
SELECT count(*) AS legacy_rows,
       count(DISTINCT market_id) FILTER (WHERE market_id IS NOT NULL AND market_id <> 0) AS legacy_markets,
       count(*) FILTER (WHERE coalesce(raw_event->>'event', '') = 'ColonisationContribution') AS legacy_contributions,
       count(*) FILTER (WHERE market_id IS NULL OR market_id = 0) AS legacy_without_market
  FROM public.colonisation_events;

-- ── 1. Перенос последнего состояния каждой площадки ─────────────────────────

INSERT INTO public.colonisation_sites AS s (
  market_id, system_name, construction_id, construction_name,
  construction_progress, resources_total, event_timestamp, user_id
)
SELECT latest.market_id,
       btrim(latest.system_name),
       latest.construction_id,
       nullif(btrim(coalesce(latest.construction_name, '')), ''),
       round(latest.construction_progress, 2),
       public.colonisation_compact_resources(latest.resources_total),
       latest.event_timestamp,
       latest.user_id
  FROM (
    SELECT DISTINCT ON (e.market_id)
           e.market_id, e.system_name, e.construction_id, e.construction_name,
           e.construction_progress, e.resources_total, e.event_timestamp, e.user_id
      FROM public.colonisation_events AS e
     WHERE e.market_id IS NOT NULL
       AND e.market_id <> 0
       AND btrim(coalesce(e.system_name, '')) <> ''
       AND coalesce(e.raw_event->>'event', '') <> 'ColonisationContribution'
     ORDER BY e.market_id, e.event_timestamp DESC, e.id DESC
  ) AS latest
ON CONFLICT (market_id) DO UPDATE SET
  system_name           = EXCLUDED.system_name,
  construction_id       = EXCLUDED.construction_id,
  construction_name     = EXCLUDED.construction_name,
  construction_progress = EXCLUDED.construction_progress,
  resources_total       = EXCLUDED.resources_total,
  event_timestamp       = EXCLUDED.event_timestamp,
  user_id               = EXCLUDED.user_id
WHERE EXCLUDED.event_timestamp > s.event_timestamp;

-- ── 2. Проверка: ни одна площадка не потеряна ───────────────────────────────

DO $$
DECLARE
  missing bigint;
BEGIN
  IF to_regclass('public.colonisation_events') IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO missing
    FROM (
      SELECT DISTINCT e.market_id
        FROM public.colonisation_events AS e
       WHERE e.market_id IS NOT NULL
         AND e.market_id <> 0
         AND btrim(coalesce(e.system_name, '')) <> ''
         AND coalesce(e.raw_event->>'event', '') <> 'ColonisationContribution'
    ) AS markets
   WHERE NOT EXISTS (
     SELECT 1 FROM public.colonisation_sites AS s WHERE s.market_id = markets.market_id
   );

  IF missing > 0 THEN
    RAISE EXCEPTION 'перенос неполный: % площадок без строки в colonisation_sites — старую таблицу не переименовываю', missing;
  END IF;
  RAISE NOTICE 'перенос проверен: все площадки на месте';
END $$;

SELECT count(*) AS sites_rows_after,
       pg_size_pretty(pg_total_relation_size('public.colonisation_sites')) AS sites_size
  FROM public.colonisation_sites;

-- ── 3. Старая таблица — в сторону, не удаляем ──────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.colonisation_events') IS NOT NULL THEN
    ALTER TABLE public.colonisation_events RENAME TO colonisation_events_legacy;
    COMMENT ON TABLE public.colonisation_events_legacy IS
      'УСТАРЕЛО: переехала в colonisation_sites. Удалить после проверки карты Raven: DROP TABLE public.colonisation_events_legacy;';
  END IF;
END $$;

ANALYZE public.colonisation_sites;

-- ── 4. Удаление старой таблицы (ОТДЕЛЬНО, после проверки) ───────────────────
--
-- Убедитесь, что карта Raven показывает точные ресурсы по известным площадкам,
-- и только потом выполните строку ниже. Она освобождает место сразу — без
-- VACUUM FULL и без долгой блокировки.
--
-- DROP TABLE IF EXISTS public.colonisation_events_legacy;
--
-- Откат до удаления: переименовать обратно и вернуть предыдущий релиз сайта:
--   ALTER TABLE public.colonisation_events_legacy RENAME TO colonisation_events;
