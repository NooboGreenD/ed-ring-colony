-- Холодная заливка каталога: снять тяжёлые индексы на время импорта.
--
-- Зачем. В galaxy_systems на каждую вставку обновляется до пяти индексов,
-- из них два очень дорогих: GIN по триграммам имени
-- (idx_galaxy_systems_name_trgm) и GiST по кубу координат
-- (idx_galaxy_systems_coord). На 2×10⁸ строк это кратно дороже самой записи
-- строки: поддержка индексов «на лету» — главный источник медленной заливки
-- после способа записи (COPY vs INSERT).
--
-- Правильный порядок холодного старта:
--   1. этот файл              — снять поисковые индексы;
--   2. импорт                 — npm run spansh:import (COPY-путь);
--   3. galaxy_systems_rebuild_indexes.sql — построить их заново.
--
-- Уникальные индексы (uq_galaxy_systems_id64, uq_galaxy_systems_name_lc)
-- НЕ трогаем: на них держится идемпотентность upsert-а, без них повторный
-- запуск задвоит каталог.
--
-- Запуск (psql в autocommit — CONCURRENTLY нельзя в транзакции):
--   docker exec -i supabase-db psql -U postgres -d postgres \
--     < supabase/maintenance/galaxy_systems_bulk_load.sql
--
-- Пока индексы сняты, поиск по имени (trgm) и запросы атласа идут seq scan-ом:
-- выполняйте это только на холодной заливке, не на живом каталоге.

DROP INDEX CONCURRENTLY IF EXISTS public.idx_galaxy_systems_name_trgm;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_galaxy_systems_coord;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_galaxy_systems_x;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_galaxy_systems_y;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_galaxy_systems_z;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_galaxy_systems_star_type;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_galaxy_systems_star_giant_class;

-- Сборка индекса после заливки упирается в память сортировки: дайте её
-- сессии, которая будет их строить (см. rebuild-файл).
SELECT current_setting('maintenance_work_mem') AS maintenance_work_mem,
       current_setting('max_parallel_maintenance_workers') AS parallel_workers;

-- Что осталось на таблице (должны быть только PK и два уникальных):
SELECT indexname FROM pg_indexes WHERE tablename = 'galaxy_systems' ORDER BY indexname;
