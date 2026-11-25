-- OPERATOR-ONLY, OPTIONAL DATA REPAIR. Not an automatic migration.
-- Prerequisite: 20261126090000_squadron_bank_reconciliation.sql.
-- Supplied by the user: Brewers Port / DNHG / 3713477376 has only
-- 1034 tritium + 4 Titan Drive Components + 2 limpets (1040 t total).
-- RECHECK the complete inventory in game before using this historical report!
-- Fill the actual UTC observation time below; NULL deliberately fails closed.
-- Dry-run by default: inspect the results, then ROLLBACK. To persist, replace
-- the FINAL ROLLBACK with COMMIT before running the reviewed script.
-- Never substitute now() merely because the observation time is unknown.
BEGIN;

SELECT public.reconcile_squadron_bank(
  3713477376,
  'DNHG',
  NULL::timestamptz, -- REQUIRED: e.g. an actual timestamp from your observation, with UTC offset
  '[
    {"commodity":"tritium","qty":1034,"name_localised":"Тритий"},
    {"commodity":"thargoidtitandrivecomponent","qty":4,"name_localised":"Компоненты двигателя титанов"},
    {"commodity":"drones","qty":2,"name_localised":"Дроны"}
  ]'::jsonb,
  'Operator verified the COMPLETE in-game bank inventory of Brewers Port / DNHG; replacing stale tracked stock.'
);

-- May differ from 1040 if genuine transfers occurred AFTER the observation.
SELECT commodity, name_localised, baseline_qty, baseline_at, quantity, observed_at
FROM public.fleet_carrier_cargo
WHERE carrier_id = 3713477376
ORDER BY quantity DESC, commodity;

SELECT sum(quantity) AS current_tracked_tonnes
FROM public.fleet_carrier_cargo WHERE carrier_id = 3713477376;

ROLLBACK;
