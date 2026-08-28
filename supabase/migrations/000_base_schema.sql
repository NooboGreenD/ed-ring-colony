-- ============================================================
-- 000_base_schema.sql — Базовые таблицы (безопасное обновление)
-- Если таблица уже существует — добавляем только недостающие колонки и индексы
-- ============================================================

-- 1. Хабы кольца колоний
CREATE TABLE IF NOT EXISTS public.hubs (
  id SERIAL PRIMARY KEY,
  system_name TEXT NOT NULL,
  x DOUBLE PRECISION,
  y DOUBLE PRECISION,
  z DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','completed','abandoned')),
  progress INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hubs_status ON public.hubs(status);
CREATE INDEX IF NOT EXISTS idx_hubs_system ON public.hubs(system_name);

ALTER TABLE public.hubs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Hubs are readable by all" ON public.hubs;
CREATE POLICY "Hubs are readable by all" ON public.hubs FOR SELECT USING (true);

-- 2. Профили пользователей
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  cmdr_name TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','moderator','admin')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Добавляем колонки, если таблица profiles уже существовала без них
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS squadron TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS total_delivered INTEGER DEFAULT 0;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS hubs_visited INTEGER DEFAULT 0;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS forum_posts_count INTEGER DEFAULT 0;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Profiles are readable by all" ON public.profiles;
CREATE POLICY "Profiles are readable by all" ON public.profiles FOR SELECT USING (true);
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- 3. Доставки (логистика)
CREATE TABLE IF NOT EXISTS public.deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  system_name TEXT NOT NULL,
  commodity TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  source_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deliveries_user ON public.deliveries(user_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_system ON public.deliveries(system_name);
CREATE INDEX IF NOT EXISTS idx_deliveries_commodity ON public.deliveries(commodity);

ALTER TABLE public.deliveries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own deliveries" ON public.deliveries;
CREATE POLICY "Users can read own deliveries" ON public.deliveries FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own deliveries" ON public.deliveries;
CREATE POLICY "Users can insert own deliveries" ON public.deliveries FOR INSERT WITH CHECK (auth.uid() = user_id);

-- 4. Категории форума
CREATE TABLE IF NOT EXISTS public.forum_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.forum_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Forum categories are readable by all" ON public.forum_categories;
CREATE POLICY "Forum categories are readable by all" ON public.forum_categories FOR SELECT USING (true);

-- 5. Темы форума
CREATE TABLE IF NOT EXISTS public.forum_threads (
  id SERIAL PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES public.forum_categories(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Добавляем колонки, если таблица уже существовала без них
ALTER TABLE public.forum_threads ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.forum_threads ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.forum_threads ADD COLUMN IF NOT EXISTS views INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_forum_threads_category ON public.forum_threads(category_id);
CREATE INDEX IF NOT EXISTS idx_forum_threads_pinned ON public.forum_threads(pinned, created_at DESC);

ALTER TABLE public.forum_threads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Forum threads are readable by all" ON public.forum_threads;
CREATE POLICY "Forum threads are readable by all" ON public.forum_threads FOR SELECT USING (true);
DROP POLICY IF EXISTS "Authenticated can create threads" ON public.forum_threads;
CREATE POLICY "Authenticated can create threads" ON public.forum_threads FOR INSERT WITH CHECK (auth.uid() = author_id);

-- 6. Сообщения форума
CREATE TABLE IF NOT EXISTS public.forum_posts (
  id SERIAL PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES public.forum_threads(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  author_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Добавляем колонки, если таблица уже существовала без них
ALTER TABLE public.forum_posts ADD COLUMN IF NOT EXISTS parent_post_id INTEGER REFERENCES public.forum_posts(id) ON DELETE SET NULL;
ALTER TABLE public.forum_posts ADD COLUMN IF NOT EXISTS is_edited BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_forum_posts_thread ON public.forum_posts(thread_id);
CREATE INDEX IF NOT EXISTS idx_forum_posts_parent ON public.forum_posts(parent_post_id);

ALTER TABLE public.forum_posts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Forum posts are readable by all" ON public.forum_posts;
CREATE POLICY "Forum posts are readable by all" ON public.forum_posts FOR SELECT USING (true);
DROP POLICY IF EXISTS "Authenticated can create posts" ON public.forum_posts;
CREATE POLICY "Authenticated can create posts" ON public.forum_posts FOR INSERT WITH CHECK (auth.uid() = author_id);

-- 7. Реакции на посты
CREATE TABLE IF NOT EXISTS public.forum_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id INTEGER NOT NULL REFERENCES public.forum_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reaction_type TEXT NOT NULL DEFAULT 'like',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, user_id, reaction_type)
);

CREATE INDEX IF NOT EXISTS idx_forum_reactions_post ON public.forum_reactions(post_id);

ALTER TABLE public.forum_reactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own reactions" ON public.forum_reactions;
CREATE POLICY "Users can manage own reactions" ON public.forum_reactions FOR ALL USING (auth.uid() = user_id);

-- 8. Подписки на темы
CREATE TABLE IF NOT EXISTS public.forum_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL REFERENCES public.forum_threads(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_forum_subscriptions_user ON public.forum_subscriptions(user_id);

ALTER TABLE public.forum_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own subscriptions" ON public.forum_subscriptions;
CREATE POLICY "Users can manage own subscriptions" ON public.forum_subscriptions FOR ALL USING (auth.uid() = user_id);
