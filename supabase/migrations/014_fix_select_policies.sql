-- ============================================================
-- 014_fix_select_policies.sql — Восстановление SELECT-политик
-- ============================================================
-- Проблема: в 013 при замене политик на project_* мы удалили
-- FOR SELECT USING (true), оставив только FOR ALL для менеджеров.
-- Это означало, что обычные пользователи не видели участников,
-- системы и планы проекта.
-- ============================================================

-- project_members: все видят, менеджеры управляют
DROP POLICY IF EXISTS "Project members readable by all" ON public.project_members;
CREATE POLICY "Project members readable by all" ON public.project_members FOR SELECT USING (true);

-- project_systems: все видят, менеджеры управляют
DROP POLICY IF EXISTS "Project systems readable by all" ON public.project_systems;
CREATE POLICY "Project systems readable by all" ON public.project_systems FOR SELECT USING (true);

-- project_build_plans: все видят, менеджеры управляют
DROP POLICY IF EXISTS "Build plans readable by all" ON public.project_build_plans;
CREATE POLICY "Build plans readable by all" ON public.project_build_plans FOR SELECT USING (true);
