-- ============================================================
-- 028_add_fk_profiles.sql
-- Добавляем FK от forum_posts, forum_threads, news → profiles
-- PostgREST нужны явные FK для работы JOIN author:profiles(...)
-- ============================================================

-- 1. FK forum_posts → profiles
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'forum_posts_author_id_fkey' 
    AND table_name = 'forum_posts'
  ) THEN
    ALTER TABLE public.forum_posts 
    ADD CONSTRAINT forum_posts_author_id_fkey 
    FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 2. FK forum_threads → profiles
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'forum_threads_author_id_fkey' 
    AND table_name = 'forum_threads'
  ) THEN
    ALTER TABLE public.forum_threads 
    ADD CONSTRAINT forum_threads_author_id_fkey 
    FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3. FK news → profiles (пересоздаём если был на auth.users)
DO $$
BEGIN
  ALTER TABLE public.news DROP CONSTRAINT IF EXISTS news_author_id_fkey;
  ALTER TABLE public.news 
  ADD CONSTRAINT news_author_id_fkey 
  FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'Could not alter news FK: %', SQLERRM;
END $$;

-- 4. Перезагружаем schema cache PostgREST
NOTIFY pgrst, 'reload schema';
