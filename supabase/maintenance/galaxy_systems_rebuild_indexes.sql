-- Построить поисковые индексы galaxy_systems ПОСЛЕ холодной заливки.
--
-- Парный файл к galaxy_systems_bulk_load.sql. Запускать, когда импорт
-- закончен (каталог ~2×10⁸ строк). Всё строится CONCURRENTLY — сайт работает,
-- только медленнее, пока индексов нет.
--
-- Запуск (psql в autocommit, НЕ внутри транзакции):
--   docker exec -i supabase-db psql -U postgres -d postgres \
--     < supabase/maintenance/galaxy_systems_rebuild_indexes.sql
--
-- Время: часы на каждый большой индекс. Прогресс:
--   SELECT phase, blocks_done, blocks_total, tuples_done
--   FROM pg_stat_progress_create_index;
--
-- Прерванный запуск оставляет НЕВАЛИДНЫЙ индекс, а IF NOT EXISTS его
-- пропустит — сначала проверьте и снесите такие:
--   SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--   WHERE NOT i.indisvalid AND c.relname LIKE 'idx_galaxy_systems%';

-- Память сортировки решает: 64 МБ по умолчанию против 2 ГБ — это разы.
SET maintenance_work_mem = '2GB';
SET max_parallel_maintenance_workers = 4;

CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Куб/KNN атласа.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_galaxy_systems_coord
  ON public.galaxy_systems USING gist (cube(ARRAY[x, y, z]));

-- Поиск системы по части имени.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_galaxy_systems_name_trgm
  ON public.galaxy_systems USING gin (name_lc gin_trgm_ops);

-- Планировщик после 10⁸ вставок обязан пересчитать статистику, иначе
-- запросы атласа продолжат ходить по плану пустой таблицы.
ANALYZE public.galaxy_systems;

SELECT indexname FROM pg_indexes WHERE tablename = 'galaxy_systems' ORDER BY indexname;
