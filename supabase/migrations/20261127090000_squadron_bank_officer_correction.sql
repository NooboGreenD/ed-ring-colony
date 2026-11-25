-- Website correction uses the existing audited reconciliation, never direct
-- browser table writes. Repeat permissions inside the parent-carrier lock so
-- stale pages/cross-squadron rebindings cannot authorize a correction.
ALTER TABLE public.squadron_bank_reconciliations
  ADD COLUMN IF NOT EXISTS actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.correct_squadron_bank_as_officer(
  p_actor_id uuid,
  p_squadron_id bigint,
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
  result jsonb;
BEGIN
  SELECT * INTO car FROM public.fleet_carriers WHERE carrier_id = p_carrier_id FOR UPDATE;
  IF NOT FOUND OR car.carrier_type <> 'SquadronCarrier' OR car.squadron_id IS DISTINCT FROM p_squadron_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Squadron carrier access denied';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.squadron_members m
      JOIN public.squadrons s ON s.id = m.squadron_id
      LEFT JOIN public.squadron_ranks r ON r.id = m.rank_id AND r.squadron_id = m.squadron_id
    WHERE m.user_id = p_actor_id AND m.squadron_id = p_squadron_id
      AND (s.created_by = p_actor_id OR r.can_edit_squadron IS TRUE)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Squadron officer permission required';
  END IF;
  result := public.reconcile_squadron_bank(p_carrier_id, p_expected_callsign, p_observed_at, p_items, p_reason);
  IF coalesce((result->>'duplicate')::boolean, false) IS FALSE THEN
    UPDATE public.squadron_bank_reconciliations SET actor_id = p_actor_id
      WHERE id = (result->>'id')::bigint AND carrier_id = p_carrier_id;
  END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.correct_squadron_bank_as_officer(uuid,bigint,bigint,text,timestamptz,jsonb,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.correct_squadron_bank_as_officer(uuid,bigint,bigint,text,timestamptz,jsonb,text)
  TO service_role;
