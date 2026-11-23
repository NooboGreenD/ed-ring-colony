-- updated_at is an ingestion time: uploading an old journal today must not
-- acknowledge a newer local squadron-bank transfer in Helper. Keep the actual
-- observation time per commodity, including depleted (quantity=0) rows.
ALTER TABLE public.fleet_carrier_cargo ADD COLUMN IF NOT EXISTS observed_at timestamptz;

CREATE OR REPLACE FUNCTION public.fleet_carrier_cargo_observation_time()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.observed_at := greatest(NEW.baseline_at, (
    SELECT max(e.event_at) FROM public.fleet_carrier_events e
     WHERE e.carrier_id = NEW.carrier_id AND e.commodity = NEW.commodity
  ));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.fleet_carrier_cargo_observation_time() FROM PUBLIC;

DROP TRIGGER IF EXISTS fleet_carrier_cargo_observation_time ON public.fleet_carrier_cargo;
CREATE TRIGGER fleet_carrier_cargo_observation_time
BEFORE INSERT OR UPDATE OF quantity, baseline_at ON public.fleet_carrier_cargo
FOR EACH ROW EXECUTE FUNCTION public.fleet_carrier_cargo_observation_time();

-- Backfill with event times, never now(). The trigger also covers future
-- ledger recomputations without changing the batch RPC/its access rules.
UPDATE public.fleet_carrier_cargo SET quantity = quantity;
