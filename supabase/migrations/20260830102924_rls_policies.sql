-- ============================================================
-- SUPABASE RLS POLICIES & MIGRATIONS
-- ED Ring Colony
-- Выполнить в Supabase SQL Editor (New query → Run)
-- ============================================================

-- 0. Расширения и базовые настройки
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 1. PROFILES
-- ============================================================
-- Убедимся, что таблица существует (если создаётся с нуля)
-- Примечание: Supabase Auth создаёт auth.users автоматически,
-- profiles обычно создаётся триггером или вручную.
-- Если profiles ещё нет, раскомментируйте:
/*
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  cmdr_name TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  squadron TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
*/

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- SELECT: все видят все профили (публичная инфа)
DROP POLICY IF EXISTS profiles_select ON public.profiles;
CREATE POLICY profiles_select ON public.profiles
  FOR SELECT TO anon, authenticated USING (true);

-- INSERT: только свой профиль (или service_role через API)
DROP POLICY IF EXISTS profiles_insert ON public.profiles;
CREATE POLICY profiles_insert ON public.profiles
  FOR INSERT TO authenticated WITH CHECK (id = auth.uid());

-- UPDATE: свой профиль или admin
DROP POLICY IF EXISTS profiles_update ON public.profiles;
CREATE POLICY profiles_update ON public.profiles
  FOR UPDATE TO authenticated
  USING (
    id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  )
  WITH CHECK (
    id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- DELETE: только admin
DROP POLICY IF EXISTS profiles_delete ON public.profiles;
CREATE POLICY profiles_delete ON public.profiles
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

GRANT SELECT ON public.profiles TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.profiles TO authenticated;

-- ============================================================
-- 2. NEWS
-- ============================================================
/*
CREATE TABLE IF NOT EXISTS public.news (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  cover_url TEXT,
  author_id UUID REFERENCES public.profiles(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
*/

ALTER TABLE public.news ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS news_select ON public.news;
CREATE POLICY news_select ON public.news
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS news_insert ON public.news;
CREATE POLICY news_insert ON public.news
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

DROP POLICY IF EXISTS news_update ON public.news;
CREATE POLICY news_update ON public.news
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

DROP POLICY IF EXISTS news_delete ON public.news;
CREATE POLICY news_delete ON public.news
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

GRANT SELECT ON public.news TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.news TO authenticated;

-- ============================================================
-- 3. HUBS
-- ============================================================
/*
CREATE TABLE IF NOT EXISTS public.hubs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  system_name TEXT NOT NULL,
  x DOUBLE PRECISION,
  y DOUBLE PRECISION,
  z DOUBLE PRECISION,
  segment_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planned',
  progress INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
*/

ALTER TABLE public.hubs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hubs_select ON public.hubs;
CREATE POLICY hubs_select ON public.hubs
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS hubs_insert ON public.hubs;
CREATE POLICY hubs_insert ON public.hubs
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

DROP POLICY IF EXISTS hubs_update ON public.hubs;
CREATE POLICY hubs_update ON public.hubs
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

DROP POLICY IF EXISTS hubs_delete ON public.hubs;
CREATE POLICY hubs_delete ON public.hubs
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

GRANT SELECT ON public.hubs TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.hubs TO authenticated;

-- ============================================================
-- 4. ROUTE_SYSTEMS
-- ============================================================
ALTER TABLE public.route_systems ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS route_systems_select ON public.route_systems;
CREATE POLICY route_systems_select ON public.route_systems
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS route_systems_insert ON public.route_systems;
CREATE POLICY route_systems_insert ON public.route_systems
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

DROP POLICY IF EXISTS route_systems_update ON public.route_systems;
CREATE POLICY route_systems_update ON public.route_systems
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

DROP POLICY IF EXISTS route_systems_delete ON public.route_systems;
CREATE POLICY route_systems_delete ON public.route_systems
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

GRANT SELECT ON public.route_systems TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.route_systems TO authenticated;

-- ============================================================
-- 5. SITE_CONTENT
-- ============================================================
CREATE TABLE IF NOT EXISTS public.site_content (
  id INTEGER PRIMARY KEY DEFAULT 1,
  kicker TEXT,
  title1 TEXT,
  title2 TEXT,
  manifest TEXT,
  footer_copyright TEXT,
  footer_discord TEXT,
  footer_edsm TEXT,
  footer_inara TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.site_content ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS site_content_select ON public.site_content;
CREATE POLICY site_content_select ON public.site_content
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS site_content_upsert ON public.site_content;
CREATE POLICY site_content_upsert ON public.site_content
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

GRANT SELECT ON public.site_content TO anon, authenticated;
GRANT ALL ON public.site_content TO authenticated;

-- ============================================================
-- 6. DELIVERIES
-- ============================================================
/*
CREATE TABLE IF NOT EXISTS public.deliveries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  system_name TEXT NOT NULL,
  commodity TEXT,
  amount INTEGER,
  delivered_at TIMESTAMPTZ,
  is_hub BOOLEAN DEFAULT false,
  route_system_id BIGINT,
  source_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
*/

ALTER TABLE public.deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deliveries_select ON public.deliveries;
CREATE POLICY deliveries_select ON public.deliveries
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS deliveries_insert ON public.deliveries;
CREATE POLICY deliveries_insert ON public.deliveries
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS deliveries_update ON public.deliveries;
CREATE POLICY deliveries_update ON public.deliveries
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

DROP POLICY IF EXISTS deliveries_delete ON public.deliveries;
CREATE POLICY deliveries_delete ON public.deliveries
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

GRANT SELECT ON public.deliveries TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.deliveries TO authenticated;

-- ============================================================
-- 7. API_TOKENS
-- ============================================================
/*
CREATE TABLE IF NOT EXISTS public.api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT,
  is_revoked BOOLEAN NOT NULL DEFAULT false,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
*/

ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_tokens_select ON public.api_tokens;
CREATE POLICY api_tokens_select ON public.api_tokens
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS api_tokens_insert ON public.api_tokens;
CREATE POLICY api_tokens_insert ON public.api_tokens
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS api_tokens_update ON public.api_tokens;
CREATE POLICY api_tokens_update ON public.api_tokens
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS api_tokens_delete ON public.api_tokens;
CREATE POLICY api_tokens_delete ON public.api_tokens
  FOR DELETE TO authenticated USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_tokens TO authenticated;

-- ============================================================
-- 8. PROJECTS
-- ============================================================
/*
CREATE TABLE IF NOT EXISTS public.projects (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT,
  icon TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  squadron_id BIGINT,
  created_by UUID NOT NULL REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
*/

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS projects_select ON public.projects;
CREATE POLICY projects_select ON public.projects
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS projects_insert ON public.projects;
CREATE POLICY projects_insert ON public.projects
  FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS projects_update ON public.projects;
CREATE POLICY projects_update ON public.projects
  FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'))
  WITH CHECK (created_by = auth.uid() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

DROP POLICY IF EXISTS projects_delete ON public.projects;
CREATE POLICY projects_delete ON public.projects
  FOR DELETE TO authenticated
  USING (created_by = auth.uid() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

GRANT SELECT ON public.projects TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.projects TO authenticated;

-- ============================================================
-- 9. PROJECT_MEMBERS
-- ============================================================
/*
CREATE TABLE IF NOT EXISTS public.project_members (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  callsign TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, user_id)
);
*/

ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_members_select ON public.project_members;
CREATE POLICY project_members_select ON public.project_members
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS project_members_insert ON public.project_members;
CREATE POLICY project_members_insert ON public.project_members
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = project_id AND pm.user_id = auth.uid() AND pm.role IN ('leader', 'officer'))
    OR EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = project_id AND pr.created_by = auth.uid())
  );

DROP POLICY IF EXISTS project_members_update ON public.project_members;
CREATE POLICY project_members_update ON public.project_members
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = project_id AND pm.user_id = auth.uid() AND pm.role = 'leader')
    OR EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = project_id AND pr.created_by = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = project_id AND pm.user_id = auth.uid() AND pm.role = 'leader')
    OR EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = project_id AND pr.created_by = auth.uid())
  );

DROP POLICY IF EXISTS project_members_delete ON public.project_members;
CREATE POLICY project_members_delete ON public.project_members
  FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = project_id AND pm.user_id = auth.uid() AND pm.role IN ('leader', 'officer'))
    OR EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = project_id AND pr.created_by = auth.uid())
  );

GRANT SELECT ON public.project_members TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.project_members TO authenticated;

-- ============================================================
-- 10. SQUADRONS & SQUADRON_MEMBERS
-- ============================================================
/*
CREATE TABLE IF NOT EXISTS public.squadrons (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  tag TEXT NOT NULL,
  description TEXT,
  created_by UUID NOT NULL REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.squadron_members (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  squadron_id BIGINT NOT NULL REFERENCES public.squadrons(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  can_manage_projects BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(squadron_id, user_id)
);
*/

ALTER TABLE public.squadrons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squadron_members ENABLE ROW LEVEL SECURITY;

-- SQUADRONS
DROP POLICY IF EXISTS squadrons_select ON public.squadrons;
CREATE POLICY squadrons_select ON public.squadrons
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS squadrons_insert ON public.squadrons;
CREATE POLICY squadrons_insert ON public.squadrons
  FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS squadrons_update ON public.squadrons;
CREATE POLICY squadrons_update ON public.squadrons
  FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'))
  WITH CHECK (created_by = auth.uid() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

DROP POLICY IF EXISTS squadrons_delete ON public.squadrons;
CREATE POLICY squadrons_delete ON public.squadrons
  FOR DELETE TO authenticated
  USING (created_by = auth.uid() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

-- SQUADRON_MEMBERS
DROP POLICY IF EXISTS squadron_members_select ON public.squadron_members;
CREATE POLICY squadron_members_select ON public.squadron_members
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS squadron_members_insert ON public.squadron_members;
CREATE POLICY squadron_members_insert ON public.squadron_members
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_id AND sm.user_id = auth.uid()));

DROP POLICY IF EXISTS squadron_members_update ON public.squadron_members;
CREATE POLICY squadron_members_update ON public.squadron_members
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_id AND sm.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_id AND sm.user_id = auth.uid()));

DROP POLICY IF EXISTS squadron_members_delete ON public.squadron_members;
CREATE POLICY squadron_members_delete ON public.squadron_members
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_id AND sm.user_id = auth.uid()));

GRANT SELECT ON public.squadrons TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.squadrons TO authenticated;
GRANT SELECT ON public.squadron_members TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.squadron_members TO authenticated;

-- ============================================================
-- 11. FORUM TABLES
-- ============================================================
/*
CREATE TABLE IF NOT EXISTS public.forum_categories (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  is_locked BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.forum_threads (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_id BIGINT NOT NULL REFERENCES public.forum_categories(id),
  title TEXT NOT NULL,
  author_id UUID NOT NULL REFERENCES public.profiles(id),
  is_pinned BOOLEAN DEFAULT false,
  is_locked BOOLEAN DEFAULT false,
  views INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.forum_posts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id BIGINT NOT NULL REFERENCES public.forum_threads(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES public.profiles(id),
  body TEXT NOT NULL,
  is_deleted BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.forum_reactions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id BIGINT NOT NULL REFERENCES public.forum_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(post_id, user_id, emoji)
);
*/

ALTER TABLE public.forum_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_reactions ENABLE ROW LEVEL SECURITY;

-- FORUM_CATEGORIES
DROP POLICY IF EXISTS forum_categories_select ON public.forum_categories;
CREATE POLICY forum_categories_select ON public.forum_categories
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS forum_categories_modify ON public.forum_categories;
CREATE POLICY forum_categories_modify ON public.forum_categories
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

-- FORUM_THREADS
DROP POLICY IF EXISTS forum_threads_select ON public.forum_threads;
CREATE POLICY forum_threads_select ON public.forum_threads
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS forum_threads_insert ON public.forum_threads;
CREATE POLICY forum_threads_insert ON public.forum_threads
  FOR INSERT TO authenticated WITH CHECK (author_id = auth.uid());

DROP POLICY IF EXISTS forum_threads_update ON public.forum_threads;
CREATE POLICY forum_threads_update ON public.forum_threads
  FOR UPDATE TO authenticated
  USING (author_id = auth.uid() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')))
  WITH CHECK (author_id = auth.uid() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

DROP POLICY IF EXISTS forum_threads_delete ON public.forum_threads;
CREATE POLICY forum_threads_delete ON public.forum_threads
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

-- FORUM_POSTS
DROP POLICY IF EXISTS forum_posts_select ON public.forum_posts;
CREATE POLICY forum_posts_select ON public.forum_posts
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS forum_posts_insert ON public.forum_posts;
CREATE POLICY forum_posts_insert ON public.forum_posts
  FOR INSERT TO authenticated WITH CHECK (author_id = auth.uid());

DROP POLICY IF EXISTS forum_posts_update ON public.forum_posts;
CREATE POLICY forum_posts_update ON public.forum_posts
  FOR UPDATE TO authenticated
  USING (author_id = auth.uid() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')))
  WITH CHECK (author_id = auth.uid() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

DROP POLICY IF EXISTS forum_posts_delete ON public.forum_posts;
CREATE POLICY forum_posts_delete ON public.forum_posts
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

-- FORUM_REACTIONS
DROP POLICY IF EXISTS forum_reactions_select ON public.forum_reactions;
CREATE POLICY forum_reactions_select ON public.forum_reactions
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS forum_reactions_insert ON public.forum_reactions;
CREATE POLICY forum_reactions_insert ON public.forum_reactions
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS forum_reactions_delete ON public.forum_reactions;
CREATE POLICY forum_reactions_delete ON public.forum_reactions
  FOR DELETE TO authenticated USING (user_id = auth.uid());

GRANT SELECT ON public.forum_categories, public.forum_threads, public.forum_posts, public.forum_reactions TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.forum_categories TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.forum_threads TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.forum_posts TO authenticated;
GRANT INSERT, DELETE ON public.forum_reactions TO authenticated;

-- ============================================================
-- 12. ATLAS TABLES
-- ============================================================
/*
CREATE TABLE IF NOT EXISTS public.atlas_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_system TEXT NOT NULL,
  reference_x DOUBLE PRECISION,
  reference_y DOUBLE PRECISION,
  reference_z DOUBLE PRECISION,
  cube_size_ly INTEGER NOT NULL,
  world_types TEXT[] NOT NULL,
  extra_filters JSONB,
  created_by UUID REFERENCES public.profiles(id),
  status TEXT NOT NULL DEFAULT 'pending',
  total_found INTEGER,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.atlas_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id UUID NOT NULL REFERENCES public.atlas_searches(id) ON DELETE CASCADE,
  system_name TEXT NOT NULL,
  x DOUBLE PRECISION,
  y DOUBLE PRECISION,
  z DOUBLE PRECISION,
  world_type TEXT,
  body_name TEXT,
  distance_from_ref DOUBLE PRECISION,
  distance_to_arrival DOUBLE PRECISION,
  estimated_value DOUBLE PRECISION,
  is_main_star BOOLEAN DEFAULT false,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.atlas_favorites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  candidate_id UUID NOT NULL REFERENCES public.atlas_candidates(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, candidate_id)
);
*/

ALTER TABLE public.atlas_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.atlas_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.atlas_favorites ENABLE ROW LEVEL SECURITY;

-- ATLAS_SEARCHES
DROP POLICY IF EXISTS atlas_searches_select ON public.atlas_searches;
CREATE POLICY atlas_searches_select ON public.atlas_searches
  FOR SELECT TO authenticated USING (created_by = auth.uid() OR created_by IS NULL);

DROP POLICY IF EXISTS atlas_searches_insert ON public.atlas_searches;
CREATE POLICY atlas_searches_insert ON public.atlas_searches
  FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());

-- ATLAS_CANDIDATES
DROP POLICY IF EXISTS atlas_candidates_select ON public.atlas_candidates;
CREATE POLICY atlas_candidates_select ON public.atlas_candidates
  FOR SELECT TO anon, authenticated USING (true);

-- ATLAS_FAVORITES
DROP POLICY IF EXISTS atlas_favorites_select ON public.atlas_favorites;
CREATE POLICY atlas_favorites_select ON public.atlas_favorites
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS atlas_favorites_insert ON public.atlas_favorites;
CREATE POLICY atlas_favorites_insert ON public.atlas_favorites
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS atlas_favorites_delete ON public.atlas_favorites;
CREATE POLICY atlas_favorites_delete ON public.atlas_favorites
  FOR DELETE TO authenticated USING (user_id = auth.uid());

GRANT SELECT ON public.atlas_searches, public.atlas_candidates TO anon, authenticated;
GRANT INSERT ON public.atlas_searches TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.atlas_favorites TO authenticated;

-- ============================================================
-- 13. NOTIFICATIONS & PUSH
-- ============================================================
/*
CREATE TABLE IF NOT EXISTS public.notifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, endpoint)
);
*/

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- NOTIFICATIONS
DROP POLICY IF EXISTS notifications_select ON public.notifications;
CREATE POLICY notifications_select ON public.notifications
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS notifications_insert ON public.notifications;
CREATE POLICY notifications_insert ON public.notifications
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS notifications_update ON public.notifications;
CREATE POLICY notifications_update ON public.notifications
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS notifications_delete ON public.notifications;
CREATE POLICY notifications_delete ON public.notifications
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- PUSH_SUBSCRIPTIONS
DROP POLICY IF EXISTS push_subscriptions_select ON public.push_subscriptions;
CREATE POLICY push_subscriptions_select ON public.push_subscriptions
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS push_subscriptions_insert ON public.push_subscriptions;
CREATE POLICY push_subscriptions_insert ON public.push_subscriptions
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS push_subscriptions_delete ON public.push_subscriptions;
CREATE POLICY push_subscriptions_delete ON public.push_subscriptions
  FOR DELETE TO authenticated USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.push_subscriptions TO authenticated;

-- ============================================================
-- 14. SYSTEM_PROGRESS & RAVEN_SYNC_LOG
-- ============================================================
/*
CREATE TABLE IF NOT EXISTS public.system_progress (
  system_name TEXT PRIMARY KEY,
  progress INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data JSONB
);

CREATE TABLE IF NOT EXISTS public.raven_sync_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  system_name TEXT NOT NULL,
  build_id TEXT,
  build_name TEXT,
  architect_name TEXT,
  progress INTEGER,
  system_progress INTEGER,
  system_status TEXT,
  site_name TEXT,
  resources JSONB DEFAULT '[]',
  projects JSONB DEFAULT '[]',
  full_data JSONB,
  error_message TEXT,
  sync_type TEXT,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
*/

ALTER TABLE public.system_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.raven_sync_log ENABLE ROW LEVEL SECURITY;

-- SYSTEM_PROGRESS
DROP POLICY IF EXISTS system_progress_select ON public.system_progress;
CREATE POLICY system_progress_select ON public.system_progress
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS system_progress_insert ON public.system_progress;
CREATE POLICY system_progress_insert ON public.system_progress
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

DROP POLICY IF EXISTS system_progress_update ON public.system_progress;
CREATE POLICY system_progress_update ON public.system_progress
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

-- RAVEN_SYNC_LOG
DROP POLICY IF EXISTS raven_sync_log_select ON public.raven_sync_log;
CREATE POLICY raven_sync_log_select ON public.raven_sync_log
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS raven_sync_log_insert ON public.raven_sync_log;
CREATE POLICY raven_sync_log_insert ON public.raven_sync_log
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

GRANT SELECT ON public.system_progress, public.raven_sync_log TO anon, authenticated;
GRANT INSERT, UPDATE ON public.system_progress TO authenticated;
GRANT INSERT ON public.raven_sync_log TO authenticated;

-- ============================================================
-- 15. FRIENDS
-- ============================================================
/*
CREATE TABLE IF NOT EXISTS public.friends (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  friend_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, friend_id)
);
*/

ALTER TABLE public.friends ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS friends_select ON public.friends;
CREATE POLICY friends_select ON public.friends
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR friend_id = auth.uid());

DROP POLICY IF EXISTS friends_insert ON public.friends;
CREATE POLICY friends_insert ON public.friends
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS friends_update ON public.friends;
CREATE POLICY friends_update ON public.friends
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR friend_id = auth.uid())
  WITH CHECK (user_id = auth.uid() OR friend_id = auth.uid());

DROP POLICY IF EXISTS friends_delete ON public.friends;
CREATE POLICY friends_delete ON public.friends
  FOR DELETE TO authenticated USING (user_id = auth.uid() OR friend_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.friends TO authenticated;

-- ============================================================
-- 16. EDDN_MESSAGES
-- ============================================================
/*
CREATE TABLE IF NOT EXISTS public.eddn_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  system_name TEXT NOT NULL,
  station_name TEXT,
  commodity TEXT,
  buy_price INTEGER,
  sell_price INTEGER,
  demand INTEGER,
  supply INTEGER,
  timestamp TIMESTAMPTZ,
  message JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
*/

ALTER TABLE public.eddn_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS eddn_messages_select ON public.eddn_messages;
CREATE POLICY eddn_messages_select ON public.eddn_messages
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS eddn_messages_insert ON public.eddn_messages;
CREATE POLICY eddn_messages_insert ON public.eddn_messages
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

GRANT SELECT ON public.eddn_messages TO anon, authenticated;
GRANT INSERT ON public.eddn_messages TO authenticated;

-- ============================================================
-- 17. STORAGE: news-covers bucket
-- ============================================================
-- В Supabase Dashboard → Storage → New bucket: news-covers
-- Затем настройте policies:
--   SELECT (download): все
--   INSERT (upload): admin/moderator
--   DELETE: admin/moderator
--
-- Или выполните через SQL:
/*
INSERT INTO storage.buckets (id, name, public)
VALUES ('news-covers', 'news-covers', true)
ON CONFLICT DO NOTHING;
*/

DROP POLICY IF EXISTS news_covers_select ON storage.objects;
CREATE POLICY news_covers_select ON storage.objects
  FOR SELECT TO anon, authenticated USING (bucket_id = 'news-covers');

DROP POLICY IF EXISTS news_covers_insert ON storage.objects;
CREATE POLICY news_covers_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'news-covers'
    AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator'))
  );

DROP POLICY IF EXISTS news_covers_delete ON storage.objects;
CREATE POLICY news_covers_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'news-covers'
    AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator'))
  );

-- ============================================================
-- 18. ТРИГГЕР: авто-создание профиля при регистрации
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, cmdr_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'cmdr_name', ''),
    'user'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- 19. ТРИГГЕР: обновление updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Для profiles
DROP TRIGGER IF EXISTS profiles_updated_at ON public.profiles;
CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Для site_content
DROP TRIGGER IF EXISTS site_content_updated_at ON public.site_content;
CREATE TRIGGER site_content_updated_at
  BEFORE UPDATE ON public.site_content
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- 20. ИНДЕКСЫ (производительность)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_cmdr_name ON public.profiles(cmdr_name);
CREATE INDEX IF NOT EXISTS idx_deliveries_user_id ON public.deliveries(user_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_system_name ON public.deliveries(system_name);
CREATE INDEX IF NOT EXISTS idx_project_members_project_id ON public.project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user_id ON public.project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_squadron_members_squadron_id ON public.squadron_members(squadron_id);
CREATE INDEX IF NOT EXISTS idx_squadron_members_user_id ON public.squadron_members(user_id);
CREATE INDEX IF NOT EXISTS idx_forum_posts_thread_id ON public.forum_posts(thread_id);
CREATE INDEX IF NOT EXISTS idx_forum_posts_author_id ON public.forum_posts(author_id);
CREATE INDEX IF NOT EXISTS idx_atlas_candidates_search_id ON public.atlas_candidates(search_id);
CREATE INDEX IF NOT EXISTS idx_raven_sync_log_system_name ON public.raven_sync_log(system_name);
CREATE INDEX IF NOT EXISTS idx_raven_sync_log_created_at ON public.raven_sync_log(created_at);
CREATE INDEX IF NOT EXISTS idx_system_progress_system_name ON public.system_progress(system_name);
