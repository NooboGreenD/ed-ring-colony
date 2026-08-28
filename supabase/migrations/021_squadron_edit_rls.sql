-- ============================================================
-- 021_squadron_edit_rls.sql — Разрешаем редактирование эскадрильи
-- не только создателю, но и тем, у кого can_edit_squadron = true
-- ============================================================

-- Функция: проверка права редактирования эскадрильи
CREATE OR REPLACE FUNCTION public.can_edit_squadron(check_squadron_id INTEGER, check_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.squadron_members sm
    JOIN public.squadron_ranks sr ON sr.id = sm.rank_id
    WHERE sm.squadron_id = check_squadron_id
      AND sm.user_id = check_user_id
      AND sr.can_edit_squadron = true
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Обновляем RLS политику: создатель ИЛИ can_edit_squadron
DROP POLICY IF EXISTS "Squadron creators can manage" ON public.squadrons;
CREATE POLICY "Squadron creators can manage" ON public.squadrons FOR ALL USING (
  auth.uid() = created_by OR public.can_edit_squadron(id, auth.uid())
);

GRANT EXECUTE ON FUNCTION public.can_edit_squadron(INTEGER, UUID) TO anon, authenticated;
