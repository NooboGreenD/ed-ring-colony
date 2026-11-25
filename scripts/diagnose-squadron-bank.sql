-- READ ONLY. Private SQL-editor diagnosis, no personal IDs/tokens/hashes.
-- Defaults to Brewers Port (DNHG); no modifications are made.
SELECT carrier_id, callsign, name, carrier_type, squadron_id,
       cargo_baseline_at, cargo_baseline_source, cargo_updated_at, space_usage
FROM public.fleet_carriers WHERE carrier_id = 3713477376;

SELECT c.commodity, c.name_localised, c.quantity, c.baseline_qty, c.baseline_at,
       c.baseline_source, c.observed_at, c.updated_at,
       (SELECT count(*) FROM public.fleet_carrier_events e
         WHERE e.carrier_id = c.carrier_id AND e.commodity = c.commodity
           AND (c.baseline_at IS NULL OR e.event_at > c.baseline_at)) AS active_events
FROM public.fleet_carrier_cargo c
WHERE carrier_id = 3713477376
ORDER BY quantity DESC, commodity;

-- Separate event time from upload time; uploads today may be old journals.
SELECT commodity, event, source, count(*) AS event_count, sum(delta) AS net_tonnes,
       min(event_at) AS first_event_at, max(event_at) AS last_event_at,
       max(created_at) AS last_uploaded_at
FROM public.fleet_carrier_events WHERE carrier_id = 3713477376
GROUP BY commodity, event, source ORDER BY commodity, event, source;

-- Candidates, NOT proof of duplication: two pilots can perform identical
-- transfers in the same second. Do not delete these rows automatically.
SELECT commodity, event, event_at, delta, count(*) AS matching_events,
       array_agg(DISTINCT source) AS sources
FROM public.fleet_carrier_events WHERE carrier_id = 3713477376
GROUP BY commodity, event, event_at, delta HAVING count(*) > 1
ORDER BY event_at DESC LIMIT 50;
