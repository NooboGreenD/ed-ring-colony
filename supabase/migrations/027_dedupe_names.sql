-- ============================================================
-- 027_dedupe_names.sql
-- Убираем дублирование cmdr_name/author_name из зависимых таблиц.
-- Единый источник правды: profiles.cmdr_name
-- Связь: user_id / author_id (UUID) → profiles.id
-- ============================================================

-- 0. Удаляем view leaderboard (зависит от deliveries.cmdr_name)
DROP VIEW IF EXISTS public.leaderboard;

-- 1. deliveries: убираем cmdr_name (данные берём из profiles по user_id)
ALTER TABLE public.deliveries DROP COLUMN IF EXISTS cmdr_name;

-- 2. forum_posts: убираем author_name
ALTER TABLE public.forum_posts DROP COLUMN IF EXISTS author_name;

-- 3. forum_threads: убираем author_name (если была добавлена позже)
ALTER TABLE public.forum_threads DROP COLUMN IF EXISTS author_name;

-- 4. news: добавляем author_id (UUID), убираем author (TEXT)
ALTER TABLE public.news ADD COLUMN IF NOT EXISTS author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
-- Мигрируем существующие записи: ищем профили по старому author
UPDATE public.news n
SET author_id = p.id
FROM public.profiles p
WHERE p.cmdr_name = n.author AND n.author IS NOT NULL;
-- Убираем старую колонку
ALTER TABLE public.news DROP COLUMN IF EXISTS author;

-- 5. Индексы для JOIN-оптимизации
CREATE INDEX IF NOT EXISTS idx_deliveries_user_id ON public.deliveries(user_id);
CREATE INDEX IF NOT EXISTS idx_news_author_id ON public.news(author_id);

-- 6. RLS для news
ALTER TABLE public.news ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "News readable by all" ON public.news;
CREATE POLICY "News readable by all" ON public.news FOR SELECT USING (true);
DROP POLICY IF EXISTS "Authenticated can create news" ON public.news;
CREATE POLICY "Authenticated can create news" ON public.news FOR INSERT WITH CHECK (auth.uid() = author_id);

-- 7. RPC: get_cmdr_rank по UUID (вместо cmdr_name)
DROP FUNCTION IF EXISTS public.get_cmdr_rank(UUID);
CREATE OR REPLACE FUNCTION public.get_cmdr_rank(user_uuid UUID)
RETURNS TABLE(rank BIGINT) AS $$
BEGIN
  RETURN QUERY
  WITH ranked AS (
    SELECT 
      d.user_id,
      SUM(d.amount) as total,
      ROW_NUMBER() OVER (ORDER BY SUM(d.amount) DESC) as rnk
    FROM public.deliveries d
    GROUP BY d.user_id
  )
  SELECT r.rnk
  FROM ranked r
  WHERE r.user_id = user_uuid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
