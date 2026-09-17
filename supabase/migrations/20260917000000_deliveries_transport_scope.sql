-- ═══════════════════════════════════════════════════════════════
-- Доставки: различаем «весь перевезённый груз» и «завезено на стройплощадку»
-- ═══════════════════════════════════════════════════════════════
--
-- Досье пилота показывает две разные метрики:
--   • «Всего тонн»  — весь груз, который командир перевёз за всё время
--     (колонизационные поставки, склад крыла, продажа на авианосце,
--      грузовые миссии, Powerplay, Search and Rescue);
--   • «На стройплощадки» — только то, что реально ушло на проекты.
--
-- До этой миграции таблица хранила только доставленный груз, и различить
-- источники было нечем. Старые строки остаются с NULL: исторически в
-- `deliveries` попадали только колонизационные поставки, поэтому NULL
-- трактуется как «на стройку» (см. `is_construction IS DISTINCT FROM false`).
-- Новые импорты пишут признак явно.

ALTER TABLE public.deliveries
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS is_construction BOOLEAN,
  ADD COLUMN IF NOT EXISTS market_id TEXT;

COMMENT ON COLUMN public.deliveries.source IS
  'Колонка журнала-источник: colonisation_contribution | cargo_depot | cargo_delta | carrier_delivery | mission_delivery | powerplay_delivery | rescue_delivery';
COMMENT ON COLUMN public.deliveries.is_construction IS
  'NULL — исторические строки (считаются поставкой на стройку); false — перевозка, не относящаяся к проектам';

-- Агрегация досье идёт по пользователю и признаку «стройка»: частичный индекс
-- держит сумму «только стройплощадки» дешёвой даже на большой таблице.
CREATE INDEX IF NOT EXISTS idx_deliveries_user_construction
  ON public.deliveries (user_id, delivered_at DESC)
  WHERE is_construction IS DISTINCT FROM false;

CREATE INDEX IF NOT EXISTS idx_deliveries_user_source
  ON public.deliveries (user_id, source)
  WHERE source IS NOT NULL;
