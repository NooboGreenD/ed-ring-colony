-- ════════════════════════════════════════════════════════════════════
-- 000_base_schema.sql — БАЗОВАЯ СХЕМА ED Ring Colony
-- ════════════════════════════════════════════════════════════════════
--
-- Зачем этот файл. Исторически проект развивался прямо в SQL Editor
-- Supabase, поэтому часть DDL так и не попала в репозиторий:
--   • базовые таблицы (profiles, news, projects, forum_* и т.д.) лежали
--     в 20260830102924_rls_policies.sql ЗАКОММЕНТИРОВАННЫМИ;
--   • ~27 таблиц, которые использует код (messages, project_systems,
--     squadron_ranks, market_search_jobs, hub_goals, atlas_routes …),
--     не были описаны ни в одной миграции;
--   • RPC-функции (get_project_route, get_cmdr_rank,
--     increment_thread_views, increment_forum_posts,
--     get_route_delivery_stats) вызываются кодом, но их DDL в репо не было.
--
-- Этот файл восстанавливает ВСЮ недостающую базу. Он:
--   • идемпотентен (IF NOT EXISTS / OR REPLACE / ADD COLUMN IF NOT EXISTS),
--     на действующей продовой базе ничего не ломает и почти всё пропускает;
--   • по имени (000_) сортируется раньше 001_rls_policies.sql, поэтому на
--     свежей базе таблицы появляются ДО применения RLS-политик;
--   • колонки выведены из фактических обращений кода (insert/select/upsert)
--     и из условий RLS-политик в 001_rls_policies.sql.
--
-- Применение на свежей базе: см. supabase/DATABASE.md
-- ════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ════════════════════════════════════════════════════════════════════
-- 1. ПОЛЬЗОВАТЕЛИ И КОНТЕНТ САЙТА
-- ════════════════════════════════════════════════════════════════════

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
-- Счётчик сообщений форума (rpc increment_forum_posts)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS forum_posts_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.news (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  cover_url TEXT,
  author_id UUID REFERENCES public.profiles(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

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

-- ════════════════════════════════════════════════════════════════════
-- 2. КАРТА КОЛЬЦА: ХАБЫ, СИСТЕМЫ МАРШРУТА, ПРОГРЕСС
-- ════════════════════════════════════════════════════════════════════

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

-- Цели по товарам для хабов (GET /api/hubs)
CREATE TABLE IF NOT EXISTS public.hub_goals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hub_id BIGINT NOT NULL REFERENCES public.hubs(id) ON DELETE CASCADE,
  commodity TEXT NOT NULL,
  target_amount BIGINT NOT NULL DEFAULT 0,
  current_amount BIGINT NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 't',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.route_systems (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  system_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Код читает route_systems(status, progress, x, y, z)
ALTER TABLE public.route_systems ADD COLUMN IF NOT EXISTS x DOUBLE PRECISION;
ALTER TABLE public.route_systems ADD COLUMN IF NOT EXISTS y DOUBLE PRECISION;
ALTER TABLE public.route_systems ADD COLUMN IF NOT EXISTS z DOUBLE PRECISION;
ALTER TABLE public.route_systems ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'planned';
ALTER TABLE public.route_systems ADD COLUMN IF NOT EXISTS progress INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS route_systems_system_name_lower
  ON public.route_systems (LOWER(system_name));
CREATE INDEX IF NOT EXISTS route_systems_sort_order_idx
  ON public.route_systems (sort_order, id);

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

CREATE TABLE IF NOT EXISTS public.architect_systems (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  system_name TEXT NOT NULL,
  architect_name TEXT,
  data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════════════
-- 3. ДОСТАВКИ И API-ТОКЕНЫ
-- ════════════════════════════════════════════════════════════════════

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

CREATE TABLE IF NOT EXISTS public.api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT,
  is_revoked BOOLEAN NOT NULL DEFAULT false,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════════════
-- 4. ПРОЕКТЫ
-- ════════════════════════════════════════════════════════════════════

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

CREATE TABLE IF NOT EXISTS public.project_members (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  callsign TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, user_id)
);

-- Системы внутри проекта (страница /projects/[id], /api/projects/[id]/systems)
CREATE TABLE IF NOT EXISTS public.project_systems (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  system_name TEXT NOT NULL,
  route_system_id BIGINT REFERENCES public.route_systems(id) ON DELETE SET NULL,
  hub_id BIGINT REFERENCES public.hubs(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  planned_status TEXT NOT NULL DEFAULT 'planned',
  priority INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  assigned_to UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  target_date DATE,
  x NUMERIC,
  y NUMERIC,
  z NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_systems_project ON public.project_systems(project_id, sort_order);

CREATE TABLE IF NOT EXISTS public.project_build_plans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_system_id BIGINT NOT NULL REFERENCES public.project_systems(id) ON DELETE CASCADE,
  plan JSONB NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

-- ════════════════════════════════════════════════════════════════════
-- 5. ЭСКАДРИЛЬИ: ЗВАНИЯ, ЧАТ, ГОЛОСОВЫЕ КОМНАТЫ
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.squadrons (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  tag TEXT NOT NULL,
  description TEXT,
  created_by UUID NOT NULL REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Поля, добавленные по мере развития (используются страницами эскадрилий)
ALTER TABLE public.squadrons ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE public.squadrons ADD COLUMN IF NOT EXISTS discord_url TEXT;
ALTER TABLE public.squadrons ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE public.squadrons ADD COLUMN IF NOT EXISTS home_system TEXT;
ALTER TABLE public.squadrons ADD COLUMN IF NOT EXISTS language TEXT;
ALTER TABLE public.squadrons ADD COLUMN IF NOT EXISTS timezone TEXT;
ALTER TABLE public.squadrons ADD COLUMN IF NOT EXISTS power TEXT;
ALTER TABLE public.squadrons ADD COLUMN IF NOT EXISTS allegiance TEXT;
ALTER TABLE public.squadrons ADD COLUMN IF NOT EXISTS activity_type TEXT;
ALTER TABLE public.squadrons ADD COLUMN IF NOT EXISTS recruitment_message TEXT;
ALTER TABLE public.squadrons ADD COLUMN IF NOT EXISTS is_open_recruitment BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.squadrons ADD COLUMN IF NOT EXISTS member_limit INTEGER;
ALTER TABLE public.squadrons ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE public.squadrons ADD COLUMN IF NOT EXISTS name_changed_at TIMESTAMPTZ;
ALTER TABLE public.squadrons ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Звания (создаются автоматически триггером on_squadron_created,
-- см. 20260911030000_squadron_read_models_and_profile_sync.sql)
CREATE TABLE IF NOT EXISTS public.squadron_ranks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  squadron_id BIGINT NOT NULL REFERENCES public.squadrons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 99,
  is_default BOOLEAN NOT NULL DEFAULT false,
  can_manage_projects BOOLEAN NOT NULL DEFAULT false,
  can_manage_members BOOLEAN NOT NULL DEFAULT false,
  can_manage_ranks BOOLEAN NOT NULL DEFAULT false,
  can_edit_squadron BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_squadron_ranks_squadron ON public.squadron_ranks(squadron_id, sort_order);

CREATE TABLE IF NOT EXISTS public.squadron_members (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  squadron_id BIGINT NOT NULL REFERENCES public.squadrons(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  can_manage_projects BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(squadron_id, user_id)
);
-- Современная модель прав идёт через звание
ALTER TABLE public.squadron_members ADD COLUMN IF NOT EXISTS rank_id BIGINT REFERENCES public.squadron_ranks(id) ON DELETE SET NULL;
ALTER TABLE public.squadron_members ADD COLUMN IF NOT EXISTS callsign TEXT;
ALTER TABLE public.squadron_members ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Двухканальный чат эскадрильи (general / officer)
CREATE TABLE IF NOT EXISTS public.squadron_chat_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  squadron_id BIGINT NOT NULL REFERENCES public.squadrons(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  chat_type TEXT NOT NULL DEFAULT 'general',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_squadron_chat_squadron
  ON public.squadron_chat_messages(squadron_id, chat_type, created_at);

-- Голосовые комнаты (WebRTC-сигналинг через таблицы)
CREATE TABLE IF NOT EXISTS public.squadron_voice_rooms (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  squadron_id BIGINT NOT NULL REFERENCES public.squadrons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_officer_only BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.squadron_voice_participants (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id BIGINT NOT NULL REFERENCES public.squadron_voice_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  is_muted BOOLEAN NOT NULL DEFAULT false,
  is_deafened BOOLEAN NOT NULL DEFAULT false,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(room_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.squadron_voice_signals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  squadron_id BIGINT NOT NULL REFERENCES public.squadrons(id) ON DELETE CASCADE,
  room_id BIGINT NOT NULL REFERENCES public.squadron_voice_rooms(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  target_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_voice_signals_room ON public.squadron_voice_signals(room_id, created_at);

-- Read-model: комнаты + число участников (/api/squadrons/[id]/voice)
DO $$ BEGIN
  IF to_regclass('public.squadron_voice_room_summary') IS NULL THEN
    EXECUTE $view$
      CREATE VIEW public.squadron_voice_room_summary
      WITH (security_invoker = true) AS
      SELECT
        vr.*,
        (SELECT count(*)::integer
           FROM public.squadron_voice_participants vp
          WHERE vp.room_id = vr.id) AS participant_count
      FROM public.squadron_voice_rooms vr
    $view$;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- 6. ФОРУМ
-- ════════════════════════════════════════════════════════════════════

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
-- Денормализация «последний ответ» (триггер update_thread_last_post)
ALTER TABLE public.forum_threads ADD COLUMN IF NOT EXISTS last_post_at TIMESTAMPTZ;
ALTER TABLE public.forum_threads ADD COLUMN IF NOT EXISTS last_post_author TEXT;
ALTER TABLE public.forum_threads ADD COLUMN IF NOT EXISTS post_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.forum_posts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id BIGINT NOT NULL REFERENCES public.forum_threads(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES public.profiles(id),
  content TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS public.forum_subscriptions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id BIGINT NOT NULL REFERENCES public.forum_threads(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(thread_id, user_id)
);

-- Уведомления форума (колокольчик; пишет триггер notify_forum_subscribers)
CREATE TABLE IF NOT EXISTS public.forum_notifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  thread_id BIGINT REFERENCES public.forum_threads(id) ON DELETE CASCADE,
  post_id BIGINT REFERENCES public.forum_posts(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'forum_reply',
  title TEXT NOT NULL,
  body TEXT,
  is_read BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_forum_notifications_user
  ON public.forum_notifications(user_id, is_read, created_at DESC);

CREATE TABLE IF NOT EXISTS public.forum_reports (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reporter_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  post_id BIGINT REFERENCES public.forum_posts(id) ON DELETE CASCADE,
  thread_id BIGINT REFERENCES public.forum_threads(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.forum_tags (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.thread_tags (
  thread_id BIGINT NOT NULL REFERENCES public.forum_threads(id) ON DELETE CASCADE,
  tag_id BIGINT NOT NULL REFERENCES public.forum_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (thread_id, tag_id)
);

CREATE TABLE IF NOT EXISTS public.forum_post_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id BIGINT NOT NULL REFERENCES public.forum_posts(id) ON DELETE CASCADE,
  author_id UUID REFERENCES public.profiles(id),
  old_content TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.forum_moderation_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  moderator_id UUID REFERENCES public.profiles(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id BIGINT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════════════
-- 7. ЛИЧНЫЕ СООБЩЕНИЯ, ДРУЗЬЯ, УВЕДОМЛЕНИЯ
-- ════════════════════════════════════════════════════════════════════

-- Личные сообщения (страница /account/messages, realtime-канал 'unread')
CREATE TABLE IF NOT EXISTS public.messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  author_name TEXT,
  avatar_url TEXT,
  content TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_recipient_unread
  ON public.messages(recipient_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_pair
  ON public.messages(sender_id, recipient_id, created_at);

CREATE TABLE IF NOT EXISTS public.friends (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  friend_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, friend_id)
);

-- Универсальные внутренние уведомления (in-app колокольчик)
CREATE TABLE IF NOT EXISTS public.user_notifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  href TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  is_read BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_notifications_user
  ON public.user_notifications(user_id, is_read, created_at DESC);

-- Устаревшая таблица уведомлений (кое-где ещё читается)
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

-- ════════════════════════════════════════════════════════════════════
-- 8. АТЛАС
-- ════════════════════════════════════════════════════════════════════

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

-- Сохранённые маршруты (/api/atlas/route)
CREATE TABLE IF NOT EXISTS public.atlas_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  from_system TEXT NOT NULL,
  to_system TEXT NOT NULL,
  engine TEXT,
  jump_range NUMERIC,
  waypoints JSONB NOT NULL DEFAULT '[]',
  total_distance_ly DOUBLE PRECISION,
  estimated_jumps INTEGER,
  created_by UUID REFERENCES public.profiles(id),
  user_id UUID REFERENCES public.profiles(id),
  is_public BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.user_pois (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  system_name TEXT NOT NULL,
  name TEXT,
  description TEXT,
  x DOUBLE PRECISION,
  y DOUBLE PRECISION,
  z DOUBLE PRECISION,
  is_public BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.route_tracks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT,
  systems JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════════════
-- 9. ПОИСК РЫНКОВ (/api/market/find/*)
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.market_search_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_system TEXT NOT NULL,
  radius INTEGER NOT NULL DEFAULT 150,
  mode TEXT NOT NULL DEFAULT 'single',
  commodity TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  total_systems INTEGER NOT NULL DEFAULT 0,
  scanned_systems INTEGER NOT NULL DEFAULT 0,
  found_stations INTEGER NOT NULL DEFAULT 0,
  current_system TEXT,
  systems_list JSONB NOT NULL DEFAULT '[]',
  result JSONB NOT NULL DEFAULT '[]',
  scan_log JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.market_search_cache (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  system_name TEXT NOT NULL,
  station_name TEXT NOT NULL,
  market_id BIGINT,
  commodity_name TEXT NOT NULL,
  stock INTEGER,
  sell_price INTEGER,
  distance DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(system_name, station_name, commodity_name)
);

CREATE TABLE IF NOT EXISTS public.colonisation_market_systems (
  system_name TEXT PRIMARY KEY,
  x DOUBLE PRECISION,
  y DOUBLE PRECISION,
  z DOUBLE PRECISION,
  has_market BOOLEAN NOT NULL DEFAULT false,
  station_count INTEGER NOT NULL DEFAULT 0,
  station_names JSONB NOT NULL DEFAULT '[]',
  commodities_available JSONB NOT NULL DEFAULT '[]',
  last_checked_at TIMESTAMPTZ
);

-- ════════════════════════════════════════════════════════════════════
-- 10. EDDN (сырой лог) И ДОСТИЖЕНИЯ/БЕЙДЖИ (задел под геймификацию)
-- ════════════════════════════════════════════════════════════════════

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

CREATE TABLE IF NOT EXISTS public.badges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.user_badges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  badge_id BIGINT NOT NULL REFERENCES public.badges(id) ON DELETE CASCADE,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, badge_id)
);

CREATE TABLE IF NOT EXISTS public.hero_badges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.user_hero_badges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  hero_badge_id BIGINT NOT NULL REFERENCES public.hero_badges(id) ON DELETE CASCADE,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, hero_badge_id)
);

CREATE TABLE IF NOT EXISTS public.achievement_tracks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.achievement_ranks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  track_id BIGINT NOT NULL REFERENCES public.achievement_tracks(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  threshold BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.user_achievements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  track_id BIGINT REFERENCES public.achievement_tracks(id) ON DELETE CASCADE,
  rank_id BIGINT REFERENCES public.achievement_ranks(id) ON DELETE SET NULL,
  progress BIGINT NOT NULL DEFAULT 0,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════════════
-- 11. ФУНКЦИИ (RPC, вызываются кодом через supabase.rpc)
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Счётчик просмотров темы: rpc('increment_thread_views', { thread_id })
CREATE OR REPLACE FUNCTION public.increment_thread_views(thread_id BIGINT)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.forum_threads t
     SET views = COALESCE(t.views, 0) + 1
   WHERE t.id = increment_thread_views.thread_id;
$$;

-- Счётчик сообщений пользователя: rpc('increment_forum_posts', { uid })
CREATE OR REPLACE FUNCTION public.increment_forum_posts(uid UUID)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.profiles p
     SET forum_posts_count = COALESCE(p.forum_posts_count, 0) + 1
   WHERE p.id = uid;
$$;

-- Маршрут проекта для 3D-карты: rpc('get_project_route', { project_id })
-- Отдаёт точки в порядке sort_order с координатами и прогрессом.
CREATE OR REPLACE FUNCTION public.get_project_route(project_id BIGINT)
RETURNS TABLE (
  system_name TEXT,
  x DOUBLE PRECISION,
  y DOUBLE PRECISION,
  z DOUBLE PRECISION,
  status TEXT,
  progress INTEGER,
  is_hub BOOLEAN,
  sort_order INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    ps.system_name,
    COALESCE(ps.x::double precision, h.x, rs.x)  AS x,
    COALESCE(ps.y::double precision, h.y, rs.y)  AS y,
    COALESCE(ps.z::double precision, h.z, rs.z)  AS z,
    COALESCE(h.status, rs.status, ps.planned_status, 'planned') AS status,
    COALESCE(h.progress, rs.progress, 0)         AS progress,
    (h.id IS NOT NULL)                            AS is_hub,
    ps.sort_order
  FROM public.project_systems ps
  LEFT JOIN public.hubs h
    ON LOWER(h.system_name) = LOWER(ps.system_name)
  LEFT JOIN public.route_systems rs
    ON rs.id = ps.route_system_id
    OR LOWER(rs.system_name) = LOWER(ps.system_name)
  WHERE ps.project_id = get_project_route.project_id
  ORDER BY ps.sort_order, ps.id;
$$;

-- Сводка доставок по системам для карты: rpc('get_route_delivery_stats')
CREATE OR REPLACE FUNCTION public.get_route_delivery_stats()
RETURNS TABLE (system_name TEXT, total_delivered BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT d.system_name, COALESCE(SUM(d.amount), 0)::bigint AS total_delivered
  FROM public.deliveries d
  GROUP BY d.system_name;
$$;

-- Место пилота в лидерборде: rpc('get_cmdr_rank', { user_uuid })
CREATE OR REPLACE FUNCTION public.get_cmdr_rank(user_uuid UUID)
RETURNS TABLE (rank BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH totals AS (
    SELECT d.user_id, COALESCE(SUM(d.amount), 0) AS total
    FROM public.deliveries d
    GROUP BY d.user_id
  ),
  ranked AS (
    SELECT t.user_id, RANK() OVER (ORDER BY t.total DESC) AS rank
    FROM totals t
  )
  SELECT r.rank FROM ranked r WHERE r.user_id = user_uuid;
$$;

-- Форумные триггер-функции. Финальные версии живут в
-- 20260902120000_fix_forum_trigger_author_name.sql (CREATE OR REPLACE);
-- здесь — первичные определения, чтобы триггеры ниже было к чему привязать.
CREATE OR REPLACE FUNCTION public.update_thread_last_post()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  author_name TEXT;
BEGIN
  SELECT cmdr_name INTO author_name FROM public.profiles WHERE id = NEW.author_id;
  UPDATE public.forum_threads
     SET last_post_at = NEW.created_at,
         last_post_author = COALESCE(author_name, 'Unknown'),
         post_count = COALESCE(post_count, 0) + 1,
         updated_at = NOW()
   WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_forum_subscribers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  sub RECORD;
  thread_title TEXT;
  post_preview TEXT;
  author_name TEXT;
BEGIN
  SELECT title INTO thread_title FROM public.forum_threads WHERE id = NEW.thread_id;
  SELECT cmdr_name INTO author_name FROM public.profiles WHERE id = NEW.author_id;

  post_preview := LEFT(NEW.content, 120);
  IF LENGTH(NEW.content) > 120 THEN
    post_preview := post_preview || '…';
  END IF;

  FOR sub IN
    SELECT user_id FROM public.forum_subscriptions
    WHERE thread_id = NEW.thread_id AND user_id != NEW.author_id
  LOOP
    INSERT INTO public.forum_notifications (user_id, thread_id, post_id, type, title, body)
    VALUES (sub.user_id, NEW.thread_id, NEW.id, 'forum_reply',
            COALESCE(thread_title, 'Новый ответ в теме'),
            COALESCE(author_name, 'Unknown') || ': ' || post_preview);
  END LOOP;

  RETURN NEW;
END;
$$;

-- Привязка триггеров (в проде они были созданы вручную и в репо не попали)
DROP TRIGGER IF EXISTS trg_update_thread_last_post ON public.forum_posts;
CREATE TRIGGER trg_update_thread_last_post
  AFTER INSERT ON public.forum_posts
  FOR EACH ROW EXECUTE FUNCTION public.update_thread_last_post();

DROP TRIGGER IF EXISTS trg_notify_forum_subscribers ON public.forum_posts;
CREATE TRIGGER trg_notify_forum_subscribers
  AFTER INSERT ON public.forum_posts
  FOR EACH ROW EXECUTE FUNCTION public.notify_forum_subscribers();

DROP TRIGGER IF EXISTS market_search_jobs_updated_at ON public.market_search_jobs;
CREATE TRIGGER market_search_jobs_updated_at
  BEFORE UPDATE ON public.market_search_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ════════════════════════════════════════════════════════════════════
-- 12. RLS ДЛЯ ТАБЛИЦ, НЕ ПОКРЫТЫХ 001_rls_policies.sql
-- ════════════════════════════════════════════════════════════════════
-- market_search_* и colonisation_market_systems пишутся только
-- service-role клиентом (обходит RLS) — обычным ролям только чтение.

ALTER TABLE public.market_search_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_search_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.colonisation_market_systems ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS market_search_jobs_select ON public.market_search_jobs;
CREATE POLICY market_search_jobs_select ON public.market_search_jobs
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS market_search_cache_select ON public.market_search_cache;
CREATE POLICY market_search_cache_select ON public.market_search_cache
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS colonisation_market_systems_select ON public.colonisation_market_systems;
CREATE POLICY colonisation_market_systems_select ON public.colonisation_market_systems
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS forum_notifications_select ON public.forum_notifications;
CREATE POLICY forum_notifications_select ON public.forum_notifications
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS forum_notifications_update ON public.forum_notifications;
CREATE POLICY forum_notifications_update ON public.forum_notifications
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS forum_notifications_delete ON public.forum_notifications;
CREATE POLICY forum_notifications_delete ON public.forum_notifications
  FOR DELETE TO authenticated USING (user_id = auth.uid());

GRANT SELECT ON public.market_search_jobs, public.market_search_cache,
  public.colonisation_market_systems TO anon, authenticated;
GRANT SELECT, UPDATE, DELETE ON public.forum_notifications TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- 13. SUPABASE-СПЕЦИФИКА: REALTIME И STORAGE (мягко, если доступны)
-- ════════════════════════════════════════════════════════════════════

-- Личные сообщения слушаются через postgres_changes → таблица должна
-- быть в публикации supabase_realtime.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public' AND tablename = 'messages'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
    END IF;
  END IF;
END $$;

-- Bucket аватаров (news-covers создаёт 20260830102924, support-attachments —
-- 20250906_support_system). Аватары публичные на чтение, запись — владельцу.
DO $$ BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public)
    VALUES ('avatars', 'avatars', true)
    ON CONFLICT (id) DO NOTHING;

    BEGIN
      DROP POLICY IF EXISTS avatars_read ON storage.objects;
      CREATE POLICY avatars_read ON storage.objects
        FOR SELECT TO anon, authenticated USING (bucket_id = 'avatars');

      DROP POLICY IF EXISTS avatars_insert ON storage.objects;
      CREATE POLICY avatars_insert ON storage.objects
        FOR INSERT TO authenticated WITH CHECK (bucket_id = 'avatars');

      DROP POLICY IF EXISTS avatars_update ON storage.objects;
      CREATE POLICY avatars_update ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'avatars' AND owner = auth.uid());

      DROP POLICY IF EXISTS avatars_delete ON storage.objects;
      CREATE POLICY avatars_delete ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'avatars' AND owner = auth.uid());
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'storage.objects принадлежит supabase_admin — создайте политики бакета avatars через Dashboard';
    END;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- 14. GRANT'Ы ДЛЯ НОВЫХ ТАБЛИЦ (политики доступа задаёт RLS в 001)
-- ════════════════════════════════════════════════════════════════════

GRANT SELECT ON public.hub_goals, public.project_systems, public.squadron_ranks,
  public.atlas_routes, public.architect_systems, public.badges, public.user_badges,
  public.hero_badges, public.user_hero_badges, public.achievement_tracks,
  public.achievement_ranks, public.user_achievements, public.forum_tags,
  public.thread_tags TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages, public.user_notifications,
  public.forum_subscriptions, public.forum_reports, public.squadron_chat_messages,
  public.squadron_voice_rooms, public.squadron_voice_participants,
  public.squadron_voice_signals, public.project_systems, public.squadron_ranks,
  public.user_pois, public.route_tracks, public.atlas_routes,
  public.forum_post_history, public.project_build_plans, public.hub_goals,
  public.forum_moderation_logs, public.forum_tags, public.thread_tags,
  public.user_badges, public.user_hero_badges, public.user_achievements
  TO authenticated;

GRANT SELECT ON public.squadron_voice_room_summary TO anon, authenticated;

-- ════════════════════════════════════════════════════════════════════
-- 15. МИНИМАЛЬНЫЙ SEED
-- ════════════════════════════════════════════════════════════════════

-- Главная страница читает site_content с id = 1 — строка должна существовать.
INSERT INTO public.site_content (id, kicker, title1, title2, manifest)
VALUES (1, '', 'ED Ring Colony', 'The Galaxy Ring Project', '')
ON CONFLICT (id) DO NOTHING;
