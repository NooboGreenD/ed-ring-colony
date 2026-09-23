-- ════════════════════════════════════════════════════════════════
-- Migration: galaxy_systems на масштабе всей галактики
--
-- Каталог — это не 1.3M строк. Spansh `systems.json.gz` (5.9 GiB) содержит все
-- исследованные системы: EDAstro считает 203 642 699 систем (99.9M visited +
-- 103.8M route-only). Порядок величины — 10⁸ строк, и прежняя схема для него
-- не годится:
--
--   · три b-tree по x/y/z + bitmap AND на куб — это сотни тысяч обращений к
--     странице на каждый запрос Атласа, а сортировка по расстоянию всё равно
--     требует прочитать весь куб;
--   · b-tree по star_type (16 значений) и star_giant_class (3 значения)
--     планировщик не использует никогда: селективность слишком мала;
--   · autovacuum по умолчанию ждёт 20% мёртвых строк — на 2×10⁸ это 4×10⁷
--     строк до первой уборки.
--
-- Что делает миграция:
--   1. GiST-индекс по cube(ARRAY[x,y,z]) — куб-фильтр и KNN-сортировка
--      «ближайшие сначала» одним индексным сканированием;
--   2. функции Атласа переписаны на этот индекс (`&&` + `<->`);
--   3. пять устаревших индексов удаляются (только когда новый построен);
--   4. fillfactor/autovacuum настраиваются под большую таблицу.
--
-- На большой таблице GiST создаётся БЕЗ блокировки записи отдельным скриптом
-- supabase/maintenance/galaxy_systems_spatial_index.sql — миграция в этом
-- случае только заменит функции и напишет NOTICE.
--
-- Проверка после применения (см. SPANSH-IMPORT.md → «Масштаб»):
--   SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid))
--   FROM pg_stat_user_indexes WHERE relname = 'galaxy_systems';
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE
  spatial_ready boolean;
  total_rows bigint;
BEGIN
  -- cube входит в contrib и есть в образе Supabase; если расширения нет,
  -- блок откатится целиком и схема останется прежней (функции включительно).
  CREATE EXTENSION IF NOT EXISTS cube;

  SELECT COALESCE(c.reltuples, 0)::bigint INTO total_rows
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'galaxy_systems';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'galaxy_systems'
      AND indexname = 'idx_galaxy_systems_coord'
  ) INTO spatial_ready;

  IF NOT spatial_ready AND total_rows < 5000000 THEN
    -- Пустая/небольшая таблица (свежая установка): строим сразу.
    EXECUTE 'CREATE INDEX idx_galaxy_systems_coord ON public.galaxy_systems USING gist (cube(ARRAY[x, y, z]))';
    spatial_ready := true;
  ELSIF NOT spatial_ready THEN
    RAISE NOTICE
      'galaxy_systems: ~% строк — GiST-индекс создайте без блокировки записи: psql -f supabase/maintenance/galaxy_systems_spatial_index.sql',
      total_rows;
  END IF;

  -- ─── Ближайшие звёзды нужных классов в кубе ───
  -- `&&` отсекает куб индексом, `<->` отдаёт строки уже в порядке расстояния,
  -- поэтому LIMIT не требует читать и сортировать весь куб.
  CREATE OR REPLACE FUNCTION public.galaxy_star_candidates(
    cx double precision,
    cy double precision,
    cz double precision,
    half double precision,
    star_types text[],
    giant_classes text[],
    lim integer
  )
  RETURNS SETOF public.galaxy_systems
  LANGUAGE sql
  STABLE
  AS $fn$
    SELECT g.*
    FROM public.galaxy_systems g
    WHERE cube(ARRAY[g.x, g.y, g.z]) && cube(
            ARRAY[cx - half, cy - half, cz - half],
            ARRAY[cx + half, cy + half, cz + half]
          )
      AND (
        (cardinality(star_types) > 0 AND g.star_type = ANY(star_types))
        OR (cardinality(giant_classes) > 0 AND g.star_giant_class = ANY(giant_classes))
      )
    ORDER BY cube(ARRAY[g.x, g.y, g.z]) <-> cube(ARRAY[cx, cy, cz])
    LIMIT GREATEST(1, LEAST(COALESCE(lim, 2000), 2000));
  $fn$;

  -- ─── Любые системы в кубе, ближайшие сначала (поиск маршрута) ───
  CREATE OR REPLACE FUNCTION public.galaxy_systems_near(
    cx double precision,
    cy double precision,
    cz double precision,
    half double precision,
    lim integer
  )
  RETURNS TABLE(name text, x double precision, y double precision, z double precision)
  LANGUAGE sql
  STABLE
  AS $fn$
    SELECT g.name, g.x, g.y, g.z
    FROM public.galaxy_systems g
    WHERE cube(ARRAY[g.x, g.y, g.z]) && cube(
            ARRAY[cx - half, cy - half, cz - half],
            ARRAY[cx + half, cy + half, cz + half]
          )
    ORDER BY cube(ARRAY[g.x, g.y, g.z]) <-> cube(ARRAY[cx, cy, cz])
    LIMIT GREATEST(1, LEAST(COALESCE(lim, 800), 2000));
  $fn$;

  GRANT EXECUTE ON FUNCTION public.galaxy_star_candidates(
    double precision, double precision, double precision, double precision, text[], text[], integer
  ) TO anon, authenticated, service_role;

  GRANT EXECUTE ON FUNCTION public.galaxy_systems_near(
    double precision, double precision, double precision, double precision, integer
  ) TO anon, authenticated, service_role;

  IF spatial_ready THEN
    -- Куб и KNN закрывает один GiST; классы звезды фильтруются внутри куба.
    DROP INDEX IF EXISTS public.idx_galaxy_systems_x;
    DROP INDEX IF EXISTS public.idx_galaxy_systems_y;
    DROP INDEX IF EXISTS public.idx_galaxy_systems_z;
    DROP INDEX IF EXISTS public.idx_galaxy_systems_star_type;
    DROP INDEX IF EXISTS public.idx_galaxy_systems_star_giant_class;
  END IF;

  -- ─── Хранение и autovacuum под 10⁸ строк ───
  -- fillfactor 100: апсерт меняет только реально обновившиеся системы, HOT нам
  -- всё равно не доступен (индексируемые колонки), а 10% пустого места на
  -- таблице такого размера — это гигабайты.
  -- scale_factor 0.01/0.002: уборка и сбор статистики чаще, чем раз в 4×10⁷ строк.
  ALTER TABLE public.galaxy_systems SET (
    fillfactor = 100,
    autovacuum_vacuum_scale_factor = 0.01,
    autovacuum_analyze_scale_factor = 0.002,
    autovacuum_vacuum_cost_limit = 2000,
    autovacuum_vacuum_cost_delay = 2
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'galaxy_systems scale migration skipped: %', SQLERRM;
END $$;

-- Статистика по фактическим данным: без неё планировщик оценивает куб
-- по прежнему (пустому) состоянию таблицы.
ANALYZE public.galaxy_systems;
