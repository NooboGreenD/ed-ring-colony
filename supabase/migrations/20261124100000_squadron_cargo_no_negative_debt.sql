-- Squadron inventory is partial: withdrawing unobserved opening stock must
-- floor the estimate at zero *at that event*, not create a negative balance
-- that consumes future deliveries. Keep all events so delayed uploads and
-- newer baselines can still be reconciled in event order.
-- Personal carriers and the batch RPC's authentication/locking are unchanged.
CREATE OR REPLACE FUNCTION public.squadron_cargo_running_quantity(
  p_carrier_id bigint,
  p_commodity text,
  p_baseline_qty integer,
  p_baseline_at timestamptz
) RETURNS integer
LANGUAGE sql STABLE
SET search_path = public
AS $$
  WITH running AS (
    SELECT sum(e.delta::bigint) OVER (
      ORDER BY e.event_at, e.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS balance, e.delta
    FROM public.fleet_carrier_events e
    WHERE e.carrier_id = p_carrier_id AND e.commodity = p_commodity
      AND (p_baseline_at IS NULL OR e.event_at > p_baseline_at)
  )
  SELECT (p_baseline_qty::bigint + coalesce(sum(delta::bigint), 0)
    - least(0::bigint, p_baseline_qty::bigint + coalesce(min(balance), 0)))::integer
  FROM running;
$$;
REVOKE ALL ON FUNCTION public.squadron_cargo_running_quantity(bigint, text, integer, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.squadron_cargo_running_quantity(bigint, text, integer, timestamptz)
  TO service_role;

CREATE OR REPLACE FUNCTION public.squadron_cargo_quantity_floor()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fleet_carriers
             WHERE carrier_id = NEW.carrier_id AND carrier_type = 'SquadronCarrier') THEN
    NEW.quantity := public.squadron_cargo_running_quantity(
      NEW.carrier_id, NEW.commodity, NEW.baseline_qty, NEW.baseline_at);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.squadron_cargo_quantity_floor() FROM PUBLIC, anon, authenticated;

-- Cover the existing RPC's final recomputation as well as baseline changes.
-- The independent observation-time trigger still records journal times.
DROP TRIGGER IF EXISTS squadron_cargo_quantity_floor ON public.fleet_carrier_cargo;
CREATE TRIGGER squadron_cargo_quantity_floor
BEFORE INSERT OR UPDATE OF quantity, baseline_qty, baseline_at ON public.fleet_carrier_cargo
FOR EACH ROW EXECUTE FUNCTION public.squadron_cargo_quantity_floor();

-- Repair existing estimates without fabricating events, moving baselines or
-- losing deduplication hashes. Reapplying the migration is safe.
-- Use the same parent-row lock as the RPC before touching its cargo rows.
DO $$
DECLARE cid bigint;
BEGIN
  FOR cid IN SELECT carrier_id FROM public.fleet_carriers
             WHERE carrier_type = 'SquadronCarrier' ORDER BY carrier_id FOR UPDATE LOOP
    UPDATE public.fleet_carrier_cargo c
    SET quantity = public.squadron_cargo_running_quantity(c.carrier_id, c.commodity, c.baseline_qty, c.baseline_at),
        updated_at = now()
    WHERE c.carrier_id = cid AND c.quantity IS DISTINCT FROM public.squadron_cargo_running_quantity(
      c.carrier_id, c.commodity, c.baseline_qty, c.baseline_at);
    IF FOUND THEN
      UPDATE public.fleet_carriers SET cargo_updated_at = now() WHERE carrier_id = cid;
    END IF;
  END LOOP;
END;
$$;
