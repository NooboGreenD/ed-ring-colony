-- An incomplete event ledger cannot recover missed withdrawals by replaying
-- deposits. Allow an operator to reconcile a COMPLETE, observed bank inventory.
-- This migration changes NO inventories. Reconciliation is explicit/service-only.
CREATE TABLE IF NOT EXISTS public.squadron_bank_reconciliations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carrier_id bigint NOT NULL REFERENCES public.fleet_carriers(carrier_id),
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by text NOT NULL DEFAULT current_user,
  reason text NOT NULL,
  items jsonb NOT NULL,
  previous_carrier jsonb NOT NULL,
  previous_cargo jsonb NOT NULL,
  UNIQUE (carrier_id, observed_at)
);
ALTER TABLE public.squadron_bank_reconciliations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.squadron_bank_reconciliations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.squadron_bank_reconciliations TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.squadron_bank_reconciliations_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_squadron_bank(
  p_carrier_id bigint,
  p_expected_callsign text,
  p_observed_at timestamptz,
  p_items jsonb,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  car public.fleet_carriers%ROWTYPE;
  item jsonb;
  before_cargo jsonb;
  reconciliation_id bigint;
  existing public.squadron_bank_reconciliations%ROWTYPE;
  total_qty bigint;
BEGIN
  -- Same parent lock as apply_fleet_carrier_batch; ingestion and reconciliation
  -- cannot interleave cargo writes. Do not accept personal/unbound carriers.
  SELECT * INTO car FROM public.fleet_carriers WHERE carrier_id = p_carrier_id FOR UPDATE;
  IF NOT FOUND OR car.carrier_type <> 'SquadronCarrier' OR car.squadron_id IS NULL THEN
    RAISE EXCEPTION 'A bound squadron carrier is required';
  END IF;
  IF p_expected_callsign IS NULL OR trim(p_expected_callsign) = ''
     OR upper(trim(p_expected_callsign)) IS DISTINCT FROM upper(car.callsign) THEN
    RAISE EXCEPTION 'Carrier callsign does not match';
  END IF;
  IF p_observed_at IS NULL OR NOT isfinite(p_observed_at) OR p_observed_at > now() THEN
    RAISE EXCEPTION 'An actual observation time, not a future/upload time, is required';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 10 AND 1000 THEN
    RAISE EXCEPTION 'Provide an audit reason (10 to 1000 characters)';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'Provide the complete bank inventory as an array';
  END IF;
  IF jsonb_array_length(p_items) > 512 THEN
    RAISE EXCEPTION 'Too many inventory rows';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(item) <> 'object'
       OR jsonb_typeof(item->'commodity') IS DISTINCT FROM 'string'
       OR (item->>'commodity') !~ '^[a-z0-9]{1,80}$'
       OR jsonb_typeof(item->'qty') IS DISTINCT FROM 'number'
       OR (item->>'qty') !~ '^[0-9]{1,5}$'
       OR (item->>'qty')::integer NOT BETWEEN 0 AND 60000
       OR (item ? 'name_localised' AND (jsonb_typeof(item->'name_localised') <> 'string'
         OR length(item->>'name_localised') > 120)) THEN
      RAISE EXCEPTION 'Invalid inventory row';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) i GROUP BY i->>'commodity' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate commodity in inventory';
  END IF;
  SELECT coalesce(sum((i->>'qty')::integer), 0) INTO total_qty FROM jsonb_array_elements(p_items) i;
  IF total_qty > 60000 THEN RAISE EXCEPTION 'Inventory exceeds squadron carrier capacity'; END IF;

  -- Exact retry is a no-op even if later observations have since arrived.
  -- Reusing the timestamp with a different inventory is never an overwrite.
  SELECT * INTO existing FROM public.squadron_bank_reconciliations
    WHERE carrier_id = p_carrier_id AND observed_at = p_observed_at;
  IF FOUND THEN
    IF existing.items IS DISTINCT FROM p_items THEN RAISE EXCEPTION 'Conflicting inventory at this observation time'; END IF;
    RETURN jsonb_build_object('ok', true, 'id', existing.id, 'duplicate', true);
  END IF;
  IF car.cargo_baseline_at >= p_observed_at OR EXISTS (
    SELECT 1 FROM public.fleet_carrier_cargo WHERE carrier_id = p_carrier_id AND baseline_at >= p_observed_at
  ) THEN
    RAISE EXCEPTION 'A newer or equal inventory baseline exists; obtain a fresh complete observation';
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.commodity), '[]'::jsonb) INTO before_cargo
    FROM public.fleet_carrier_cargo c WHERE c.carrier_id = p_carrier_id;
  INSERT INTO public.squadron_bank_reconciliations(carrier_id, observed_at, reason, items, previous_carrier, previous_cargo)
    VALUES (p_carrier_id, p_observed_at, trim(p_reason), p_items, jsonb_build_object(
      'carrier_id', car.carrier_id, 'callsign', car.callsign,
      'cargo_baseline_at', car.cargo_baseline_at, 'cargo_baseline_source', car.cargo_baseline_source,
      'cargo_updated_at', car.cargo_updated_at), before_cargo)
    RETURNING id INTO reconciliation_id;

  UPDATE public.fleet_carriers SET cargo_baseline_at = p_observed_at,
    cargo_baseline_source = 'BankReconciliation', cargo_updated_at = now(), updated_at = now()
    WHERE carrier_id = p_carrier_id;

  -- Include ALL old rows and every known event commodity, even if absent from
  -- the supplied inventory. Missing goods are zero AT the observation time.
  -- Delayed history arriving later inherits the carrier-wide baseline too.
  INSERT INTO public.fleet_carrier_cargo(carrier_id, commodity, baseline_qty, baseline_at, baseline_source)
    SELECT p_carrier_id, keys.commodity, coalesce((v.item->>'qty')::integer, 0), p_observed_at, 'BankReconciliation'
    FROM (
      SELECT commodity FROM public.fleet_carrier_cargo WHERE carrier_id = p_carrier_id
      UNION SELECT commodity FROM public.fleet_carrier_events WHERE carrier_id = p_carrier_id
      UNION SELECT value->>'commodity' FROM jsonb_array_elements(p_items)
    ) keys
    LEFT JOIN LATERAL (SELECT value AS item FROM jsonb_array_elements(p_items) WHERE value->>'commodity' = keys.commodity) v ON true
    ON CONFLICT (carrier_id, commodity) DO UPDATE SET
      baseline_qty = EXCLUDED.baseline_qty, baseline_at = EXCLUDED.baseline_at,
      baseline_source = EXCLUDED.baseline_source;

  -- Do not delete events/hashes: keep audit evidence and upload deduplication.
  -- The existing floor/observation triggers compute deltas strictly AFTER the
  -- observation, preserving already-ingested newer operations.
  UPDATE public.fleet_carrier_cargo c SET
    name_localised = coalesce((SELECT i->>'name_localised' FROM jsonb_array_elements(p_items) i
      WHERE i->>'commodity' = c.commodity), c.name_localised),
    quantity = public.squadron_cargo_running_quantity(c.carrier_id, c.commodity, c.baseline_qty, c.baseline_at),
    updated_at = now()
    WHERE c.carrier_id = p_carrier_id;
  RETURN jsonb_build_object('ok', true, 'id', reconciliation_id, 'duplicate', false,
    'observed_at', p_observed_at, 'observed_total', total_qty);
END;
$$;
REVOKE ALL ON FUNCTION public.reconcile_squadron_bank(bigint, text, timestamptz, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_squadron_bank(bigint, text, timestamptz, jsonb, text) TO service_role;
