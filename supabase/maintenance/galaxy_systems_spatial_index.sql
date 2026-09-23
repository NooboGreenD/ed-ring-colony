-- Пространственный GiST-индекс galaxy_systems БЕЗ блокировки записи.
--
-- Зачем отдельным файлом: миграция 20260925000000_galaxy_systems_scale.sql
-- строит индекс сама только на небольшой таблице. На каталоге всей галактики
-- (10⁸ строк) обычный CREATE INDEX держит блокировку записи часами, а
-- CREATE INDEX CONCURRENTLY нельзя выполнить внутри транзакции — ни в
-- транзакционной обёртке Supabase, ни в BEGIN/COMMIT.
--
-- Запуск (psql применяет файл в autocommit — так и нужно):
--   docker exec -i supabase-db psql -U postgres -d postgres \
--     < supabase/maintenance/galaxy_systems_spatial_index.sql
--   # либо с хоста:  psql "$DATABASE_URL" -f supabase/maintenance/galaxy_systems_spatial_index.sql
--
-- Время на 2×10⁸ строк: часы (два прохода по таблице); запись и чтение всё это
-- время работают. Прогресс:
--   SELECT phase, blocks_done, blocks_total FROM pg_stat_progress_create_index;

-- ── 0. Префлайт: прерванный предыдущий запуск оставляет НЕВАЛИДНЫЙ индекс,
--       а IF NOT EXISTS его пропустит. Такой индекс надо удалить первым.
SELECT c.relname AS invalid_index
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE NOT i.indisvalid AND c.relname = 'idx_galaxy_systems_coord';

-- Если строка выше есть — выполните и повторите запуск файла:
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_galaxy_systems_coord;

-- ── 1. Расширение и индекс ──
CREATE EXTENSION IF NOT EXISTS cube;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_galaxy_systems_coord
  ON public.galaxy_systems USING gist (cube(ARRAY[x, y, z]));

-- ── 2. Устаревшие индексы: куб и KNN теперь закрывает один GiST ──
DROP INDEX CONCURRENTLY IF EXISTS public.idx_galaxy_systems_x;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_galaxy_systems_y;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_galaxy_systems_z;
-- Класс звезды (16 значений) и класс гиганта (3 значения) отдельно не
-- ищутся никогда: их фильтрует galaxy_star_candidates внутри куба.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_galaxy_systems_star_type;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_galaxy_systems_star_giant_class;

-- ── 3. Статистика под новый план ──
ANALYZE public.galaxy_systems;

-- ── 4. Проверка: оба запроса должны показать Bitmap/Index Scan по
--       idx_galaxy_systems_coord, а не Seq Scan.
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM public.galaxy_systems_near(0, 0, 0, 200, 50);

-- Сколько места занимают индексы таблицы:
SELECT indexrelname,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size,
       idx_scan
FROM pg_stat_user_indexes
WHERE relname = 'galaxy_systems'
ORDER BY pg_relation_size(indexrelid) DESC;
