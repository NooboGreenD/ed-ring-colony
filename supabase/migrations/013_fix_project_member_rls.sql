-- ============================================================
-- 013_fix_project_member_rls.sql — Исправление infinite recursion
-- в RLS-политиках project_members / squadron_members
-- ============================================================

-- ============================================================
-- ШАГ 1. Удаляем ВСЕ зависимые политики
-- ============================================================
DROP POLICY IF EXISTS "Project leaders can manage members" ON public.project_members;
DROP POLICY IF EXISTS "Project managers can manage members" ON public.project_members;
DROP POLICY IF EXISTS "Project leaders can manage systems" ON public.project_systems;
DROP POLICY IF EXISTS "Project managers can manage systems" ON public.project_systems;
DROP POLICY IF EXISTS "Project leaders can manage plans" ON public.project_build_plans;
DROP POLICY IF EXISTS "Project managers can manage plans" ON public.project_build_plans;
DROP POLICY IF EXISTS "Squadron leaders can manage members" ON public.squadron_members;
DROP POLICY IF EXISTS "Squadron leaders manage ranks" ON public.squadron_ranks;

-- ============================================================
-- ШАГ 2. Удаляем функции (теперь без зависимостей)
-- ============================================================
DROP FUNCTION IF EXISTS public.is_project_manager(INTEGER, UUID);
DROP FUNCTION IF EXISTS public.is_squadron_leader(INTEGER, UUID);
DROP FUNCTION IF EXISTS public.is_squadron_rank_manager(INTEGER, UUID);

-- ============================================================
-- ШАГ 3. Пересоздаём функции с гарантированным SECURITY DEFINER
--    SECURITY DEFINER обходит RLS → SELECT внутри функции НЕ
--    вызывает политики таблицы → рекурсии НЕТ.
-- ============================================================

CREATE FUNCTION public.is_project_manager(check_project_id INTEGER, check_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.project_members pm
    WHERE pm.project_id = check_project_id
      AND pm.user_id = check_user_id
      AND pm.role IN ('leader', 'officer')
  );
END;
$$;

CREATE FUNCTION public.is_squadron_leader(check_squadron_id INTEGER, check_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.squadron_members sm
    JOIN public.squadron_ranks sr ON sr.id = sm.rank_id
    WHERE sm.squadron_id = check_squadron_id
      AND sm.user_id = check_user_id
      AND sr.can_manage_members = true
  );
END;
$$;

CREATE FUNCTION public.is_squadron_rank_manager(check_squadron_id INTEGER, check_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.squadron_members sm
    JOIN public.squadron_ranks sr ON sr.id = sm.rank_id
    WHERE sm.squadron_id = check_squadron_id
      AND sm.user_id = check_user_id
      AND sr.can_manage_ranks = true
  );
END;
$$;

-- ============================================================
-- ШАГ 4. Восстанавливаем политики squadron_* через функции
--    (функции с SECURITY DEFINER — безопасно, рекурсии нет)
-- ============================================================

CREATE POLICY "Squadron leaders can manage members" ON public.squadron_members FOR ALL USING (
  public.is_squadron_leader(squadron_members.squadron_id, auth.uid())
);

CREATE POLICY "Squadron leaders manage ranks" ON public.squadron_ranks FOR ALL USING (
  public.is_squadron_rank_manager(squadron_ranks.squadron_id, auth.uid())
);

-- ============================================================
-- ШАГ 5. project_members — inline без рекурсии (нет SELECT из project_members)
-- ============================================================
CREATE POLICY "Project managers can manage members" ON public.project_members FOR ALL USING (
  EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = project_members.project_id
      AND p.created_by = auth.uid()
  )
  OR
  EXISTS (
    SELECT 1 FROM public.squadron_members sm
    JOIN public.squadron_ranks sr ON sr.id = sm.rank_id
    JOIN public.projects p ON p.squadron_id = sm.squadron_id
    WHERE p.id = project_members.project_id
      AND sm.user_id = auth.uid()
      AND sr.can_manage_projects = true
  )
);

-- ============================================================
-- ШАГ 6. project_systems — inline без рекурсии
-- ============================================================
CREATE POLICY "Project managers can manage systems" ON public.project_systems FOR ALL USING (
  EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = project_systems.project_id
      AND p.created_by = auth.uid()
  )
  OR
  EXISTS (
    SELECT 1 FROM public.squadron_members sm
    JOIN public.squadron_ranks sr ON sr.id = sm.rank_id
    JOIN public.projects p ON p.squadron_id = sm.squadron_id
    WHERE p.id = project_systems.project_id
      AND sm.user_id = auth.uid()
      AND sr.can_manage_projects = true
  )
);

-- ============================================================
-- ШАГ 7. project_build_plans — inline без рекурсии
-- ============================================================
CREATE POLICY "Project managers can manage plans" ON public.project_build_plans FOR ALL USING (
  EXISTS (
    SELECT 1 FROM public.project_systems ps
    JOIN public.projects p ON p.id = ps.project_id
    WHERE ps.id = project_build_plans.project_system_id
      AND p.created_by = auth.uid()
  )
  OR
  EXISTS (
    SELECT 1 FROM public.project_systems ps
    JOIN public.projects p ON p.id = ps.project_id
    JOIN public.squadron_members sm ON sm.squadron_id = p.squadron_id
    JOIN public.squadron_ranks sr ON sr.id = sm.rank_id
    WHERE ps.id = project_build_plans.project_system_id
      AND sm.user_id = auth.uid()
      AND sr.can_manage_projects = true
  )
);
