-- Restore the squadron read models expected by the application without
-- replacing an already working production view. Older installations contain
-- the base tables but never received the corresponding view DDL, which makes
-- profiles and squadron pages look as though a member has no squadron.
--
-- These views are compatibility read models only; the application also reads
-- the underlying tables so a PostgREST schema-cache delay cannot hide data.
-- The malformed historical migration also never reliably added/synchronised the
-- denormalised label used by project member cards, so ensure that small column
-- exists before installing its row-scoped triggers.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS squadron text;

DO $$
DECLARE
  membership_timestamp_column text;
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'squadron_members' AND column_name = 'joined_at'
    ) THEN 'joined_at'
    ELSE 'created_at'
  END INTO membership_timestamp_column;

  IF to_regclass('public.squadron_member_detail') IS NULL THEN
    EXECUTE format($view$
      CREATE VIEW public.squadron_member_detail
      WITH (security_invoker = true) AS
      SELECT
        sm.id,
        sm.squadron_id,
        sm.user_id,
        sm.rank_id,
        sm.callsign,
        sm.%1$I AS joined_at,
        sr.name AS rank_name,
        sr.sort_order AS rank_order,
        sr.is_default,
        sr.can_manage_projects,
        sr.can_manage_members,
        sr.can_manage_ranks,
        sr.can_edit_squadron,
        p.cmdr_name,
        p.avatar_url
      FROM public.squadron_members AS sm
      LEFT JOIN public.squadron_ranks AS sr ON sr.id = sm.rank_id
      LEFT JOIN public.profiles AS p ON p.id = sm.user_id
    $view$, membership_timestamp_column);
  END IF;

  IF to_regclass('public.squadron_summary') IS NULL THEN
    EXECUTE $view$
      CREATE VIEW public.squadron_summary
      WITH (security_invoker = true) AS
      SELECT
        sq.*,
        (
          SELECT count(*)::integer
          FROM public.squadron_members AS sm
          WHERE sm.squadron_id = sq.id
        ) AS member_count,
        (
          SELECT count(*)::integer
          FROM public.projects AS p
          WHERE p.squadron_id = sq.id
        ) AS project_count
      FROM public.squadrons AS sq
    $view$;
  END IF;

  IF to_regclass('public.project_summary') IS NULL THEN
    EXECUTE $view$
      CREATE VIEW public.project_summary
      WITH (security_invoker = true) AS
      SELECT
        p.*,
        (
          SELECT count(*)::integer
          FROM public.project_members AS pm
          WHERE pm.project_id = p.id
        ) AS member_count,
        (
          SELECT count(*)::integer
          FROM public.project_systems AS ps
          WHERE ps.project_id = p.id
        ) AS system_count,
        (
          SELECT count(*)::integer
          FROM public.project_systems AS ps
          WHERE ps.project_id = p.id AND ps.planned_status = 'done'
        ) AS systems_done,
        (
          SELECT count(*)::integer
          FROM public.project_systems AS ps
          WHERE ps.project_id = p.id AND ps.planned_status = 'building'
        ) AS systems_building,
        (
          SELECT max(ps.target_date)
          FROM public.project_systems AS ps
          WHERE ps.project_id = p.id
        ) AS latest_target_date
      FROM public.projects AS p
    $view$;
  END IF;

  -- A historical endpoint used this name, while newer endpoints use
  -- project_summary. Keep it as a simple alias for a zero-downtime rollout.
  IF to_regclass('public.squadron_projects') IS NULL THEN
    EXECUTE 'CREATE VIEW public.squadron_projects WITH (security_invoker = true) AS SELECT * FROM public.project_summary';
  END IF;
END $$;

GRANT SELECT ON public.squadron_member_detail, public.squadron_summary,
  public.project_summary, public.squadron_projects TO anon, authenticated;

-- Restore the creation trigger that was bundled into the malformed historical
-- migration. SECURITY DEFINER is necessary because a newly-created squadron
-- has no member yet, while normal RLS policies require membership to create
-- its first rank/member.
CREATE OR REPLACE FUNCTION public.create_default_squadron_ranks(p_squadron_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.squadron_ranks (
    squadron_id, name, sort_order, is_default,
    can_manage_projects, can_manage_members, can_manage_ranks, can_edit_squadron
  ) VALUES
    (p_squadron_id, 'Командир эскадрильи', 1, true, true, true, true, true),
    (p_squadron_id, 'Заместитель командира', 2, true, true, true, false, false),
    (p_squadron_id, 'Офицер', 3, true, true, true, false, false),
    (p_squadron_id, 'Ветеран', 4, true, true, false, false, false),
    (p_squadron_id, 'Пилот', 5, true, false, false, false, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_default_voice_rooms(p_squadron_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.squadron_voice_rooms (
    squadron_id, name, description, is_officer_only, sort_order
  ) VALUES
    (p_squadron_id, 'Общий канал', 'Общий голосовой канал для всех пилотов', false, 1),
    (p_squadron_id, 'Офицерский канал', 'Офицерский канал для командного состава', true, 2),
    (p_squadron_id, 'Оперативный канал', 'Канал для оперативных задач', false, 3);
END;
$$;

CREATE OR REPLACE FUNCTION public.on_squadron_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  commander_rank_id bigint;
BEGIN
  -- Explicitly select the bigint helpers even on an older integer-id schema
  -- where a prior, unsafe integer overload may still exist.
  PERFORM public.create_default_squadron_ranks(NEW.id::bigint);
  PERFORM public.create_default_voice_rooms(NEW.id::bigint);

  SELECT id INTO commander_rank_id
  FROM public.squadron_ranks
  WHERE squadron_id = NEW.id AND name = 'Командир эскадрильи'
  ORDER BY id
  LIMIT 1;

  IF commander_rank_id IS NOT NULL THEN
    INSERT INTO public.squadron_members (squadron_id, user_id, rank_id)
    VALUES (NEW.id, NEW.created_by, commander_rank_id)
    ON CONFLICT (squadron_id, user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_on_squadron_created ON public.squadrons;
DROP TRIGGER IF EXISTS on_squadron_created ON public.squadrons;
CREATE TRIGGER trg_on_squadron_created
  AFTER INSERT ON public.squadrons
  FOR EACH ROW EXECUTE FUNCTION public.on_squadron_created();

-- The profile.squadron label is a denormalised convenience field. Rebuild the
-- synchronization triggers with valid SQL and a constrained, security-definer
-- helper. No whole-table backfill is performed here: live pages resolve the
-- authoritative membership relation until an affected profile next changes.
CREATE OR REPLACE FUNCTION public.refresh_profile_squadron(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_squadron_name text;
BEGIN
  SELECT sq.name
  INTO current_squadron_name
  FROM public.squadron_members AS sm
  INNER JOIN public.squadrons AS sq ON sq.id = sm.squadron_id
  WHERE sm.user_id = p_user_id
  ORDER BY sm.id DESC
  LIMIT 1;

  UPDATE public.profiles AS p
  SET squadron = current_squadron_name
  WHERE p.id = p_user_id
    AND p.squadron IS DISTINCT FROM current_squadron_name;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_profile_squadron_from_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.refresh_profile_squadron(OLD.user_id);
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    PERFORM public.refresh_profile_squadron(OLD.user_id);
  END IF;
  PERFORM public.refresh_profile_squadron(NEW.user_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_profiles_after_squadron_rename()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.profiles AS p
  SET squadron = NEW.name
  WHERE p.squadron IS DISTINCT FROM NEW.name
    AND EXISTS (
      SELECT 1
      FROM public.squadron_members AS sm
      WHERE sm.user_id = p.id AND sm.squadron_id = NEW.id
    );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_profile_squadron_insert ON public.squadron_members;
DROP TRIGGER IF EXISTS trg_sync_profile_squadron_delete ON public.squadron_members;
DROP TRIGGER IF EXISTS trg_sync_profile_squadron_membership_insert ON public.squadron_members;
DROP TRIGGER IF EXISTS trg_sync_profile_squadron_membership_delete ON public.squadron_members;
DROP TRIGGER IF EXISTS trg_sync_profile_squadron_membership_update ON public.squadron_members;

CREATE TRIGGER trg_sync_profile_squadron_membership_insert
  AFTER INSERT ON public.squadron_members
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_squadron_from_membership();
CREATE TRIGGER trg_sync_profile_squadron_membership_delete
  AFTER DELETE ON public.squadron_members
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_squadron_from_membership();
CREATE TRIGGER trg_sync_profile_squadron_membership_update
  AFTER UPDATE OF squadron_id, user_id ON public.squadron_members
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_squadron_from_membership();

DROP TRIGGER IF EXISTS trg_sync_profiles_after_squadron_rename ON public.squadrons;
CREATE TRIGGER trg_sync_profiles_after_squadron_rename
  AFTER UPDATE OF name ON public.squadrons
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION public.sync_profiles_after_squadron_rename();

REVOKE ALL ON FUNCTION public.create_default_squadron_ranks(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_default_voice_rooms(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.on_squadron_created() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_profile_squadron(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_profile_squadron_from_membership() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_profiles_after_squadron_rename() FROM PUBLIC;

CREATE INDEX IF NOT EXISTS idx_squadron_members_user_squadron
  ON public.squadron_members (user_id, squadron_id);
CREATE INDEX IF NOT EXISTS idx_projects_squadron_id
  ON public.projects (squadron_id);
