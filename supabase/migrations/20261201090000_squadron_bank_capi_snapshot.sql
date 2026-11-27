-- A server-fetched Frontier bank snapshot is not an officer's manual edit.
-- Keep the existing audited reconciliation and parent lock; ordinary members
-- may trigger it but cannot submit inventory or call this service-only RPC.
CREATE OR REPLACE FUNCTION public.sync_squadron_bank_from_capi(
  p_actor_id uuid, p_squadron_id bigint, p_carrier_id bigint,
  p_expected_callsign text, p_observed_at timestamptz, p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE car public.fleet_carriers%ROWTYPE; result jsonb;
BEGIN
  SELECT * INTO car FROM public.fleet_carriers WHERE carrier_id = p_carrier_id FOR UPDATE;
  IF NOT FOUND OR car.carrier_type <> 'SquadronCarrier'
     OR car.squadron_id IS DISTINCT FROM p_squadron_id
     OR NOT EXISTS (SELECT 1 FROM public.squadron_members
                    WHERE user_id = p_actor_id AND squadron_id = p_squadron_id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Squadron bank access denied';
  END IF;
  -- With no provider timestamp the server uses the request-start retrieval
  -- cursor. Refuse a response racing with observed transactions; retry later.
  IF EXISTS (SELECT 1 FROM public.fleet_carrier_events
             WHERE carrier_id = p_carrier_id AND event_at >= p_observed_at) THEN
    RAISE EXCEPTION 'Bank changed during snapshot retrieval; retry when idle';
  END IF;
  result := public.reconcile_squadron_bank(p_carrier_id, p_expected_callsign, p_observed_at, p_items,
    'Frontier CAPI /squadron shared bank snapshot (server retrieved)');
  IF coalesce((result->>'duplicate')::boolean, false) IS FALSE THEN
    UPDATE public.squadron_bank_reconciliations SET actor_id = p_actor_id
      WHERE id = (result->>'id')::bigint AND carrier_id = p_carrier_id;
  END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_squadron_bank_from_capi(uuid,bigint,bigint,text,timestamptz,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_squadron_bank_from_capi(uuid,bigint,bigint,text,timestamptz,jsonb) TO service_role;
