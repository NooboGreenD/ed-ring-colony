-- Импорт журнала падал с «canceling statement due to statement timeout» на
-- больших историях доставок.
--
-- Миграция `20260911040000_delivery_import_placement_resolver.sql` создала
-- индексы только на НОРМАЛИЗОВАННОЕ имя системы:
--   ((lower(regexp_replace(btrim(system_name), '\s+', ' ', 'g'))))
-- Они обслуживают RPC `resolve_delivery_system_placements`. Но резервный путь
-- `loadExactPlacementLookup` (и прямой поиск хабов/маршрутов в том же потоке)
-- фильтрует по ТОЧНОМУ `system_name`:
--   WHERE system_name IN (...)
-- под который ни один из этих индексов не подходит. Без обычного индекса каждый
-- такой запрос сканирует таблицу целиком, а Supabase обрывает запрос по
-- `statement_timeout` через несколько секунд.
--
-- Индексы намеренно не уникальные: дубликаты имён в hubs/route_systems
-- допустимы исторически, и миграция не имеет права на них падать.
CREATE INDEX IF NOT EXISTS idx_hubs_system_name
  ON public.hubs (system_name);

CREATE INDEX IF NOT EXISTS idx_route_systems_system_name
  ON public.route_systems (system_name);

-- Запрос существующих `source_hash` опирается на частичный индекс
-- `idx_deliveries_user_source_hash ... WHERE source_hash IS NOT NULL`.
-- API теперь добавляет в запрос явный `source_hash IS NOT NULL`, чтобы
-- планировщик гарантированно применял частичный индекс; этот обычный индекс —
-- страховка для старых развёртываний API, которые фильтр ещё не добавляют.
CREATE INDEX IF NOT EXISTS idx_deliveries_user_source_hash_full
  ON public.deliveries (user_id, source_hash);
