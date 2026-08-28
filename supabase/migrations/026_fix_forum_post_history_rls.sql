-- ============================================================
-- Fix RLS for forum_post_history
-- Триггер на forum_posts пытается вставить в forum_post_history,
-- но RLS блокирует. Разрешаем INSERT для авторизованных.
-- ============================================================

-- Включаем RLS (если ещё не включено)
ALTER TABLE public.forum_post_history ENABLE ROW LEVEL SECURITY;

-- Политика на чтение: видим записи для постов, которые мы редактировали или создавали
DROP POLICY IF EXISTS "Users can read own post history" ON public.forum_post_history;
CREATE POLICY "Users can read own post history" 
  ON public.forum_post_history FOR SELECT 
  USING (
    EXISTS (
      SELECT 1 FROM public.forum_posts fp 
      WHERE fp.id = forum_post_history.post_id 
      AND fp.author_id = auth.uid()
    )
  );

-- Политика на INSERT: любой авторизованный может вставлять (триггер выполняется от их имени)
DROP POLICY IF EXISTS "Authenticated can insert post history" ON public.forum_post_history;
CREATE POLICY "Authenticated can insert post history" 
  ON public.forum_post_history FOR INSERT 
  WITH CHECK (auth.uid() IS NOT NULL);

-- Если триггер-функция существует, убедимся что она SECURITY DEFINER
DO $$
DECLARE
  func_name TEXT;
BEGIN
  FOR func_name IN 
    SELECT p.proname 
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' 
    AND p.proname LIKE '%forum%post%history%'
  LOOP
    EXECUTE format('ALTER FUNCTION %I() SET SECURITY DEFINER', func_name);
    RAISE NOTICE 'Set SECURITY DEFINER for function %', func_name;
  END LOOP;
END $$;
