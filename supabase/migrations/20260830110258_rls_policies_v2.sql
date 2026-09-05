-- ============================================================
-- SUPABASE RLS POLICIES — ED Ring Colony
-- Generated from actual schema dump
-- ============================================================

-- 0. Enable extension
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 1. PROFILES
-- ============================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_select ON public.profiles;
CREATE POLICY profiles_select ON public.profiles
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS profiles_insert ON public.profiles;
CREATE POLICY profiles_insert ON public.profiles
  FOR INSERT TO authenticated WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS profiles_update ON public.profiles;
CREATE POLICY profiles_update ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'))
  WITH CHECK (id = auth.uid() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

DROP POLICY IF EXISTS profiles_delete ON public.profiles;
CREATE POLICY profiles_delete ON public.profiles
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

GRANT SELECT ON public.profiles TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.profiles TO authenticated;

-- ============================================================
-- 2. NEWS
-- ============================================================
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
-- 7. MESSAGES
-- ============================================================
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS messages_select ON public.messages;
CREATE POLICY messages_select ON public.messages
  FOR SELECT TO authenticated
  USING (sender_id = auth.uid() OR recipient_id = auth.uid());

DROP POLICY IF EXISTS messages_insert ON public.messages;
CREATE POLICY messages_insert ON public.messages
  FOR INSERT TO authenticated WITH CHECK (sender_id = auth.uid());

DROP POLICY IF EXISTS messages_update ON public.messages;
CREATE POLICY messages_update ON public.messages
  FOR UPDATE TO authenticated
  USING (sender_id = auth.uid() OR recipient_id = auth.uid())
  WITH CHECK (sender_id = auth.uid() OR recipient_id = auth.uid());

DROP POLICY IF EXISTS messages_delete ON public.messages;
CREATE POLICY messages_delete ON public.messages
  FOR DELETE TO authenticated
  USING (sender_id = auth.uid() OR recipient_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO authenticated;

-- ============================================================
-- 8. API_TOKENS
-- ============================================================
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
-- 9. PROJECTS
-- ============================================================
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
-- 10. PROJECT_MEMBERS
-- ============================================================
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
-- 11. PROJECT_SYSTEMS
-- ============================================================
ALTER TABLE public.project_systems ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_systems_select ON public.project_systems;
CREATE POLICY project_systems_select ON public.project_systems
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS project_systems_insert ON public.project_systems;
CREATE POLICY project_systems_insert ON public.project_systems
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = project_id AND pm.user_id = auth.uid() AND pm.role IN ('leader', 'officer'))
    OR EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = project_id AND pr.created_by = auth.uid())
  );

DROP POLICY IF EXISTS project_systems_update ON public.project_systems;
CREATE POLICY project_systems_update ON public.project_systems
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = project_id AND pm.user_id = auth.uid() AND pm.role IN ('leader', 'officer'))
    OR EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = project_id AND pr.created_by = auth.uid())
    OR assigned_to = auth.uid()
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = project_id AND pm.user_id = auth.uid() AND pm.role IN ('leader', 'officer'))
    OR EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = project_id AND pr.created_by = auth.uid())
    OR assigned_to = auth.uid()
  );

DROP POLICY IF EXISTS project_systems_delete ON public.project_systems;
CREATE POLICY project_systems_delete ON public.project_systems
  FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = project_id AND pm.user_id = auth.uid() AND pm.role = 'leader')
    OR EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = project_id AND pr.created_by = auth.uid())
  );

GRANT SELECT ON public.project_systems TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.project_systems TO authenticated;

-- ============================================================
-- 12. SQUADRONS
-- ============================================================
ALTER TABLE public.squadrons ENABLE ROW LEVEL SECURITY;

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

GRANT SELECT ON public.squadrons TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.squadrons TO authenticated;

-- ============================================================
-- 13. SQUADRON_MEMBERS
-- ============================================================
ALTER TABLE public.squadron_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS squadron_members_select ON public.squadron_members;
CREATE POLICY squadron_members_select ON public.squadron_members
  FOR SELECT TO anon, authenticated USING (true);

-- INSERT: только если ты уже в эскадрилье (любой ранг)
DROP POLICY IF EXISTS squadron_members_insert ON public.squadron_members;
CREATE POLICY squadron_members_insert ON public.squadron_members
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_id AND sm.user_id = auth.uid()));

-- UPDATE: только если ты уже в эскадрилье
DROP POLICY IF EXISTS squadron_members_update ON public.squadron_members;
CREATE POLICY squadron_members_update ON public.squadron_members
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_id AND sm.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_id AND sm.user_id = auth.uid()));

-- DELETE: только если ты уже в эскадрилье
DROP POLICY IF EXISTS squadron_members_delete ON public.squadron_members;
CREATE POLICY squadron_members_delete ON public.squadron_members
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_id AND sm.user_id = auth.uid()));

GRANT SELECT ON public.squadron_members TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.squadron_members TO authenticated;

-- ============================================================
-- 14. SQUADRON_RANKS
-- ============================================================
ALTER TABLE public.squadron_ranks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS squadron_ranks_select ON public.squadron_ranks;
CREATE POLICY squadron_ranks_select ON public.squadron_ranks
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS squadron_ranks_insert ON public.squadron_ranks;
CREATE POLICY squadron_ranks_insert ON public.squadron_ranks
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_id AND sm.user_id = auth.uid()));

DROP POLICY IF EXISTS squadron_ranks_update ON public.squadron_ranks;
CREATE POLICY squadron_ranks_update ON public.squadron_ranks
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_id AND sm.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_id AND sm.user_id = auth.uid()));

DROP POLICY IF EXISTS squadron_ranks_delete ON public.squadron_ranks;
CREATE POLICY squadron_ranks_delete ON public.squadron_ranks
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_id AND sm.user_id = auth.uid()));

GRANT SELECT ON public.squadron_ranks TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.squadron_ranks TO authenticated;

-- ============================================================
-- 15. FORUM_CATEGORIES
-- ============================================================
ALTER TABLE public.forum_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS forum_categories_select ON public.forum_categories;
CREATE POLICY forum_categories_select ON public.forum_categories
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS forum_categories_modify ON public.forum_categories;
CREATE POLICY forum_categories_modify ON public.forum_categories
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

GRANT SELECT ON public.forum_categories TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.forum_categories TO authenticated;

-- ============================================================
-- 16. FORUM_THREADS
-- ============================================================
ALTER TABLE public.forum_threads ENABLE ROW LEVEL SECURITY;

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

GRANT SELECT ON public.forum_threads TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.forum_threads TO authenticated;

-- ============================================================
-- 17. FORUM_POSTS
-- ============================================================
ALTER TABLE public.forum_posts ENABLE ROW LEVEL SECURITY;

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

GRANT SELECT ON public.forum_posts TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.forum_posts TO authenticated;

-- ============================================================
-- 18. FORUM_REACTIONS
-- ============================================================
ALTER TABLE public.forum_reactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS forum_reactions_select ON public.forum_reactions;
CREATE POLICY forum_reactions_select ON public.forum_reactions
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS forum_reactions_insert ON public.forum_reactions;
CREATE POLICY forum_reactions_insert ON public.forum_reactions
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS forum_reactions_delete ON public.forum_reactions;
CREATE POLICY forum_reactions_delete ON public.forum_reactions
  FOR DELETE TO authenticated USING (user_id = auth.uid());

GRANT SELECT ON public.forum_reactions TO anon, authenticated;
GRANT INSERT, DELETE ON public.forum_reactions TO authenticated;

-- ============================================================
-- 19. FORUM_SUBSCRIPTIONS
-- ============================================================
ALTER TABLE public.forum_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS forum_subscriptions_select ON public.forum_subscriptions;
CREATE POLICY forum_subscriptions_select ON public.forum_subscriptions
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS forum_subscriptions_insert ON public.forum_subscriptions;
CREATE POLICY forum_subscriptions_insert ON public.forum_subscriptions
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS forum_subscriptions_delete ON public.forum_subscriptions;
CREATE POLICY forum_subscriptions_delete ON public.forum_subscriptions
  FOR DELETE TO authenticated USING (user_id = auth.uid());

GRANT SELECT, INSERT, DELETE ON public.forum_subscriptions TO authenticated;

-- ============================================================
-- 20. FORUM_MODERATION_LOGS
-- ============================================================
ALTER TABLE public.forum_moderation_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS forum_moderation_logs_select ON public.forum_moderation_logs;
CREATE POLICY forum_moderation_logs_select ON public.forum_moderation_logs
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

DROP POLICY IF EXISTS forum_moderation_logs_insert ON public.forum_moderation_logs;
CREATE POLICY forum_moderation_logs_insert ON public.forum_moderation_logs
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

GRANT SELECT, INSERT ON public.forum_moderation_logs TO authenticated;

-- ============================================================
-- 21. FORUM_REPORTS
-- ============================================================
ALTER TABLE public.forum_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS forum_reports_select ON public.forum_reports;
CREATE POLICY forum_reports_select ON public.forum_reports
  FOR SELECT TO authenticated
  USING (reporter_id = auth.uid() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

DROP POLICY IF EXISTS forum_reports_insert ON public.forum_reports;
CREATE POLICY forum_reports_insert ON public.forum_reports
  FOR INSERT TO authenticated WITH CHECK (reporter_id = auth.uid());

GRANT SELECT, INSERT ON public.forum_reports TO authenticated;

-- ============================================================
-- 22. FORUM_TAGS & THREAD_TAGS
-- ============================================================
ALTER TABLE public.forum_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thread_tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS forum_tags_select ON public.forum_tags;
CREATE POLICY forum_tags_select ON public.forum_tags
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS forum_tags_modify ON public.forum_tags;
CREATE POLICY forum_tags_modify ON public.forum_tags
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

DROP POLICY IF EXISTS thread_tags_select ON public.thread_tags;
CREATE POLICY thread_tags_select ON public.thread_tags
  FOR SELECT TO anon, authenticated USING (true);

GRANT SELECT ON public.forum_tags, public.thread_tags TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.forum_tags TO authenticated;

-- ============================================================
-- 23. ATLAS_SEARCHES
-- ============================================================
ALTER TABLE public.atlas_searches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS atlas_searches_select ON public.atlas_searches;
CREATE POLICY atlas_searches_select ON public.atlas_searches
  FOR SELECT TO authenticated USING (created_by = auth.uid() OR created_by IS NULL);

DROP POLICY IF EXISTS atlas_searches_insert ON public.atlas_searches;
CREATE POLICY atlas_searches_insert ON public.atlas_searches
  FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());

GRANT SELECT, INSERT ON public.atlas_searches TO authenticated;

-- ============================================================
-- 24. ATLAS_CANDIDATES
-- ============================================================
ALTER TABLE public.atlas_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS atlas_candidates_select ON public.atlas_candidates;
CREATE POLICY atlas_candidates_select ON public.atlas_candidates
  FOR SELECT TO anon, authenticated USING (true);

GRANT SELECT ON public.atlas_candidates TO anon, authenticated;

-- ============================================================
-- 25. ATLAS_FAVORITES
-- ============================================================
ALTER TABLE public.atlas_favorites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS atlas_favorites_select ON public.atlas_favorites;
CREATE POLICY atlas_favorites_select ON public.atlas_favorites
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS atlas_favorites_insert ON public.atlas_favorites;
CREATE POLICY atlas_favorites_insert ON public.atlas_favorites
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS atlas_favorites_delete ON public.atlas_favorites;
CREATE POLICY atlas_favorites_delete ON public.atlas_favorites
  FOR DELETE TO authenticated USING (user_id = auth.uid());

GRANT SELECT, INSERT, DELETE ON public.atlas_favorites TO authenticated;

-- ============================================================
-- 26. ATLAS_ROUTES
-- ============================================================
ALTER TABLE public.atlas_routes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS atlas_routes_select ON public.atlas_routes;
CREATE POLICY atlas_routes_select ON public.atlas_routes
  FOR SELECT TO authenticated
  USING (created_by = auth.uid() OR is_public = true OR user_id = auth.uid());

DROP POLICY IF EXISTS atlas_routes_insert ON public.atlas_routes;
CREATE POLICY atlas_routes_insert ON public.atlas_routes
  FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS atlas_routes_update ON public.atlas_routes;
CREATE POLICY atlas_routes_update ON public.atlas_routes
  FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS atlas_routes_delete ON public.atlas_routes;
CREATE POLICY atlas_routes_delete ON public.atlas_routes
  FOR DELETE TO authenticated USING (created_by = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.atlas_routes TO authenticated;

-- ============================================================
-- 27. SYSTEM_PROGRESS
-- ============================================================
ALTER TABLE public.system_progress ENABLE ROW LEVEL SECURITY;

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

GRANT SELECT ON public.system_progress TO anon, authenticated;
GRANT INSERT, UPDATE ON public.system_progress TO authenticated;

-- ============================================================
-- 28. RAVEN_SYNC_LOG
-- ============================================================
ALTER TABLE public.raven_sync_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS raven_sync_log_select ON public.raven_sync_log;
CREATE POLICY raven_sync_log_select ON public.raven_sync_log
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS raven_sync_log_insert ON public.raven_sync_log;
CREATE POLICY raven_sync_log_insert ON public.raven_sync_log
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

GRANT SELECT ON public.raven_sync_log TO anon, authenticated;
GRANT INSERT ON public.raven_sync_log TO authenticated;

-- ============================================================
-- 29. FRIENDS
-- ============================================================
ALTER TABLE public.friends ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS friends_select ON public.friends;
CREATE POLICY friends_select ON public.friends
  FOR SELECT TO authenticated
  USING (requester_id = auth.uid() OR addressee_id = auth.uid());

DROP POLICY IF EXISTS friends_insert ON public.friends;
CREATE POLICY friends_insert ON public.friends
  FOR INSERT TO authenticated WITH CHECK (requester_id = auth.uid());

DROP POLICY IF EXISTS friends_update ON public.friends;
CREATE POLICY friends_update ON public.friends
  FOR UPDATE TO authenticated
  USING (requester_id = auth.uid() OR addressee_id = auth.uid())
  WITH CHECK (requester_id = auth.uid() OR addressee_id = auth.uid());

DROP POLICY IF EXISTS friends_delete ON public.friends;
CREATE POLICY friends_delete ON public.friends
  FOR DELETE TO authenticated
  USING (requester_id = auth.uid() OR addressee_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.friends TO authenticated;

-- ============================================================
-- 30. PUSH_SUBSCRIPTIONS
-- ============================================================
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_subscriptions_select ON public.push_subscriptions;
CREATE POLICY push_subscriptions_select ON public.push_subscriptions
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS push_subscriptions_insert ON public.push_subscriptions;
CREATE POLICY push_subscriptions_insert ON public.push_subscriptions
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS push_subscriptions_delete ON public.push_subscriptions;
CREATE POLICY push_subscriptions_delete ON public.push_subscriptions
  FOR DELETE TO authenticated USING (user_id = auth.uid());

GRANT SELECT, INSERT, DELETE ON public.push_subscriptions TO authenticated;

-- ============================================================
-- 31. USER_NOTIFICATIONS
-- ============================================================
ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_notifications_select ON public.user_notifications;
CREATE POLICY user_notifications_select ON public.user_notifications
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS user_notifications_insert ON public.user_notifications;
CREATE POLICY user_notifications_insert ON public.user_notifications
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS user_notifications_update ON public.user_notifications;
CREATE POLICY user_notifications_update ON public.user_notifications
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS user_notifications_delete ON public.user_notifications;
CREATE POLICY user_notifications_delete ON public.user_notifications
  FOR DELETE TO authenticated USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_notifications TO authenticated;

-- ============================================================
-- 32. NOTIFICATIONS (legacy)
-- ============================================================
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO authenticated;

-- ============================================================
-- 33. EDDN_MESSAGES
-- ============================================================
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
-- 34. BADGES & USER_BADGES
-- ============================================================
ALTER TABLE public.badges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_badges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS badges_select ON public.badges;
CREATE POLICY badges_select ON public.badges
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS badges_modify ON public.badges;
CREATE POLICY badges_modify ON public.badges
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

DROP POLICY IF EXISTS user_badges_select ON public.user_badges;
CREATE POLICY user_badges_select ON public.user_badges
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS user_badges_insert ON public.user_badges;
CREATE POLICY user_badges_insert ON public.user_badges
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

GRANT SELECT ON public.badges TO anon, authenticated;
GRANT SELECT ON public.user_badges TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.badges TO authenticated;
GRANT INSERT, DELETE ON public.user_badges TO authenticated;

-- ============================================================
-- 35. USER_POIS
-- ============================================================
ALTER TABLE public.user_pois ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_pois_select ON public.user_pois;
CREATE POLICY user_pois_select ON public.user_pois
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR is_public = true);

DROP POLICY IF EXISTS user_pois_insert ON public.user_pois;
CREATE POLICY user_pois_insert ON public.user_pois
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS user_pois_update ON public.user_pois;
CREATE POLICY user_pois_update ON public.user_pois
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS user_pois_delete ON public.user_pois;
CREATE POLICY user_pois_delete ON public.user_pois
  FOR DELETE TO authenticated USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_pois TO authenticated;

-- ============================================================
-- 36. HUB_GOALS
-- ============================================================
ALTER TABLE public.hub_goals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hub_goals_select ON public.hub_goals;
CREATE POLICY hub_goals_select ON public.hub_goals
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS hub_goals_insert ON public.hub_goals;
CREATE POLICY hub_goals_insert ON public.hub_goals
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

DROP POLICY IF EXISTS hub_goals_update ON public.hub_goals;
CREATE POLICY hub_goals_update ON public.hub_goals
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

DROP POLICY IF EXISTS hub_goals_delete ON public.hub_goals;
CREATE POLICY hub_goals_delete ON public.hub_goals
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

GRANT SELECT ON public.hub_goals TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.hub_goals TO authenticated;

-- ============================================================
-- 37. ACHIEVEMENT_TRACKS, ACHIEVEMENT_RANKS, USER_ACHIEVEMENTS
-- ============================================================
ALTER TABLE public.achievement_tracks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.achievement_ranks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_achievements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS achievement_tracks_select ON public.achievement_tracks;
CREATE POLICY achievement_tracks_select ON public.achievement_tracks
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS achievement_tracks_modify ON public.achievement_tracks;
CREATE POLICY achievement_tracks_modify ON public.achievement_tracks
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

DROP POLICY IF EXISTS achievement_ranks_select ON public.achievement_ranks;
CREATE POLICY achievement_ranks_select ON public.achievement_ranks
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS user_achievements_select ON public.user_achievements;
CREATE POLICY user_achievements_select ON public.user_achievements
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS user_achievements_insert ON public.user_achievements;
CREATE POLICY user_achievements_insert ON public.user_achievements
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

GRANT SELECT ON public.achievement_tracks, public.achievement_ranks, public.user_achievements TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.achievement_tracks TO authenticated;
GRANT INSERT, DELETE ON public.user_achievements TO authenticated;

-- ============================================================
-- 38. HERO_BADGES & USER_HERO_BADGES
-- ============================================================
ALTER TABLE public.hero_badges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_hero_badges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hero_badges_select ON public.hero_badges;
CREATE POLICY hero_badges_select ON public.hero_badges
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS hero_badges_modify ON public.hero_badges;
CREATE POLICY hero_badges_modify ON public.hero_badges
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

DROP POLICY IF EXISTS user_hero_badges_select ON public.user_hero_badges;
CREATE POLICY user_hero_badges_select ON public.user_hero_badges
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS user_hero_badges_insert ON public.user_hero_badges;
CREATE POLICY user_hero_badges_insert ON public.user_hero_badges
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

GRANT SELECT ON public.hero_badges, public.user_hero_badges TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.hero_badges TO authenticated;
GRANT INSERT, DELETE ON public.user_hero_badges TO authenticated;

-- ============================================================
-- 39. ARCHITECT_SYSTEMS
-- ============================================================
ALTER TABLE public.architect_systems ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS architect_systems_select ON public.architect_systems;
CREATE POLICY architect_systems_select ON public.architect_systems
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS architect_systems_insert ON public.architect_systems;
CREATE POLICY architect_systems_insert ON public.architect_systems
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

GRANT SELECT ON public.architect_systems TO anon, authenticated;
GRANT INSERT ON public.architect_systems TO authenticated;

-- ============================================================
-- 40. SQUADRON_CHAT_MESSAGES
-- ============================================================
ALTER TABLE public.squadron_chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS squadron_chat_messages_select ON public.squadron_chat_messages;
CREATE POLICY squadron_chat_messages_select ON public.squadron_chat_messages
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_id AND sm.user_id = auth.uid()));

DROP POLICY IF EXISTS squadron_chat_messages_insert ON public.squadron_chat_messages;
CREATE POLICY squadron_chat_messages_insert ON public.squadron_chat_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_id AND sm.user_id = auth.uid())
  );

GRANT SELECT, INSERT ON public.squadron_chat_messages TO authenticated;

-- ============================================================
-- 41. SQUADRON_VOICE_ROOMS
-- ============================================================
ALTER TABLE public.squadron_voice_rooms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS squadron_voice_rooms_select ON public.squadron_voice_rooms;
CREATE POLICY squadron_voice_rooms_select ON public.squadron_voice_rooms
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_id AND sm.user_id = auth.uid()));

DROP POLICY IF EXISTS squadron_voice_rooms_insert ON public.squadron_voice_rooms;
CREATE POLICY squadron_voice_rooms_insert ON public.squadron_voice_rooms
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_id AND sm.user_id = auth.uid()));

GRANT SELECT, INSERT ON public.squadron_voice_rooms TO authenticated;

-- ============================================================
-- 42. SQUADRON_VOICE_SIGNALS & PARTICIPANTS
-- ============================================================
ALTER TABLE public.squadron_voice_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squadron_voice_participants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS squadron_voice_signals_select ON public.squadron_voice_signals;
CREATE POLICY squadron_voice_signals_select ON public.squadron_voice_signals
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_id AND sm.user_id = auth.uid()));

DROP POLICY IF EXISTS squadron_voice_signals_insert ON public.squadron_voice_signals;
CREATE POLICY squadron_voice_signals_insert ON public.squadron_voice_signals
  FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_id AND sm.user_id = auth.uid())
  );

DROP POLICY IF EXISTS squadron_voice_participants_select ON public.squadron_voice_participants;
CREATE POLICY squadron_voice_participants_select ON public.squadron_voice_participants
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.squadron_voice_rooms vr WHERE vr.id = room_id AND EXISTS (
    SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = vr.squadron_id AND sm.user_id = auth.uid()
  )));

DROP POLICY IF EXISTS squadron_voice_participants_insert ON public.squadron_voice_participants;
CREATE POLICY squadron_voice_participants_insert ON public.squadron_voice_participants
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT ON public.squadron_voice_signals, public.squadron_voice_participants TO authenticated;

-- ============================================================
-- 43. ROUTE_TRACKS
-- ============================================================
ALTER TABLE public.route_tracks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS route_tracks_select ON public.route_tracks;
CREATE POLICY route_tracks_select ON public.route_tracks
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS route_tracks_insert ON public.route_tracks;
CREATE POLICY route_tracks_insert ON public.route_tracks
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS route_tracks_update ON public.route_tracks;
CREATE POLICY route_tracks_update ON public.route_tracks
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS route_tracks_delete ON public.route_tracks;
CREATE POLICY route_tracks_delete ON public.route_tracks
  FOR DELETE TO authenticated USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.route_tracks TO authenticated;

-- ============================================================
-- 44. FORUM_POST_HISTORY
-- ============================================================
ALTER TABLE public.forum_post_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS forum_post_history_select ON public.forum_post_history;
CREATE POLICY forum_post_history_select ON public.forum_post_history
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.forum_posts fp WHERE fp.id = post_id AND fp.author_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')));

DROP POLICY IF EXISTS forum_post_history_insert ON public.forum_post_history;
CREATE POLICY forum_post_history_insert ON public.forum_post_history
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.forum_posts fp WHERE fp.id = post_id AND fp.author_id = auth.uid()));

GRANT SELECT, INSERT ON public.forum_post_history TO authenticated;

-- ============================================================
-- 45. PROJECT_BUILD_PLANS
-- ============================================================
ALTER TABLE public.project_build_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_build_plans_select ON public.project_build_plans;
CREATE POLICY project_build_plans_select ON public.project_build_plans
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS project_build_plans_insert ON public.project_build_plans;
CREATE POLICY project_build_plans_insert ON public.project_build_plans
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.project_systems ps WHERE ps.id = project_system_id AND EXISTS (
    SELECT 1 FROM public.project_members pm WHERE pm.project_id = ps.project_id AND pm.user_id = auth.uid() AND pm.role IN ('leader', 'officer')
  )));

GRANT SELECT, INSERT ON public.project_build_plans TO authenticated;

-- ============================================================
-- 46. STORAGE: news-covers bucket
-- ============================================================
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
-- 47. ТРИГГЕР: авто-создание профиля при регистрации
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
-- 48. ТРИГГЕР: обновление updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS profiles_updated_at ON public.profiles;
CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS site_content_updated_at ON public.site_content;
CREATE TRIGGER site_content_updated_at
  BEFORE UPDATE ON public.site_content
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS squadrons_updated_at ON public.squadrons;
CREATE TRIGGER squadrons_updated_at
  BEFORE UPDATE ON public.squadrons
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- 49. ИНДЕКСЫ
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
CREATE INDEX IF NOT EXISTS idx_raven_sync_log_synced_at ON public.raven_sync_log(synced_at);
CREATE INDEX IF NOT EXISTS idx_system_progress_system_name ON public.system_progress(system_name);
CREATE INDEX IF NOT EXISTS idx_friends_requester ON public.friends(requester_id);
CREATE INDEX IF NOT EXISTS idx_friends_addressee ON public.friends(addressee_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON public.api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_user_notifications_user_id ON public.user_notifications(user_id);
