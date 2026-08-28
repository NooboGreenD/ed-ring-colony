-- ============================================================
-- 016_fix_relationships.sql — Добавление FK для Supabase relationships
-- ============================================================
-- Проблема: Supabase PostgREST не видит relationship между
-- project_members и profiles, т.к. FK user_id → auth.users,
-- а не profiles.id. Аналогично для project_systems.assigned_to
-- и squadron_members.user_id.
-- ============================================================

-- 1. FK project_members.user_id → profiles.id
--    (profiles.id уже является PK и равен auth.users.id)
ALTER TABLE public.project_members
  DROP CONSTRAINT IF EXISTS fk_project_members_profiles;

ALTER TABLE public.project_members
  ADD CONSTRAINT fk_project_members_profiles
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- 2. FK project_systems.assigned_to → profiles.id
ALTER TABLE public.project_systems
  DROP CONSTRAINT IF EXISTS fk_project_systems_profiles_assigned;

ALTER TABLE public.project_systems
  ADD CONSTRAINT fk_project_systems_profiles_assigned
  FOREIGN KEY (assigned_to) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 3. FK squadron_members.user_id → profiles.id
ALTER TABLE public.squadron_members
  DROP CONSTRAINT IF EXISTS fk_squadron_members_profiles;

ALTER TABLE public.squadron_members
  ADD CONSTRAINT fk_squadron_members_profiles
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- 4. Перестраиваем кэш схемы PostgREST
NOTIFY pgrst, 'reload schema';
