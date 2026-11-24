-- READ ONLY. Run in the project's Supabase SQL editor (not in a public API).
-- No migration is needed to run this query. Change only these two values if
-- diagnosing a different carrier/good. Output omits users, tokens and hashes.
WITH params AS (
  SELECT 3713477376::bigint AS carrier_id, 'steel'::text AS commodity
), cargo AS (
  SELECT p.*, c.quantity, coalesce(c.baseline_qty, 0) AS baseline_qty,
         c.baseline_at, c.baseline_source, c.updated_at,
         fc.carrier_type, fc.cargo_baseline_at AS full_baseline_at,
         fc.cargo_baseline_source AS full_baseline_source
  FROM params p
  LEFT JOIN public.fleet_carriers fc ON fc.carrier_id = p.carrier_id
  LEFT JOIN public.fleet_carrier_cargo c ON c.carrier_id = p.carrier_id AND c.commodity = p.commodity
), active AS (
  SELECT e.*, sum(e.delta::bigint) OVER (
    ORDER BY e.event_at, e.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS running_delta
  FROM public.fleet_carrier_events e JOIN cargo c
    ON e.carrier_id = c.carrier_id AND e.commodity = c.commodity
  WHERE c.baseline_at IS NULL OR e.event_at > c.baseline_at
), sums AS (
  SELECT coalesce(sum(delta::bigint), 0) AS net_delta,
         coalesce(min(running_delta), 0) AS minimum_delta,
         count(*) AS active_events
  FROM active
), times AS (
  SELECT max(e.event_at) AS latest_event_at,
         max(e.event_at) FILTER (WHERE e.delta > 0) AS latest_deposit_at,
         max(e.created_at) AS latest_upload_at,
         count(*) FILTER (WHERE e.event_at <= c.baseline_at) AS events_covered_by_baseline
  FROM public.fleet_carrier_events e JOIN cargo c
    ON e.carrier_id = c.carrier_id AND e.commodity = c.commodity
)
SELECT c.*, s.active_events, s.net_delta,
       greatest(0::bigint, c.baseline_qty::bigint + s.net_delta) AS old_formula_quantity,
       -least(0::bigint, c.baseline_qty::bigint + s.minimum_delta) AS unobserved_withdrawal_deficit,
       c.baseline_qty::bigint + s.net_delta
         - least(0::bigint, c.baseline_qty::bigint + s.minimum_delta) AS per_event_floor_quantity,
       t.*, coalesce(t.latest_deposit_at <= c.baseline_at, false) AS latest_deposit_covered_by_baseline,
       now() AS database_now
FROM cargo c CROSS JOIN sums s CROSS JOIN times t;

-- Recent events for the affected commodity: inspect event time separately
-- from upload time. A recent upload may contain an older, covered event.
SELECT event, delta, event_at, created_at AS uploaded_at, source
FROM public.fleet_carrier_events
WHERE carrier_id = 3713477376 AND commodity = 'steel'
ORDER BY event_at DESC, id DESC LIMIT 20;
