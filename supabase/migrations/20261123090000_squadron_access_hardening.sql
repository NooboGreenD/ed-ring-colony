-- S02/S11: enforce the same squadron boundary for API and direct PostgREST.
-- Forward-only: do not edit already applied migrations. No data is rewritten.
-- Applied atomically by deploy/update-project.sh (--single-transaction).

-- These helpers deliberately accept no user id: identity always comes from
-- the verified JWT. Definer avoids recursive squadron_members RLS checks.
CREATE OR REPLACE FUNCTION public.squadron_request_can(p_squadron bigint, p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.squadrons sq
      WHERE sq.id = p_squadron AND sq.created_by = auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.squadron_members sm
      LEFT JOIN public.squadron_ranks r ON r.id = sm.rank_id AND r.squadron_id = sm.squadron_id
      WHERE sm.squadron_id = p_squadron AND sm.user_id = auth.uid()
      AND CASE p_permission
        WHEN 'member' THEN true
        WHEN 'officer' THEN coalesce(r.can_manage_members OR r.can_manage_projects OR r.can_manage_ranks OR r.can_edit_squadron, false)
        WHEN 'members' THEN coalesce(r.can_manage_members, false)
        WHEN 'ranks' THEN coalesce(r.can_manage_ranks, false)
        WHEN 'projects' THEN coalesce(r.can_manage_projects, false)
        WHEN 'edit' THEN coalesce(r.can_edit_squadron, false)
        ELSE false END
    )
  ) AND p_permission IN ('member', 'officer', 'members', 'ranks', 'projects', 'edit');
$$;

CREATE OR REPLACE FUNCTION public.squadron_request_can_delegate(
  p_squadron bigint, p_members boolean, p_ranks boolean, p_projects boolean, p_edit boolean
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT (NOT coalesce(p_members, false) OR public.squadron_request_can(p_squadron, 'members'))
     AND (NOT coalesce(p_ranks, false) OR public.squadron_request_can(p_squadron, 'ranks'))
     AND (NOT coalesce(p_projects, false) OR public.squadron_request_can(p_squadron, 'projects'))
     AND (NOT coalesce(p_edit, false) OR public.squadron_request_can(p_squadron, 'edit'));
$$;

CREATE OR REPLACE FUNCTION public.squadron_request_can_assign(p_squadron bigint, p_rank bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT p_rank IS NULL OR EXISTS (
    SELECT 1 FROM public.squadron_ranks r WHERE r.id = p_rank AND r.squadron_id = p_squadron
      AND public.squadron_request_can_delegate(p_squadron, r.can_manage_members,
        r.can_manage_ranks, r.can_manage_projects, r.can_edit_squadron)
  );
$$;

CREATE OR REPLACE FUNCTION public.squadron_request_can_manage_target(p_squadron bigint, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT public.squadron_request_can(p_squadron, 'members') AND EXISTS (
    SELECT 1 FROM public.squadrons sq WHERE sq.id = p_squadron
      AND (sq.created_by IS DISTINCT FROM p_user OR sq.created_by = auth.uid())
  );
$$;

CREATE OR REPLACE FUNCTION public.squadron_request_can_use_room(p_room bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.squadron_voice_rooms vr WHERE vr.id = p_room
    AND public.squadron_request_can(vr.squadron_id, 'member')
    AND (NOT vr.is_officer_only OR public.squadron_request_can(vr.squadron_id, 'officer')));
$$;

REVOKE ALL ON FUNCTION public.squadron_request_can(bigint,text),
  public.squadron_request_can_delegate(bigint,boolean,boolean,boolean,boolean),
  public.squadron_request_can_assign(bigint,bigint),
  public.squadron_request_can_manage_target(bigint,uuid),
  public.squadron_request_can_use_room(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.squadron_request_can(bigint,text),
  public.squadron_request_can_delegate(bigint,boolean,boolean,boolean,boolean),
  public.squadron_request_can_assign(bigint,bigint),
  public.squadron_request_can_manage_target(bigint,uuid),
  public.squadron_request_can_use_room(bigint) TO authenticated, service_role;

-- Policies are permissive/ORed by default. Replace the complete policy set on
-- these six relations, including installations with legacy policy names.
DO $$ DECLARE p record;
BEGIN
  FOR p IN SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'
    AND tablename IN ('squadron_members', 'squadron_ranks', 'squadron_chat_messages',
      'squadron_voice_rooms', 'squadron_voice_signals', 'squadron_voice_participants')
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, p.tablename);
  END LOOP;
END $$;

ALTER TABLE public.squadron_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squadron_ranks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squadron_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squadron_voice_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squadron_voice_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squadron_voice_participants ENABLE ROW LEVEL SECURITY;

-- Public roster/rank read models remain public. Server-owned identity, legacy
-- role and journal columns cannot be changed with a browser JWT.
REVOKE INSERT, UPDATE ON public.squadron_members FROM PUBLIC, anon, authenticated;
GRANT INSERT (squadron_id,user_id,rank_id,callsign), UPDATE (rank_id,callsign)
  ON public.squadron_members TO authenticated;
GRANT SELECT ON public.squadron_members TO anon, authenticated;
GRANT DELETE ON public.squadron_members TO authenticated;
CREATE POLICY squadron_members_select ON public.squadron_members FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY squadron_members_insert ON public.squadron_members FOR INSERT TO authenticated
  WITH CHECK (public.squadron_request_can_manage_target(squadron_id,user_id)
    AND public.squadron_request_can_assign(squadron_id,rank_id));
CREATE POLICY squadron_members_update ON public.squadron_members FOR UPDATE TO authenticated
  USING (public.squadron_request_can_manage_target(squadron_id,user_id))
  WITH CHECK (public.squadron_request_can_manage_target(squadron_id,user_id)
    AND public.squadron_request_can_assign(squadron_id,rank_id));
CREATE POLICY squadron_members_delete ON public.squadron_members FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.squadron_request_can_manage_target(squadron_id,user_id));

REVOKE INSERT, UPDATE ON public.squadron_ranks FROM PUBLIC, anon, authenticated;
GRANT INSERT (squadron_id,name,sort_order,is_default,can_manage_members,can_manage_ranks,can_manage_projects,can_edit_squadron),
  UPDATE (name,sort_order,can_manage_members,can_manage_ranks,can_manage_projects,can_edit_squadron)
  ON public.squadron_ranks TO authenticated;
GRANT SELECT ON public.squadron_ranks TO anon, authenticated;
GRANT DELETE ON public.squadron_ranks TO authenticated;
CREATE POLICY squadron_ranks_select ON public.squadron_ranks FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY squadron_ranks_insert ON public.squadron_ranks FOR INSERT TO authenticated
  WITH CHECK (NOT is_default AND public.squadron_request_can(squadron_id,'ranks')
    AND public.squadron_request_can_delegate(squadron_id,can_manage_members,can_manage_ranks,can_manage_projects,can_edit_squadron));
CREATE POLICY squadron_ranks_update ON public.squadron_ranks FOR UPDATE TO authenticated
  USING (public.squadron_request_can(squadron_id,'ranks'))
  WITH CHECK (public.squadron_request_can(squadron_id,'ranks'));
CREATE POLICY squadron_ranks_delete ON public.squadron_ranks FOR DELETE TO authenticated
  USING (NOT is_default AND public.squadron_request_can(squadron_id,'ranks')
    AND NOT EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.rank_id = squadron_ranks.id));

-- Default rank editing is limited to sort_order, just as in the API.
CREATE OR REPLACE FUNCTION public.squadron_protect_default_rank()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user = 'authenticated' AND OLD.is_default AND
    (to_jsonb(NEW) - 'sort_order') IS DISTINCT FROM (to_jsonb(OLD) - 'sort_order') THEN
    RAISE EXCEPTION 'Default rank permissions are server-managed' USING ERRCODE = '42501';
  END IF;
  IF current_user = 'authenticated' AND
    ROW(NEW.can_manage_members,NEW.can_manage_ranks,NEW.can_manage_projects,NEW.can_edit_squadron)
      IS DISTINCT FROM ROW(OLD.can_manage_members,OLD.can_manage_ranks,OLD.can_manage_projects,OLD.can_edit_squadron)
    AND NOT public.squadron_request_can_delegate(NEW.squadron_id,NEW.can_manage_members,
      NEW.can_manage_ranks,NEW.can_manage_projects,NEW.can_edit_squadron) THEN
    RAISE EXCEPTION 'Cannot delegate permissions you do not have' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS squadron_protect_default_rank ON public.squadron_ranks;
CREATE TRIGGER squadron_protect_default_rank BEFORE UPDATE ON public.squadron_ranks
  FOR EACH ROW EXECUTE FUNCTION public.squadron_protect_default_rank();

CREATE POLICY squadron_chat_messages_select ON public.squadron_chat_messages FOR SELECT TO authenticated
  USING (public.squadron_request_can(squadron_id,'member') AND
    (chat_type = 'general' OR (chat_type = 'officer' AND public.squadron_request_can(squadron_id,'officer'))));
CREATE POLICY squadron_chat_messages_insert ON public.squadron_chat_messages FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.squadron_request_can(squadron_id,'member') AND
    (chat_type = 'general' OR (chat_type = 'officer' AND public.squadron_request_can(squadron_id,'officer'))));

CREATE POLICY squadron_voice_rooms_select ON public.squadron_voice_rooms FOR SELECT TO authenticated
  USING (public.squadron_request_can_use_room(id));
CREATE POLICY squadron_voice_rooms_insert ON public.squadron_voice_rooms FOR INSERT TO authenticated
  WITH CHECK (public.squadron_request_can(squadron_id,'officer'));
CREATE POLICY squadron_voice_rooms_delete ON public.squadron_voice_rooms FOR DELETE TO authenticated
  USING (public.squadron_request_can(squadron_id,'officer'));

CREATE POLICY squadron_voice_signals_select ON public.squadron_voice_signals FOR SELECT TO authenticated
  USING (public.squadron_request_can_use_room(room_id)
    AND (target_id IS NULL OR target_id = auth.uid() OR sender_id = auth.uid())
    AND EXISTS (SELECT 1 FROM public.squadron_voice_rooms vr
      WHERE vr.id = squadron_voice_signals.room_id AND vr.squadron_id = squadron_voice_signals.squadron_id));
CREATE POLICY squadron_voice_signals_insert ON public.squadron_voice_signals FOR INSERT TO authenticated
  WITH CHECK (sender_id = auth.uid() AND public.squadron_request_can_use_room(room_id)
    AND EXISTS (SELECT 1 FROM public.squadron_voice_rooms vr
      WHERE vr.id = squadron_voice_signals.room_id AND vr.squadron_id = squadron_voice_signals.squadron_id));
CREATE POLICY squadron_voice_participants_select ON public.squadron_voice_participants FOR SELECT TO authenticated
  USING (public.squadron_request_can_use_room(room_id));
CREATE POLICY squadron_voice_participants_insert ON public.squadron_voice_participants FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.squadron_request_can_use_room(room_id));
CREATE POLICY squadron_voice_participants_update ON public.squadron_voice_participants FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND public.squadron_request_can_use_room(room_id))
  WITH CHECK (user_id = auth.uid() AND public.squadron_request_can_use_room(room_id));
CREATE POLICY squadron_voice_participants_delete ON public.squadron_voice_participants FOR DELETE TO authenticated
  USING (user_id = auth.uid());
REVOKE UPDATE ON public.squadron_voice_participants FROM PUBLIC, anon, authenticated;
GRANT UPDATE (is_muted,is_deafened) ON public.squadron_voice_participants TO authenticated;
GRANT SELECT, INSERT ON public.squadron_chat_messages, public.squadron_voice_signals TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.squadron_voice_rooms, public.squadron_voice_participants TO authenticated;
GRANT ALL ON public.squadron_members, public.squadron_ranks, public.squadron_chat_messages,
  public.squadron_voice_rooms, public.squadron_voice_signals, public.squadron_voice_participants TO service_role;

-- An owner-executed view would silently bypass the room policies above.
DO $$ BEGIN
  IF to_regclass('public.squadron_voice_room_summary') IS NOT NULL THEN
    ALTER VIEW public.squadron_voice_room_summary SET (security_invoker = true);
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
