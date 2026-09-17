-- ═══════════════════════════════════════════════════════════════
-- Доставки: КУДА именно ушёл груз (стройплощадка / колонизационный корабль /
-- авианосец / грузовая миссия / рынок / Powerplay / SAR)
-- ═══════════════════════════════════════════════════════════════
--
-- Миграция `20260917000000_deliveries_transport_scope` развела «весь
-- перевозимый груз» и «завезено на стройплощадку» булевым `is_construction`.
-- Этого мало: досье обязано показывать структуру перевозок — сколько ушло на
-- площадки колонизационных проектов, сколько на колонизационные корабли
-- («System Colonisation Ship»), сколько отгружено авианосцам, сколько
-- перевезено грузовыми миссиями и сколько просто продано на рынках.
--
-- Значения `delivery_kind` (зеркало `src/lib/cargoScope.ts::DeliveryKind`):
--   construction_site | colonisation_ship | fleet_carrier | mission_delivery
--   | powerplay_delivery | rescue_delivery | market_sale | legacy_site
--
-- `station_name`/`station_kind` — станция, у которой сдан груз: по ним видно,
-- почему строка отнесена к тому или иному виду, и по ним же можно
-- пересчитать историю, когда правила классификации уточняются.

ALTER TABLE public.deliveries
  ADD COLUMN IF NOT EXISTS delivery_kind TEXT,
  ADD COLUMN IF NOT EXISTS station_name TEXT,
  ADD COLUMN IF NOT EXISTS station_kind TEXT;

COMMENT ON COLUMN public.deliveries.delivery_kind IS
  'Куда сдан груз: construction_site | colonisation_ship | fleet_carrier | mission_delivery | powerplay_delivery | rescue_delivery | market_sale | legacy_site';
COMMENT ON COLUMN public.deliveries.station_kind IS
  'Вид станции из Docked/Market: construction_site | colonisation_ship | fleet_carrier | station | outpost | surface | megaship';

-- Строки без `delivery_kind` наследуют смысл из `source`/`is_construction`:
-- исторические (NULL признак) считаются поставкой на стройку, новые — по
-- явному `is_construction`. Вью держит это правило в одном месте, чтобы и
-- досье, и любые будущие отчёты не расходились.
CREATE OR REPLACE VIEW public.delivery_scope_summary AS
SELECT
  user_id,
  COALESCE(
    delivery_kind,
    CASE
      WHEN is_construction IS DISTINCT FROM false THEN 'legacy_site'
      WHEN source = 'carrier_delivery' THEN 'fleet_carrier'
      WHEN source IN ('mission_delivery', 'cargo_depot') THEN 'mission_delivery'
      WHEN source = 'powerplay_delivery' THEN 'powerplay_delivery'
      WHEN source = 'rescue_delivery' THEN 'rescue_delivery'
      ELSE 'market_sale'
    END
  ) AS kind,
  COALESCE(SUM(GREATEST(amount, 0)), 0) AS tons,
  COUNT(*) FILTER (WHERE amount > 0) AS ops
FROM public.deliveries
GROUP BY 1, 2;

COMMENT ON VIEW public.delivery_scope_summary IS
  'Тоннаж и число поставок пользователя в разбивке по получателю груза';

-- Структура перевозок читается одним запросом на досье: частичный индекс
-- держит дешёвой и «только стройку», и группировку по видам.
CREATE INDEX IF NOT EXISTS idx_deliveries_user_kind
  ON public.deliveries (user_id, delivery_kind)
  WHERE delivery_kind IS NOT NULL;
