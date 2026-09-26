-- ════════════════════════════════════════════════════════════════════
-- ED Ring Colony — ПОЛНАЯ СХЕМА БАЗЫ ДАННЫХ (single-file)
-- Сгенерировано из supabase/migrations/* — см. supabase/DATABASE.md
--
-- Назначение: развернуть БД одним файлом в SQL Editor Supabase
-- (или psql) на СВЕЖЕМ проекте. Файл почти полностью идемпотентен,
-- но исторические миграции 20260904* используют CREATE TABLE без
-- IF NOT EXISTS — на уже развёрнутой базе применяйте не этот файл,
-- а недостающие миграции по одной.
--
-- Пересборка файла после добавления миграций:
--   см. команду в supabase/DATABASE.md («Как пересобрать full_schema.sql»)
--
-- НЕ включено (выполняется отдельно, см. DATABASE.md):
--   • supabase/maintenance/create_delivery_source_hash_unique_index_concurrently.sql
--   • supabase/maintenance/colonisation_events_source_hash_dedup.sql
--     (разбор накопленных дублей + CREATE INDEX CONCURRENTLY: в транзакции нельзя)
-- ════════════════════════════════════════════════════════════════════


-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 000_base_schema.sql                                 │
-- └────────────────────────────────────────────────────────────────┘

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

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 001_rls_policies.sql                                │
-- └────────────────────────────────────────────────────────────────┘

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
--
-- Колонки берём из самой таблицы: в этом репозитории она объявлена как
-- user_id/friend_id (000_base_schema.sql), а в части развёрнутых баз осталась
-- в старом виде — requester_id/addressee_id. Жёсткие имена ломали файл на
-- «column "requester_id" does not exist», из-за чего обрывались и все разделы
-- ниже по файлу (30. PUSH_SUBSCRIPTIONS и далее).
-- ============================================================
DO $$
DECLARE
  v_user   TEXT;
  v_friend TEXT;
BEGIN
  IF to_regclass('public.friends') IS NULL THEN
    RAISE NOTICE 'rls_policies: таблицы public.friends нет — раздел пропущен';
    RETURN;
  END IF;

  SELECT (SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'friends' AND column_name = 'requester_id'),
         (SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'friends' AND column_name = 'addressee_id')
    INTO v_user, v_friend;

  IF v_user IS NULL OR v_friend IS NULL THEN
    SELECT (SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'friends' AND column_name = 'user_id'),
           (SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'friends' AND column_name = 'friend_id')
      INTO v_user, v_friend;
  END IF;

  IF v_user IS NULL OR v_friend IS NULL THEN
    RAISE NOTICE 'rls_policies: у public.friends незнакомые колонки — раздел пропущен';
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE public.friends ENABLE ROW LEVEL SECURITY';

  EXECUTE 'DROP POLICY IF EXISTS friends_select ON public.friends';
  EXECUTE format('CREATE POLICY friends_select ON public.friends'
                 ' FOR SELECT TO authenticated'
                 ' USING (%1$I = auth.uid() OR %2$I = auth.uid())', v_user, v_friend);

  EXECUTE 'DROP POLICY IF EXISTS friends_insert ON public.friends';
  EXECUTE format('CREATE POLICY friends_insert ON public.friends'
                 ' FOR INSERT TO authenticated WITH CHECK (%1$I = auth.uid())', v_user);

  EXECUTE 'DROP POLICY IF EXISTS friends_update ON public.friends';
  EXECUTE format('CREATE POLICY friends_update ON public.friends'
                 ' FOR UPDATE TO authenticated'
                 ' USING (%1$I = auth.uid() OR %2$I = auth.uid())'
                 ' WITH CHECK (%1$I = auth.uid() OR %2$I = auth.uid())', v_user, v_friend);

  EXECUTE 'DROP POLICY IF EXISTS friends_delete ON public.friends';
  EXECUTE format('CREATE POLICY friends_delete ON public.friends'
                 ' FOR DELETE TO authenticated'
                 ' USING (%1$I = auth.uid() OR %2$I = auth.uid())', v_user, v_friend);

  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_friends_requester ON public.friends(%I)', v_user);
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_friends_addressee ON public.friends(%I)', v_friend);

  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.friends TO authenticated';
END $$;

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
CREATE INDEX IF NOT EXISTS idx_raven_sync_log_created_at ON public.raven_sync_log(created_at);
CREATE INDEX IF NOT EXISTS idx_system_progress_system_name ON public.system_progress(system_name);
-- Индексы idx_friends_requester / idx_friends_addressee создаются в разделе
-- 29: имена колонок там берутся из самой таблицы.
CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON public.api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_user_notifications_user_id ON public.user_notifications(user_id);

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20250831160000_add_language_to_profiles.sql         │
-- └────────────────────────────────────────────────────────────────┘

-- Migration: Add language column to profiles table
-- Created: 2025-08-31
-- Purpose: Store user's preferred UI language

-- Add language column with default 'ru'
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS language VARCHAR(10) DEFAULT 'ru' NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN public.profiles.language IS 'User preferred UI language (ru, en, de, it, ko, zh, ja)';

-- Create index for fast lookups (useful if filtering by language)
CREATE INDEX IF NOT EXISTS idx_profiles_language ON public.profiles(language);

-- Update existing rows that have NULL language (should not happen with DEFAULT, but safety measure)
UPDATE public.profiles SET language = 'ru' WHERE language IS NULL;

-- Add check constraint to ensure only valid language codes
ALTER TABLE public.profiles
DROP CONSTRAINT IF EXISTS chk_profiles_language;

ALTER TABLE public.profiles
ADD CONSTRAINT chk_profiles_language
CHECK (language IN ('ru', 'en', 'de', 'it', 'ko', 'zh', 'ja'));

-- Grant select on profiles to anon and authenticated roles (if not already granted)
GRANT SELECT ON public.profiles TO anon;
GRANT SELECT, UPDATE ON public.profiles TO authenticated;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20250906_support_system.sql                         │
-- └────────────────────────────────────────────────────────────────┘

-- ============================================
-- ED Ring Colony — Support System Migration
-- Tables: support_tickets, support_messages, support_attachments
-- Roles: admin, moderator, support_manager
-- ============================================

-- 1. Support tickets table
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  category text NOT NULL DEFAULT 'other' CHECK (category IN ('bug', 'feature_request', 'account_issue', 'other')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting_user', 'resolved', 'closed')),
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  page_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  resolved_at timestamptz,
  closed_at timestamptz
);

-- 2. Support messages table (threaded conversation)
CREATE TABLE IF NOT EXISTS public.support_messages (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL,
  is_internal boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- 3. Support attachments table (screenshots, files)
CREATE TABLE IF NOT EXISTS public.support_attachments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  message_id uuid REFERENCES public.support_messages(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  file_type text NOT NULL,
  file_size integer NOT NULL,
  storage_path text NOT NULL,
  public_url text NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);

-- 4. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_support_tickets_user_id ON public.support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON public.support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned_to ON public.support_tickets(assigned_to);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created_at ON public.support_tickets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_id ON public.support_messages(ticket_id);
CREATE INDEX IF NOT EXISTS idx_support_messages_created_at ON public.support_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_support_attachments_ticket_id ON public.support_attachments(ticket_id);

-- 5. Updated_at trigger for support_tickets
CREATE OR REPLACE FUNCTION public.update_support_ticket_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_support_tickets_updated_at ON public.support_tickets;
CREATE TRIGGER trg_support_tickets_updated_at
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.update_support_ticket_updated_at();

-- 6. RLS Policies
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_attachments ENABLE ROW LEVEL SECURITY;

-- Tickets policies
DROP POLICY IF EXISTS support_tickets_user_select ON public.support_tickets;
DROP POLICY IF EXISTS support_tickets_user_insert ON public.support_tickets;
DROP POLICY IF EXISTS support_tickets_user_update ON public.support_tickets;
DROP POLICY IF EXISTS support_tickets_staff_select ON public.support_tickets;
DROP POLICY IF EXISTS support_tickets_staff_update ON public.support_tickets;

CREATE POLICY support_tickets_user_select ON public.support_tickets
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY support_tickets_user_insert ON public.support_tickets
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY support_tickets_user_update ON public.support_tickets
  FOR UPDATE USING (auth.uid() = user_id AND status IN ('open', 'waiting_user'));

CREATE POLICY support_tickets_staff_select ON public.support_tickets
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'moderator', 'support_manager')
    )
  );

CREATE POLICY support_tickets_staff_update ON public.support_tickets
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'moderator', 'support_manager')
    )
  );

-- Messages policies
DROP POLICY IF EXISTS support_messages_user_select ON public.support_messages;
DROP POLICY IF EXISTS support_messages_user_insert ON public.support_messages;
DROP POLICY IF EXISTS support_messages_staff_select ON public.support_messages;
DROP POLICY IF EXISTS support_messages_staff_insert ON public.support_messages;

CREATE POLICY support_messages_user_select ON public.support_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = ticket_id AND t.user_id = auth.uid()
    ) AND is_internal = false
  );

CREATE POLICY support_messages_user_insert ON public.support_messages
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = ticket_id AND t.user_id = auth.uid()
    ) AND is_internal = false
  );

CREATE POLICY support_messages_staff_select ON public.support_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'moderator', 'support_manager')
    )
  );

CREATE POLICY support_messages_staff_insert ON public.support_messages
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'moderator', 'support_manager')
    )
  );

-- Attachments policies
DROP POLICY IF EXISTS support_attachments_user_select ON public.support_attachments;
DROP POLICY IF EXISTS support_attachments_user_insert ON public.support_attachments;
DROP POLICY IF EXISTS support_attachments_staff_select ON public.support_attachments;
DROP POLICY IF EXISTS support_attachments_staff_insert ON public.support_attachments;

CREATE POLICY support_attachments_user_select ON public.support_attachments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = ticket_id AND t.user_id = auth.uid()
    )
  );

CREATE POLICY support_attachments_user_insert ON public.support_attachments
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = ticket_id AND t.user_id = auth.uid()
    )
  );

CREATE POLICY support_attachments_staff_select ON public.support_attachments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'moderator', 'support_manager')
    )
  );

CREATE POLICY support_attachments_staff_insert ON public.support_attachments
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'moderator', 'support_manager')
    )
  );

-- 7. Create storage bucket for support attachments
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'support-attachments',
  'support-attachments',
  true,
  5242880,
  ARRAY['image/jpeg','image/png','image/gif','image/webp','application/pdf','text/plain']
)
ON CONFLICT (id) DO NOTHING;

-- 8. Grant usage
GRANT ALL ON public.support_tickets TO service_role;
GRANT ALL ON public.support_messages TO service_role;
GRANT ALL ON public.support_attachments TO service_role;

-- 9. Function to notify staff on new ticket
CREATE OR REPLACE FUNCTION public.notify_staff_on_new_ticket()
RETURNS trigger AS $$
DECLARE
  staff_user_id uuid;
BEGIN
  FOR staff_user_id IN
    SELECT id FROM public.profiles WHERE role IN ('admin', 'moderator', 'support_manager')
  LOOP
    INSERT INTO public.user_notifications (user_id, type, title, body, href, metadata)
    VALUES (
      staff_user_id,
      'support_ticket',
      'Новое обращение в техподдержку',
      NEW.title,
      '/admin?tab=support',
      jsonb_build_object('ticket_id', NEW.id, 'user_id', NEW.user_id)
    );
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_staff_new_ticket ON public.support_tickets;
CREATE TRIGGER trg_notify_staff_new_ticket
  AFTER INSERT ON public.support_tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_staff_on_new_ticket();

-- 10. Function to notify user on staff reply
CREATE OR REPLACE FUNCTION public.notify_user_on_staff_reply()
RETURNS trigger AS $$
DECLARE
  ticket_user_id uuid;
  ticket_title text;
  sender_role text;
BEGIN
  SELECT t.user_id, t.title, p.role
  INTO ticket_user_id, ticket_title, sender_role
  FROM public.support_tickets t
  LEFT JOIN public.profiles p ON p.id = NEW.sender_id
  WHERE t.id = NEW.ticket_id;

  IF sender_role IN ('admin', 'moderator', 'support_manager') AND NEW.sender_id != ticket_user_id THEN
    INSERT INTO public.user_notifications (user_id, type, title, body, href, metadata)
    VALUES (
      ticket_user_id,
      'support_reply',
      'Ответ от техподдержки',
      ticket_title,
      '/support?t=' || NEW.ticket_id,
      jsonb_build_object('ticket_id', NEW.ticket_id, 'message_id', NEW.id)
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_user_reply ON public.support_messages;
CREATE TRIGGER trg_notify_user_reply
  AFTER INSERT ON public.support_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_user_on_staff_reply();

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20250907_fix_support_notifications.sql              │
-- └────────────────────────────────────────────────────────────────┘

-- ============================================
-- Fix: Add support_ticket and support_reply types to user_notifications
-- Fixes 500 error when creating support tickets
-- ============================================

-- First, check current constraint definition
DO $$
DECLARE
  constraint_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO constraint_def
  FROM pg_constraint
  WHERE conrelid = 'user_notifications'::regclass
    AND conname = 'user_notifications_type_check';
  
  IF constraint_def IS NOT NULL THEN
    RAISE NOTICE 'Current constraint: %', constraint_def;
  ELSE
    RAISE NOTICE 'No user_notifications_type_check constraint found';
  END IF;
END $$;

-- Drop the old constraint if it exists
ALTER TABLE public.user_notifications
DROP CONSTRAINT IF EXISTS user_notifications_type_check;

-- Add the new constraint with support types included
ALTER TABLE public.user_notifications
ADD CONSTRAINT user_notifications_type_check
CHECK (type IN (
  'forum_reply',
  'forum_mention',
  'squadron_invite',
  'friend_request',
  'project_update',
  'news_comment',
  'support_ticket',
  'support_reply'
));

-- Also ensure the table exists with correct schema if it was created elsewhere
-- Add missing columns if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_notifications' AND column_name = 'metadata'
  ) THEN
    ALTER TABLE public.user_notifications ADD COLUMN metadata jsonb;
  END IF;
END $$;

-- Verify the fix
SELECT conname, pg_get_constraintdef(oid) as constraint_definition
FROM pg_constraint
WHERE conrelid = 'user_notifications'::regclass
  AND conname = 'user_notifications_type_check';

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260830102924_rls_policies.sql                     │
-- └────────────────────────────────────────────────────────────────┘

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

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260830110258_rls_policies_v2.sql                  │
-- └────────────────────────────────────────────────────────────────┘

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
--
-- Колонки берём из самой таблицы: в этом репозитории она объявлена как
-- user_id/friend_id (000_base_schema.sql), а в части развёрнутых баз осталась
-- в старом виде — requester_id/addressee_id. Жёсткие имена ломали файл на
-- «column "requester_id" does not exist», из-за чего обрывались и все разделы
-- ниже по файлу (30. PUSH_SUBSCRIPTIONS и далее).
-- ============================================================
DO $$
DECLARE
  v_user   TEXT;
  v_friend TEXT;
BEGIN
  IF to_regclass('public.friends') IS NULL THEN
    RAISE NOTICE 'rls_policies: таблицы public.friends нет — раздел пропущен';
    RETURN;
  END IF;

  SELECT (SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'friends' AND column_name = 'requester_id'),
         (SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'friends' AND column_name = 'addressee_id')
    INTO v_user, v_friend;

  IF v_user IS NULL OR v_friend IS NULL THEN
    SELECT (SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'friends' AND column_name = 'user_id'),
           (SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'friends' AND column_name = 'friend_id')
      INTO v_user, v_friend;
  END IF;

  IF v_user IS NULL OR v_friend IS NULL THEN
    RAISE NOTICE 'rls_policies: у public.friends незнакомые колонки — раздел пропущен';
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE public.friends ENABLE ROW LEVEL SECURITY';

  EXECUTE 'DROP POLICY IF EXISTS friends_select ON public.friends';
  EXECUTE format('CREATE POLICY friends_select ON public.friends'
                 ' FOR SELECT TO authenticated'
                 ' USING (%1$I = auth.uid() OR %2$I = auth.uid())', v_user, v_friend);

  EXECUTE 'DROP POLICY IF EXISTS friends_insert ON public.friends';
  EXECUTE format('CREATE POLICY friends_insert ON public.friends'
                 ' FOR INSERT TO authenticated WITH CHECK (%1$I = auth.uid())', v_user);

  EXECUTE 'DROP POLICY IF EXISTS friends_update ON public.friends';
  EXECUTE format('CREATE POLICY friends_update ON public.friends'
                 ' FOR UPDATE TO authenticated'
                 ' USING (%1$I = auth.uid() OR %2$I = auth.uid())'
                 ' WITH CHECK (%1$I = auth.uid() OR %2$I = auth.uid())', v_user, v_friend);

  EXECUTE 'DROP POLICY IF EXISTS friends_delete ON public.friends';
  EXECUTE format('CREATE POLICY friends_delete ON public.friends'
                 ' FOR DELETE TO authenticated'
                 ' USING (%1$I = auth.uid() OR %2$I = auth.uid())', v_user, v_friend);

  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_friends_requester ON public.friends(%I)', v_user);
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_friends_addressee ON public.friends(%I)', v_friend);

  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.friends TO authenticated';
END $$;

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
-- synced_at: колонку пишет API (src/app/api/ravencolonial/sync/log/route.ts,
-- src/app/api/projects/[id]/progress/route.ts) и читает админка. В базах,
-- развёрнутых до 20260930000000_raven_sync_log_synced_at.sql, её может не быть —
-- тогда индекс не создаём, иначе файл падал с «column "synced_at" does not exist».
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'raven_sync_log'
                AND column_name = 'synced_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_raven_sync_log_synced_at ON public.raven_sync_log(synced_at)';
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_system_progress_system_name ON public.system_progress(system_name);
-- Индексы idx_friends_requester / idx_friends_addressee создаются в разделе
-- 29: имена колонок там берутся из самой таблицы.
CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON public.api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_user_notifications_user_id ON public.user_notifications(user_id);

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260830152500_galnet_news.sql                      │
-- └────────────────────────────────────────────────────────────────┘

-- ============================================================
-- GALNET_NEWS — новости из Elite Dangerous Galnet
-- Автоматически подтягиваются с официального API
--
-- ⚠ Файл восстановлен 2026-09-25. Прежняя версия лежала одной строкой без
--   переводов строк: первый комментарий съедал весь остаток файла, поэтому
--   миграция не создавала ни одной таблицы. psql считает пустой скрипт
--   успешно выполненным, так что поломка была не видна до первого запроса:
--   на таблице висели переводы Galnet (20260915000000), сверка структуры
--   (20260924010000) и весь синк из scripts/lib/galnet-sync.mjs.
-- ============================================================

-- ─── GALNET_NEWS: лента новостей ────────────────────────────
CREATE TABLE IF NOT EXISTS public.galnet_news (
  id           SERIAL PRIMARY KEY,
  nid          TEXT UNIQUE NOT NULL,  -- внешний ID из Galnet API (по нему идёт upsert)
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  image        TEXT,                  -- URL изображения из Galnet
  published_at TIMESTAMPTZ NOT NULL,
  fetched_at   TIMESTAMPTZ DEFAULT NOW(),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_galnet_published ON public.galnet_news(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_galnet_nid ON public.galnet_news(nid);

ALTER TABLE public.galnet_news ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS galnet_select ON public.galnet_news;
CREATE POLICY galnet_select ON public.galnet_news
  FOR SELECT TO anon, authenticated USING (true);

GRANT SELECT ON public.galnet_news TO anon, authenticated;

-- ─── GALNET_SYNC_LOG: лог синхронизации ─────────────────────
-- Пишут только сервисные задачи (service_role), читает админка.
CREATE TABLE IF NOT EXISTS public.galnet_sync_log (
  id             SERIAL PRIMARY KEY,
  fetched_at     TIMESTAMPTZ DEFAULT NOW(),
  articles_count INTEGER DEFAULT 0,
  new_count      INTEGER DEFAULT 0,
  error_msg      TEXT,
  status         TEXT DEFAULT 'success'
);

GRANT SELECT, INSERT ON public.galnet_sync_log TO anon, authenticated;

ALTER TABLE public.galnet_sync_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS galnet_sync_select ON public.galnet_sync_log;
CREATE POLICY galnet_sync_select ON public.galnet_sync_log
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS galnet_sync_insert ON public.galnet_sync_log;
CREATE POLICY galnet_sync_insert ON public.galnet_sync_log
  FOR INSERT TO anon, authenticated WITH CHECK (true);

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260831000000_comments.sql                         │
-- └────────────────────────────────────────────────────────────────┘

-- Comments table for Galnet and News articles

CREATE TABLE IF NOT EXISTS public.comments (
  id          SERIAL PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('galnet', 'news')),
  target_id   TEXT NOT NULL,
  author_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content     TEXT NOT NULL CHECK (LENGTH(content) BETWEEN 1 AND 2000),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_target ON public.comments(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_comments_author ON public.comments(author_id);
CREATE INDEX IF NOT EXISTS idx_comments_created ON public.comments(created_at DESC);

ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;

-- Select policy
DROP POLICY IF EXISTS comments_select ON public.comments;
CREATE POLICY comments_select ON public.comments
  FOR SELECT TO anon, authenticated USING (true);

-- Insert policy
DROP POLICY IF EXISTS comments_insert ON public.comments;
CREATE POLICY comments_insert ON public.comments
  FOR INSERT TO authenticated WITH CHECK (true);

-- Delete policy (author, admin, moderator)
DROP POLICY IF EXISTS comments_delete ON public.comments;
CREATE POLICY comments_delete ON public.comments
  FOR DELETE TO authenticated USING (
    auth.uid() = author_id OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'moderator'))
  );

-- Update policy (author only)
DROP POLICY IF EXISTS comments_update ON public.comments;
CREATE POLICY comments_update ON public.comments
  FOR UPDATE TO authenticated USING (auth.uid() = author_id)
  WITH CHECK (auth.uid() = author_id);

-- Grants
GRANT SELECT, INSERT, DELETE, UPDATE ON public.comments TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE comments_id_seq TO anon, authenticated;

-- Updated at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS comments_updated_at ON public.comments;
CREATE TRIGGER comments_updated_at
  BEFORE UPDATE ON public.comments
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260831030000_comments_fix_fk.sql                  │
-- └────────────────────────────────────────────────────────────────┘

-- Fix comments table: add explicit FK to profiles so PostgREST can embed profiles
-- This allows queries like: .select('*,author:profiles(cmdr_name)')

-- Drop existing FK if it points to auth.users
ALTER TABLE public.comments
  DROP CONSTRAINT IF EXISTS comments_author_id_fkey;

-- Add FK pointing to profiles(id) — profiles.id already references auth.users(id)
ALTER TABLE public.comments
  ADD CONSTRAINT comments_author_id_fkey
  FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260901000000_wiki.sql                             │
-- └────────────────────────────────────────────────────────────────┘

-- ED Ring Colony Wiki — Database Schema Migration
-- ============================================================

-- 1. Categories
CREATE TABLE IF NOT EXISTS public.wiki_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT,
  sort_order  INT DEFAULT 0,
  parent_id   UUID REFERENCES public.wiki_categories(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wiki_categories_slug ON public.wiki_categories(slug);
CREATE INDEX IF NOT EXISTS idx_wiki_categories_parent ON public.wiki_categories(parent_id);

-- 2. Articles
CREATE TABLE IF NOT EXISTS public.wiki_articles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title          TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  content        TEXT NOT NULL DEFAULT '',
  category_id    UUID REFERENCES public.wiki_categories(id) ON DELETE SET NULL,
  author_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_editor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','archived')),
  is_featured    BOOLEAN DEFAULT FALSE,
  view_count     INT DEFAULT 0,
  version        INT DEFAULT 1,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wiki_articles_slug ON public.wiki_articles(slug);
CREATE INDEX IF NOT EXISTS idx_wiki_articles_category ON public.wiki_articles(category_id);
CREATE INDEX IF NOT EXISTS idx_wiki_articles_status ON public.wiki_articles(status);
CREATE INDEX IF NOT EXISTS idx_wiki_articles_featured ON public.wiki_articles(is_featured) WHERE is_featured = TRUE;

-- 3. Revisions
CREATE TABLE IF NOT EXISTS public.wiki_revisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id      UUID NOT NULL REFERENCES public.wiki_articles(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  editor_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  revision_number INT NOT NULL,
  change_summary  TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wiki_revisions_article ON public.wiki_revisions(article_id);
CREATE INDEX IF NOT EXISTS idx_wiki_revisions_number ON public.wiki_revisions(article_id, revision_number DESC);

-- 4. Tags
CREATE TABLE IF NOT EXISTS public.wiki_tags (
  id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_wiki_tags_slug ON public.wiki_tags(slug);

-- 5. Article Tags (many-to-many)
CREATE TABLE IF NOT EXISTS public.wiki_article_tags (
  article_id UUID NOT NULL REFERENCES public.wiki_articles(id) ON DELETE CASCADE,
  tag_id     UUID NOT NULL REFERENCES public.wiki_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_wiki_article_tags_tag ON public.wiki_article_tags(tag_id);

-- 6. Redirects
CREATE TABLE IF NOT EXISTS public.wiki_redirects (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_slug  TEXT NOT NULL UNIQUE,
  to_slug    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wiki_redirects_from ON public.wiki_redirects(from_slug);

-- 7. Favorites
CREATE TABLE IF NOT EXISTS public.wiki_favorites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  article_id UUID NOT NULL REFERENCES public.wiki_articles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, article_id)
);

CREATE INDEX IF NOT EXISTS idx_wiki_favorites_user ON public.wiki_favorites(user_id);

-- ============================================================
-- RLS Policies
-- ============================================================

ALTER TABLE public.wiki_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wiki_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wiki_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wiki_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wiki_article_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wiki_redirects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wiki_favorites ENABLE ROW LEVEL SECURITY;

-- wiki_categories: public read, admin write
DROP POLICY IF EXISTS wiki_categories_select ON public.wiki_categories;
CREATE POLICY wiki_categories_select ON public.wiki_categories
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS wiki_categories_insert ON public.wiki_categories;
CREATE POLICY wiki_categories_insert ON public.wiki_categories
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','moderator'))
  );

DROP POLICY IF EXISTS wiki_categories_update ON public.wiki_categories;
CREATE POLICY wiki_categories_update ON public.wiki_categories
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','moderator'))
  );

DROP POLICY IF EXISTS wiki_categories_delete ON public.wiki_categories;
CREATE POLICY wiki_categories_delete ON public.wiki_categories
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','moderator'))
  );

-- wiki_articles: public read published, auth create/edit own or admin any
DROP POLICY IF EXISTS wiki_articles_select ON public.wiki_articles;
CREATE POLICY wiki_articles_select ON public.wiki_articles
  FOR SELECT TO anon, authenticated USING (
    status = 'published' OR auth.uid() = author_id OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','moderator'))
  );

DROP POLICY IF EXISTS wiki_articles_insert ON public.wiki_articles;
CREATE POLICY wiki_articles_insert ON public.wiki_articles
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = author_id);

DROP POLICY IF EXISTS wiki_articles_update ON public.wiki_articles;
CREATE POLICY wiki_articles_update ON public.wiki_articles
  FOR UPDATE TO authenticated USING (
    auth.uid() = author_id OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','moderator'))
  );

DROP POLICY IF EXISTS wiki_articles_delete ON public.wiki_articles;
CREATE POLICY wiki_articles_delete ON public.wiki_articles
  FOR DELETE TO authenticated USING (
    auth.uid() = author_id OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','moderator'))
  );

-- wiki_revisions: public read, insert by editor only
DROP POLICY IF EXISTS wiki_revisions_select ON public.wiki_revisions;
CREATE POLICY wiki_revisions_select ON public.wiki_revisions
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS wiki_revisions_insert ON public.wiki_revisions;
CREATE POLICY wiki_revisions_insert ON public.wiki_revisions
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = editor_id);

-- wiki_tags: public read, auth create
DROP POLICY IF EXISTS wiki_tags_select ON public.wiki_tags;
CREATE POLICY wiki_tags_select ON public.wiki_tags
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS wiki_tags_insert ON public.wiki_tags;
CREATE POLICY wiki_tags_insert ON public.wiki_tags
  FOR INSERT TO authenticated WITH CHECK (true);

-- wiki_article_tags: public read, auth manage
DROP POLICY IF EXISTS wiki_article_tags_select ON public.wiki_article_tags;
CREATE POLICY wiki_article_tags_select ON public.wiki_article_tags
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS wiki_article_tags_insert ON public.wiki_article_tags;
CREATE POLICY wiki_article_tags_insert ON public.wiki_article_tags
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS wiki_article_tags_delete ON public.wiki_article_tags;
CREATE POLICY wiki_article_tags_delete ON public.wiki_article_tags
  FOR DELETE TO authenticated USING (true);

-- wiki_redirects: public read, admin write
DROP POLICY IF EXISTS wiki_redirects_select ON public.wiki_redirects;
CREATE POLICY wiki_redirects_select ON public.wiki_redirects
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS wiki_redirects_insert ON public.wiki_redirects;
CREATE POLICY wiki_redirects_insert ON public.wiki_redirects
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','moderator'))
  );

DROP POLICY IF EXISTS wiki_redirects_update ON public.wiki_redirects;
CREATE POLICY wiki_redirects_update ON public.wiki_redirects
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','moderator'))
  );

DROP POLICY IF EXISTS wiki_redirects_delete ON public.wiki_redirects;
CREATE POLICY wiki_redirects_delete ON public.wiki_redirects
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','moderator'))
  );

-- wiki_favorites: self only
DROP POLICY IF EXISTS wiki_favorites_select ON public.wiki_favorites;
CREATE POLICY wiki_favorites_select ON public.wiki_favorites
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS wiki_favorites_insert ON public.wiki_favorites;
CREATE POLICY wiki_favorites_insert ON public.wiki_favorites
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS wiki_favorites_delete ON public.wiki_favorites;
CREATE POLICY wiki_favorites_delete ON public.wiki_favorites
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- ============================================================
-- Grants
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wiki_categories TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wiki_articles TO anon, authenticated;
GRANT SELECT, INSERT ON public.wiki_revisions TO anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.wiki_tags TO anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.wiki_article_tags TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wiki_redirects TO anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.wiki_favorites TO anon, authenticated;

-- ============================================================
-- Updated at trigger for wiki_articles
-- ============================================================
DROP TRIGGER IF EXISTS wiki_articles_updated_at ON public.wiki_articles;
CREATE TRIGGER wiki_articles_updated_at
  BEFORE UPDATE ON public.wiki_articles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Seed categories
-- ============================================================
INSERT INTO public.wiki_categories (name, slug, description, sort_order) VALUES
  ('Корабли', 'ships', 'Все корабли Elite Dangerous', 1),
  ('Инженеры', 'engineers', 'Инженеры и их модификации', 2),
  ('Материалы', 'materials', 'Редкие и обычные материалы', 3),
  ('Гайды', 'guides', 'Руководства и советы', 4),
  ('Лор', 'lore', 'История и лор вселенной', 5),
  ('Механики', 'mechanics', 'Игровые механики', 6),
  ('Колонизация', 'colonization', 'Всё о колонизации систем', 7),
  ('Проект Кольцо', 'ring-project', 'The Galaxy Ring Project', 8)
ON CONFLICT (slug) DO NOTHING;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260902120000_fix_forum_trigger_author_name.sql    │
-- └────────────────────────────────────────────────────────────────┘

-- Fix: replace NEW.author_name with lookup from profiles table in forum triggers
-- Applied via Supabase Management API on 2026-09-02

CREATE OR REPLACE FUNCTION public.update_thread_last_post()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  author_name TEXT;
BEGIN
  SELECT cmdr_name INTO author_name FROM profiles WHERE id = NEW.author_id;
  
  UPDATE forum_threads 
  SET last_post_at = NEW.created_at,
      last_post_author = COALESCE(author_name, 'Unknown'),
      updated_at = NOW()
  WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_forum_subscribers()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  sub RECORD;
  thread_title TEXT;
  post_preview TEXT;
  author_name TEXT;
BEGIN
  SELECT title INTO thread_title FROM forum_threads WHERE id = NEW.thread_id;
  SELECT cmdr_name INTO author_name FROM profiles WHERE id = NEW.author_id;

  post_preview := LEFT(NEW.content, 120);
  IF LENGTH(NEW.content) > 120 THEN
    post_preview := post_preview || '…';
  END IF;

  FOR sub IN
    SELECT user_id FROM forum_subscriptions
    WHERE thread_id = NEW.thread_id AND user_id != NEW.author_id
  LOOP
    INSERT INTO forum_notifications (user_id, thread_id, post_id, type, title, body)
    VALUES (sub.user_id, NEW.thread_id, NEW.id, 'forum_reply',
            COALESCE(thread_title, 'Новый ответ в теме'),
            COALESCE(author_name, 'Unknown') || ': ' || post_preview);
  END LOOP;

  RETURN NEW;
END;
$function$;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260903000000_wiki_fill_empty_categories.sql       │
-- └────────────────────────────────────────────────────────────────┘

-- ============================================================
-- ED Ring Colony Wiki — Seed: гайды (категория «Гайды»)
--
-- ⚠ Файл восстановлен 2026-09-25. Прежняя версия лежала одной строкой: в ней
--   были потеряны все переводы строк, поэтому первый же комментарий «-- …»
--   съедал весь остаток файла вместе с блоком DO. Миграция не создавала
--   ничего, а при попытке выполнить DO сервер отвечал
--   «syntax error at end of input» — и обновление падало
--   (deploy/update-project.sh накатывает миграции с ON_ERROR_STOP=1).
--
--   Что сделано при восстановлении:
--     • комментарии снова на своих строках, структура DO/INSERT/END цела;
--     • маркеры $nl$ внутри текстов статей заменены реальными переводами
--       строк — разворачивать их было некому, в базу попадала одна строка
--       с литералами «$nl$»;
--     • статья и её первая ревизия вставляются идемпотентно
--       (ON CONFLICT (slug) DO NOTHING), чтобы повторный накат не ронял
--       обновление на «duplicate key value violates unique constraint»;
--     • категория ищется по id из рабочей базы, затем по slug 'guides' и лишь
--       при отсутствии создаётся: 20260901000000_wiki.sql сеет категории
--       через gen_random_uuid(), и в свежей базе id у них другие;
--     • если пользователя-автора в базе нет (установка с нуля до регистрации
--       администратора), сид пропускается с NOTICE: это контент, а не схема,
--       ронять из-за него деплой нельзя.
--
--   Остальные статьи серии: 20260903010000 (колонизация), 20260903020000 (лор).
-- ============================================================

DO $seed$
DECLARE
  v_admin_id   UUID := 'd0680fc1-5fa0-4a54-b9bd-6918f88de63a';
  v_author_id  UUID;
  v_cat_guides UUID;
  v_article_id UUID;
BEGIN
  -- ============================================================
  -- 0. Категория «Гайды» и автор статей
  -- ============================================================
  SELECT id INTO v_cat_guides FROM public.wiki_categories
   WHERE id = '448d06b4-5a1d-4c90-b37e-019f22ec9064';
  IF v_cat_guides IS NULL THEN
    SELECT id INTO v_cat_guides FROM public.wiki_categories WHERE slug = 'guides';
  END IF;
  IF v_cat_guides IS NULL THEN
    INSERT INTO public.wiki_categories (name, slug, description, sort_order)
    VALUES ('Гайды', 'guides', 'Руководства и советы', 4)
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO v_cat_guides;
  END IF;

  SELECT COALESCE(
           (SELECT id FROM auth.users WHERE id = v_admin_id),
           (SELECT id FROM public.profiles
             WHERE role IN ('admin', 'moderator')
             ORDER BY created_at LIMIT 1)
         ) INTO v_author_id;
  IF v_author_id IS NULL THEN
    RAISE NOTICE 'wiki_fill_empty_categories: нет пользователя-автора (admin/moderator) — сид пропущен';
    RETURN;
  END IF;

  -- ============================================================
  -- КАТЕГОРИЯ: ГАЙДЫ (3 статьи)
  -- ============================================================
  -- ── Первые шаги новичка ──────────────────────────────────────────────
  INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
  VALUES (
    'Первые шаги новичка',
    'pervye-shagi-novichka',
    $c$# Первые шаги новичка

**Тип:** Гайд
**Сложность:** Начальный
**Время чтения:** 15 минут

## Описание

Только что купили Elite Dangerous и не знаете, с чего начать? Этот гайд проведёт вас от первого запуска до осознанного выбора профессии. Не торопитесь — игра вознаградит любопытство.

## Этап 1: Прохождение обучения

Не пропускайте обучение. Оно научит:
- Базовому управлению (взлёт, посадка, FSD)
- Суперкруизу и выходу из него
- Стыковке вручную и через Docking Computer
- Базовому бою и сканированию

## Этап 2: Первые кредиты (Sidewinder)

| Способ | Доход | Сложность |
|--------|-------|-----------|
| Миссии «Доставка данных» | 10–50 тыс. | Низкая |
| Поиск обломков (RES) | 20–100 тыс. | Средняя |
| Базовая торговля | 5–20 тыс. | Низкая |

Рекомендация: выполните 3–5 миссий на доставку данных, чтобы накопить на Cobra Mk III (~350 тыс.)

## Этап 3: Первый апгрейд корабля

**Цель:** Cobra Mk III
- Универсальность: торговля, бой, исследования
- 4 внутренних слота
- Достаточно щитов и скорости

Обязательные модули для покупки:
1. **D-rated FSD** — максимальная дальность прыжка
2. **Fuel Scoop** — бесплатное топливо от звёзд
3. **Detailed Surface Scanner** — заработок на исследованиях

## Этап 4: Выбор пути

После Cobra Mk III выберите специализацию:

| Профессия | Следующий корабль | Что делать |
|-----------|-------------------|------------|
| Торговля | Type-6 Transporter | Loop routes, rare goods |
| Бой | Vulture | RES, Combat Zones |
| Исследования | Diamondback Explorer | Дальние миры, продажа данных |
| Многоцелевой | Python | Всё понемногу |

## Советы

- **Не летайте без страховки (Rebuy)** — всегда держите 5–10% стоимости корабля
- **Используйте Inara.cz и EDDB** — внеигровые инструменты экономят часы
- **Присоединяйтесь к Squadron** — сообщество поможет и ответит на вопросы
- **Откройте Felicity Farseer** — первый инженер, G5 FSD — must have
- **Не бойтесь Open** — PvP-гриферы редки, а помощь других игроков бесценна

## Оценка

Первые 10 часов в Elite Dangerous — самые важные. Не гонитесь за кредитами, изучайте механики. Хорошо настроенный Cobra Mk III принесёт больше удовольствия, чем stock Anaconda.$c$,
    v_cat_guides, v_author_id, v_author_id, 'published', true, 0, 1, NOW(), NOW()
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO v_article_id;

  IF v_article_id IS NOT NULL THEN
    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed', NOW());
  END IF;

  -- ── Быстрый заработок кредитов ──────────────────────────────────────────────
  INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
  VALUES (
    'Быстрый заработок кредитов',
    'bystryj-zarabotok-kreditov',
    $c$# Быстрый заработок кредитов

**Тип:** Гайд
**Сложность:** Любая
**Актуальность:** 2026

## Описание

Elite Dangerous предлагает множество способов заработка. Этот гайд описывает самые эффективные методы на разных этапах карьеры — от стартового Sidewinder до флота Fleet Carrier.

## Начальный этап (0–5 млн CR)

| Метод | Доход/час | Требования |
|-------|-----------|------------|
| Миссии доставки данных | 0.5–1 млн | Sidewinder, любая станция |
| Road to Riches | 1–3 млн | Cobra Mk III + DSS + Fuel Scoop |
| Низкоуровневый RES | 1–2 млн | Любой боевой корабль, система с RES |

**Road to Riches** — сканируйте дорогие планеты (Earth-like, Water worlds) в пределах 5000 св. лет от Bubble. Маршруты есть на [EDTools](https://edtools.cc/).

## Средний этап (5–500 млн CR)

| Метод | Доход/час | Требования |
|-------|-----------|------------|
| Void Opals / LTD mining | 50–200 млн | Корабль с трюмом 100+ т, seismic charges |
| Passenger missions (Robigo) | 20–50 млн | Python, 3A Business cabins |
| Stackable massacre missions | 30–100 млн | Корабль G3+, allied фракция |

**Robigo Mines** — станция в системе Robigo. Берите пассажиров в Sirius Atmospherics, летите в Sothis. 10-минутный рейс, 10–20 млн прибыли.

## Продвинутый этап (500 млн+)

| Метод | Доход/час | Требования |
|-------|-----------|------------|
| Platinum laser mining | 100–300 млн | Type-9 / Cutter, mapped hotspot |
| Thargoid interceptor hunting | 100–500 млн | AX-krait, опыт |
| Colonization logistics | 50–200 млн | Fleet Carrier, Type-11 |

## Советы

- Не гонитесь только за кредитами — инженеры важнее
- Fleet Carrier стоит 5 млрд + 500 млн/неделю upkeep — считайте заранее
- Используйте [Mineraltools](https://mineraltools.com) для поиска актуальных hotspot'ов
- Community Goals часто дают десятки миллионов за простые действия

## Оценка

Лучший заработок — тот, который вам не надоеден. Mining приносит больше всего, но быстро утомляет. Passenger Robigo — золотая середина: стабильный, предсказуемый, не требует постоянного внимания.$c$,
    v_cat_guides, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO v_article_id;

  IF v_article_id IS NOT NULL THEN
    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed', NOW());
  END IF;

  -- ── Гайд по открытию инженеров ──────────────────────────────────────────────
  INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
  VALUES (
    'Гайд по открытию инженеров',
    'gayd-po-otkrytiyu-inzhenerov',
    $c$# Гайд по открытию инженеров

**Тип:** Гайд
**Сложность:** Средняя
**Время:** 10–30 часов

## Описание

Инженеры — ключевая прогрессия в Elite Dangerous. G5-модификации превращают стоковый корабль в машину, способную на всё. Этот гайд описывает оптимальный порядок открытия и требования для каждого инженера.

## Порядок открытия (рекомендуемый)

| # | Инженер | Зачем открывать | Сложность |
|---|---------|-----------------|-----------|
| 1 | Felicity Farseer | G5 FSD, G3 Thrusters | Очень низкая |
| 2 | Tod McQuinn | G5 Multi-cannons, G3 Railguns | Низкая |
| 3 | The Dweller | G5 Power Distributor | Низкая |
| 4 | Elvira Martuuk | G5 FSD (альтернатива) | Низкая |
| 5 | Liz Ryder | G5 Missiles, G3 Torpedoes | Низкая |
| 6 | Selene Jean | G5 Hull | Средняя |
| 7 | Didi Vatermann | G5 Shield Boosters | Средняя |
| 8 | Lei Cheung | G5 Shields | Средняя |
| 9 | Marco Qwent | G4 Power Plant, открывает Palin | Средняя |
| 10 | Professor Palin | G5 Thrusters, G3 AFMU | Высокая |

## Как начать

1. **Felicity Farseer** — требует звание Scout в исследованиях. Сделайте Road to Riches, продайте данные в Farseer Inc (Deciat)
2. **Meta-Alloys** — купите у Darnielle's Progress (Maia) или соберите с Thargoid Barnacle
3. **Marco Qwent** — требует приглашение от Elvira Martuuk и 25 единиц Modular Terminals (миссии Sirius Corp)
4. **Professor Palin** — требует 5000 св. лет от стартовой системы + приглашение от Marco Qwent

## Быстрые материалы для старта

| Инженер | Что принести | Где взять |
|---------|--------------|-----------|
| Felicity | 1 Meta-Alloy | Maia — Darnielle's Progress |
| Tod McQuinn | 15 Fragment Cannons убийств | Any RES |
| The Dweller | 5 единиц Black Market | Продайте контрабанду |
| Liz Ryder | 200 единиц Landmines | Eurybia — Kammerman's Port |

## Советы

- Не пытайтесь открыть всех сразу — это выгорание
- Сначала поднимите репутацию (G1→G3 модули), потом фармите G5 материалы
- Используйте [Inara](https://inara.cz) для отслеживания требований
- pinned blueprint — закреплённый чертёж, позволяет крафтить удалённо
- Experimental effects доступны только на базе инженера

## Оценка

Инженеры — must have для любой серьёзной деятельности. Даже G3 FSD от Felicity удвоит вашу дальность. Потратьте 2–3 вечера на открытие первой пятёрки — это окупится сторицей.$c$,
    v_cat_guides, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO v_article_id;

  IF v_article_id IS NOT NULL THEN
    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed', NOW());
  END IF;

END
$seed$;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260903010000_wiki_update_colonization.sql         │
-- └────────────────────────────────────────────────────────────────┘

-- ============================================================
-- ED Ring Colony Wiki — Update: гайд по колонизации (версия 2.0) + 2 статьи
--
-- ⚠ Файл восстановлен 2026-09-25. Прежняя версия лежала одной строкой без
--   переводов строк: первый комментарий съедал весь остаток файла вместе с
--   блоком DO, поэтому миграция не выполняла ни одной команды (psql считает
--   пустой скрипт успешным, и поломка была незаметна).
--
--   Что сохранено и что исправлено:
--     • текст статей не менялся, маркеры $nl$ развёрнуты в реальные переводы
--       строк (разворачивать их было некому — в базе оставалась одна строка);
--     • гайд по колонизации обновляется до версии 2.0, а на базе, где его нет
--       (чистая установка, гайд заводили вручную из шаблона), — создаётся сразу
--       в версии 2.0: раньше UPDATE молча не находил ни одной строки;
--     • повторный накат безопасен: статьи не дублируются (ON CONFLICT (slug)),
--       ревизия №2 добавляется только если её ещё нет;
--     • категория «Колонизация» и автор ищутся по базе — как в
--       20260903000000_wiki_fill_empty_categories.sql.
-- ============================================================

DO $seed$
DECLARE
  v_admin_id         UUID := 'd0680fc1-5fa0-4a54-b9bd-6918f88de63a';
  v_author_id        UUID;
  v_cat_colonization UUID;
  v_article_id       UUID;
  v_guide_content    TEXT;
BEGIN
  -- ============================================================
  -- 0. Категория «Колонизация» и автор статей
  -- ============================================================
  SELECT id INTO v_cat_colonization FROM public.wiki_categories
   WHERE id = '117fddde-9c52-4741-b00d-edb2788e4e42';
  IF v_cat_colonization IS NULL THEN
    SELECT id INTO v_cat_colonization FROM public.wiki_categories WHERE slug = 'colonization';
  END IF;
  IF v_cat_colonization IS NULL THEN
    INSERT INTO public.wiki_categories (name, slug, description, sort_order)
    VALUES ('Колонизация', 'colonization', 'Всё о колонизации систем', 7)
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO v_cat_colonization;
  END IF;

  SELECT COALESCE(
           (SELECT id FROM auth.users WHERE id = v_admin_id),
           (SELECT id FROM public.profiles
             WHERE role IN ('admin', 'moderator')
             ORDER BY created_at LIMIT 1)
         ) INTO v_author_id;
  IF v_author_id IS NULL THEN
    RAISE NOTICE 'wiki_update_colonization: нет пользователя-автора (admin/moderator) — сид пропущен';
    RETURN;
  END IF;

  v_guide_content := $c$# Полный гайд по колонизации в Elite Dangerous

> **Актуально для:** Update 2 / Trailblazers (февраль 2026)  
> **Автор:** Сообщество ED Ring Colony  
> **Категория:** Колонизация  
> **Версия:** 2.0  
> **Статус:** Актуально для текущего патча

---

## Содержание

1. [Введение: что такое колонизация](#введение-что-такое-колонизация)
2. [Этап 0: Подготовка](#этап-0-подготовка)
3. [Этап 1: Выбор системы](#этап-1-выбор-системы)
4. [Этап 2: Покупка клейма](#этап-2-покупка-клейма)
5. [Этап 3: Размещение маяка](#этап-3-размещение-маяка)
6. [Этап 4: Доставка материалов](#этап-4-доставка-материалов)
7. [Этап 5: Становление System Architect](#этап-5-становление-system-architect)
8. [Защита клейма от перехвата](#защита-клейма-от-перехвата)
9. [Технологическое дерево (Tech Tree)](#технологическое-дерево-tech-tree)
10. [Орбитальные объекты: полный справочник](#орбитальные-объекты-полный-справочник)
11. [Поверхностные объекты: полный справочник](#поверхностные-объекты-полный-справочник)
12. [Экономика системы](#экономика-системы)
13. [BGS, фракции и Powerplay](#bgs-фракции-и-powerplay)
14. [Логистика и Fleet Carrier](#логистика-и-fleet-carrier)
15. [Construction Points (CP)](#construction-points-cp)
16. [Доход и награды](#доход-и-награды)
17. [Название объектов](#название-объектов)
18. [Демонтаж и отмена строительства](#демонтаж-и-отмена-строительства)
19. [Расширение: цепочки систем и мини-Bubble](#расширение-цепочки-систем-и-мини-bubble)
20. [Частые ошибки и как их избежать](#частые-ошибки-и-как-их-избежать)
21. [Полезные инструменты и ресурсы](#полезные-инструменты-и-ресурсы)

---

## Введение: что такое колонизация

**System Colonisation** — это механика, позволяющая игрокам заявлять незаселённые звёздные системы и развивать их, строя порты, аванпосты, поселения и другие объекты. Вы становитесь **System Architect** (Системным Архитектором) — бессрочным управляющим развитием своей колонии.

### Ключевые факты (февраль 2026)

- **101,862+ систем** колонизировано по всей галактике
- **307,014 космических** и **175,973 наземных** объектов построено
- Механика вышла из бета-теста **11 ноября 2025 года** (Dodec Update)
- **Trailblazer megaships** были удалены из игры — колонии теперь самодостаточны
- Колонизация — **PvE-контент**: другие игроки **не могут** разрушить вашу колонию
- **Нет ежемесячных расходов** на содержание — развивайте в своём темпе
- Каждая система уникальна: тип звезды, планеты, ресурсы влияют на экономику

### Общая схема процесса

```
Выбор системы → Покупка клейма → Размещение маяка → Доставка материалов → 
→ Постройка первого порта → System Architect → Расширение системы
```

---

## Этап 0: Подготовка

### Минимальные требования

| Параметр | Требование |
|----------|------------|
| Кредиты | Минимум **50–100 млн** (25 млн маяк + 25 млн резерв + стоимость корабля) |
| Корабль | С трюмом **200+ тонн** (Type-9, Cutter, Type-11, Panther Clipper Mk II) |
| FSD | Инженерный апгрейд от Felicity Farseer желателен |
| Fleet Carrier | **Не обязателен**, но делает процесс в 10 раз проще |
| Squadron | Желателен для координации и BGS-контроля |

### Рекомендуемый набор кораблей

1. **Panther Clipper Mk II** — новый король грузоперевозок (до 1238 т, Large)
2. **Type-11 Prospector** — массовые перевозки, SCO-optimized
3. **Corsair** — быстрый средний корабль с хорошим трюмом (318 т, SCO)
4. **Python** — универсал: доставки, SRV, майнинг
5. **Krait Mk II** — боевые миссии и защита
6. **Diamondback Explorer** — разведка и поиск систем

---

## Этап 1: Выбор системы

### Критерии выбора (от важного к менее важному)

### Обязательные условия

1. **Расстояние** — в пределах **15 световых лет** от заселённой системы
2. **Статус** — система должна быть **Unclaimed** (незаявленной)
3. **Доступность** — не permit-locked, не в exclusion zone

### Желательные условия

| Фактор | Почему важно | Идеально |
|--------|-------------|----------|
| **Тип звезды** | K/G-тип стабильны, дают хорошие слоты | K- или G-звезда |
| **Количество планет** | Больше тел = больше орбитальных слотов | 5+ планет/лун |
| **Кольца** | Создают Resource Extraction Sites | Кольца на Rocky body |
| **Ресурсы** | Влияют на базовую экономику | Pristine reserves |
| **Geological signals** | Бонус к Refinery-экономике | Есть на Rocky/HMC |
| **Terraformable** | Бонус к населению и экономике | 1+ планета |

### Типы планет и базовая экономика

| Тип планеты | Базовая экономика | Бонус |
|-------------|-------------------|-------|
| Rocky body | Refinery +1.0 | Pristine = +, Depleted = − |
| High Metal Content (HMC) | Extraction +1.0 | Геология = + |
| Water World | Tourism потенциал | Terraformable = ++ |
| Gas Giant | Много лун = слоты | Кольца = RES |

### Чего избегать

- **Neutron stars / Black holes** — нет планет, нет слотов
- **White dwarfs** — мало слотов, опасны для FSD
- **Системы с 1-2 планетами** — мало возможностей для развития
- **Системы в 14.9 св.лет** — сложно достичь, мало запаса для цепочки

---

## Этап 2: Покупка клейма

### Процесс

1. Прилетите в **любой Star Port** в заселённой системе
2. Откройте **Station Services → Colonization Contact**
3. Выберите незаселённую систему в пределах 15 св.лет
4. Выберите тип **Primary Starport**

### Типы портов

| Тип порта | Стоимость клейма | Особенности |
|-----------|-----------------|-------------|
| **Outpost** | Дешевле | Только Medium площадки, меньше грузов |
| **Coriolis** | Средне | Классика, Large площадки, Colony-экономика |
| **Ocellus** | Дороже | Tier 3, высокие статы |
| **Orbis** | Дороже | Tier 3, аналог Ocellus |
| **Dodec** | Самый дорогой | Tier 3, максимальные статы, уникальный дизайн |

### Важно

- Клейм действует **24 часа** — за это время нужно разместить маяк
- Если пропустили дедлайн — **3 дня блокировки** перед новой попыткой
- Нельзя иметь несколько активных клеймов одновременно
- После завершения первого порта можно заявлять следующую систему

---

## Этап 3: Размещение маяка

### Что нужно сделать

1. Полетите в заявленную систему
2. Откройте **System Colonization Suite** (модуль по умолчанию на всех кораблях)
3. Разверните **Colonization Beacon** в предустановленной точке
4. Маяк стоит **25 млн кредитов**

### Что происходит дальше

- Система помечается как **Claimed** (заявленная)
- Запускается обратный отсчёт **24 часа**
- Прибывает гигантский **Colonization Ship** — временная база с 32 площадками
- Вы становитесь **System Architect** (после завершения первого порта)

### Если не успели за 24 часа

- Клейм **аннулируется**
- **3 дня** нельзя подавать новые заявки
- Потраченные кредиты **не возвращаются**

---

## Этап 4: Доставка материалов

### Цель

Доставить все необходимые **commodities** на Colonization Ship за **4 недели**.

### Типы материалов

| Категория | Примеры | Источник |
|-----------|---------|----------|
| **Руды (Minerals)** | Bauxite, Gallite, Indite, Coltan | Mining / Покупка |
| **Товары (Commodities)** | Food Cartridges, Insulating Membrane, CMM Composite | Рынки Bubble |
| **Материалы (Materials)** | Iron, Nickel, Carbon, Sulphur | SRV surface mining |
| **Топливо** | Tritium для FC | Рынки / Mining |

### Ключевые советы по доставке

- **Fleet Carrier = must have** для серьёзных проектов: 25,000 т груза + прыжки 500 св.лет
- **Panther Clipper Mk II** — новый лучший корабль для массовых перевозок (1238 т)
- **Type-11 Prospector** — SCO-optimized, хорошая альтернатива
- **Создавайте цепочки** систем каждые 15 св.лет для дальних колоний
- Некоторые товары (**Insulating Membrane**) доступны **только** на орбитальных рынках
- **CMM Composite** производится на планетах с Refinery-экономикой

### Что происходит после доставки

- Порт появляется в виде **строящейся станции** с лесами
- После **еженедельного тика** (четверг, 07:00 UTC) порт достраивается
- Маяк превращается в **Nav Beacon**
- Система становится заселённой

---

## Этап 5: Становление System Architect

### Ваши полномочия

- **Размещение** новых объектов (орбитальных и поверхностных)
- **Управление** экономикой, населением, безопасностью
- **Назначение** названий объектов (платно через Arx)
- **Демонтаж** ошибочно размещённых объектов

### Ограничения

- Нужно дождаться **первого еженедельного тика** после постройки порта
- Количество **одновременных строек** ограничено (смотрите в Architect View)
- Поверхностные объекты могут появляться с **задержкой до 48 часов**
- **Ground Ports (Planetary Port)** не работают с экономическими влияниями — используйте Orbital Ports

### Architect Mode

- Открывается через **System Map**
- Показывает доступные **орбитальные слоты** (иконки с «+»)
- Показывает **поверхностные слоты** на каждой планете
- Флаг на орбитальном слоте = место для **Primary Port**

---

## Защита клейма от перехвата

### Механика «Claim Sniping Protection»

После завершения первого порта в новой системе действует **эксклюзивная блокировка** на подачу клеймов ИЗ этой системы:

| Фаза | Длительность | Кто может заявлять |
|------|-------------|-------------------|
| **Phase 1** | 30 минут | Только System Architect |
| **Phase 2** | 23.5 часа | Члены Squadron Architect'а |
| **Phase 3** | После 24 часов | Любой игрок |

### Важно

- Если Architect **не в Squadron** — действует только 30-минутная блокировка
- Блокировка отображается в панели клейма с таймером
- Это позволяет строить **цепочки систем** без опасения, что кто-то «перехватит» ваш маршрут
- Даже одиночный игрок в своём собственном Squadron получает полные 24 часа защиты

---

## Технологическое дерево (Tech Tree)

### Принцип работы

- Каждый объект даёт **Construction Points (CP)**
- **Tier 1** объекты открываются сразу (нужен только First Station)
- **Tier 2** требуют определённых Tier 1 объектов
- **Tier 3** требуют Tier 2 + достаточного количества CP

### Пример цепочки

```
First Station → Scientific Outpost → Research Station → Ocellus Starport
                    ↓
             Mining Outpost → Asteroid Base
```

### Поверхностная ветка

```
First Station → Planetary Outposts → Settlements → Hubs → Planetary Port
```

---

## Орбитальные объекты: полный справочник

### Starports (Tier 2-3)

| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | Pop+ | MaxPop+ |
|--------|------|-----------|----------|------|--------|-----|-----|------|---------|
| **Coriolis** | 2 | Colony | -2 | 1 | 2 | 3 | 2 | 1 | 0 |
| **Asteroid Base** | 2 | Extraction | -1 | 3 | 5 | -4 | 7 | 1 | 0 |
| **Ocellus** | 3 | Colony | -3 | 6 | 7 | 5 | 8 | 5 | 1 |
| **Orbis** | 3 | Colony | -3 | 6 | 7 | 5 | 8 | 5 | 1 |
| **Dodec** | 3 | Colony | -4 | 8 | 9 | 7 | 10 | 8 | 4 |

### Outposts (Tier 1)

| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | Pop+ | CP Reward |
|--------|------|-----------|----------|------|--------|-----|-----|------|-----------|
| **Commercial Outpost** | 1 | Colony | -1 | — | 2 | 5 | — | 0 | Tier 2: 1 |
| **Industrial Outpost** | 1 | Industrial | — | 3 | — | — | 2 | 0 | Tier 2: 1 |
| **Criminal Outpost** | 1 | Colony | -2 | — | 2 | — | — | 0 | Tier 2: 1 |
| **Civilian Outpost** | 1 | Colony | -1 | — | 1 | 1 | 1 | 0 | Tier 2: 1 |
| **Scientific Outpost** | 1 | Hightech | — | 3 | — | — | — | 1 | Tier 2: 1 |
| **Military Outpost** | 1 | Military | 2 | — | — | — | — | 1 | Tier 2: 1 |

### Installations (Tier 1-2)

| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | CP Cost | CP Reward |
|--------|------|-----------|----------|------|--------|-----|-----|---------|-----------|
| **Satellite** | 1 | — | — | — | 1 | 1 | 1 | — | Tier 2: 1 |
| **Communication Station** | 1 | — | — | 1 | 3 | — | — | — | Tier 2: 1 |
| **Space Farm** | 1 | Agricultural | — | — | — | 5 | 1 | — | Tier 2: 1 |
| **Pirate Base** | 1 | Contraband | -4 | — | 3 | — | — | — | Tier 2: 1 |
| **Mining Outpost** | 1 | Extraction | — | — | 3 | -2 | — | — | Tier 2: 1 |
| **Relay Station** | 1 | Hightech | 1 | — | — | — | 1 | — | Tier 2: 1 |
| **Military Installation** | 2 | Military | 6 | — | — | — | — | Tier 2: 1 | Tier 3: 1 |

---

## Поверхностные объекты: полный справочник

### Planetary Outposts (Tier 1)

| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | Pop+ | CP Reward |
|--------|------|-----------|----------|------|--------|-----|-----|------|-----------|
| **Civilian Planetary Outpost** | 1 | Colony | -2 | — | — | 3 | — | 2 | Tier 2: 1 |
| **Industrial Planetary Outpost** | 1 | Industrial | -1 | — | 2 | — | — | 1 | Tier 2: 1 |
| **Scientific Planetary Outpost** | 1 | Hightech | -1 | 5 | — | — | 1 | 1 | Tier 2: 1 |

### Planetary Port (Tier 3)

| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | Pop+ | MaxPop+ | CP Cost |
|--------|------|-----------|----------|------|--------|-----|-----|------|---------|---------|
| **Planetary Port** | 3 | Colony | -3 | 5 | 5 | 6 | 10 | 10 | 10 | Tier 3: 6 |

**Важно:** Planetary Port не получает экономических бонусов от других объектов. Используйте Orbital Ports для торговли.

### Settlements (Tier 1-2)

| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | CP Cost | CP Reward |
|--------|------|-----------|----------|------|--------|-----|-----|---------|-----------|
| **Small Agricultural Settlement** | 1 | Agricultural | — | — | — | 3 | — | — | Tier 2: 1 |
| **Medium Agricultural Settlement** | 1 | Agricultural | — | — | — | 6 | — | — | Tier 2: 1 |
| **Large Agricultural Settlement** | 2 | Agricultural | — | — | — | 10 | — | Tier 2: 1 | Tier 3: 2 |
| **Small Extraction Settlement** | 1 | Extraction | — | — | 2 | — | — | — | Tier 2: 1 |
| **Medium Extraction Settlement** | 1 | Extraction | — | — | 5 | — | — | — | Tier 2: 1 |
| **Large Extraction Settlement** | 2 | Extraction | — | 1 | 7 | -2 | — | Tier 2: 1 | Tier 3: 2 |
| **Small Industrial Settlement** | 1 | Industrial | — | — | — | — | 2 | — | Tier 2: 1 |
| **Medium Industrial Settlement** | 1 | Industrial | — | — | — | — | 5 | — | Tier 2: 1 |
| **Large Industrial Settlement** | 2 | Industrial | — | — | 2 | — | 8 | Tier 2: 1 | Tier 3: 2 |
| **Small Military Settlement** | 1 | Military | 2 | — | — | — | — | — | Tier 2: 1 |
| **Medium Military Settlement** | 1 | Military | 4 | — | — | — | — | — | Tier 2: 1 |
| **Large Military Settlement** | 2 | Military | 6 | — | — | — | 2 | Tier 2: 1 | Tier 3: 2 |
| **Small Scientific Settlement** | 2 | Hightech | — | 3 | — | — | 1 | Tier 2: 1 | Tier 3: 1 |
| **Medium Scientific Settlement** | 2 | Hightech | — | 6 | — | — | 1 | Tier 2: 1 | Tier 3: 1 |
| **Large Scientific Settlement** | 2 | Hightech | — | 10 | — | — | 2 | Tier 2: 1 | Tier 3: 2 |
| **Small Tourism Settlement** | 2 | Tourism | -1 | — | 1 | — | — | Tier 2: 1 | Tier 3: 1 |
| **Medium Tourism Settlement** | 2 | Tourism | -1 | — | 2 | — | — | Tier 2: 1 | Tier 3: 1 |
| **Large Tourism Settlement** | 2 | Tourism | -1 | — | 5 | — | — | Tier 2: 1 | Tier 3: 2 |

### Hubs (Tier 2)

| Объект | Требует | Экономика | Security | Tech | Wealth | SoL | Dev | CP Cost | CP Reward |
|--------|---------|-----------|----------|------|--------|-----|-----|---------|-----------|
| **Extraction Hub** | Small/Medium/Large Mining Settlement | Extraction | — | — | 10 | -4 | 2 | Tier 2: 1 | Tier 3: 1 |
| **Civilian Hub** | Small/Medium/Large Agricultural Settlement | — | -3 | — | — | 3 | 2 | Tier 2: 1 | Tier 3: 1 |
| **Exploration Hub** | Communication Station | Tourism | -1 | 6 | — | — | 2 | Tier 2: 1 | Tier 3: 1 |
| **Outpost Hub** | Space Farm | — | -2 | — | — | 3 | 2 | Tier 2: 1 | Tier 3: 1 |
| **Scientific Hub** | First Station | Hightech | — | 10 | — | — | — | Tier 2: 1 | Tier 3: 1 |
| **Military Hub** | Military Installation | Military | 10 | — | — | — | — | Tier 2: 1 | Tier 3: 1 |
| **Refinery Hub** | First Station | Refinery | -1 | 3 | 5 | -2 | 7 | Tier 2: 1 | Tier 3: 1 |
| **High Tech Hub** | First Station | Hightech | -2 | 10 | -2 | — | — | Tier 2: 1 | Tier 3: 1 |
| **Industrial Hub** | Mining Outpost | Industrial | — | 3 | 5 | -4 | 2 | Tier 2: 1 | Tier 3: 1 |

---

## Экономика системы

### Как работает экономика

Каждый объект влияет на **6 параметров** системы:

| Параметр | Описание | Что влияет |
|----------|----------|------------|
| **Security** | Уровень безопасности | Высокий = меньше пиратов, налоги |
| **Tech Level** | Технологический уровень | Доступность модулей и кораблей |
| **Wealth** | Богатство | Цены на товары, миссии |
| **Standard of Living** | Уровень жизни | Пассажирские миссии, tourism |
| **Development Level** | Уровень развития | Рост населения, BGS |
| **Population** | Население | Количество миссий, размер рынка |

### Базовая экономика планет

| Тип тела | Базовая экономика | Бонус |
|----------|-------------------|-------|
| Rocky body | Refinery +1.0 | Pristine/Major reserves = + |
| High Metal Content | Extraction +1.0 | Геология = + |
| Water World | Tourism потенциал | Terraformable = ++ |
| Icy body | — | — |
| Gas Giant | — | Кольца = RES |

### CMM Composite

Для производства **CMM Composite** нужна **Refinery-экономика** в топ-2:

1. **Rocky body** + Planetary Port (Civilian) + Refinery Hub
2. **High Metal Content** + Planetary Port (Civilian) + Refinery Hub

Если на планете есть geological/biological signals — может потребоваться больше Refinery Hub'ов.

### Расположение объектов

- Объекты **ближе к планете** сильнее влияют на экономику
- Объекты **дальше от Starport** имеют **слабое рыночное соединение**
- Экономика объекта влияет на рынки портов на **том же теле**

---

## BGS, фракции и Powerplay

### Фракции

- **Фракция, у которой куплен клейм**, становится доминирующей в системе
- Существующие BGS-фракции могут расширяться в вашу систему
- Player Minor Factions можно привезти через прокси
- Супердержавы расширяют влияние через фракции-прокси

### Government Type

| Тип | Эффект |
|-----|--------|
| **Anarchy** | Сниженная безопасность, легальны все товары |
| **Corporate** | Баланс между порядком и свободой |
| **Democracy** | Высокий SoL, средняя безопасность |
| **Dictatorship** | Высокая безопасность, низкий SoL |
| **Theocracy** | Специфические ограничения на товары |

### Powerplay

- После постройки первого порта система **НЕ контролируется Power**
- Фракция переносится из исходной системы
- Для Powerplay-контроля нужно отдельное влияние

---

## Логистика и Fleet Carrier

### Fleet Carrier — must have?

| Без FC | С FC |
|--------|------|
| Множество рейсов в Bubble | Один рейс = 25,000 т |
| Зависимость от рынков | Собственный рынок |
| Ограниченная дальность | Прыжки 500 св.лет |
| Высокие временные затраты | Автономность месяцами |

### Топливо для FC

- **Tritium** — покупается на рынках или добывается
- Расход: ~1 тонна на прыжок
- Всегда держите запас на 2 прыжка + 500 тонн

### Lynx Highliner

- Новый пассажирский лайнер (Zorgon Peterson)
- Отличен для пассажирских миссий в/из вашей колонии
- Business-class каюты = высокий доход

---

## Construction Points (CP)

### Как получить

| Источник | CP | Условие |
|----------|-----|---------|
| Tier 1 объект | — | Даёт CP для Tier 2 |
| Tier 2 объект | Тратит CP | Даёт CP для Tier 3 |
| Tier 3 объект | Тратит CP | Максимальный уровень |

### Пример прогрессии

```
First Station (бесплатно)
    ↓
Scientific Outpost → даёт 1 CP (Tier 2)
    ↓
Research Station → тратит 3 CP (Tier 2 cost)
    ↓
Ocellus Starport → тратит 6 CP (Tier 3 cost)
```

### Ускорение CP

- **Boom state** — +25% к генерации
- **Player activity** — миссии в системе ускоряют рост
- **Powerplay** — некоторые Power дают бонусы

---

## Доход и награды

### Пассивный доход

- **Торговля** — ваши порты генерируют товары
- **Миссии** — чем выше население, тем больше миссий
- **Tourist** — Tourism-экономика = высокооплачиваемые пассажирские миссии
- **Mining** — Extraction/Refinery = ресурсы для продажи

### Активный доход

- **Доставка товаров** в вашу систему = высокие цены
- **Stackable massacre missions** — если Military-экономика
- **Passenger missions** — если Tourism/High SoL

### Нет upkeep costs!

В отличие от Fleet Carrier, колонии **не требуют** еженедельных платежей. Развивайте в своём темпе.

---

## Название объектов

### Процесс

1. Откройте **System Map → Architect View**
2. Выберите объект
3. Нажмите **Rename**
4. Стоимость: **Arx** (внутриигровая премиум-валюта)

### Правила

- Модерация Frontier — оскорбления и товарные знаки запрещены
- Единый стиль важен для иммерсии
- Названия остаются **навсегда**

---

## Демонтаж и отмена строительства

### Как снести объект

1. Откройте **Galaxy Map**
2. Найдите систему с объектом
3. Откройте **System Map → Architect View**
4. Выберите объект
5. Нажмите **Demolish** внизу списка commodities
6. Подтвердите

### Что происходит

- Демонтаж завершается после **серверного тика**
- Таймер отображается в UI
- **Возвращается только часть ресурсов**
- Если объект строился — строительство отменяется

### Важно

- Демонтаж **Primary Port** невозможен
- Некоторые объекты нельзя снести, если они требуются для других
- Планируйте заранее — демонтаж дорогой

---

## Расширение: цепочки систем и мини-Bubble

### Цепочки (Highways)

- Каждая новая система должна быть в **15 св.лет** от существующей
- Создавайте «ступеньки» каждые 10–15 св.лет
- Используйте **Neutron Highway** для ускорения

### Мини-Bubble

- Группа систем в радиусе 30–50 св.лет
- Общая логистика через Fleet Carrier
- Специализация: одна система — добыча, другая — производство, третья — торговля

### Omega Nebula

- Популярное направление для колонизации
- **40+ ringed water worlds** по маршруту
- **31 чёрная дыра** и **57 нейтронных звёзд** в радиусе 50 св.лет
- Достигнута сообществом **6 января 2026**

---

## Частые ошибки и как их избежать

| Ошибка | Последствие | Решение |
|--------|-------------|---------|
| **Пропустили 24 часа на маяк** | Потеря 25 млн + 3 дня блокировки | Ставьте таймер, не откладывайте |
| **Построили Ground Port для торговли** | Нет экономических бонусов | Используйте Orbital Ports |
| **Неправильное расположение** | Слабое влияние на экономику | Объекты ближе к планете = сильнее |
| **Забыли про CP** | Нельзя строить Tier 3 | Планируйте Tech Tree заранее |
| **Нет резерва Tritium** | FC застрял в пустоте | Всегда 2 прыжка + 500 тонн |
| **Соло в дальней системе** | Сложно доставлять материалы | Squadron или FC-логистика |

---

## Полезные инструменты и ресурсы

### Внеигровые инструменты

| Инструмент | Ссылка | Описание |
|------------|--------|----------|
| **ED Colonisation Planner** | [edcolonisationplanner.com](https://edcolonisationplanner.com) | Автоматический планировщик: загрузите журнал, выберите цель — он рассчитает порядок строительства |
| **DaftMav Spreadsheet** | [Google Sheets](https://docs.google.com) | Таблица со всеми объектами, CP, экономикой |
| **Raven Colonial Corp** | [raven-colonial.org](https://raven-colonial.org) | Планирование колоний, экономика, логистика |
| **Inara** | [inara.cz](https://inara.cz) | Поиск товаров, commodities, инженеры |
| **Spansh** | [spansh.co.uk](https://spansh.co.uk) | Neutron Highway, маршруты |

### Сообщества

- **Frontier Forums** — [forums.frontier.co.uk/forums/system-colonisation](https://forums.frontier.co.uk/forums/system-colonisation/)
- **Reddit** — r/EliteDangerous, r/EliteColonization
- **Discord** — серверы Squadron и проектов

---

## Оценка

Колонизация — это **конечная цель** для многих пилотов Elite Dangerous. Это не даёт прямого преимущества в PvP или PvE, но предоставляет **беспрецедентный уровень креативного контроля** над игровой вселенной. Ваша система останется в галактике **навсегда** — это ваш перманентный след в истории Elite Dangerous.$c$;

  -- ============================================================
  -- 1. ОБНОВЛЕНИЕ: Гайд по колонизации (версия 2.0)
  -- ============================================================
  UPDATE public.wiki_articles
     SET content        = v_guide_content,
         last_editor_id = v_author_id,
         version        = 2,
         updated_at     = NOW()
   WHERE slug = 'polnyy-gayd-po-kolonizacii-v-elite-dangerous';

  IF FOUND THEN
    -- Ревизия №2 — как в исходной миграции; повторный накат её не дублирует.
    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    SELECT a.id, a.content, v_author_id, 2, 'Updated for February 2026: added claim sniping protection, Dodec stats, new ships (Panther Clipper, Corsair), ground port warnings, demolition info, updated statistics', NOW()
      FROM public.wiki_articles a
     WHERE a.slug = 'polnyy-gayd-po-kolonizacii-v-elite-dangerous'
       AND NOT EXISTS (
             SELECT 1 FROM public.wiki_revisions r
              WHERE r.article_id = a.id AND r.revision_number = 2
           );
  ELSE
    -- Чистая установка: гайд создаётся сразу в версии 2.0.
    INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
    VALUES (
      'Полный гайд по колонизации в Elite Dangerous',
      'polnyy-gayd-po-kolonizacii-v-elite-dangerous',
      v_guide_content,
      v_cat_colonization, v_author_id, v_author_id, 'published', true, 0, 2, NOW(), NOW()
    )
    RETURNING id INTO v_article_id;

    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed', NOW());
  END IF;

  -- ============================================================
  -- 2. НОВАЯ СТАТЬЯ: Выбор системы для колонизации
  -- ============================================================
  INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
  VALUES (
    'Выбор системы для колонизации',
    'vybor-sistemy-dlya-kolonizacii',
    $c$# Выбор системы для колонизации

**Тип:** Колонизация / Гайд
**Сложность:** Начальный–Средний
**Время чтения:** 10 минут

## Описание

Выбор правильной системы — это 50% успеха колонизации. Плохой выбор = ограниченное развитие, сложная логистика, разочарование. Этот гайд научит находить идеальные системы за 15 минут сканирования.

## Чек-лист идеальной системы

### Обязательно (без этого не начинайте)

| Критерий | Почему важно | Минимум |
|----------|-------------|---------|
| **Unclaimed статус** | Иначе нельзя заявить | Да |
| **В пределах 15 св.лет от inhabited** | Требование механики | ≤ 15 св.лет |
| **Не permit-locked** | Иначе доступ закрыт | Да |
| **Есть планеты** | Нужны слоты для объектов | 3+ тела |

### Желательно (влияет на потенциал)

| Критерий | Идеально | Хорошо | Плохо |
|----------|----------|--------|-------|
| **Тип звезды** | K, G | F, M | Neutron, WD, BH |
| **Планеты** | 8+ | 5–7 | 1–2 |
| **Rocky bodies** | 2+ с кольцами | 1 с кольцами | 0 |
| **HMC планеты** | 2+ с геологией | 1 с геологией | 0 |
| **Water Worlds** | 1 terraformable | 1 обычный | 0 |
| **Резервы** | Pristine | Major | Low/Depleted |

### Бонусы (делают систему уникальной)

- **Кольца на Rocky body** → Resource Extraction Sites
- **Terraformable Water World** → Tourism + Population
- **Geological signals** → Refinery бонус
- **Biological signals** → Exploration / Tourism
- **Близость к Neutron star** → Быстрые путешествия

## Пошаговый поиск

### Шаг 1: Найти anchor-систему

1. Откройте **Galaxy Map**
2. Включите фильтр **«Inhabited Systems»**
3. Найдите систему на **границе Bubble** или вашей мини-Bubble
4. Запомните координаты

### Шаг 2: Поиск в радиусе 15 св.лет

1. Переключитесь на **«Unclaimed Systems»**
2. Ищите в радиусе 15 св.лет от anchor
3. Сканируйте каждую кандидатку FSS

### Шаг 3: Быстрая оценка (FSS)

| Что смотреть | За сколько секунд | Что значит |
|--------------|-------------------|------------|
| Тип звезды | 2 сек | K/G = хорошо, иначе skip |
| Количество тел | 5 сек | 5+ = продолжаем, 3-4 = возможно, 1-2 = skip |
| Кольца | 10 сек | Есть = отлично |
| Terraformable | 15 сек | Есть = бонус |

### Шаг 4: Детальное сканирование (если прошла отбор)

1. Прилетите в систему
2. Отсканируйте **Discovery Scanner**
3. Откройте **System Map** и изучите каждое тело
4. Проверьте **Planetary Information**:
   - Composition (для ресурсов)
   - Signals (геология/биология)
   - Terraformable status

### Шаг 5: Проверка слотов

1. Откройте **Galaxy Map → System Colonisation view**
2. Выберите систему
3. Посмотрите **иконки слотов**:
   - **+** = доступный слот
   - **Флаг** = слот для Primary Port
   - Чем больше слотов — тем лучше

## Типы систем по назначению

### Тип A: Промышленная

**Цель:** Производство CMM Composite, Refinery, Industrial

**Идеальные условия:**
- Rocky body с Pristine reserves
- Geological signals
- 2+ HMC планеты
- Много слотов

**Что строить:**
- Refinery Hub
- Industrial Settlement (Large)
- Mining Outpost
- Planetary Port на Rocky body

### Тип B: Туристическая

**Цель:** Высокий доход от пассажиров

**Идеальные условия:**
- Terraformable Water World
- Красивые виды (туманности, кольца)
- Высокий SoL потенциал

**Что строить:**
- Tourism Settlement (Large)
- Exploration Hub
- Luxury Starport (Ocellus/Dodec)
- Communication Station

### Тип C: Военная

**Цель:** Stackable massacre missions, высокая безопасность

**Идеальные условия:**
- Близость к Conflict Zones
- Возможность Military-экономики

**Что строить:**
- Military Settlement (Large)
- Military Hub
- Military Outpost
- Starport с высоким Security

### Тип D: Исследовательская

**Цель:** High Tech, продажа данных, Universal Cartographics

**Идеальные условия:**
- Необычная звезда (Wolf-Rayet, T Tauri)
- Интересные планеты
- Далеко от Bubble (для продажи данных)

**Что строить:**
- Scientific Settlement (Large)
- Scientific Hub
- Research Station
- High Tech Hub

## Красные флаги (пропускайте)

| Проблема | Почему плохо |
|----------|-------------|
| **Только 1-2 планеты** | Мало слотов, нет развития |
| **Нет Rocky/HMC** | Нет добычи, нет Refinery |
| **White Dwarf primary** | Опасно, мало слотов |
| **14.9 св.лет от inhabited** | Сложно достичь, нет запаса |
| **Permit-locked** | Просто нельзя |
| **Уже Claimed** | Кто-то успел раньше |

## Инструменты для поиска

| Инструмент | Как использовать |
|------------|-----------------|
| **EDSM** | Поиск систем по параметрам |
| **Spansh** | Маршруты, neutron highway |
| **Inara** | Проверка статуса системы |
| **ED Colonisation Planner** | Загрузите скан — получите рекомендации |

## Оценка

Идеальная система — это баланс между логистикой (близость к Bubble), потенциалом (планеты, ресурсы) и вашими целями. Не гонитесь за «идеалом» — хорошая система в 5 св.лет лучше идеальной в 14.9. Помните: вы можете иметь **неограниченное количество** колоний, так что первую можно использовать для обучения.$c$,
    v_cat_colonization, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO v_article_id;

  IF v_article_id IS NOT NULL THEN
    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed', NOW());
  END IF;

  -- ============================================================
  -- 3. НОВАЯ СТАТЬЯ: Экономика колонии и BGS
  -- ============================================================
  INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
  VALUES (
    'Экономика колонии и BGS',
    'ekonomiya-kolonii-i-bgs',
    $c$# Экономика колонии и BGS

**Тип:** Колонизация / Механика
**Сложность:** Средний–Высокий
**Время чтения:** 12 минут

## Описание

Экономика колонии — это не просто цифры. Это живой организм, который определяет, какие товары продаются на ваших рынках, какие миссии доступны пилотам и как быстро растёт ваше население. Понимание BGS (Background Simulation) позволяет создавать системы, которые приносят **пассивный доход** и служат якорем для сообщества.

## Шесть столпов экономики

Каждый объект влияет на 6 параметров:

| Параметр | Что делает | Как повысить |
|----------|-----------|--------------|
| **Security** | Уровень безопасности | Military объекты, Starports |
| **Tech Level** | Технологический уровень | Scientific/High Tech объекты |
| **Wealth** | Богатство | Commercial, Tourism, Refinery |
| **Standard of Living (SoL)** | Пассажирские миссии, tourism | Agricultural, Civilian объекты |
| **Development Level** | Уровень развития | Рост населения, BGS |
| **Population** | Население | Starports, Planetary Port |

## Как работает влияние объектов

### Принцип близости

- Объекты **ближе к планете** = **сильнее влияние**
- Объекты **дальше от Starport** = **слабое рыночное соединение**
- Экономика объекта влияет на рынки портов **на том же теле**

### Пример

```
Планета A (Rocky body, Pristine)
├── Orbital: Coriolis Starport (Slot 0) ← РЫНОК
├── Orbital: Mining Outpost (Slot 1)    ← Влияет на Coriolis
├── Orbital: Refinery Hub (Slot 2)      ← Влияет слабее
└── Surface: Large Extraction Settlement  ← Влияет на Coriolis

Планета B (Water World)
├── Orbital: Ocellus Starport (Slot 0)  ← Свой рынок
└── Orbital: Tourism Settlement           ← Влияет на Ocellus
```

## Создание CMM Composite

CMM Composite — **ключевой товар** для колонизации. Без него сложно строить Tier 2-3 объекты.

### Способ 1: Rocky body + Refinery

1. Найдите **Rocky body** с **Pristine reserves**
2. Постройте **Planetary Port (Civilian)** или **Planetary Outpost (Civilian)**
3. Добавьте **Refinery Hub** на поверхности
4. Убедитесь, что Refinery в **топ-2 экономик** системы

### Способ 2: HMC + Refinery

1. Найдите **High Metal Content** body
2. Постройте **Planetary Port (Civilian)**
3. Добавьте **Refinery Hub**
4. Если есть geological signals — может потребоваться **2+ Refinery Hub**

### Проверка

- Откройте рынок на Starport
- Посмотрите **Commodities → CMM Composite**
- Если есть в продаже — Refinery работает
- Если нет — добавьте ещё Refinery-объектов

## Government Type и рынок

| Government | Эффект на рынок | Особенности |
|------------|----------------|-------------|
| **Anarchy** | Все товары легальны | Низкая безопасность, пиратство |
| **Corporate** | Баланс | Средние цены, стабильность |
| **Democracy** | Высокий SoL | Больше пассажирских миссий |
| **Dictatorship** | Высокая безопасность | Низкий SoL, строгий контроль |
| **Theocracy** | Ограничения на товары | Некоторые товары illegal |

**Важно:** Если government type считает товар **illegal** — он **не появится** на рынке, даже если экономика подходит.

## BGS-циклы и состояния

### Как работает BGS в колониях

1. Каждая система имеет **фракцию-владельца** (та, у которой куплен клейм)
2. Фракция может находиться в разных **состояниях (states)**
3. Состояния меняются каждый **tick** (ежедневно)

### Полезные состояния

| State | Эффект | Как вызвать |
|-------|--------|-------------|
| **Boom** | +25% доход, быстрый рост | Торговля, миссии на доход |
| **Expansion** | Расширение в соседние системы | Высокое влияние, население |
| **Investment** | Бонусы к строительству | Продажа товаров, доходы |
| **Civil Liberty** | Высокий SoL | Миссии на безопасность |

### Вредные состояния

| State | Эффект | Как избежать |
|-------|--------|--------------|
| **Bust** | -25% доход, замедление | Не допускайте дефицита товаров |
| **Civil Unrest** | Низкая безопасность | Поддерживайте Security |
| **Famine** | Нет еды, кризис | Стройте Agricultural объекты |
| **Outbreak** | Медицинский кризис | Стройте медицинские объекты |

## Манипуляция BGS

### Для одиночек

1. Выполняйте **миссии** для вашей фракции
2. **Продавайте товары** на рынках вашей системы
3. **Сканируйте** данные и продавайте их
4. Участвуйте в **Conflict Zones** (если Military)

### Для Squadron

1. **Координируйте миссии** — 10 пилотов = 10x эффект
2. **Организуйте торговые рейсы** — массовые продажи товаров
3. **Stackable massacre missions** — Military-экономика + CZ
4. **Bounty hunting** — повышает Security

### Типичная BGS-рутина (30 минут)

```
1. Взять 3 миссии на доставку для вашей фракции
2. Купить товары и доставить
3. Взять 2 миссии на bounty hunting
4. Полететь в RES, заработать 500k+ bounties
5. Сдать миссии и bounties
6. Повторить на следующей системе
```

## Экономические стратегии

### Стратегия 1: Торговый хаб

**Цель:** Максимальный Wealth + Population

**Объекты:**
- Coriolis / Ocellus (Commercial focus)
- Commercial Outpost
- Space Farm
- Civilian Hub

**Результат:** Высокие цены, много миссий, пассивный доход

### Стратегия 2: Промышленный комплекс

**Цель:** CMM Composite + Industrial товары

**Объекты:**
- Asteroid Base (Extraction)
- Industrial Settlement (Large)
- Refinery Hub
- Mining Outpost

**Результат:** Производство ключевых товаров, экспорт в Bubble

### Стратегия 3: Военная база

**Цель:** Stackable massacre missions

**Объекты:**
- Military Settlement (Large)
- Military Hub
- Military Outpost
- Starport с высоким Security

**Результат:** 50–100 млн/час на massacre missions

### Стратегия 4: Научный центр

**Цель:** High Tech + продажа данных

**Объекты:**
- Scientific Settlement (Large)
- Scientific Hub
- Research Station
- Communication Station

**Результат:** Доступ к G5 модулям, высокие цены на данные

## Частые вопросы

### Q: Почему на моём рынке нет товаров?

A: Проверьте:
1. Прошёл ли **первый тик** после постройки?
2. Правильная ли **экономика** (Refinery для CMM)?
3. Не считает ли **government** товар illegal?
4. Достаточно ли **населения**?

### Q: Как быстрее растить население?

A:
1. Стройте объекты с **Population Increase** (Starports, Planetary Port)
2. Поддерживайте **Boom** state
3. Стройте **Agricultural** объекты (SoL → рост населения)
4. Ждите — рост пассивный, но ускоряется активностью

### Q: Можно ли изменить government type?

A: Напрямую — нет. Но можно привезти **Player Minor Faction** с нужным government type и вырастить её влияние до 75%+.

### Q: Что делать, если фракция уходит в Bust?

A:
1. Массово продавайте товары на рынок
2. Выполняйте миссии на доход
3. Избегайте миссий, которые забирают товары из системы
4. Подождите 3–7 дней — BGS самокорректируется

## Оценка

BGS — это «тёмная материя» Elite Dangerous. Она невидима, но определяет всё. Понимание экономики колонии позволяет превратить пустую систему в **процветающий торговый хаб** или **неприступную военную крепость**. Не игнорируйте BGS — это разница между «построил и забыл» и «построил и процветаю».$c$,
    v_cat_colonization, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO v_article_id;

  IF v_article_id IS NOT NULL THEN
    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed', NOW());
  END IF;

END
$seed$;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260903020000_wiki_lore_articles.sql               │
-- └────────────────────────────────────────────────────────────────┘

-- ============================================================
-- ED Ring Colony Wiki — Seed: 5 статей лора
-- (История человечества, CMDR, Colonia, Generation Ships, Raxxla)
--
-- ⚠ Файл восстановлен 2026-09-25. Прежняя версия лежала одной строкой без
--   переводов строк: первый комментарий съедал весь остаток файла вместе с
--   блоком DO, поэтому миграция не выполняла ни одной команды и пяти статей
--   лора в базе не было (psql считает пустой скрипт успешным).
--
--   Что сохранено и что исправлено:
--     • тексты статей не менялись, маркеры $nl$ развёрнуты в реальные переводы
--       строк;
--     • повторный накат безопасен: статьи не дублируются (ON CONFLICT (slug)),
--       ревизия пишется только для действительно вставленной статьи;
--     • категория «Лор» и автор ищутся по базе — как в
--       20260903000000_wiki_fill_empty_categories.sql.
-- ============================================================

DO $seed$
DECLARE
  v_admin_id   UUID := 'd0680fc1-5fa0-4a54-b9bd-6918f88de63a';
  v_author_id  UUID;
  v_cat_lore   UUID;
  v_article_id UUID;
BEGIN
  -- ============================================================
  -- 0. Категория «Лор» и автор статей
  -- ============================================================
  SELECT id INTO v_cat_lore FROM public.wiki_categories
   WHERE id = 'ceb24c42-7d36-483c-880b-e0e08d5c4d99';
  IF v_cat_lore IS NULL THEN
    SELECT id INTO v_cat_lore FROM public.wiki_categories WHERE slug = 'lore';
  END IF;
  IF v_cat_lore IS NULL THEN
    INSERT INTO public.wiki_categories (name, slug, description, sort_order)
    VALUES ('Лор', 'lore', 'История и лор вселенной', 5)
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO v_cat_lore;
  END IF;

  SELECT COALESCE(
           (SELECT id FROM auth.users WHERE id = v_admin_id),
           (SELECT id FROM public.profiles
             WHERE role IN ('admin', 'moderator')
             ORDER BY created_at LIMIT 1)
         ) INTO v_author_id;
  IF v_author_id IS NULL THEN
    RAISE NOTICE 'wiki_lore_articles: нет пользователя-автора (admin/moderator) — сид пропущен';
    RETURN;
  END IF;

  -- ============================================================
  -- 1. История человечества: хронология 2090–3308+
  -- ============================================================
  INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
  VALUES (
    'История человечества: хронология от 2090 до 3308+',
    'istoriya-chelovechestva-hronologiya',
    $c$# История человечества: хронология от 2090 до 3308+

**Тип:** Лор
**Категория:** История вселенной
**Время чтения:** 20 минут

## XXI век: Первые шаги (2090–2200)

### 2090 — Первые колонии за пределами Солнечной системы

После decades of resource depletion и климатического кризиса человечество обратило взор к звёздам. Первые межзвёздные колонизационные корабли, оснащённые прототипами Frame Shift Drive, отправились к ближайшим системам: Alpha Centauri, Tau Ceti и Barnard's Star. Эти миссии были односторонними — колонисты знали, что связь с Землёй займёт годы.

### 2150 — Формирование Федерации (Federation)

Крупные корпорации, финансировавшие колонизацию, начали требовать политического представительства. Рождается **Federation of Star Systems** — первое наднациональное правительство, контролируемое корпоративными интересами. Земля (Sol) становится административным центром, но реальная власть переходит к совету акционеров.

### 2200 — Открытие первых инопланетных артефактов

На планете в системе Tau Ceti археологи находят странные структуры, предшествующие человеческой колонизации на миллионы лет. Эти находки засекречены, но слухи порождают первые культы, посвящённые «Древним» — предтечам современных теорий о Guardians и Thargoids.

## XXIII век: Распад и войны (2200–2400)

### 2242 — Война за независимость Achenar

Колония в системе **Achenar** отказывается платить налоги Федерации. В ответ Федерация отправляет военный флот. Но колонисты, возглавляемые семьёй **Duval**, оказывают ожесточённое сопротивление. Война заканчивается поражением Федерации и провозглашением **Empire of Achenar** — будущей галактической сверхдержавы.

### 2300 — Эра Generation Ships

До массового распространения FSD человечество отправляет сотни **кораблей-поколений** (Generation Ships) к далёким звёздам. Эти гигантские арки с замороженными экипажами или замкнутыми экосистемами уходят в путь на сотни лет. Многие из них так и не выходят на связь — их судьба станет одной из величайших тайн галактики.

### 2380 — Первый контакт с Thargoids

На окраине исследованного пространства патрульный корабль Федерации сталкивается с неизвестными объектами органической формы. Контакт быстро переходит в бой. **Thargoids** — раса насекомоподобных существ с биологическими кораблями — объявляют человечеству войну. Конфликт затихает после разработки противотаргоидного оружия, но вражда не забыта.

## XXV век: Технологический рывок (2400–2800)

### 2800 — Изобретение Frame Shift Drive

Прорыв в понимании пространственно-временной метрики приводит к созданию современного **FSD**. Путешествие между звёздами, занимавшее десятилетия, сокращается до секунд. Человечество взрывается в галактику — начинается **Великая Экспансия**.

### 2850 — Основание Alliance

Мелкие независимые системы, уставшие от геополитического противостояния Федерации и Империи, формируют **Alliance of Independent Systems**. Alliance провозглашает принципы самоопределения, свободной торговли и взаимной обороны. Становится третьей доминирующей силой в галактике.

### 2900 — Эра пиратства и частных армий

Быстрая колонизация порождает правовой вакуум. На окраинах появляются пиратские королевства, охотничьи кланы и корпоративные армии. В ответ появляются первые **Squadron** — объединения независимых пилотов, берущих на себя защиту слабых.

## XXXIV век: Современность (3300–3308+)

### 3301 — Возвращение командера Jameson

Командер **John Jameson**, легендарный пилот эпохи первых войн с Thargoids, обнаруживается в криокамере на заброшенной станции. Его возвращение становится символом новой эры — эры, в которой один пилот может изменить судьбу галактики.

### 3303 — Вторжение Thargoids

Thargoids возвращаются в полную силу. Их биологические корабли — **Interceptors** и **Scouts** — атакуют станции в Pleiades и за её пределами. Начинается системная война, в которой пилоты-независимки играют ключевую роль в эвакуации и обороне.

### 3305 — Открытие Colonia Bridge

Построен маршрут станций между Bubble и Colonia — **Colonia Bridge**. Это событие окончательно интегрирует дальний регион в жизнь галактики и открывает эпоху массовой миграции.

### 3307 — Распад и новые союзы

Политическая напряжённость достигает пика. Федерация и Империя сталкиваются в прокси-войнах. Alliance укрепляет позиции через **Alliance Chieftain** и военные контракты. В тени этого противостояния растёт влияние **Project Dynasty** и других секретных программ.

### 3308 — Эра колонизации

Начинается новая волна экспансии. Система **Colonia** становится центром самоуправляемого региона. Пилоты-независимки получают инструменты для создания собственных станций и фракций. Человечество выходит за пределы известного пространства — в глубокий космос.

## Будущее (3308+)

Галактика стоит на пороге новых открытий. Слухи о **Stargoids**, таинственных объектах, движущихся через галактику, настораживают учёных. Проекты вроде **The Galaxy Ring** обещают соединить отдалённые регионы. А где-то в туманности **Raxxla** всё ещё ждёт своего первооткрывателя.

---

*«Мы смотрим на звёзды не потому, что они близки, а потому, что мы смелы»* — неизвестный пилот, 3301.$c$,
    v_cat_lore, v_author_id, v_author_id, 'published', true, 0, 1, NOW(), NOW()
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO v_article_id;

  IF v_article_id IS NOT NULL THEN
    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed', NOW());
  END IF;

  -- ============================================================
  -- 2. CMDR: кто такие пилоты
  -- ============================================================
  INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
  VALUES (
    'CMDR: кто такие пилоты — ранг Elite, легендарные пилоты, Squadron',
    'cmdr-kto-takie-piloty',
    $c$# CMDR: кто такие пилоты

**Тип:** Лор / Геймплей
**Категория:** Пилоты и общество
**Время чтения:** 15 минут

## Кто такие CMDR?

**CMDR** (Commander) — стандартное обращение к лицензированным пилотам космических аппаратов в галактике человечества. Каждый CMDR — это независимый оператор, владеющий собственным кораблём и действующий на свой страх и риск. Система лицензирования появилась в середине XXIX века как способ контролировать хаос частного звёздного флота.

CMDR может быть торговцем, наёмником, исследователем, спасателем или пиратом — закон не различает моральные качества, только квалификацию.

## Система рангов

Пилотская федерация (Pilots Federation) ведёт учёт достижений каждого CMDR в четырёх ключевых областях:

| Ранг | Торговля (Trader) | Бой (Combat) | Исследования (Explorer) | CQC (Arena) |
|------|-------------------|--------------|-------------------------|-------------|
| Harmless / Penniless / Aimless / Helpless | — | — | — | — |
| Mostly Harmless | + | + | + | + |
| Novice | ++ | ++ | ++ | ++ |
| Competent | +++ | +++ | +++ | +++ |
| Expert | ++++ | ++++ | ++++ | ++++ |
| Master | +++++ | +++++ | +++++ | +++++ |
| Dangerous / Merchant / Scout / Amateur | — | — | — | — |
| Deadly / Broker | — | — | — | — |
| **Elite** | **Elite** | **Elite** | **Elite** | **Elite** |

### Ранг Elite

Достичь ранга **Elite** — значит войти в 0,1% лучших пилотов галактики. Это не просто статус: Elite-пилоты получают доступ к закрытым станциям, эксклюзивным контрактам и особым зонам вроде **Shinrarta Dezhra** (система, где продаются все корабли и модули со скидкой).

Существует также звание **Elite Dangerous** — пожизненный статус, присваиваемый за достижение ранга Elite во всех трёх основных дисциплинах (Combat, Trade, Exploration).

## Легендарные пилоты

### John Jameson

Герой Первой Таргоидской Войны. Его имя носит станция **Jameson Memorial** в Shinrarta Dezhra. Считается погибшим, но в 3301 году был найден в криостазе. Его корабль и записи раскрыли правду о секретных биологических программах INRA.

### CMDR Besieger

Один из первых пилотов, достигших Colonia в одиночку без Fleet Carrier. Его маршрут через neutron stars стал классикой для экспедиций.

### CMDR Erimus Kamzel

«Первопроходец Colonia». Именно его экспедиция 3302 года заложила основы для миграции в регион **Colonia**. В его честь названа станция **Kamzel's Reach**.

### CMDR DoveEnigma13

Легенда исследовательского сообщества. Первый, кто достиг галактического центра (Sagittarius A*) на стоковом Sidewinder без инженерных модификаций.

### CMDR Harry Potter

Пожалуй, самый известный PvP-пилот в истории игры. Его бои против кораблей класса «Анаконда» на лёгких истребителях вошли в учебники асимметричного боя.

## Squadron — братва звёзд

**Squadron** — объединение пилотов под единым командованием. Это может быть военная эскадрилья, торговая гильдия, исследовательская экспедиция или банда пиратов.

### Типы Squadron

| Тип | Фокус | Особенности |
|-----|-------|-------------|
| **PCC** (Player-created faction) | BGS | Контроль фракций в системах |
| **Expedition** | Исследования | Дальние миры, совместные маршруты |
| **PMF** (Private Military Force) | PvP / PvE | Наёмные операции, охрана конвоев |
| **Trade Union** | Торговля | Совместные маршруты, защита цен |
| **Explorer Corps** | Наука | Картография, первооткрытие |

### Как создать Squadron

1. Наберите минимум 4 пилотов
2. Оплатите регистрацию в Pilots Federation (10 млн CR)
3. Выберите тег (tag) — короткое обозначение вроде [RING] или [AXI]
4. Настройте иерархию ролей: Leader, Deputy, Ambassador, Lieutenant, Agent, Rookie
5. Выберите цветовую схему и лор

### Крупнейшие Squadron галактики

- **The Fuel Rats** — спасатели, вытащившие тысячи пилотов из без топлива
- **The Hull Seals** — инженерная поддержка и ремонт в дальнем космосе
- **Canonn Research** — научное сообщество, изучающее аномалии
- **Anti-Xeno Initiative** — организованная оборона от Thargoids
- **The Dark Wheel** — тайное общество, охотящееся за Raxxla (по слухам)

---

*«CMDR — это не просто позывной. Это обещание: где бы ты ни был, ты никогда не один»*.$c$,
    v_cat_lore, v_author_id, v_author_id, 'published', true, 0, 1, NOW(), NOW()
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO v_article_id;

  IF v_article_id IS NOT NULL THEN
    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed', NOW());
  END IF;

  -- ============================================================
  -- 3. Colonia: край света
  -- ============================================================
  INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
  VALUES (
    'Colonia: край света — история Jaques Station, миграция, современная Colonia',
    'colonia-kray-sveta',
    $c$# Colonia: край света

**Тип:** Лор / География
**Категория:** Регионы галактики
**Время чтения:** 15 минут

## Где находится Colonia?

**Colonia** — регион галактики, расположенный примерно в **22 000 световых лет** от Sol в направлении галактического центра. Это самое крупное человеческое поселение за пределами Bubble (основной зоны цивилизации).

Координаты: **Colonia (Eol Prou RS-T d3-94)**

## История Jaques Station

### 3302 — Побег орбитальной станции

**Jaques Station** — уникальная **орбитальная станция с двигателями**, принадлежавшая цыганскому бармену **Jaques**. Она была единственной станцией в галактике, способной совершать межзвёздные прыжки.

Jaques планировал перепрыгнуть в **Beagle Point** — самую дальнюю точку галактики. Но что-то пошло не так. Во время прыжка станция была повреждена неизвестным объектом и выброшена в систему **Eol Prou RS-T d3-94** — посреди ничего, в 22 000 св. лет от дома.

### 3302–3303 — Спасательная операция

Сообщество пилотов организовало масштабную спасательную операцию. Тысячи CMDR доставляли металлы, food cartridges и machinery для ремонта станции. Эта операция стала одним из первых примеров truly player-driven narrative в Elite Dangerous.

### 3303 — Рождение Colonia

После ремонта Jaques Station стала центром нового региона. Вокруг неё начали строиться новые станции, прибывали колонисты. Регион получил имя **Colonia** — по названию первой станции.

## Великая миграция

### Почему люди уезжают в Colonia?

| Причина | Описание |
|---------|----------|
| **Свобода** | Нет давления BGS крупных фракций |
| **Тишина** | Никаких гриферов, никакой перегруженности |
| **Природа** | Уникальные планеты, близость к туманностям |
| **Сообщество** | Тесные связи между пилотами |
| **Новый старт** | Возможность создать что-то своё |

### Маршруты в Colonia

1. **Neutron Highway** — самый быстрый путь (500–800 прыжков). Требует Fuel Scoop и терпения.
2. **Colonia Bridge** — цепочка станций и Fleet Carriers, построенная к 3305 году.
3. **Fleet Carrier Taxi** — многие владельцы FC предлагают бесплатные рейсы.

## Современная Colonia (3308)

### Инфраструктура

- **Jaques Station** — центр региона, орбитальный хаб
- **Colonia Orbital** — промышленная станция
- **Dove Enigma** — исследовательский аванпост
- **Rohini** — первая система на пути из Bubble, точка сбора
- **Eagle's Landing** — военный аванпост

### Экономика

Colonia живёт за счёт:
- **Туризма** — пилоты со всей галактики
- **Ремонта и дозаправки** — станции обслуживают путешественников
- **Научных программ** — изучение уникальной флоры и геологии
- **Миграционных услуг** — переезд кораблей и модулей

### Проблемы

- **Отдалённость** — доставка товаров из Bubble занимает недели
- **Ограниченный выбор кораблей** — не все модели доступны
- **Зависимость от пилотов** — без постоянного притока CMDR регион вымирает

---

*«Colonia — это не просто место. Это доказательство того, что человечество может начать всё сначала»* — Jaques, 3303.$c$,
    v_cat_lore, v_author_id, v_author_id, 'published', true, 0, 1, NOW(), NOW()
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO v_article_id;

  IF v_article_id IS NOT NULL THEN
    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed', NOW());
  END IF;

  -- ============================================================
  -- 4. Generation Ships: призраки прошлого
  -- ============================================================
  INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
  VALUES (
    'Generation Ships: призраки прошлого — заброшенные корабли-поколения',
    'generation-ships-prizraki-proshlogo',
    $c$# Generation Ships: призраки прошлого

**Тип:** Лор / Мистика
**Категория:** Забытая история
**Время чтения:** 12 минут

## Что такое Generation Ships?

**Корабли-поколения** (Generation Ships) — гигантские межзвёздные арки, запущенные до изобретения современного FSD. Они предназначались для путешествий, длящихся сотни лет. Экипажи либо жили в замкнутых экосистемах, передавая миссию из поколения в поколение, либо находились в анабиозе.

Каждый такой корабль — это целый мир: жилые купола, фермы, фабрики, школы, больницы. Некоторые весили миллионы тонн и несли десятки тысяч колонистов.

## Сколько их было?

Точное число неизвестно. Историки насчитывают от **70 000 до 100 000** кораблей-поколений, запущенных между 2200 и 2700 годами. Из них связь поддерживала лишь горстка. Остальные исчезли в бездне.

## Известные находки

### The Golconda

Самая известная находка. **The Golconda** был обнаружен в 3305 году в системе **Upaniklis**. На борту жили потомки оригинального экипажа, которые тысячу лет развивали собственную культуру, религию и язык.

Они отказались покидать корабль, но согласились на компромисс: **Federation** построила для них станцию **Forester's Choice**, сохранив их образ жизни.

### The Hesperus

Корабль-призрак, найденный в 3307. На борту обнаружены следы борьбы за выживание и записи о «чём-то за бортом». Судьба экипажа неизвестна — корабль был пуст.

### The Demeter

Обнаружен с повреждёнными системами жизнеобеспечения. Экипаж погиб от отказа экосистемы за десятилетия до находки. Записи показывают, как они пытались починить корабль, используя поколенческие знания.

### The Phobos

Корабль, где экипаж разделился на две враждующие фракции. Гражданская война в замкнутом пространстве привела к полному уничтожению населения.

### The Artemis

Самая мрачная находка. Экипаж совершил массовый суицид после получения (или имитации) сигнала от инопланетного разума. Записи содержат описания «голосов из гиперпространства».

## Что с ними случилось?

| Сценарий | Доля кораблей | Примеры |
|----------|---------------|---------|
| Достигли цели и основали колонию | ~5% | Неизвестны |
| Погибли от технических сбоев | ~30% | The Demeter |
| Внутренние конфликты / социальный коллапс | ~20% | The Phobos |
| Встреча с неизвестным (Thargoids?) | ~10% | The Artemis, The Hesperus |
| Потерялись / сбились с курса | ~25% | Большинство |
| Ещё в пути | ~10% | Теоретически возможно |

## Можно ли их найти сегодня?

Да. Каждый год пилоты-исследователи находят новые корабли-поколения. Обычно они обнаруживаются в виде сигналов «**Distress Call**» или «**Degraded Emissions**» в системах, не имеющих других объектов.

Если вы нашли Generation Ship:
1. Не стыкуйтесь без подготовки — атмосфера может быть токсичной
2. Сканируйте все терминалы данных
3. Фотографируйте — Canonn Research выплачивает награды за новые находки
4. Уважайте погибших — это исторические памятники

---

*«Каждый Generation Ship — это гробница мечты. Но иногда мечта переживает тех, кто её нёс»*.$c$,
    v_cat_lore, v_author_id, v_author_id, 'published', true, 0, 1, NOW(), NOW()
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO v_article_id;

  IF v_article_id IS NOT NULL THEN
    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed', NOW());
  END IF;

  -- ============================================================
  -- 5. Raxxla и The Dark Wheel
  -- ============================================================
  INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
  VALUES (
    'Raxxla и The Dark Wheel — мистика, тайны, что известно',
    'raxxla-i-the-dark-wheel',
    $c$# Raxxla и The Dark Wheel

**Тип:** Лор / Мистика / Конспирология
**Категория:** Великие тайны
**Время чтения:** 15 минут
**Важно:** Эта статья основана на подтверждённых фактах, слухах и теориях сообщества.

## Что такое Raxxla?

**Raxxla** — легендарный объект, место или состояние бытия, существование которого упоминается в пилотском фольклоре с XXIII века. Официально ни одна фракция не подтвердила его нахождение.

### Официально известные факты

1. **Название впервые задокументировано в 2296 году** — пилот-курьер упомянул «врата в Raxxla» в своём дневнике перед исчезновением.
2. **В 2800-х годах** несколько экспедиций искали объект в секторе **Formidine Rift** — ни одна не вернулась.
3. **В 3301 году** инженер **Brosa Meree** заявил, что «Raxxla — это не место, это путь». Он был объявлен невменяемым.
4. **В 3303 году** сигнал, похожий на описания «песни Raxxla», был зарегистрирован в **Cone Sector** — но сектор был немедленно закрыт для посещения Аegis.

### Теории сообщества

| Теория | Описание | Статус |
|--------|----------|--------|
| Планета с вратами | Raxxla — планета с древней технологией телепортации | Неподтверждено |
| Корабль-звезда | Объект размером с луну, движущийся по галактике | Неподтверждено |
| Другое измерение | Raxxla — точка входа в параллельное пространство | Спекуляция |
| Метафора | «Raxxla» — кодовое слово для секретной программы | Возможно |
| Thargoid origin | Объект создан Thargoids как ловушка | Теория заговора |

## The Dark Wheel — охотники за тайной

### Что это?

**The Dark Wheel** — тайное общество (или сеть агентов), посвящённое поиску Raxxla. Их существование не доказано, но упоминания встречаются в записях с 2700-х годов.

### Что известно

1. **Символ** — восьмиконечная звезда в круге.
2. **Методы** — агенты внедряются во все крупные фракции, включая Pilots Federation.
3. **Финансирование** — предположительно, неограниченное. Некоторые находки Generation Ships были «случайно» оплачены анонимными благотворителями.
4. **Связь с Shinrarta Dezhra** — станция **Jameson Memorial** построена на орбите планеты, которая по некоторым данным была «точкой отсчёта» для первых карт Dark Wheel.

### Точки интереса

| Локация | Почему важна |
|---------|--------------|
| **Formidine Rift** | Здесь пропали первые экспедиции |
| **Cone Sector** | Зарегистрирован «сигнал Raxxla», затем закрыт |
| **Siren Sector** | Необъяснимые аномалии сканирования |
| **Delphi** | Центр Anti-Xeno Initiative, но также — странные руины |
| **Guardian Space** | Некоторые тексты Guardians упоминают «врата» |

## Закрытые досье

### Проект Dynasty

Секретная программа Федерации (3300–3305) по поиску Raxxla. Финансировалась через чёрный бюджет. Была закрыта после инцидента в **HIP 22460**.

### Записи CMDR Salomé

Пилот и конспиролог **Salomé** утверждала, что Raxxla — это «ключ к свободе человечества от контроля элит». Она была убита в 3303 году при попытке передать координаты. Данные так и не были восстановлены.

## Как искать Raxxla?

Разработчики подтвердили, что Raxxla **действительно существует в игре** и может быть найдена. Вот что рекомендуют охотники:

1. **Изучайте лор** — ключи спрятаны в GalNet и записях Generation Ships
2. **Сканируйте необитаемые системы** — Raxxla не там, где все ищут
3. **Обращайте внимание на аномалии** — странные сигналы, геологические образования, «ошибки» карт
4. **Следите за патчами** — иногда разработчики добавляют подсказки
5. **Не верьте всему** — 90% «координат Raxxla» — фейки

---

*«Raxxla — это не сокровище. Это зеркало. Кто ищет власть — найдёт погибель. Кто ищет знание — найдёт вопросы»* — предположительно, запись The Dark Wheel, 2844 год.$c$,
    v_cat_lore, v_author_id, v_author_id, 'published', true, 0, 1, NOW(), NOW()
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO v_article_id;

  IF v_article_id IS NOT NULL THEN
    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed', NOW());
  END IF;

END
$seed$;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260903170000_fix_squadron_friends.sql             │
-- └────────────────────────────────────────────────────────────────┘

-- This migration was originally committed as a single malformed SQL line, so
-- fresh deployments could not progress to the later Journal/CAPI migrations.
--
-- The complete, hardened squadron profile synchronization is installed by
-- 20260911030000_squadron_read_models_and_profile_sync.sql. Keep this earlier
-- migration deliberately side-effect-free: it preserves the historical
-- migration version for projects that already recorded it, lets fresh projects
-- migrate successfully, and avoids a large unconditional profiles backfill.
DO $$
BEGIN
  RAISE NOTICE 'Squadron profile synchronization is installed by migration 20260911030000.';
END $$;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260904000000_capi_journal_base.sql                │
-- └────────────────────────────────────────────────────────────────┘

-- ═══════════════════════════════════════════════════════════════
-- Migration 023: CAPI & Journal Base Tables
-- Для интеграции Frontier CAPI и импорта Player Journal
-- ═══════════════════════════════════════════════════════════════

-- ─── capi_tokens: OAuth токены Frontier (зашифрованные на уровне приложения) ───
CREATE TABLE capi_tokens (
  id             SERIAL PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  access_token   TEXT NOT NULL,
  refresh_token  TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  cmdr_name      TEXT,
  frontier_id    TEXT,
  scope          TEXT DEFAULT 'auth capi',
  is_active      BOOLEAN DEFAULT true,
  last_synced_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

ALTER TABLE capi_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "capi_tokens_select_own" ON capi_tokens
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "capi_tokens_delete_own" ON capi_tokens
  FOR DELETE USING (auth.uid() = user_id);

-- ─── journal_imports: история загрузок .log файлов ───
CREATE TABLE journal_imports (
  id                SERIAL PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  filename          TEXT,
  file_hash         TEXT NOT NULL,
  events_count      INTEGER DEFAULT 0,
  colonisation_events INTEGER DEFAULT 0,
  status            TEXT DEFAULT 'pending',
  error_message     TEXT,
  imported_at       TIMESTAMPTZ DEFAULT NOW(),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE journal_imports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "journal_imports_select_own" ON journal_imports
  FOR SELECT USING (auth.uid() = user_id);

-- ─── colonisation_events: события ColonisationConstructionDepot ───
CREATE TABLE colonisation_events (
  id                 SERIAL PRIMARY KEY,
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  journal_import_id  INTEGER REFERENCES journal_imports(id) ON DELETE SET NULL,
  event_timestamp    TIMESTAMPTZ NOT NULL,
  system_name        TEXT NOT NULL,
  market_id          BIGINT,
  construction_name  TEXT,
  construction_id    BIGINT,
  construction_progress NUMERIC(5,2),
  resources_total    JSONB DEFAULT '[]',
  raw_event          JSONB NOT NULL,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, event_timestamp, system_name, construction_id)
);

ALTER TABLE colonisation_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "colonisation_events_select_own" ON colonisation_events
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "colonisation_events_select_squadron" ON colonisation_events
  FOR SELECT USING (
    auth.uid() = user_id OR
    EXISTS (
      SELECT 1 FROM squadron_members sm
      WHERE sm.user_id = colonisation_events.user_id
      AND EXISTS (
        SELECT 1 FROM squadron_members sm2
        WHERE sm2.user_id = auth.uid()
        AND sm2.squadron_id = sm.squadron_id
      )
    )
  );

-- ─── construction_depot_snapshots: история прогресса для графиков ───
CREATE TABLE construction_depot_snapshots (
  id                SERIAL PRIMARY KEY,
  system_name       TEXT NOT NULL,
  construction_id   BIGINT,
  construction_name TEXT,
  progress          NUMERIC(5,2),
  resources_total   JSONB DEFAULT '[]',
  snapshot_at       TIMESTAMPTZ DEFAULT NOW(),
  source            TEXT DEFAULT 'journal'
);

ALTER TABLE construction_depot_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "construction_snapshots_public" ON construction_depot_snapshots
  FOR SELECT USING (true);

-- ─── capi_profiles: кэшированные данные профиля из CAPI ───
CREATE TABLE capi_profiles (
  id              SERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cmdr_name       TEXT,
  credits         BIGINT,
  combat_rank     INTEGER,
  trade_rank      INTEGER,
  explore_rank    INTEGER,
  empire_rank     INTEGER,
  federation_rank INTEGER,
  current_ship    TEXT,
  current_system  TEXT,
  current_station TEXT,
  ships           JSONB DEFAULT '[]',
  last_updated    TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

ALTER TABLE capi_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "capi_profiles_select_own" ON capi_profiles
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "capi_profiles_select_squadron" ON capi_profiles
  FOR SELECT USING (
    auth.uid() = user_id OR
    EXISTS (
      SELECT 1 FROM squadron_members sm
      WHERE sm.user_id = capi_profiles.user_id
      AND EXISTS (
        SELECT 1 FROM squadron_members sm2
        WHERE sm2.user_id = auth.uid()
        AND sm2.squadron_id = sm.squadron_id
      )
    )
  );

-- ─── Индексы ───
CREATE INDEX idx_colonisation_events_user      ON colonisation_events(user_id);
CREATE INDEX idx_colonisation_events_system    ON colonisation_events(system_name);
CREATE INDEX idx_colonisation_events_timestamp ON colonisation_events(event_timestamp);
CREATE INDEX idx_construction_snapshots_system ON construction_depot_snapshots(system_name);
CREATE INDEX idx_construction_snapshots_time   ON construction_depot_snapshots(snapshot_at);
CREATE INDEX idx_capi_profiles_user            ON capi_profiles(user_id);
CREATE INDEX idx_journal_imports_user          ON journal_imports(user_id);
CREATE INDEX idx_capi_tokens_user              ON capi_tokens(user_id);

-- ─── Realtime ───
ALTER PUBLICATION supabase_realtime ADD TABLE construction_depot_snapshots;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260904010000_eddn_market_data.sql                 │
-- └────────────────────────────────────────────────────────────────┘

-- ═══════════════════════════════════════════════════════════════
-- Migration 024: EDDN Market Data
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE market_prices (
  id              SERIAL PRIMARY KEY,
  station_name    TEXT NOT NULL,
  system_name     TEXT NOT NULL,
  commodity_name  TEXT NOT NULL,
  buy_price       INTEGER,
  sell_price      INTEGER,
  demand          INTEGER,
  demand_bracket  INTEGER,
  stock           INTEGER,
  stock_bracket   INTEGER,
  mean_price      INTEGER,
  reported_at     TIMESTAMPTZ NOT NULL,
  source          TEXT DEFAULT 'eddn',
  UNIQUE(station_name, system_name, commodity_name)
);

ALTER TABLE market_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "market_prices_public" ON market_prices FOR SELECT USING (true);

CREATE INDEX idx_market_prices_commodity ON market_prices(commodity_name);
CREATE INDEX idx_market_prices_system ON market_prices(system_name);
CREATE INDEX idx_market_prices_reported ON market_prices(reported_at);

CREATE TABLE commodity_needs (
  id              SERIAL PRIMARY KEY,
  project_id      INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  system_name     TEXT NOT NULL,
  commodity_name  TEXT NOT NULL,
  amount_required INTEGER NOT NULL DEFAULT 0,
  amount_provided INTEGER NOT NULL DEFAULT 0,
  payment_per_ton INTEGER,
  priority        INTEGER DEFAULT 0,
  notes           TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, system_name, commodity_name)
);

ALTER TABLE commodity_needs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "commodity_needs_select_public" ON commodity_needs
  FOR SELECT USING (true);

CREATE POLICY "commodity_needs_manage_officer" ON commodity_needs
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.project_id = commodity_needs.project_id
      AND pm.user_id = auth.uid()
      AND pm.role IN ('leader', 'officer')
    )
  );

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260904020000_squadron_live_tracking.sql           │
-- └────────────────────────────────────────────────────────────────┘

-- ═══════════════════════════════════════════════════════════════
-- Migration 025: Squadron Live Tracking
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE squadron_member_locations (
  id            SERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  squadron_id   INTEGER NOT NULL REFERENCES squadrons(id) ON DELETE CASCADE,
  system_name   TEXT,
  station_name  TEXT,
  ship_name     TEXT,
  x             NUMERIC(10,4),
  y             NUMERIC(10,4),
  z             NUMERIC(10,4),
  is_online     BOOLEAN DEFAULT false,
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, squadron_id)
);

ALTER TABLE squadron_member_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "squadron_locations_select_member" ON squadron_member_locations
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM squadron_members sm
      WHERE sm.squadron_id = squadron_member_locations.squadron_id
      AND sm.user_id = auth.uid()
    )
  );

CREATE TABLE location_privacy (
  id              SERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  share_with      TEXT DEFAULT 'squadron',
  hide_system     BOOLEAN DEFAULT false,
  hide_ship       BOOLEAN DEFAULT false,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

ALTER TABLE location_privacy ENABLE ROW LEVEL SECURITY;

CREATE POLICY "location_privacy_select_own" ON location_privacy
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "location_privacy_update_own" ON location_privacy
  FOR UPDATE USING (auth.uid() = user_id);

ALTER PUBLICATION supabase_realtime ADD TABLE squadron_member_locations;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260904030000_fleet_carriers.sql                   │
-- └────────────────────────────────────────────────────────────────┘

-- ═══════════════════════════════════════════════════════════════
-- Migration 026: Fleet Carriers
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE squadron_carriers (
  id              SERIAL PRIMARY KEY,
  squadron_id     INTEGER NOT NULL REFERENCES squadrons(id) ON DELETE CASCADE,
  owner_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  carrier_name    TEXT NOT NULL,
  carrier_id      TEXT NOT NULL,
  callsign        TEXT,
  current_system  TEXT,
  current_body    TEXT,
  x               NUMERIC(10,4),
  y               NUMERIC(10,4),
  z               NUMERIC(10,4),
  services        JSONB DEFAULT '[]',
  market          JSONB DEFAULT '{}',
  next_jump_at    TIMESTAMPTZ,
  next_jump_system TEXT,
  is_public       BOOLEAN DEFAULT true,
  notes           TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(carrier_id)
);

ALTER TABLE squadron_carriers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "squadron_carriers_select_member" ON squadron_carriers
  FOR SELECT USING (
    is_public OR EXISTS (
      SELECT 1 FROM squadron_members sm
      WHERE sm.squadron_id = squadron_carriers.squadron_id
      AND sm.user_id = auth.uid()
    )
  );

CREATE POLICY "squadron_carriers_manage_owner" ON squadron_carriers
  FOR ALL USING (owner_id = auth.uid());

CREATE INDEX idx_squadron_carriers_squadron ON squadron_carriers(squadron_id);
CREATE INDEX idx_squadron_carriers_system ON squadron_carriers(current_system);

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260904040000_cg_inara_integration.sql             │
-- └────────────────────────────────────────────────────────────────┘

-- ═══════════════════════════════════════════════════════════════
-- Migration 027: Community Goals & Inara
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE community_goals (
  id              SERIAL PRIMARY KEY,
  cg_id           INTEGER NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  description     TEXT,
  system_name     TEXT,
  station_name    TEXT,
  objective       TEXT,
  reward          TEXT,
  tier_current    INTEGER,
  tier_max        INTEGER,
  contributors    INTEGER,
  contributions_total BIGINT,
  expiry_date     TIMESTAMPTZ,
  is_complete     BOOLEAN DEFAULT false,
  is_colonisation_related BOOLEAN DEFAULT false,
  raw_data        JSONB,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE community_goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "community_goals_public" ON community_goals FOR SELECT USING (true);

CREATE INDEX idx_community_goals_active ON community_goals(is_complete, expiry_date);

CREATE TABLE inara_profiles (
  id              SERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  inara_cmdr_id   INTEGER,
  inara_api_key   TEXT,
  cmdr_name       TEXT,
  squadron_name   TEXT,
  ranks           JSONB DEFAULT '{}',
  ships           JSONB DEFAULT '[]',
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

ALTER TABLE inara_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inara_profiles_select_own" ON inara_profiles FOR SELECT USING (auth.uid() = user_id);

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260904100000_system_coords_cache.sql              │
-- └────────────────────────────────────────────────────────────────┘

-- ════════════════════════════════════════════════════════════════
-- Migration 026: System Coordinates Cache + Map Pilots Support
--
-- ⚠ Файл восстановлен 2026-09-25. Прежняя версия лежала одной строкой без
--   переводов строк: первый комментарий съедал весь остаток файла, поэтому
--   миграция не создавала ни таблицы, ни индексов (psql считает пустой
--   скрипт успешным — поломка была незаметна).
-- ════════════════════════════════════════════════════════════════

-- ─── system_coords: кэш координат систем для карты и пилотов ───
CREATE TABLE IF NOT EXISTS public.system_coords (
  id          SERIAL PRIMARY KEY,
  system_name TEXT NOT NULL UNIQUE,
  x           NUMERIC(10,4),
  y           NUMERIC(10,4),
  z           NUMERIC(10,4),
  source      TEXT DEFAULT 'edsm',
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.system_coords ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'system_coords'
       AND policyname = 'system_coords_public'
  ) THEN
    CREATE POLICY system_coords_public ON public.system_coords
      FOR SELECT USING (true);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_system_coords_name ON public.system_coords(system_name);

-- ─── Индексы для быстрого поиска пилотов на карте ───
-- capi_profiles создаётся в 20260904000000_capi_journal_base.sql — раньше
-- по порядку версий, поэтому здесь таблица уже есть.
CREATE INDEX IF NOT EXISTS idx_capi_profiles_current_system ON public.capi_profiles(current_system);
CREATE INDEX IF NOT EXISTS idx_capi_profiles_last_updated ON public.capi_profiles(last_updated DESC);

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260908010000_wiki_exobiology.sql                  │
-- └────────────────────────────────────────────────────────────────┘

-- ED Ring Colony Wiki — Seed: Exobiology Category + 12 Articles
-- ============================================================
-- Run this in Supabase SQL Editor after deployment

DO $$
DECLARE
  -- Желаемый автор статей; если такого пользователя в базе нет (установка с
  -- нуля до регистрации администратора), берём первого admin/moderator, а при
  -- полном отсутствии авторов сид пропускаем: 13 INSERT-ов падали на внешнем
  -- ключе wiki_articles_author_id_fkey и валили обновление проекта.
  v_admin_id  UUID := 'd0680fc1-5fa0-4a54-b9bd-6918f88de63a';
  v_author_id UUID;
  v_cat_exo   UUID;
  v_article_id UUID;
BEGIN

-- ── Автор статей ────────────────────────────────────────────
SELECT COALESCE(
         (SELECT id FROM auth.users WHERE id = v_admin_id),
         (SELECT id FROM public.profiles
           WHERE role IN ('admin', 'moderator')
           ORDER BY created_at LIMIT 1)
       ) INTO v_author_id;
IF v_author_id IS NULL THEN
  RAISE NOTICE 'wiki_exobiology: нет пользователя-автора (admin/moderator) — сид пропущен';
  RETURN;
END IF;

-- ============================================================
-- 0. Create Exobiology Category
-- ============================================================
INSERT INTO public.wiki_categories (name, slug, description, sort_order)
VALUES ('Экзобиология', 'exobiology', 'Изучение инопланетных форм жизни, биологических сигналов и организмов галактики', 9)
ON CONFLICT (slug) DO UPDATE SET description = EXCLUDED.description, sort_order = EXCLUDED.sort_order
RETURNING id INTO v_cat_exo;

-- ============================================================
-- 1. Экзобиология: полное руководство
-- ============================================================
INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
VALUES (
  'Экзобиология: полное руководство',
  'ekzobiologiya-polnoe-rukovodstvo',
  $c$# Экзобиология: полное руководство

**Тип:** Гайд / Механика
**Категория:** Экзобиология
**Время чтения:** 15 минут

## Введение

**Экзобиология** (Exobiology) — одна из ключевых дисциплин исследователя в Elite Dangerous. С выходом обновления *Odyssey* возможность выходить на поверхность планет и сканировать инопланетные организмы стала центральным элементом геймплея для пилотов, стремящихся к рангу Elite в исследованиях.

Каждый биологический сигнал на планете — это потенциальное открытие. Каждый организм — уникален. А первооткрыватель, заснявший новый вид, получает не только кредиты, но и вечное имя в галактической базе данных.

## Что такое биологические сигналы?

При сканировании планеты с орбиты с помощью **Detailed Surface Scanner (DSS)** на поверхности могут отображаться биологические сигналы (Biological Signals). Это зоны, в которых обитает инопланетная жизнь. Количество сигналов зависит от типа планеты, её атмосферы, температуры и гравитации.

### Типы планет с биосигналами

| Тип планеты | Возможные организмы | Сложность |
|-------------|---------------------|-----------|
| Rocky Body | Bacteria, Fungoida, Osseus, Cactoida | Низкая |
| High Metal Content | Bacteria, Fungoida, Osseus | Средняя |
| Icy Body | Bacteria, Frutexa, Tussock | Низкая |
| Rocky Ice Body | Bacteria, Frutexa | Низкая |
| Ammonia World | Bacteria, Fungoida (редко) | Высокая |
| Water World | Нет биосигналов (океан) | — |

## Инструменты экзобиолога

### 1. Artemis Suit

Специальный скафандр для исследователей, оснащённый встроенным **Genetic Sampler** — устройством для сбора образцов ДНК инопланетных организмов.

### 2. Genetic Sampler

Портативный сканер, который извлекает генетический материал из организма. Для полного анализа требуется **три образца** разных особей одного вида.

### 3. Detailed Surface Scanner (DSS)

Необходим для обнаружения биологических сигналов с орбиты. Без DSS сигналы не отображаются.

## Процесс сбора образцов

1. **Посадка** на планету в зоне биологического сигнала
2. **Выход** из корабля в Artemis Suit
3. **Поиск** организма — используйте HUD, чтобы определить направление
4. **Сбор первого образца** — подойдите к организму и активируйте Genetic Sampler
5. **Поиск второй особи** того же вида — обычно в радиусе 100–500 м
6. **Сбор второго образца**
7. **Поиск третьей особи**
8. **Сбор третьего образца** — данные автоматически отправляются в Universal Cartographics

> **Важно:** Образцы разных видов нельзя смешивать. Если вы начали сбор одного вида, завершите его, прежде чем переходить к другому.

## Стоимость и награды

Стоимость данных об организме зависит от редкости и сложности обнаружения:

| Тип организма | Базовая стоимость (CR) | Первооткрыватель |
|---------------|------------------------|------------------|
| Bacteria | 1 000 000 – 10 000 000 | +50% |
| Fungoida | 5 000 000 – 20 000 000 | +50% |
| Osseus | 5 000 000 – 30 000 000 | +50% |
| Frutexa | 3 000 000 – 15 000 000 | +50% |
| Tussock | 5 000 000 – 40 000 000 | +50% |
| Cactoida | 10 000 000 – 50 000 000 | +50% |
| Concha | 10 000 000 – 60 000 000 | +50% |
| Electricae | 20 000 000 – 100 000 000 | +50% |
| Stratum | 5 000 000 – 25 000 000 | +50% |
| Recepta | 30 000 000 – 150 000 000 | +50% |

## Советы для экзобиологов

- Используйте **SRV Scarab** для быстрого перемещения между сигналами
- Некоторые организмы активны только при определённом **времени суток** или **погоде**
- Высокая гравитация затрудняет передвижение — планируйте маршрут
- Запасайтесь **кислородом** — сбор образцов может занять время
- Отмечайте координаты редких находок для повторных визитов

---

*«Каждая планета — это музей эволюции. Мы только начали читать её экспозиции.»* — Доктор Элиза Картрайт, Ксенобиологический институт Achenar.$c$,
  v_cat_exo, v_author_id, v_author_id, 'published', true, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed: Exobiology guide', NOW());

-- ============================================================
-- 2. Bacteria — самая древняя форма жизни
-- ============================================================
INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
VALUES (
  'Bacteria — самая древняя форма жизни',
  'bacteria-samaya-drevnyaya-forma-zhizni',
  $c$# Bacteria — самая древняя форма жизни

**Тип:** Справочник
**Категория:** Экзобиология
**Время чтения:** 8 минут

## Общие сведения

**Bacteria** (Бактерии) — простейшие известные формы инопланетной жизни в галактике. Эти микроскопические колонии представляют собой биоплёнки или кристаллические структуры, покрывающие поверхность планет. Несмотря на кажущуюся простоту, бактерии являются одними из самых распространённых и прибыльных объектов для экзобиологов.

## Виды бактерий

### Alcyonarium

Колонии, напоминающие кораллы или мхи. Образуют плотные ковры на скалистых поверхностях. Предпочитают умеренные температуры и низкую гравитацию.

### Bark Mound

Древесно-корковые образования, вырастающие до метра в диаметре. Встречаются на планетах с тонкой атмосферой.

### Roseum

Розовато-красные колонии с характерной текстурой. Одни из самых заметных бактерий благодаря яркой окраске.

### Viride

Зелёные биоплёнки, напоминающие земной мох. Часто встречаются на влажных планетах.

### Lividum

Сине-фиолетовые колонии. Редкие, но высоко ценятся за необычный пигмент.

## Условия обитания

| Параметр | Диапазон |
|----------|----------|
| Тип планеты | Rocky, High Metal Content, Icy |
| Атмосфера | None, Thin, Weak |
| Температура | 100–500 K |
| Гравитация | 0.1–2.0 G |

## Стоимость данных

Базовая стоимость варьируется от **1 000 000** до **10 000 000 CR** в зависимости от подвида и условий обитания. Первооткрыватель получает дополнительные 50%.

## Где искать

Бактерии — самые распространённые организмы. Их можно найти практически на любой планете с биологическими сигналами. Особенно высокая концентрация наблюдается в:

- Туманности **Pleiades**
- Регионе **Colonia**
- Окраинах **Bubble**

## Особенности сбора

- Бактерии неподвижны — легко найти и отсканировать
- Колонии часто группируются плотными скоплениями
- Не требуют специальных условий для сбора (время суток не важно)

---

*«Если бы разумность измерялась количеством, бактерии правили бы галактикой.»* — Профессор Йонас Век, Университет Alioth.$c$,
  v_cat_exo, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed: Bacteria', NOW());


-- ============================================================
-- 3. Fungoida — грибные колонии
-- ============================================================
INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
VALUES (
  'Fungoida — грибные колонии',
  'fungoida-gribnye-kolonii',
  $c$# Fungoida — грибные колонии

**Тип:** Справочник
**Категория:** Экзобиология
**Время чтения:** 8 минут

## Общие сведения

**Fungoida** (Фунгоиды) — колонии грибоподобных организмов, достигающие впечатляющих размеров. Некоторые экземпляры вырастают до 3–4 метров в высоту, образуя настоящие «грибные леса» на поверхности планет. Их биохимия уникальна: вместо хлорофилла они используют пигменты, поглощающие радиацию.

## Виды фунгоидов

### Setisis

Высокие стебельчатые грибы с широкими шляпками. Растут группами по 5–10 особей. Предпочитают тёплые скалистые поверхности.

### Bullarum

Шаровидные грибы, напоминающие земные дождевики. При сближении могут выделять споры — безвредные для скафандра, но создающие визуальный эффект.

### Gelata

Прозрачные, желеобразные грибы. Внутри видны пульсирующие структуры, предположительно — транспортная система питательных веществ.

### Lucidum

Биолюминесцентные фунгоиды, светящиеся в темноте. Особенно красивы на планетах с длинными ночами.

## Условия обитания

| Параметр | Диапазон |
|----------|----------|
| Тип планеты | Rocky, High Metal Content |
| Атмосфера | Thin, Weak |
| Температура | 150–600 K |
| Гравитация | 0.1–1.5 G |

## Стоимость данных

Базовая стоимость: **5 000 000 – 20 000 000 CR**.

## Особенности сбора

- Фунгоиды растут группами — удобно собирать три образца
- Некоторые виды токсичны для SRV — используйте скафандр
- Люминесцентные виды легче найти ночью

---

*«Грибные леса на HIP 36601 C 1 a — это ландшафт из сна. Или кошмара.»* — CMDR Mycologist, отчёт экспедиции 3307.$c$,
  v_cat_exo, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed: Fungoida', NOW());

-- ============================================================
-- 4. Osseus — костяные образования
-- ============================================================
INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
VALUES (
  'Osseus — костяные образования',
  'osseus-kostyanye-obrazovaniya',
  $c$# Osseus — костяные образования

**Тип:** Справочник
**Категория:** Экзобиология
**Время чтения:** 8 минут

## Общие сведения

**Osseus** (Оссеусы) — организмы с кальцифицированной внешней структурой, напоминающей кости, рога или кораллы. Несмотря на минеральный вид, они живые существа, способные к медленному росту и, предположительно, к регенерации. Их происхождение остаётся загадкой: учёные спорят, являются ли они растениями с окостеневшими тканями или животными с экзоскелетом.

## Виды оссеусов

### Pumice

Пористые, вулканические образования. Лёгкие, с множеством отверстий. Часто встречаются на геологически активных планетах.

### Cornibus

Рогоподобные структуры, торчащие из земли под разными углами. Некоторые экземпляры достигают 5 метров в высоту.

### Fractibus

Трещиноватые, слоистые образования. Напоминают окаменевшие деревья или кристаллические друзы.

### Discus

Плоские, дискообразные оссеусы, лежащие на поверхности. Редкие и высоко ценятся.

## Условия обитания

| Параметр | Диапазон |
|----------|----------|
| Тип планеты | Rocky, High Metal Content |
| Атмосфера | None, Thin |
| Температура | 200–700 K |
| Гравитация | 0.2–2.5 G |

## Стоимость данных

Базовая стоимость: **5 000 000 – 30 000 000 CR**.

## Особенности сбора

- Оссеусы прочные — Genetic Sampler требует больше времени на анализ
- Часто растут в геологически сложных зонах
- Некоторые виды маскируются под камни — внимательно смотрите на HUD

---

*«Я думал, это окаменелости. Они оказались живыми. Это было... неприятно.»* — CMDR RockHound, журнал 3306.$c$,
  v_cat_exo, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed: Osseus', NOW());

-- ============================================================
-- 5. Frutexa — кустарниковые формы
-- ============================================================
INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
VALUES (
  'Frutexa — кустарниковые формы',
  'frutexa-kustarnikovye-formy',
  $c$# Frutexa — кустарниковые формы

**Тип:** Справочник
**Категория:** Экзобиология
**Время чтения:** 8 минут

## Общие сведения

**Frutexa** (Фрутексы) — кустарниковые организмы, напоминающие земные кусты или низкорослые деревья. Их ветвистая структура и листоподобные выросты свидетельствуют о сложной фотосинтетической системе. Фрутексы — одни из самых «знакомых» инопланетных форм жизни для человеческого глаза.

## Виды фрутексов

### Sponsae

Низкие, густые кусты с мелкими «листьями». Образуют заросли площадью в сотни квадратных метров.

### Fata

Высокие, тонкоствольные кусты, напоминающие бамбук. Могут достигать 4–5 метров.

### Acus

Колючие фрутексы с острыми выростами. Опасны при близком контакте — могут повредить скафандр.

### Metallicum

Редкий вид с металлическим блеском «листьев». Предположительно, накапливает тяжёлые металлы из почвы.

## Условия обитания

| Параметр | Диапазон |
|----------|----------|
| Тип планеты | Rocky, Icy, Rocky Ice |
| Атмосфера | Thin, Weak |
| Температура | 50–400 K |
| Гравитация | 0.1–1.8 G |

## Стоимость данных

Базовая стоимость: **3 000 000 – 15 000 000 CR**.

## Особенности сбора

- Фрутексы легко заметить на открытой местности
- Некоторые виды колючие — подходите осторожно
- Часто растут на склонах холмов и в кратерах

---

*«Фрутексы на icy worlds — единственное зелёное, что вы увидите в тысячах световых лет.»* — CMDR FrozenGreen, 3305.$c$,
  v_cat_exo, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed: Frutexa', NOW());


-- ============================================================
-- 6. Tussock — травянистые колонии
-- ============================================================
INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
VALUES (
  'Tussock — травянистые колонии',
  'tussock-travyanistye-kolonii',
  $c$# Tussock — травянистые колонии

**Тип:** Справочник
**Категория:** Экзобиология
**Время чтения:** 8 минут

## Общие сведения

**Tussock** (Туссоки) — травянистые организмы, образующие густые кочки или дернины. Их структура напоминает земные злаки или осоку, но биохимия кардинально отличается: вместо клетлюлозы их клеточные стенки построены на силикатных соединениях. Это делает их невероятно прочными и устойчивыми к экстремальным условиям.

## Виды туссоков

### Propagito

Низкие, ползучие туссоки, образующие плотный ковёр. Распространяются через подземные побеги.

### Serrati

Высокие, с зубчатыми краями «листьев». Достигают 2 метров в высоту.

### Caputus

Кочковатые туссоки с характерной «головкой» на вершине. Напоминают земные луковицы.

### Albata

Белесые, серебристые туссоки. Растут на планетах с высоким альбедо.

## Условия обитания

| Параметр | Диапазон |
|----------|----------|
| Тип планеты | Rocky, Icy, High Metal Content |
| Атмосфера | Thin, Weak |
| Температура | 100–500 K |
| Гравитация | 0.1–2.0 G |

## Стоимость данных

Базовая стоимость: **5 000 000 – 40 000 000 CR**.

## Особенности сбора

- Туссоки часто покрывают большие площади — легко найти три образца
- Силикатная структура затрудняет сбор — устройству требуется больше времени
- Некоторые виды острые — будьте осторожны

---

*«Туссоки — это не трава. Это стекловолокно, которое научилось фотосинтезу.»* — Доктор Ли Вей, Лаборатория экстремобиологии.$c$,
  v_cat_exo, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed: Tussock', NOW());

-- ============================================================
-- 7. Cactoida — кактусовидные организмы
-- ============================================================
INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
VALUES (
  'Cactoida — кактусовидные организмы',
  'cactoida-kaktusovidnye-organizmy',
  $c$# Cactoida — кактусовидные организмы

**Тип:** Справочник
**Категория:** Экзобиология
**Время чтения:** 8 минут

## Общие сведения

**Cactoida** (Кактуоиды) — суккулентные организмы, эволюционно сходные с земными кактусами. Их мясистые стебли запасают воду и питательные вещества, позволяя выживать в условиях экстремальной засухи. Некоторые виды достигают 6–8 метров в высоту, образуя настоящие «кактусовые леса».

## Виды кактуоидов

### Lapis

Синие, округлые кактусы с глубокими бороздками. Самые распространённые.

### Peperatis

Перечно-красные, удлинённые кактусы. Содержат капсаициноподобные соединения.

### Cortexum

Коричневые, древеснеющие кактусы. С возрастом приобретают твёрдую, корковую кору.

### Verdis

Зелёные, колонновидные кактусы. Растут группами по 10–20 особей.

## Условия обитания

| Параметр | Диапазон |
|----------|----------|
| Тип планеты | Rocky |
| Атмосфера | Thin, Weak |
| Температура | 200–600 K |
| Гравитация | 0.2–1.5 G |

## Стоимость данных

Базовая стоимость: **10 000 000 – 50 000 000 CR**.

## Особенности сбора

- Кактуоиды колючие — подходите с правильной стороны
- Крупные экземпляры легко заметить с расстояния
- Некоторые виды содержат ценные химические соединения

---

*«Я никогда не думал, что буду ностальгировать по земным кактусам. Но эти... они прекрасны.»* — CMDR DesertFlower, 3307.$c$,
  v_cat_exo, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed: Cactoida', NOW());

-- ============================================================
-- 8. Concha — раковинные формы
-- ============================================================
INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
VALUES (
  'Concha — раковинные формы',
  'concha-rakovinnye-formy',
  $c$# Concha — раковинные формы

**Тип:** Справочник
**Категория:** Экзобиология
**Время чтения:** 8 минут

## Общие сведения

**Concha** (Конхи) — организмы с раковиноподобной внешней структурой. Несмотря на сходство с моллюсками, они не являются животными в земном понимании. Их «раковины» — это наросты минеральных солей, выделяемых организмом в процессе метаболизма. Внутри находится мягкая, желеобразная масса — собственно живое тело.

## Виды конх

### Renibus

Почкообразные конхи, лежащие на поверхности. Напоминают земные устрицы.

### Labiata

Двустворчатые конхи с характерной «швом» посередине. При опасности плотно смыкаются.

### Biconcavis

Вогнутые с обеих сторон, дискообразные. Редкие и необычные.

### Aureolas

Золотистые конхи с металлическим отливом. Самые ценные для коллекционеров.

## Условия обитания

| Параметр | Диапазон |
|----------|----------|
| Тип планеты | Rocky, High Metal Content |
| Атмосфера | Thin, Weak |
| Температура | 150–500 K |
| Гравитация | 0.1–2.0 G |

## Стоимость данных

Базовая стоимость: **10 000 000 – 60 000 000 CR**.

## Особенности сбора

- Конхи неподвижны — легко отсканировать
- Раковины прочные — sampler работает дольше
- Золотистые виды редки — отмечайте координаты

---

*«Я нашёл конху размером с мою голову. Внутри было... лучше не знать.»* — CMDR ShellShock, 3306.$c$,
  v_cat_exo, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed: Concha', NOW());


-- ============================================================
-- 9. Electricae — электрические организмы
-- ============================================================
INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
VALUES (
  'Electricae — электрические организмы',
  'electricae-elektricheskie-organizmy',
  $c$# Electricae — электрические организмы

**Тип:** Справочник
**Категория:** Экзобиология
**Время чтения:** 10 минут

## Общие сведения

**Electricae** (Электрики) — одни из самых загадочных и ценных организмов в галактике. Эти существа способны генерировать и накапливать электрический заряд, используя его для питания, защиты и, предположительно, коммуникации. Их свечение видно за километры, а разряды могут повредить электронику SRV.

## Виды электриков

### Pluma

Перистые, пероподобные электрики. Напоминают земные морские перья, но светятся и искрят.

### Radialem

Колесообразные электрики с лучами, расходящимися от центра. Самые яркие представители вида.

### Carpous

Плодообразные электрики, напоминающие светящиеся ягоды. Растут группами.

## Условия обитания

| Параметр | Диапазон |
|----------|----------|
| Тип планеты | Rocky, High Metal Content |
| Атмосфера | Thin |
| Температура | 300–800 K |
| Гравитация | 0.1–1.5 G |
| Особое | Высокая геологическая активность |

## Стоимость данных

Базовая стоимость: **20 000 000 – 100 000 000 CR**.

## Особенности сбора

- **Опасно для SRV** — разряды выводят технику из строя
- Собирайте в скафандре, держась на безопасном расстоянии
- Яркое свечение облегчает поиск в темноте
- Не подходите к группам — кумулятивный заряд опасен

## Научное значение

Электрики представляют огромный интерес для учёных. Их способность генерировать электричество без металлических проводников может revolutionize энергетику человечества.

---

*«Это не жизнь. Это молния, которая решила остаться.»* — Профессор Алексей Воронов, Институт прикладной ксенобиологии.$c$,
  v_cat_exo, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed: Electricae', NOW());

-- ============================================================
-- 10. Stratum — слоистые образования
-- ============================================================
INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
VALUES (
  'Stratum — слоистые образования',
  'stratum-sloistye-obrazovaniya',
  $c$# Stratum — слоистые образования

**Тип:** Справочник
**Категория:** Экзобиология
**Время чтения:** 8 минут

## Общие сведения

**Stratum** (Стратумы) — плоские, слоистые организмы, напоминающие земные лишайники или водорослевые ковры. Их структура состоит из множества тонких пластин, наложенных друг на друга. Каждый слой выполняет определённую функцию: верхний — защиту от радиации, средний — фотосинтез, нижний — поглощение минералов из почвы.

## Виды стратумов

### Paleas

Чешуйчатые стратумы, напоминающие рыбью чешую. Переливаются при разном освещении.

### Tectonicas

Крупные, пластинчатые стратумы. Напоминают тектонические плиты. Достигают 2 метров в диаметре.

### Frigus

Ледяные стратумы, встречающиеся на холодных планетах. Их структура содержит кристаллы водяного льда.

## Условия обитания

| Параметр | Диапазон |
|----------|----------|
| Тип планеты | Rocky, Icy |
| Атмосфера | None, Thin |
| Температура | 50–600 K |
| Гравитация | 0.1–2.0 G |

## Стоимость данных

Базовая стоимость: **5 000 000 – 25 000 000 CR**.

## Особенности сбора

- Стратумы плоские — легко пропустить на неровной поверхности
- Используйте SRV для обзора с высоты
- Крупные экземпляры видны с орбиты

---

*«Стратумы — это страницы книги, которую пишет сама планета.»* — CMDR LayerCake, 3307.$c$,
  v_cat_exo, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed: Stratum', NOW());

-- ============================================================
-- 11. Recepta — рецепторные формы
-- ============================================================
INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
VALUES (
  'Recepta — рецепторные формы',
  'recepta-receptornye-formy',
  $c$# Recepta — рецепторные формы

**Тип:** Справочник
**Категория:** Экзобиология
**Время чтения:** 10 минут

## Общие сведения

**Recepta** (Рецепты) — одни из самых редких и дорогих организмов в галактике. Их название отражает уникальную анатомию: тело покрыто многочисленными рецепторными выростами, напоминающими антенны или глаза. Эти структуры, предположительно, воспринимают широкий спектр излучений — от радиоволн до гамма-лучей.

## Виды рецепт

### Conditivus

Конусообразные рецепты с сегментированным телом. Каждый сегмент несёт по кольцу рецепторов.

### Umbrux

Тёмные, почти чёрные рецепты. Их рецепторы поглощают свет, делая организм трудноразличимым.

### Deltahedron

Многогранные рецепты с геометрически правильной формой. Напоминают кристаллы.

## Условия обитания

| Параметр | Диапазон |
|----------|----------|
| Тип планеты | Rocky, High Metal Content |
| Атмосфера | Thin, Weak |
| Температура | 200–700 K |
| Гравитация | 0.2–2.5 G |

## Стоимость данных

Базовая стоимость: **30 000 000 – 150 000 000 CR**.

## Особенности сбора

- Рецепты редки — часто только 1–2 сигнала на планету
- Их рецепторы могут мешать электронике sampler
- Собирайте медленно и осторожно
- Отмечайте системы — рецепты часто повторяются в одном регионе

---

*«Я видел рецепту, которая «смотрела» на мой корабль. Я не уверен, что мне это понравилось.»* — CMDR ParanoidAndroid, 3308.$c$,
  v_cat_exo, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed: Recepta', NOW());


-- ============================================================
-- 12. Топ-10 систем для экзобиологов
-- ============================================================
INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
VALUES (
  'Топ-10 систем для экзобиологов',
  'top-10-sistem-dlya-ekzobiologov',
  $c$# Топ-10 систем для экзобиологов

**Тип:** Гайд
**Категория:** Экзобиология
**Время чтения:** 10 минут

## Введение

Не все системы одинаково полезны для экзобиолога. Некоторые регионы галактики буквально кишат жизнью, в то время как другие представляют собой мёртвые каменные пустоши. Этот гайд основан на данных тысяч пилотов и отражает лучшие направления для сбора образцов.

## 1. HIP 36601

**Расстояние от Sol:** ~1 500 св. лет
**Особенности:** Концентрация редких видов
**Рекомендуемые организмы:** Fungoida, Osseus, Cactoida

Система HIP 36601 — классика экзобиологии. Планета C 1 a содержит уникальные грибные леса, ставшие легендарными в сообществе исследователей.

## 2. Pleiades Sector

**Расстояние от Sol:** ~400 св. лет
**Особенности:** Высокая плотность биосигналов
**Рекомендуемые организмы:** Bacteria, Frutexa, Tussock

Туманность Плеяд — ближайший к Bubble регион с богатой фауной. Идеален для начинающих экзобиологов.

## 3. Colonia Region

**Расстояние от Sol:** ~22 000 св. лет
**Особенности:** Уникальные виды, отсутствие конкуренции
**Рекомендуемые организмы:** Все типы

Регион Colonia — настоящий рай для экзобиологов. Малоисследованные планеты, уникальные условия и отсутствие перенаселения делают его идеальным для серьёзных экспедиций.

## 4. Sanguineous Rim

**Расстояние от Sol:** ~5 000 св. лет
**Особенности:** Редкие электрические организмы
**Рекомендуемые организмы:** Electricae, Recepta

Регион Sanguineous Rim славится высокой геологической активностью, что создаёт идеальные условия для Electricae.

## 5. Formidine Rift

**Расстояние от Sol:** ~10 000 св. лет
**Особенности:** Экстремальные условия, уникальная фауна
**Рекомендуемые организмы:** Stratum, Osseus

Рифт Формидин — одно из самых загадочных мест галактики. Его экстремальные условия породили уникальные формы жизни.

## 6. Elysian Shore

**Расстояние от Sol:** ~3 000 св. лет
**Особенности:** Разнообразие видов
**Рекомендуемые организмы:** Fungoida, Frutexa, Cactoida

Берег Элизиума — регион с мягким климатом и богатой фауной. Отличное место для длительных экспедиций.

## 7. Inner Orion Spur

**Расстояние от Sol:** ~1 000 св. лет
**Особенности:** Доступность, разнообразие
**Рекомендуемые организмы:** Bacteria, Tussock

Внутренняя часть шпор Ориона — ближайший к Sol регион с развитой экзобиологической активностью.

## 8. Outer Orion Spur

**Расстояние от Sol:** ~2 000 св. лет
**Особенности:** Неизведанные миры
**Рекомендуемые организмы:** Все типы

Внешняя часть шпор Ориона — граница исследованного пространства. Каждая планета здесь — потенциальное первооткрытие.

## 9. Temple Sector

**Расстояние от Sol:** ~8 000 св. лет
**Особенности:** Концентрация рецепт
**Рекомендуемые организмы:** Recepta, Concha

Сектор Temple — одно из немногих мест, где регулярно встречаются рецепты.

## 10. Acheron Region

**Расстояние от Sol:** ~15 000 св. лет
**Особенности:** Экстремофилы
**Рекомендуемые организмы:** Electricae, Stratum

Регион Ахерон — адские условия и соответствующая фауна. Только для опытных экзобиологов.

## Советы по планированию маршрута

- Используйте **EDSM** и **Spansh** для планирования маршрута
- Запасайтесь **материалами для FSD** — дальние регионы требуют много прыжков
- Рассмотрите **Fleet Carrier** как мобильную базу для длительных экспедиций
- Проверяйте **GalNet** — иногда появляются новости о недавних открытиях

---

*«Лучшая система для экзобиологии — та, на которой вы ещё не были.»* — CMDR FirstContact, 3307.$c$,
  v_cat_exo, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed: Top-10 systems', NOW());

-- ============================================================
-- 13. Экзобиология и ранг Elite
-- ============================================================
INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
VALUES (
  'Экзобиология и ранг Elite',
  'ekzobiologiya-i-rang-elite',
  $c$# Экзобиология и ранг Elite

**Тип:** Гайд
**Категория:** Экзобиология
**Время чтения:** 10 минут

## Введение

Достижение ранга **Elite** в дисциплине Exploration — одна из самых престижных целей для пилота. С введением экзобиологии этот путь стал не только более доступным, но и гораздо более увлекательным. Вместо бесконечного сканирования звёзд и планет теперь можно зарабатывать очки исследований, изучая инопланетную жизнь.

## Система рангов Exploration

| Ранг | Требуемый доход (CR) | Особенности |
|------|----------------------|-------------|
| Aimless | 0 | Стартовый ранг |
| Mostly Aimless | 40 000 | Первые шаги |
| Scout | 270 000 | Доступ к базовым миссиям |
| Surveyor | 1 140 000 | Продвинутое сканирование |
| Trailblazer | 4 200 000 | Доступ к специальным зонам |
| Pathfinder | 10 000 000 | Уважение сообщества |
| Ranger | 35 000 000 | Престижный статус |
| Pioneer | 116 000 000 | Элита исследователей |
| **Elite** | **320 000 000+** | **Вершина** |

## Как экзобиология ускоряет прогресс

### Сравнение доходности

| Действие | Средний доход |
|----------|---------------|
| Сканирование звезды (FSS) | 1 000 – 5 000 CR |
| Сканирование планеты (DSS) | 10 000 – 500 000 CR |
| Сканирование Earth-like | 500 000 – 1 500 000 CR |
| Сбор образца Bacteria | 1 000 000 – 10 000 000 CR |
| Сбор образца Electricae | 20 000 000 – 100 000 000 CR |
| Сбор образца Recepta | 30 000 000 – 150 000 000 CR |

Как видно из таблицы, один редкий организм может принести больше, чем сканирование десятков звёзд.

## Оптимальная стратегия

### Для начинающих (Aimless → Scout)

- Сканируйте все планеты в системе с помощью FSS
- Ищите планеты с биосигналами
- Собирайте **Bacteria** и **Frutexa** — легко найти, хорошо оплачиваются

### Для продвинутых (Surveyor → Pathfinder)

- Целенаправленно летите в системы с известной фауной
- Собирайте **Fungoida**, **Osseus**, **Tussock**
- Используйте **Neutron Highway** для быстрого перемещения

### Для опытных (Ranger → Elite)

- Организуйте экспедиции в **Colonia**, **Sanguineous Rim**
- Охотьтесь за **Electricae** и **Recepta**
- Становитесь первооткрывателем — бонус 50%

## Первооткрывательство

Если вы первым сканируете и собираете образцы организма на планете, вы становитесь **первооткрывателем**. Это даёт:

- **+50% к стоимости** данных
- **Вечное имя** в Galactic Codex
- **Престиж** в сообществе исследователей

## Советы от Elite-экзобиологов

1. **Не гонитесь за деньгами** — наслаждайтесь процессом
2. **Ведите журнал** — отмечайте интересные находки
3. **Делитесь координатами** — сообщество ценит щедрость
4. **Используйте Fleet Carrier** как мобильную базу
5. **Планируйте маршрут** — Spansh и EDSM ваши лучшие друзья

## Заключение

Экзобиология превратила Exploration из монотонного сканирования в увлекательное приключение. Каждая планета — это потенциальное открытие, каждый организм — уникален. И пусть путь к Elite долог, он того стоит.

---

*«Я достиг Elite в Exploration, собирая бактерии на задворках галактики. Лучшие 200 часов в моей жизни.»* — CMDR BioHunter, 3308.$c$,
  v_cat_exo, v_author_id, v_author_id, 'published', true, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed: Exobiology and Elite rank', NOW());

END $$;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260908020000_wiki_exobiology_update.sql           │
-- └────────────────────────────────────────────────────────────────┘

-- Заметка вместо миграции: обновление статей по экзобиологии (18 штук) делалось
-- через Management API, в SQL-виде контент лежит в
-- 20260908010000_wiki_exobiology.sql.
--
-- Раньше файл был просто набором комментариев: psql считает такой скрипт
-- успешно выполненным, миграция отмечалась применённой и ничего не делала — это
-- создавало иллюзию, что статья накатывается автоматически. Оставляем версию в
-- истории (как 20260903170000_fix_squadron_friends.sql), но с явным NOTICE.
DO $$
BEGIN
  RAISE NOTICE 'Exobiology articles are seeded by 20260908010000_wiki_exobiology.sql (content was uploaded via the Management API).';
END $$;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260909010000_fix_email_login_profile.sql          │
-- └────────────────────────────────────────────────────────────────┘

-- Исправление проблемы с загрузкой профиля при входе по email
-- Триггер теперь не создаёт профиль с пустым cmdr_name

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  v_cmdr_name text;
BEGIN
  -- Получаем cmdr_name из метаданных, только если оно не пустое
  v_cmdr_name := NULLIF(TRIM(NEW.raw_user_meta_data->>'cmdr_name'), '');
  
  INSERT INTO public.profiles (id, email, cmdr_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    v_cmdr_name,
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

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260911000000_raven_depot_snapshot_lookup.sql      │
-- └────────────────────────────────────────────────────────────────┘

-- Fast lookup of the newest complete Construction Depot journal snapshot for
-- the RavenColonial MarketID. Contribution rows have no full resource list and
-- are deliberately excluded from this index.
CREATE INDEX IF NOT EXISTS idx_colonisation_events_market_depot_timestamp
  ON public.colonisation_events (market_id, event_timestamp DESC)
  WHERE construction_id IS NOT NULL;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260911010000_delivery_import_idempotency.sql      │
-- └────────────────────────────────────────────────────────────────┘

-- Browser Journal imports and the Colonial Helper can resend a file/batch after
-- a timeout. Store a stable source key for new rows without rewriting every
-- legacy record in a production-sized deliveries table.
--
-- PostgreSQL permits multiple NULLs in a unique index, so legacy rows may stay
-- NULL while every new importer row carries a source_hash. Do not create that
-- potentially expensive unique index inside this transactional deploy
-- migration: use the explicitly named concurrent maintenance script after a
-- duplicate preflight during a quiet production window. Until then the API uses
-- a bounded existing-hash check for safe retry behaviour.
ALTER TABLE public.deliveries
  ADD COLUMN IF NOT EXISTS source_hash TEXT;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260911020000_precise_raven_progress.sql           │
-- └────────────────────────────────────────────────────────────────┘

-- RavenColonial returns a weighted completion percentage with two decimal
-- places. Preserve it in the cache and marker source tables so /map displays
-- the same progress as the live system detail page, rather than a rounded
-- integer (or a failed integer cast).
--
-- PostgreSQL records `UPDATE OF progress` and `WHEN (OLD.progress ...)`
-- references in trigger definitions.  Such a trigger prevents ALTER COLUMN
-- directly (for example trg_notify_route_system_change).  Snapshot every
-- user-defined trigger on each affected table, recreate it verbatim after the
-- type conversion, and leave internal FK triggers untouched.  The DO block is
-- atomic: if a conversion or recreation fails, PostgreSQL restores both the
-- original column type and the trigger definitions.
--
-- raven_sync_log is intentionally not converted here. It is an audit table,
-- not a source for map/detail progress, and deployments can expose it through
-- views such as latest_raven_sync. Its full project payload remains in JSON;
-- avoiding a view drop/recreate preserves that view's grants and definition.
DO $$
DECLARE
  target RECORD;
  saved_trigger RECORD;
  restore_commands TEXT[];
  restore_command TEXT;
BEGIN
  FOR target IN
    SELECT *
    FROM (
      VALUES
        ('system_progress', 'progress'),
        ('route_systems', 'progress'),
        ('hubs', 'progress')
    ) AS affected(table_name, column_name)
  LOOP
    -- It is safe to rerun after a partially attempted deployment.  Do not
    -- take table locks/recreate triggers when this exact target type exists.
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = target.table_name
        AND column_name = target.column_name
        AND data_type = 'numeric'
        AND numeric_precision = 7
        AND numeric_scale = 2
    )
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = target.table_name
        AND column_name = target.column_name
    ) THEN
      restore_commands := ARRAY[]::TEXT[];

      FOR saved_trigger IN
        SELECT tg.tgname, tg.tgenabled, pg_get_triggerdef(tg.oid, false) AS definition
        FROM pg_trigger AS tg
        INNER JOIN pg_class AS relation ON relation.oid = tg.tgrelid
        INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = target.table_name
          AND NOT tg.tgisinternal
      LOOP
        restore_commands := array_append(restore_commands, saved_trigger.definition);
        -- pg_get_triggerdef does not include a trigger's enabled mode.
        -- Preserve non-default disabled/replica/always settings as well.
        IF saved_trigger.tgenabled = 'D' THEN
          restore_commands := array_append(
            restore_commands,
            format('ALTER TABLE public.%I DISABLE TRIGGER %I', target.table_name, saved_trigger.tgname)
          );
        ELSIF saved_trigger.tgenabled = 'R' THEN
          restore_commands := array_append(
            restore_commands,
            format('ALTER TABLE public.%I ENABLE REPLICA TRIGGER %I', target.table_name, saved_trigger.tgname)
          );
        ELSIF saved_trigger.tgenabled = 'A' THEN
          restore_commands := array_append(
            restore_commands,
            format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', target.table_name, saved_trigger.tgname)
          );
        END IF;
        EXECUTE format('DROP TRIGGER %I ON public.%I', saved_trigger.tgname, target.table_name);
      END LOOP;

      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN %I TYPE NUMERIC(7,2) USING %I::NUMERIC(7,2)',
        target.table_name,
        target.column_name,
        target.column_name
      );

      FOREACH restore_command IN ARRAY restore_commands LOOP
        EXECUTE restore_command;
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260911030000_squadron_read_models_and_profile_sync.sql │
-- └────────────────────────────────────────────────────────────────┘

-- Restore the squadron read models expected by the application without
-- replacing an already working production view. Older installations contain
-- the base tables but never received the corresponding view DDL, which makes
-- profiles and squadron pages look as though a member has no squadron.
--
-- These views are compatibility read models only; the application also reads
-- the underlying tables so a PostgREST schema-cache delay cannot hide data.
-- The malformed historical migration also never reliably added/synchronised the
-- denormalised label used by project member cards, so ensure that small column
-- exists before installing its row-scoped triggers.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS squadron text;

DO $$
DECLARE
  membership_timestamp_column text;
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'squadron_members' AND column_name = 'joined_at'
    ) THEN 'joined_at'
    ELSE 'created_at'
  END INTO membership_timestamp_column;

  IF to_regclass('public.squadron_member_detail') IS NULL THEN
    EXECUTE format($view$
      CREATE VIEW public.squadron_member_detail
      WITH (security_invoker = true) AS
      SELECT
        sm.id,
        sm.squadron_id,
        sm.user_id,
        sm.rank_id,
        sm.callsign,
        sm.%1$I AS joined_at,
        sr.name AS rank_name,
        sr.sort_order AS rank_order,
        sr.is_default,
        sr.can_manage_projects,
        sr.can_manage_members,
        sr.can_manage_ranks,
        sr.can_edit_squadron,
        p.cmdr_name,
        p.avatar_url
      FROM public.squadron_members AS sm
      LEFT JOIN public.squadron_ranks AS sr ON sr.id = sm.rank_id
      LEFT JOIN public.profiles AS p ON p.id = sm.user_id
    $view$, membership_timestamp_column);
  END IF;

  IF to_regclass('public.squadron_summary') IS NULL THEN
    EXECUTE $view$
      CREATE VIEW public.squadron_summary
      WITH (security_invoker = true) AS
      SELECT
        sq.*,
        (
          SELECT count(*)::integer
          FROM public.squadron_members AS sm
          WHERE sm.squadron_id = sq.id
        ) AS member_count,
        (
          SELECT count(*)::integer
          FROM public.projects AS p
          WHERE p.squadron_id = sq.id
        ) AS project_count
      FROM public.squadrons AS sq
    $view$;
  END IF;

  IF to_regclass('public.project_summary') IS NULL THEN
    EXECUTE $view$
      CREATE VIEW public.project_summary
      WITH (security_invoker = true) AS
      SELECT
        p.*,
        (
          SELECT count(*)::integer
          FROM public.project_members AS pm
          WHERE pm.project_id = p.id
        ) AS member_count,
        (
          SELECT count(*)::integer
          FROM public.project_systems AS ps
          WHERE ps.project_id = p.id
        ) AS system_count,
        (
          SELECT count(*)::integer
          FROM public.project_systems AS ps
          WHERE ps.project_id = p.id AND ps.planned_status = 'done'
        ) AS systems_done,
        (
          SELECT count(*)::integer
          FROM public.project_systems AS ps
          WHERE ps.project_id = p.id AND ps.planned_status = 'building'
        ) AS systems_building,
        (
          SELECT max(ps.target_date)
          FROM public.project_systems AS ps
          WHERE ps.project_id = p.id
        ) AS latest_target_date
      FROM public.projects AS p
    $view$;
  END IF;

  -- A historical endpoint used this name, while newer endpoints use
  -- project_summary. Keep it as a simple alias for a zero-downtime rollout.
  IF to_regclass('public.squadron_projects') IS NULL THEN
    EXECUTE 'CREATE VIEW public.squadron_projects WITH (security_invoker = true) AS SELECT * FROM public.project_summary';
  END IF;
END $$;

GRANT SELECT ON public.squadron_member_detail, public.squadron_summary,
  public.project_summary, public.squadron_projects TO anon, authenticated;

-- Restore the creation trigger that was bundled into the malformed historical
-- migration. SECURITY DEFINER is necessary because a newly-created squadron
-- has no member yet, while normal RLS policies require membership to create
-- its first rank/member.
CREATE OR REPLACE FUNCTION public.create_default_squadron_ranks(p_squadron_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.squadron_ranks (
    squadron_id, name, sort_order, is_default,
    can_manage_projects, can_manage_members, can_manage_ranks, can_edit_squadron
  ) VALUES
    (p_squadron_id, 'Командир эскадрильи', 1, true, true, true, true, true),
    (p_squadron_id, 'Заместитель командира', 2, true, true, true, false, false),
    (p_squadron_id, 'Офицер', 3, true, true, true, false, false),
    (p_squadron_id, 'Ветеран', 4, true, true, false, false, false),
    (p_squadron_id, 'Пилот', 5, true, false, false, false, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_default_voice_rooms(p_squadron_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.squadron_voice_rooms (
    squadron_id, name, description, is_officer_only, sort_order
  ) VALUES
    (p_squadron_id, 'Общий канал', 'Общий голосовой канал для всех пилотов', false, 1),
    (p_squadron_id, 'Офицерский канал', 'Офицерский канал для командного состава', true, 2),
    (p_squadron_id, 'Оперативный канал', 'Канал для оперативных задач', false, 3);
END;
$$;

CREATE OR REPLACE FUNCTION public.on_squadron_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  commander_rank_id bigint;
BEGIN
  -- Explicitly select the bigint helpers even on an older integer-id schema
  -- where a prior, unsafe integer overload may still exist.
  PERFORM public.create_default_squadron_ranks(NEW.id::bigint);
  PERFORM public.create_default_voice_rooms(NEW.id::bigint);

  SELECT id INTO commander_rank_id
  FROM public.squadron_ranks
  WHERE squadron_id = NEW.id AND name = 'Командир эскадрильи'
  ORDER BY id
  LIMIT 1;

  IF commander_rank_id IS NOT NULL THEN
    INSERT INTO public.squadron_members (squadron_id, user_id, rank_id)
    VALUES (NEW.id, NEW.created_by, commander_rank_id)
    ON CONFLICT (squadron_id, user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_on_squadron_created ON public.squadrons;
DROP TRIGGER IF EXISTS on_squadron_created ON public.squadrons;
CREATE TRIGGER trg_on_squadron_created
  AFTER INSERT ON public.squadrons
  FOR EACH ROW EXECUTE FUNCTION public.on_squadron_created();

-- The profile.squadron label is a denormalised convenience field. Rebuild the
-- synchronization triggers with valid SQL and a constrained, security-definer
-- helper. No whole-table backfill is performed here: live pages resolve the
-- authoritative membership relation until an affected profile next changes.
CREATE OR REPLACE FUNCTION public.refresh_profile_squadron(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_squadron_name text;
BEGIN
  SELECT sq.name
  INTO current_squadron_name
  FROM public.squadron_members AS sm
  INNER JOIN public.squadrons AS sq ON sq.id = sm.squadron_id
  WHERE sm.user_id = p_user_id
  ORDER BY sm.id DESC
  LIMIT 1;

  UPDATE public.profiles AS p
  SET squadron = current_squadron_name
  WHERE p.id = p_user_id
    AND p.squadron IS DISTINCT FROM current_squadron_name;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_profile_squadron_from_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.refresh_profile_squadron(OLD.user_id);
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    PERFORM public.refresh_profile_squadron(OLD.user_id);
  END IF;
  PERFORM public.refresh_profile_squadron(NEW.user_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_profiles_after_squadron_rename()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.profiles AS p
  SET squadron = NEW.name
  WHERE p.squadron IS DISTINCT FROM NEW.name
    AND EXISTS (
      SELECT 1
      FROM public.squadron_members AS sm
      WHERE sm.user_id = p.id AND sm.squadron_id = NEW.id
    );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_profile_squadron_insert ON public.squadron_members;
DROP TRIGGER IF EXISTS trg_sync_profile_squadron_delete ON public.squadron_members;
DROP TRIGGER IF EXISTS trg_sync_profile_squadron_membership_insert ON public.squadron_members;
DROP TRIGGER IF EXISTS trg_sync_profile_squadron_membership_delete ON public.squadron_members;
DROP TRIGGER IF EXISTS trg_sync_profile_squadron_membership_update ON public.squadron_members;

CREATE TRIGGER trg_sync_profile_squadron_membership_insert
  AFTER INSERT ON public.squadron_members
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_squadron_from_membership();
CREATE TRIGGER trg_sync_profile_squadron_membership_delete
  AFTER DELETE ON public.squadron_members
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_squadron_from_membership();
CREATE TRIGGER trg_sync_profile_squadron_membership_update
  AFTER UPDATE OF squadron_id, user_id ON public.squadron_members
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_squadron_from_membership();

DROP TRIGGER IF EXISTS trg_sync_profiles_after_squadron_rename ON public.squadrons;
CREATE TRIGGER trg_sync_profiles_after_squadron_rename
  AFTER UPDATE OF name ON public.squadrons
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION public.sync_profiles_after_squadron_rename();

REVOKE ALL ON FUNCTION public.create_default_squadron_ranks(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_default_voice_rooms(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.on_squadron_created() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_profile_squadron(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_profile_squadron_from_membership() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_profiles_after_squadron_rename() FROM PUBLIC;

CREATE INDEX IF NOT EXISTS idx_squadron_members_user_squadron
  ON public.squadron_members (user_id, squadron_id);
CREATE INDEX IF NOT EXISTS idx_projects_squadron_id
  ON public.projects (squadron_id);

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260911040000_delivery_import_placement_resolver.sql │
-- └────────────────────────────────────────────────────────────────┘

-- Delivery imports used to download every hub and route-system row before each
-- batch. Resolve only the uploaded system names with indexed normalized keys.
-- The function is used by server-side/service-role import routes; normal users
-- cannot call it directly.
CREATE INDEX IF NOT EXISTS idx_hubs_normalized_system_name
  ON public.hubs ((lower(regexp_replace(btrim(system_name), '\s+', ' ', 'g'))));

CREATE INDEX IF NOT EXISTS idx_route_systems_normalized_system_name
  ON public.route_systems ((lower(regexp_replace(btrim(system_name), '\s+', ' ', 'g'))));

CREATE OR REPLACE FUNCTION public.resolve_delivery_system_placements(system_names text[])
RETURNS TABLE (
  input_system_name text,
  system_name text,
  is_hub boolean,
  route_system_id bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH raw_input_names AS (
    SELECT
      btrim(raw_name) AS input_system_name,
      lower(regexp_replace(btrim(raw_name), '\s+', ' ', 'g')) AS normalized_name,
      ordinal
    FROM unnest(system_names) WITH ORDINALITY AS names(raw_name, ordinal)
    WHERE raw_name IS NOT NULL AND btrim(raw_name) <> ''
  ),
  input_names AS (
    SELECT DISTINCT ON (normalized_name)
      input_system_name,
      normalized_name,
      ordinal
    FROM raw_input_names
    ORDER BY normalized_name, ordinal
  )
  SELECT
    input_names.input_system_name,
    COALESCE(hub.system_name, route_system.system_name, input_names.input_system_name) AS system_name,
    hub.system_name IS NOT NULL AS is_hub,
    route_system.id::bigint AS route_system_id
  FROM input_names
  LEFT JOIN LATERAL (
    SELECT h.system_name
    FROM public.hubs AS h
    WHERE lower(regexp_replace(btrim(h.system_name), '\s+', ' ', 'g')) = input_names.normalized_name
    ORDER BY h.id
    LIMIT 1
  ) AS hub ON true
  LEFT JOIN LATERAL (
    SELECT rs.id, rs.system_name
    FROM public.route_systems AS rs
    WHERE lower(regexp_replace(btrim(rs.system_name), '\s+', ' ', 'g')) = input_names.normalized_name
    ORDER BY rs.id
    LIMIT 1
  ) AS route_system ON true;
$$;

REVOKE ALL ON FUNCTION public.resolve_delivery_system_placements(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_delivery_system_placements(text[]) TO service_role;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260911050000_delivery_import_indexes.sql          │
-- └────────────────────────────────────────────────────────────────┘

-- Keep retry/idempotency lookups bounded for large delivery histories.
-- The importer falls back to checking existing source hashes when the optional
-- unique constraint is not present; without this index that query scans the
-- entire deliveries table and can hit the database statement timeout.
CREATE INDEX IF NOT EXISTS idx_deliveries_user_source_hash
  ON public.deliveries (user_id, source_hash)
  WHERE source_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deliveries_user_delivered_at
  ON public.deliveries (user_id, delivered_at);

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260911060000_project_system_coordinates.sql       │
-- └────────────────────────────────────────────────────────────────┘

-- Project systems need their own coordinates. They must not depend on the
-- global route_systems table: a squadron project can contain systems that are
-- not part of the global route.
ALTER TABLE public.project_systems
  ADD COLUMN IF NOT EXISTS x NUMERIC,
  ADD COLUMN IF NOT EXISTS y NUMERIC,
  ADD COLUMN IF NOT EXISTS z NUMERIC;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260912000000_atlas_ring_system_cache.sql          │
-- └────────────────────────────────────────────────────────────────┘

-- Cache of EDSM systems discovered while building the galactic ring route.
CREATE TABLE IF NOT EXISTS public.atlas_ring_system_cache (
  system_name text PRIMARY KEY,
  x double precision NOT NULL,
  y double precision NOT NULL,
  z double precision NOT NULL,
  source text NOT NULL DEFAULT 'edsm',
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_atlas_ring_cache_coordinates
  ON public.atlas_ring_system_cache (x, y, z);

ALTER TABLE public.atlas_ring_system_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS atlas_ring_cache_select ON public.atlas_ring_system_cache;
CREATE POLICY atlas_ring_cache_select ON public.atlas_ring_system_cache
  FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.atlas_ring_system_cache TO anon, authenticated;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260915000000_galnet_translations.sql              │
-- └────────────────────────────────────────────────────────────────┘

-- ============================================================
-- GALNET_NEWS / NEWS — колонки переводов и поля для инкрементальной синхронизации
--
-- Эти колонки уже использовались кодом (src/lib/translate.ts,
-- src/app/api/galnet/route.ts), но не были описаны ни в одной миграции:
-- из-за этого на свежей базе вставка статьи падала с
-- "Could not find the 'translation_status' column of 'galnet_news'".
--
-- Миграция идемпотентна: её можно запускать повторно.
-- ============================================================

-- ── galnet_news ────────────────────────────────────────────
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS guid TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS source_lang TEXT DEFAULT 'en';
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS translation_status TEXT DEFAULT 'pending';
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS translated_at TIMESTAMPTZ;

ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS title_ru TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS title_en TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS title_de TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS title_it TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS title_ko TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS title_zh TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS title_ja TEXT;

ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS body_ru TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS body_en TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS body_de TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS body_it TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS body_ko TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS body_zh TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS body_ja TEXT;

-- Оригинал всегда доступен в колонках исходного языка.
UPDATE public.galnet_news SET title_en = title WHERE title_en IS NULL AND title IS NOT NULL;
UPDATE public.galnet_news SET body_en = body   WHERE body_en IS NULL AND body IS NOT NULL;

-- Существующие переводы помечаем как завершённые.
UPDATE public.galnet_news
   SET translation_status = 'completed',
       translated_at = COALESCE(translated_at, NOW())
 WHERE translated_at IS NOT NULL
   AND COALESCE(translation_status, 'pending') <> 'completed';

UPDATE public.galnet_news
   SET translation_status = 'pending'
 WHERE translation_status IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_galnet_guid ON public.galnet_news(guid) WHERE guid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_galnet_slug ON public.galnet_news(slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_galnet_translation_status ON public.galnet_news(translation_status);

-- ── news ───────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.news') IS NOT NULL THEN
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS translation_status TEXT DEFAULT 'pending';
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS translated_at TIMESTAMPTZ;

    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS title_ru TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS title_en TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS title_de TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS title_it TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS title_ko TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS title_zh TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS title_ja TEXT;

    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS body_ru TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS body_en TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS body_de TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS body_it TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS body_ko TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS body_zh TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS body_ja TEXT;

    UPDATE public.news
       SET translation_status = 'completed',
           translated_at = COALESCE(translated_at, NOW())
     WHERE translated_at IS NOT NULL
       AND COALESCE(translation_status, 'pending') <> 'completed';

    UPDATE public.news SET translation_status = 'pending' WHERE translation_status IS NULL;

    CREATE INDEX IF NOT EXISTS idx_news_translation_status ON public.news(translation_status);
  END IF;
END $$;

-- ── galnet_sync_log — расширяем под новые отчёты ───────────
ALTER TABLE public.galnet_sync_log ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE public.galnet_sync_log ADD COLUMN IF NOT EXISTS translated_count INTEGER DEFAULT 0;
ALTER TABLE public.galnet_sync_log ADD COLUMN IF NOT EXISTS updated_count INTEGER DEFAULT 0;

-- Права на чтение лога (пишет сервисный ключ, он обходит RLS).
GRANT SELECT ON public.galnet_news TO anon, authenticated;
GRANT SELECT ON public.galnet_sync_log TO anon, authenticated;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260916000000_system_scans_and_pilot_dossier.sql   │
-- └────────────────────────────────────────────────────────────────┘

-- ═══════════════════════════════════════════════════════════════
-- Migration 036: System Scans Cache & Pilot Dossier Exploration Stats
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. system_scans: Кэш сканирования систем и тел (журнал, EDSM, хелпер) ───
CREATE TABLE IF NOT EXISTS public.system_scans (
  id BIGSERIAL PRIMARY KEY,
  system_name TEXT NOT NULL,
  body_name TEXT NOT NULL,
  body_id INTEGER,
  body_type TEXT,
  sub_type TEXT,
  distance_ls DOUBLE PRECISION DEFAULT 0,
  parents JSONB DEFAULT '[]'::jsonb,
  radius_m DOUBLE PRECISION DEFAULT 0,
  gravity DOUBLE PRECISION DEFAULT 0,
  earth_masses DOUBLE PRECISION DEFAULT 0,
  surface_temp_k DOUBLE PRECISION DEFAULT 0,
  surface_pressure DOUBLE PRECISION DEFAULT 0,
  volcanism TEXT,
  atmosphere TEXT,
  atmosphere_type TEXT,
  atmosphere_composition JSONB DEFAULT '[]'::jsonb,
  solid_composition JSONB DEFAULT '[]'::jsonb,
  materials JSONB DEFAULT '[]'::jsonb,
  rings JSONB DEFAULT '[]'::jsonb,
  is_landable BOOLEAN DEFAULT false,
  bio_signals_count INTEGER DEFAULT 0,
  bio_genuses JSONB DEFAULT '[]'::jsonb,
  first_discovered_by TEXT,
  first_mapped_by TEXT,
  first_footfall_by TEXT,
  scanned_by_cmdr TEXT,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  source TEXT DEFAULT 'journal',
  raw_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT system_scans_system_body_uniq UNIQUE (system_name, body_name)
);

CREATE INDEX IF NOT EXISTS idx_system_scans_system_name ON public.system_scans (system_name);
CREATE INDEX IF NOT EXISTS idx_system_scans_scanned_by_cmdr ON public.system_scans (scanned_by_cmdr);
CREATE INDEX IF NOT EXISTS idx_system_scans_updated_at ON public.system_scans (updated_at);

ALTER TABLE public.system_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS system_scans_select ON public.system_scans;
CREATE POLICY system_scans_select ON public.system_scans
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS system_scans_insert ON public.system_scans;
CREATE POLICY system_scans_insert ON public.system_scans
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS system_scans_update ON public.system_scans;
CREATE POLICY system_scans_update ON public.system_scans
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON public.system_scans TO anon, authenticated;

-- ─── 2. Расширение capi_profiles: Балансы, ARX, Монеты наемников и Статистика находок ───
ALTER TABLE public.capi_profiles
  ADD COLUMN IF NOT EXISTS arx BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mercenary_coins BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mercenary_rank INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exobiologist_rank INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_discoveries_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_mapped_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_footfalls_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bio_samples_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bio_species_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bio_value_cr BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exploration_stats JSONB DEFAULT '{}'::jsonb;

-- ─── 3. pilot_stats: Автономная таблица статистики пилота для Colonial Helper ───
CREATE TABLE IF NOT EXISTS public.pilot_stats (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cmdr_name TEXT,
  credits BIGINT DEFAULT 0,
  arx BIGINT DEFAULT 0,
  mercenary_coins BIGINT DEFAULT 0,
  mercenary_rank INTEGER DEFAULT 0,
  exobiologist_rank INTEGER DEFAULT 0,
  first_discoveries_count INTEGER DEFAULT 0,
  first_mapped_count INTEGER DEFAULT 0,
  first_footfalls_count INTEGER DEFAULT 0,
  bio_samples_count INTEGER DEFAULT 0,
  bio_species_count INTEGER DEFAULT 0,
  bio_value_cr BIGINT DEFAULT 0,
  exploration_stats JSONB DEFAULT '{}'::jsonb,
  last_updated TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_pilot_stats_cmdr ON public.pilot_stats (cmdr_name);

ALTER TABLE public.pilot_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pilot_stats_select ON public.pilot_stats;
CREATE POLICY pilot_stats_select ON public.pilot_stats
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS pilot_stats_upsert ON public.pilot_stats;
CREATE POLICY pilot_stats_upsert ON public.pilot_stats
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE ON public.pilot_stats TO anon, authenticated;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260917000000_deliveries_transport_scope.sql       │
-- └────────────────────────────────────────────────────────────────┘

-- ═══════════════════════════════════════════════════════════════
-- Доставки: различаем «весь перевезённый груз» и «завезено на стройплощадку»
-- ═══════════════════════════════════════════════════════════════
--
-- Досье пилота показывает две разные метрики:
--   • «Всего тонн»  — весь груз, который командир перевёз за всё время
--     (колонизационные поставки, склад крыла, продажа на авианосце,
--      грузовые миссии, Powerplay, Search and Rescue);
--   • «На стройплощадки» — только то, что реально ушло на проекты.
--
-- До этой миграции таблица хранила только доставленный груз, и различить
-- источники было нечем. Старые строки остаются с NULL: исторически в
-- `deliveries` попадали только колонизационные поставки, поэтому NULL
-- трактуется как «на стройку» (см. `is_construction IS DISTINCT FROM false`).
-- Новые импорты пишут признак явно.

ALTER TABLE public.deliveries
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS is_construction BOOLEAN,
  ADD COLUMN IF NOT EXISTS market_id TEXT;

COMMENT ON COLUMN public.deliveries.source IS
  'Колонка журнала-источник: colonisation_contribution | cargo_depot | cargo_delta | carrier_delivery | mission_delivery | powerplay_delivery | rescue_delivery';
COMMENT ON COLUMN public.deliveries.is_construction IS
  'NULL — исторические строки (считаются поставкой на стройку); false — перевозка, не относящаяся к проектам';

-- Агрегация досье идёт по пользователю и признаку «стройка»: частичный индекс
-- держит сумму «только стройплощадки» дешёвой даже на большой таблице.
CREATE INDEX IF NOT EXISTS idx_deliveries_user_construction
  ON public.deliveries (user_id, delivered_at DESC)
  WHERE is_construction IS DISTINCT FROM false;

CREATE INDEX IF NOT EXISTS idx_deliveries_user_source
  ON public.deliveries (user_id, source)
  WHERE source IS NOT NULL;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260918000000_deliveries_cargo_scope.sql           │
-- └────────────────────────────────────────────────────────────────┘

-- ═══════════════════════════════════════════════════════════════
-- Доставки: КУДА именно ушёл груз (стройплощадка / колонизационный корабль /
-- авианосец / грузовая миссия / рынок / Powerplay / SAR)
-- ═══════════════════════════════════════════════════════════════
--
-- Миграция `20260917000000_deliveries_transport_scope` развела «весь
-- перевозимый груз» и «завезено на стройплощадку» булевым `is_construction`.
-- Этого мало: досье обязано показывать структуру перевозок — сколько ушло на
-- площадки колонизационных проектов, сколько на колонизационные корабли
-- («System Colonisation Ship»), сколько отгружено авианосцам, сколько
-- перевезено грузовыми миссиями и сколько просто продано на рынках.
--
-- Значения `delivery_kind` (зеркало `src/lib/cargoScope.ts::DeliveryKind`):
--   construction_site | colonisation_ship | fleet_carrier | mission_delivery
--   | powerplay_delivery | rescue_delivery | market_sale | legacy_site
--
-- `station_name`/`station_kind` — станция, у которой сдан груз: по ним видно,
-- почему строка отнесена к тому или иному виду, и по ним же можно
-- пересчитать историю, когда правила классификации уточняются.

ALTER TABLE public.deliveries
  ADD COLUMN IF NOT EXISTS delivery_kind TEXT,
  ADD COLUMN IF NOT EXISTS station_name TEXT,
  ADD COLUMN IF NOT EXISTS station_kind TEXT;

COMMENT ON COLUMN public.deliveries.delivery_kind IS
  'Куда сдан груз: construction_site | colonisation_ship | fleet_carrier | mission_delivery | powerplay_delivery | rescue_delivery | market_sale | legacy_site';
COMMENT ON COLUMN public.deliveries.station_kind IS
  'Вид станции из Docked/Market: construction_site | colonisation_ship | fleet_carrier | station | outpost | surface | megaship';

-- Строки без `delivery_kind` наследуют смысл из `source`/`is_construction`:
-- исторические (NULL признак) считаются поставкой на стройку, новые — по
-- явному `is_construction`. Вью держит это правило в одном месте, чтобы и
-- досье, и любые будущие отчёты не расходились.
CREATE OR REPLACE VIEW public.delivery_scope_summary AS
SELECT
  user_id,
  COALESCE(
    delivery_kind,
    CASE
      WHEN is_construction IS DISTINCT FROM false THEN 'legacy_site'
      WHEN source = 'carrier_delivery' THEN 'fleet_carrier'
      WHEN source IN ('mission_delivery', 'cargo_depot') THEN 'mission_delivery'
      WHEN source = 'powerplay_delivery' THEN 'powerplay_delivery'
      WHEN source = 'rescue_delivery' THEN 'rescue_delivery'
      ELSE 'market_sale'
    END
  ) AS kind,
  COALESCE(SUM(GREATEST(amount, 0)), 0) AS tons,
  COUNT(*) FILTER (WHERE amount > 0) AS ops
FROM public.deliveries
GROUP BY 1, 2;

COMMENT ON VIEW public.delivery_scope_summary IS
  'Тоннаж и число поставок пользователя в разбивке по получателю груза';

-- Структура перевозок читается одним запросом на досье: частичный индекс
-- держит дешёвой и «только стройку», и группировку по видам.
CREATE INDEX IF NOT EXISTS idx_deliveries_user_kind
  ON public.deliveries (user_id, delivery_kind)
  WHERE delivery_kind IS NOT NULL;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260918010000_profile_privacy_settings.sql         │
-- └────────────────────────────────────────────────────────────────┘

-- ═══════════════════════════════════════════════════════════════
-- Конфиденциальность досье пилота
-- ═══════════════════════════════════════════════════════════════
--
-- Досье командира публично: его читает любой посетитель страницы
-- `/cmdr/[name]`. Раньше публичными были и чувствительные числа — баланс
-- кредитов, ARX, ранги, текущее положение корабля и история поставок. Теперь
-- командир сам решает, что показывать.
--
-- Настройки хранятся одним JSONB-столбцом: добавление нового переключателя не
-- должно требовать миграции. Отсутствующий ключ трактуется как «показывать»
-- (см. `src/lib/privacy.ts`), поэтому существующие профили ничего не теряют.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS privacy_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.profiles.privacy_settings IS
  'Публичность блоков досье: balance, ranks, cargo, deliveries, location. Отсутствующий ключ = показывать';

-- ─── Доступ к чувствительным таблицам ───────────────────────────────────────
--
-- `pilot_stats` читалась кем угодно (`USING (true)` в миграции
-- 20260916000000): настройки приватности можно было обойти прямым запросом к
-- базе, минуя досье. Теперь таблицу видит только владелец, а публичное досье
-- собирает сервер через service-role клиент и сам решает, какие поля отдать
-- (`src/lib/privacy.ts::publicPilotView`).

DROP POLICY IF EXISTS pilot_stats_select ON public.pilot_stats;
CREATE POLICY pilot_stats_select ON public.pilot_stats
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS pilot_stats_upsert ON public.pilot_stats;
CREATE POLICY pilot_stats_upsert ON public.pilot_stats
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- `capi_profiles` видна владельцу и одноэскадрильцам: это нужно живой карте
-- эскадрильи. Но если командир выключил публичность положения или статистики,
-- чужие глаза не должны видеть соответствующие колонки — их отсекает сервер,
-- а здесь остаётся правило «свой или свой по эскадрилье».
DROP POLICY IF EXISTS capi_profiles_select_own ON public.capi_profiles;
CREATE POLICY capi_profiles_select_own ON public.capi_profiles
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS capi_profiles_select_squadron ON public.capi_profiles;
CREATE POLICY capi_profiles_select_squadron ON public.capi_profiles
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1
      FROM public.squadron_members sm
      WHERE sm.user_id = capi_profiles.user_id
        AND EXISTS (
          SELECT 1 FROM public.squadron_members sm2
          WHERE sm2.user_id = auth.uid()
            AND sm2.squadron_id = sm.squadron_id
        )
    )
    AND COALESCE(
      (SELECT (p.privacy_settings ->> 'location')::boolean
         FROM public.profiles p
        WHERE p.id = capi_profiles.user_id),
      true
    )
  );

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260918020000_pilot_stats_capi_fields.sql          │
-- └────────────────────────────────────────────────────────────────┘

-- ─────────────────────────────────────────────────────────────
-- Досье пилота: боевые/торговые/исследовательские ранги и текущее
-- положение в pilot_stats.
--
-- Зачем: ранги Combat/Trade/Explore/фракций и текущая система/станция живут
-- только в capi_profiles, а эта таблица заполняется исключительно при
-- авторизации сайта через Frontier CAPI. Colonial Helper теперь умеет
-- получать профиль из CAPI сам (авторизация PKCE, без Shared Key от FDEV) и
-- отправляет его через POST /api/cmdr/stats — без этих колонок данные молча
-- терялись, а досье показывало «—».
--
-- Колонки добавляются NULL'ами: у существующих записей их не было, и
-- отличать «нет данных» от нуля важно (см. /api/cmdr/stats — поле
-- присутствует в upsert только если пришло в payload).
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.pilot_stats
  ADD COLUMN IF NOT EXISTS combat_rank     INTEGER,
  ADD COLUMN IF NOT EXISTS trade_rank      INTEGER,
  ADD COLUMN IF NOT EXISTS explore_rank    INTEGER,
  ADD COLUMN IF NOT EXISTS empire_rank     INTEGER,
  ADD COLUMN IF NOT EXISTS federation_rank INTEGER,
  ADD COLUMN IF NOT EXISTS current_ship    TEXT,
  ADD COLUMN IF NOT EXISTS current_system  TEXT,
  ADD COLUMN IF NOT EXISTS current_station TEXT;

-- Индекс для поиска досье по системе (эскадрилья: кто где сейчас).
CREATE INDEX IF NOT EXISTS idx_pilot_stats_system
  ON public.pilot_stats (current_system)
  WHERE current_system IS NOT NULL;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260919000000_delivery_import_timeout_hardening.sql │
-- └────────────────────────────────────────────────────────────────┘

-- Импорт журнала падал с «canceling statement due to statement timeout» на
-- больших историях доставок.
--
-- Миграция `20260911040000_delivery_import_placement_resolver.sql` создала
-- индексы только на НОРМАЛИЗОВАННОЕ имя системы:
--   ((lower(regexp_replace(btrim(system_name), '\s+', ' ', 'g'))))
-- Они обслуживают RPC `resolve_delivery_system_placements`. Но резервный путь
-- `loadExactPlacementLookup` (и прямой поиск хабов/маршрутов в том же потоке)
-- фильтрует по ТОЧНОМУ `system_name`:
--   WHERE system_name IN (...)
-- под который ни один из этих индексов не подходит. Без обычного индекса каждый
-- такой запрос сканирует таблицу целиком, а Supabase обрывает запрос по
-- `statement_timeout` через несколько секунд.
--
-- Индексы намеренно не уникальные: дубликаты имён в hubs/route_systems
-- допустимы исторически, и миграция не имеет права на них падать.
CREATE INDEX IF NOT EXISTS idx_hubs_system_name
  ON public.hubs (system_name);

CREATE INDEX IF NOT EXISTS idx_route_systems_system_name
  ON public.route_systems (system_name);

-- Запрос существующих `source_hash` опирается на частичный индекс
-- `idx_deliveries_user_source_hash ... WHERE source_hash IS NOT NULL`.
-- API теперь добавляет в запрос явный `source_hash IS NOT NULL`, чтобы
-- планировщик гарантированно применял частичный индекс; этот обычный индекс —
-- страховка для старых развёртываний API, которые фильтр ещё не добавляют.
CREATE INDEX IF NOT EXISTS idx_deliveries_user_source_hash_full
  ON public.deliveries (user_id, source_hash);

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260920000000_site_content_translations.sql        │
-- └────────────────────────────────────────────────────────────────┘

-- site_content: колонки переводов (ru/en/de/it/ko/zh/ja).
-- Ранее жило только в неучтённых файлах migrations/ и supabase/ — теперь
-- это обычная миграция. Идемпотентна.

ALTER TABLE site_content
  ADD COLUMN IF NOT EXISTS kicker_ru text,
  ADD COLUMN IF NOT EXISTS kicker_en text,
  ADD COLUMN IF NOT EXISTS kicker_de text,
  ADD COLUMN IF NOT EXISTS kicker_it text,
  ADD COLUMN IF NOT EXISTS kicker_ko text,
  ADD COLUMN IF NOT EXISTS kicker_zh text,
  ADD COLUMN IF NOT EXISTS kicker_ja text,
  ADD COLUMN IF NOT EXISTS title1_ru text,
  ADD COLUMN IF NOT EXISTS title1_en text,
  ADD COLUMN IF NOT EXISTS title1_de text,
  ADD COLUMN IF NOT EXISTS title1_it text,
  ADD COLUMN IF NOT EXISTS title1_ko text,
  ADD COLUMN IF NOT EXISTS title1_zh text,
  ADD COLUMN IF NOT EXISTS title1_ja text,
  ADD COLUMN IF NOT EXISTS title2_ru text,
  ADD COLUMN IF NOT EXISTS title2_en text,
  ADD COLUMN IF NOT EXISTS title2_de text,
  ADD COLUMN IF NOT EXISTS title2_it text,
  ADD COLUMN IF NOT EXISTS title2_ko text,
  ADD COLUMN IF NOT EXISTS title2_zh text,
  ADD COLUMN IF NOT EXISTS title2_ja text,
  ADD COLUMN IF NOT EXISTS manifest_ru text,
  ADD COLUMN IF NOT EXISTS manifest_en text,
  ADD COLUMN IF NOT EXISTS manifest_de text,
  ADD COLUMN IF NOT EXISTS manifest_it text,
  ADD COLUMN IF NOT EXISTS manifest_ko text,
  ADD COLUMN IF NOT EXISTS manifest_zh text,
  ADD COLUMN IF NOT EXISTS manifest_ja text;

-- Copy existing values as Russian defaults
UPDATE site_content SET
  kicker_ru = kicker,
  title1_ru = title1,
  title2_ru = title2,
  manifest_ru = manifest
WHERE id = 1;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260921000000_billing_and_premium_shop.sql         │
-- └────────────────────────────────────────────────────────────────┘

-- ============================================================================
-- 20260921000000_billing_and_premium_shop.sql
-- ED Ring Colony — Billing, Subscription Management, Analytics & Premium Shop
-- ============================================================================

-- 1. Тарифные планы подписок
CREATE TABLE IF NOT EXISTS public.billing_plans (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  name_en         TEXT,
  description     TEXT,
  description_en  TEXT,
  price_rub       INTEGER NOT NULL DEFAULT 0,
  price_credits   INTEGER NOT NULL DEFAULT 0,
  period_days     INTEGER NOT NULL DEFAULT 30,
  perks           JSONB NOT NULL DEFAULT '[]'::jsonb,
  badge_label     TEXT,
  color           TEXT DEFAULT '#e67e22',
  is_active       BOOLEAN DEFAULT true,
  is_popular      BOOLEAN DEFAULT false,
  display_order   INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- 2. Подписки пользователей
CREATE TABLE IF NOT EXISTS public.user_subscriptions (
  id              TEXT PRIMARY KEY,
  user_id         UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  cmdr_name       TEXT,
  plan_id         TEXT REFERENCES public.billing_plans(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'active', -- 'active', 'trial', 'canceled', 'expired'
  started_at      TIMESTAMPTZ DEFAULT now(),
  expires_at      TIMESTAMPTZ,
  auto_renew      BOOLEAN DEFAULT true,
  payment_method  TEXT DEFAULT 'card',
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON public.user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON public.user_subscriptions(status);

-- 3. Предметы премиум-магазина (украшения UI)
CREATE TABLE IF NOT EXISTS public.shop_items (
  id                      TEXT PRIMARY KEY,
  category                TEXT NOT NULL, -- 'frame', 'badge', 'skin', 'glow', 'title'
  title                   TEXT NOT NULL,
  title_en                TEXT,
  description             TEXT,
  description_en          TEXT,
  price_credits           INTEGER NOT NULL DEFAULT 0,
  price_rub               INTEGER NOT NULL DEFAULT 0,
  rarity                  TEXT NOT NULL DEFAULT 'common', -- 'common', 'rare', 'epic', 'legendary'
  requires_subscription   TEXT, -- null or plan_id (e.g. 'elite', 'admiral')
  subscriber_discount_pct INTEGER DEFAULT 0,
  preview_data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active               BOOLEAN DEFAULT true,
  is_featured             BOOLEAN DEFAULT false,
  sales_count             INTEGER DEFAULT 0,
  created_at              TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_items_category ON public.shop_items(category);
CREATE INDEX IF NOT EXISTS idx_shop_items_active ON public.shop_items(is_active);

-- 4. Инвентарь покупок пользователя
CREATE TABLE IF NOT EXISTS public.user_inventory (
  id                  TEXT PRIMARY KEY,
  user_id             UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  item_id             TEXT REFERENCES public.shop_items(id) ON DELETE CASCADE,
  purchased_at        TIMESTAMPTZ DEFAULT now(),
  price_paid_credits  INTEGER DEFAULT 0,
  price_paid_rub      NUMERIC(10,2) DEFAULT 0,
  transaction_id      TEXT,
  is_equipped         BOOLEAN DEFAULT false,
  UNIQUE(user_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_user_inventory_user_id ON public.user_inventory(user_id);

-- 5. Экипированные украшения интерфейса
CREATE TABLE IF NOT EXISTS public.user_cosmetics_equipped (
  user_id         UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  frame_id        TEXT REFERENCES public.shop_items(id) ON DELETE SET NULL,
  badge_id        TEXT REFERENCES public.shop_items(id) ON DELETE SET NULL,
  skin_id         TEXT REFERENCES public.shop_items(id) ON DELETE SET NULL,
  glow_id         TEXT REFERENCES public.shop_items(id) ON DELETE SET NULL,
  title_id        TEXT REFERENCES public.shop_items(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- 6. Финансовые и внутриигровые транзакции
CREATE TABLE IF NOT EXISTS public.billing_transactions (
  id              TEXT PRIMARY KEY,
  user_id         UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  cmdr_name       TEXT,
  type            TEXT NOT NULL, -- 'subscription', 'shop_purchase', 'credit_topup', 'refund', 'admin_grant'
  item_or_plan_id TEXT,
  item_title      TEXT,
  amount_rub      NUMERIC(10,2) DEFAULT 0,
  amount_credits  INTEGER DEFAULT 0,
  payment_method  TEXT DEFAULT 'card', -- 'card', 'sbp', 'credits', 'admin', 'crypto'
  status          TEXT NOT NULL DEFAULT 'completed', -- 'completed', 'pending', 'refunded', 'failed'
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_tx_user_id ON public.billing_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_billing_tx_type ON public.billing_transactions(type);
CREATE INDEX IF NOT EXISTS idx_billing_tx_created ON public.billing_transactions(created_at DESC);

-- 7. Баланс очков/кредитов пользователя
CREATE TABLE IF NOT EXISTS public.user_balances (
  user_id               UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  credits               INTEGER NOT NULL DEFAULT 1500,
  total_spent_rub       NUMERIC(10,2) DEFAULT 0,
  total_spent_credits   INTEGER DEFAULT 0,
  updated_at            TIMESTAMPTZ DEFAULT now()
);

-- RLS Policies
ALTER TABLE public.billing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_cosmetics_equipped ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_balances ENABLE ROW LEVEL SECURITY;

-- Plans & shop items can be read by everyone
CREATE POLICY "billing_plans_read" ON public.billing_plans FOR SELECT USING (true);
CREATE POLICY "shop_items_read" ON public.shop_items FOR SELECT USING (true);

-- Subscriptions: users can read their own, admins can read/write all
CREATE POLICY "user_subscriptions_read_own" ON public.user_subscriptions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "user_inventory_read_own" ON public.user_inventory FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "user_cosmetics_read_public" ON public.user_cosmetics_equipped FOR SELECT USING (true);
CREATE POLICY "user_balances_read_own" ON public.user_balances FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "billing_transactions_read_own" ON public.billing_transactions FOR SELECT USING (auth.uid() = user_id);

-- End of migration

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260921120000_galaxy_systems.sql                   │
-- └────────────────────────────────────────────────────────────────┘

-- ════════════════════════════════════════════════════════════════
-- Migration: Spansh Galaxy Systems
-- Источник данных: полный ночной дамп https://spansh.co.uk/dumps
--   (systems.json.gz — «Just system details (no bodies or stations)»,
--    формат BriefDumpSystem: id64, name, mainStar, coords{x,y,z},
--    needsPermit, updateTime — одна система на строку).
-- Загрузка: `npm run spansh:import` (scripts/import-spansh-systems.mjs).
-- ════════════════════════════════════════════════════════════════

-- ─── Все известные системы галактики (координаты — в той же системе,
--     что и на сайте: Sol = (0,0,0), SgrA = (25.21875, -20.90625, 25899.96875) ───
CREATE TABLE IF NOT EXISTS galaxy_systems (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id64 TEXT NOT NULL,                          -- Spansh ID64 (до 2^64 → строка)
  name TEXT NOT NULL,                          -- каноническое имя из Spansh
  name_lc TEXT NOT NULL,                       -- нормализованный ключ поиска (lower, сжатие пробелов)
  x DOUBLE PRECISION NOT NULL,
  y DOUBLE PRECISION NOT NULL,
  z DOUBLE PRECISION NOT NULL,
  main_star TEXT,                              -- сырой класс главной звезды, напр. 'G (White-Yellow) Star'
  star_type TEXT,                              -- нормализованный класс: o|b|a|f|g|k|m|brown_dwarf|neutron|black_hole|white_dwarf|wolf_rayet|herbig_ae_be|t_tauri|carbon|unknown
  star_giant_class TEXT,                       -- dwarf|giant|supergiant (для обычных классов), NULL для экзотических
  needs_permit BOOLEAN,
  distance_from_sols DOUBLE PRECISION,         -- ly, Sol = (0,0,0)
  distance_from_sgra DOUBLE PRECISION,         -- ly до Sagittarius A*
  updated_at TIMESTAMPTZ,                      -- updateTime из дампа (последнее обновление системы)
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Uniqueness: дамп не содержит дублей, но повторный импорт идёт как upsert
CREATE UNIQUE INDEX IF NOT EXISTS uq_galaxy_systems_id64 ON galaxy_systems(id64);
CREATE UNIQUE INDEX IF NOT EXISTS uq_galaxy_systems_name_lc ON galaxy_systems(name_lc);

-- Cube-запросы атласа (x/y/z BETWEEN …): три b-tree + bitmap AND
CREATE INDEX IF NOT EXISTS idx_galaxy_systems_x ON galaxy_systems(x);
CREATE INDEX IF NOT EXISTS idx_galaxy_systems_y ON galaxy_systems(y);
CREATE INDEX IF NOT EXISTS idx_galaxy_systems_z ON galaxy_systems(z);

-- Поиск по типу звезды (атлас: нейтроны/чёрные дыры/карлики и т.п.)
CREATE INDEX IF NOT EXISTS idx_galaxy_systems_star_type ON galaxy_systems(star_type);
CREATE INDEX IF NOT EXISTS idx_galaxy_systems_star_giant_class ON galaxy_systems(star_giant_class);

-- ─── Метаданные последней загрузки (для «DB ready»-гated логики и UI) ───
CREATE TABLE IF NOT EXISTS galaxy_systems_meta (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── RLS: открытое чтение (справочные данные), запись только через service role ───
ALTER TABLE galaxy_systems ENABLE ROW LEVEL SECURITY;
ALTER TABLE galaxy_systems_meta ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'galaxy_systems' AND policyname = 'galaxy_systems_public'
  ) THEN
    CREATE POLICY galaxy_systems_public ON galaxy_systems FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'galaxy_systems_meta' AND policyname = 'galaxy_systems_meta_public'
  ) THEN
    CREATE POLICY galaxy_systems_meta_public ON galaxy_systems_meta FOR SELECT USING (true);
  END IF;
END $$;

COMMENT ON TABLE galaxy_systems IS 'Все известные системы Elite Dangerous (ночной дамп Spansh, scripts/import-spansh-systems.mjs)';
COMMENT ON TABLE galaxy_systems_meta IS 'Метаданные последней загрузки дампа Spansh (key=''stats'')';

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260922000000_billing_real_data_payments.sql       │
-- └────────────────────────────────────────────────────────────────┘

-- ============================================================================
-- 20260922000000_billing_real_data_payments.sql
-- ED Ring Colony — Billing v2: real data storage, product settings,
-- payment providers & payment intents (webhook-driven fulfilment)
-- ============================================================================

-- 1. Extra columns for product configuration
ALTER TABLE public.shop_items
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS display_order INTEGER DEFAULT 0;

ALTER TABLE public.billing_plans
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS discount_pct INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.user_subscriptions
  ADD COLUMN IF NOT EXISTS provider_id TEXT,
  ADD COLUMN IF NOT EXISTS external_id TEXT;

ALTER TABLE public.billing_transactions
  ADD COLUMN IF NOT EXISTS provider_id TEXT,
  ADD COLUMN IF NOT EXISTS external_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

ALTER TABLE public.user_balances
  ALTER COLUMN credits SET DEFAULT 0;

-- 2. Payment providers (admin-configured integrations)
CREATE TABLE IF NOT EXISTS public.payment_providers (
  id            TEXT PRIMARY KEY,                -- 'yookassa', 'stripe', 'robokassa', 'cryptobot', 'manual'
  name          TEXT NOT NULL,
  is_enabled    BOOLEAN NOT NULL DEFAULT false,
  test_mode     BOOLEAN NOT NULL DEFAULT true,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- server-only secrets & settings
  methods       TEXT[] NOT NULL DEFAULT '{}',        -- supported payment methods ('card','sbp','crypto')
  display_order INTEGER NOT NULL DEFAULT 0,
  last_check_at TIMESTAMPTZ,
  last_check_ok BOOLEAN,
  last_check_msg TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- 3. Payment intents — one per checkout; fulfilled via webhook/return
CREATE TABLE IF NOT EXISTS public.payment_intents (
  id              TEXT PRIMARY KEY,
  user_id         UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  cmdr_name       TEXT,
  provider_id     TEXT REFERENCES public.payment_providers(id) ON DELETE SET NULL,
  external_id     TEXT,                         -- id in the payment system
  purpose         TEXT NOT NULL,                -- 'credit_topup' | 'subscription' | 'shop_purchase'
  target_id       TEXT,                         -- plan_id / item_id / topup pack id
  amount_rub      NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount_credits  INTEGER NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'RUB',
  status          TEXT NOT NULL DEFAULT 'pending', -- 'pending','paid','failed','canceled','expired'
  payment_url     TEXT,
  transaction_id  TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  paid_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payment_intents_user ON public.payment_intents(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_external ON public.payment_intents(provider_id, external_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_status ON public.payment_intents(status);

-- 4. Webhook event log (idempotency & audit)
CREATE TABLE IF NOT EXISTS public.payment_webhook_events (
  id            TEXT PRIMARY KEY,
  provider_id   TEXT,
  event_type    TEXT,
  external_id   TEXT,
  payload       JSONB,
  processed     BOOLEAN DEFAULT false,
  error         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 4b. Key/value settings (welcome credits, credit packs, etc.)
CREATE TABLE IF NOT EXISTS public.billing_settings (
  id          TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.billing_settings ENABLE ROW LEVEL SECURITY;

-- 5. RLS
ALTER TABLE public.payment_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payment_intents_read_own" ON public.payment_intents;
CREATE POLICY "payment_intents_read_own" ON public.payment_intents FOR SELECT USING (auth.uid() = user_id);
-- providers / webhook events: service role only (no policies => no anon access)

-- 6. Seed default providers (disabled until configured by admin)
INSERT INTO public.payment_providers (id, name, is_enabled, test_mode, methods, display_order) VALUES
  ('yookassa',  'ЮKassa (YooMoney)',      false, true, ARRAY['card','sbp'],   1),
  ('robokassa', 'Robokassa',              false, true, ARRAY['card','sbp'],   2),
  ('stripe',    'Stripe',                 false, true, ARRAY['card'],         3),
  ('cryptobot', 'Crypto Pay (CryptoBot)', false, true, ARRAY['crypto'],       4),
  ('manual',    'Ручное подтверждение',   false, false, ARRAY['manual'],      9)
ON CONFLICT (id) DO NOTHING;

-- 7. Seed default plans
INSERT INTO public.billing_plans (id, name, name_en, description, description_en, price_rub, price_credits, period_days, perks, badge_label, color, is_active, is_popular, display_order, discount_pct) VALUES
  ('pioneer', 'Пионер Кольца', 'Ring Pioneer',
   'Базовый премиальный статус для исследователей и строителей колонии.',
   'Standard premium tier for Ring explorers and builders.',
   290, 2500, 30,
   '["Особый позывной и тактический префикс [PIO]","Приоритетная синхронизация логов CAPI и журнала","Скидка 25% на косметические улучшения в магазине","Эксклюзивный знак отличия Пионера в профиле","Доступ к расширенной телеметрии экспедиции"]'::jsonb,
   'PIONEER', '#3498db', true, false, 1, 25),
  ('elite', 'Элита Колонии', 'Colonia Elite',
   'Расширенный статус с кастомными темами интерфейса и голографическими рамками.',
   'Advanced tier with custom HUD interface themes and holographic avatar frames.',
   590, 5000, 30,
   '["Все привилегии уровня «Пионер Кольца»","Голографическая неоновая рамка аватара на выбор","Кастомные HUD-темы оформления интерфейса сайта","Скидка 50% на все товары Премиум-магазина","Приоритет в голосовых каналах эскадрилий","Нагрудный знак ветерана Элиты Колонии","Увеличенный лимит избранных систем в Атласе до 100"]'::jsonb,
   'ELITE', '#e67e22', true, true, 2, 50),
  ('admiral', 'Флотоводец VIP', 'Fleet Admiral VIP',
   'Высший ранг покровителя проекта с полным доступом ко всем украшениям и VIP-каналам.',
   'Highest benefactor tier with full access to all cosmetics and VIP priority.',
   1190, 10000, 30,
   '["Полный безлимитный доступ ко всем модулям платформы","Анимированные эффекты хроматического свечения ника","Все легендарные голографические рамки аватаров","Скидка 75% в магазине косметики + доступ к VIP-эксклюзивам","VIP-статус в технической поддержке с ускоренным ответом","Именная золотая запись в реестре Основателей Кольца","Личный золотой штандарт Флотоводца с орлиными крыльями","Возможность закреплять сообщения в общем чате"]'::jsonb,
   'VIP ADMIRAL', '#9b59b6', true, false, 3, 75)
ON CONFLICT (id) DO NOTHING;

-- 8. Seed default shop catalogue (the app also seeds these on first run)
INSERT INTO public.shop_items (id, category, title, title_en, description, description_en, price_credits, price_rub, rarity, requires_subscription, subscriber_discount_pct, preview_data, is_active, is_featured, display_order) VALUES
  ('frame-singularity','frame','Квантовая Сингулярность','Quantum Singularity','Вращающееся гравитационное кольцо аккреционного диска с фиолетовым свечением искривленного пространства.','Rotating gravitational accretion disk with violet curved space glow.',3500,450,'legendary',NULL,35,'{"color":"#a855f7","accentColor":"#3b82f6","glowColor":"rgba(168, 85, 247, 0.65)","frameStyle":"singularity","borderWidth":3}'::jsonb,true,true,1),
  ('frame-vanguard','frame','Авангард Колонии','Colonia Vanguard','Тактическая бронированная рамка с угловыми оптическими визирами и янтарной телеметрией.','Tactical armored frame with corner optical brackets and amber telemetry.',2200,290,'epic',NULL,25,'{"color":"#e67e22","accentColor":"#f39c12","glowColor":"rgba(230, 126, 34, 0.55)","frameStyle":"vanguard","borderWidth":2}'::jsonb,true,false,2),
  ('frame-subzero','frame','Ледяной Импульс','Sub-Zero Pulse','Криогенный гексагональный силовой щит с бегущей волной неонового циана.','Cryogenic hexagonal power shield with running neon cyan wave.',1500,190,'rare',NULL,20,'{"color":"#06b6d4","accentColor":"#38bdf8","glowColor":"rgba(6, 182, 212, 0.6)","frameStyle":"subzero","borderWidth":2}'::jsonb,true,false,3),
  ('frame-solar','frame','Вспышка Сверхновой','Solar Flare','Плазменная корона звезды O-класса с пульсирующими выбросами солнечного протуберанца.','O-class star plasma corona with pulsing solar prominences.',2400,320,'epic','elite',50,'{"color":"#f97316","accentColor":"#eab308","glowColor":"rgba(249, 115, 22, 0.7)","frameStyle":"solar","borderWidth":3}'::jsonb,true,true,4),
  ('frame-stealth','frame','Призрак Пустоты','Void Phantom','Матовая стелс-рамка с красными лазерными прицельными маркерами.','Matte stealth frame with red laser targeting markers.',1200,150,'rare',NULL,20,'{"color":"#ef4444","accentColor":"#991b1b","glowColor":"rgba(239, 68, 68, 0.5)","frameStyle":"stealth","borderWidth":2}'::jsonb,true,false,5),
  ('badge-founder','badge','Орден Основателя Кольца','Ring Founder Order','Золотой знак с орлиными крыльями для первых покровителей проекта.','Golden badge with eagle wings for the first project benefactors.',2800,350,'legendary','admiral',75,'{"color":"#fbbf24","icon":"crown"}'::jsonb,true,true,10),
  ('badge-explorer','badge','Звездный Первопроходец','Star Trailblazer','Компас исследователя дальнего космоса в неоново-голубом обрамлении.','Deep-space explorer compass in neon-blue trim.',900,120,'rare',NULL,20,'{"color":"#38bdf8","icon":"star"}'::jsonb,true,false,11),
  ('badge-titan','badge','Покоритель Титанов','Titan Breaker','Изумрудный клинок — знак участника операций против Таргоидских Титанов.','Emerald blade — mark of anti-Thargoid Titan operations.',1600,210,'epic',NULL,25,'{"color":"#10b981","icon":"sword"}'::jsonb,true,false,12),
  ('badge-carrier','badge','Владелец Флагмана','Fleet Carrier Owner','Синий якорь для командиров, владеющих собственным флотоносцем.','Blue anchor for commanders who own a Fleet Carrier.',1400,180,'epic',NULL,25,'{"color":"#60a5fa","icon":"anchor"}'::jsonb,true,false,13),
  ('badge-mining','badge','Мастер Глубинного Бурения','Deep Core Mining Master','Салатовый кристалл — знак опытного добытчика.','Lime crystal — mark of an experienced miner.',600,80,'common',NULL,15,'{"color":"#a3e635","icon":"diamond"}'::jsonb,true,false,14),
  ('skin-amber','skin','Янтарь Колонии','Colonia Amber','Классическая тёплая HUD-тема с янтарными акцентами Elite Dangerous.','Classic warm HUD theme with Elite Dangerous amber accents.',1800,240,'rare',NULL,25,'{"color":"#f59e0b","accentColor":"#fbbf24","hudSkinClass":"skin-colonia-amber"}'::jsonb,true,false,20),
  ('skin-cyber','skin','Киберпанк 3309','Cyberpunk 3309','Высококонтрастная футуристичная тема с кибер-цианом и пульсирующей неоновой маджентой.','High-contrast futuristic HUD skin with cyber cyan and pulsing neon magenta.',2600,340,'epic','elite',50,'{"color":"#ec4899","accentColor":"#06b6d4","hudSkinClass":"skin-cyberpunk-3309"}'::jsonb,true,true,21),
  ('skin-void','skin','Навигатор Пустоты','Void Navigator','Глубокая сине-фиолетовая тема дальних экспедиций.','Deep blue-violet theme for long-range expeditions.',2000,260,'rare',NULL,25,'{"color":"#3b82f6","accentColor":"#8b5cf6","hudSkinClass":"skin-void-navigator"}'::jsonb,true,false,22),
  ('skin-imperial','skin','Имперское Золото','Imperial Gold','Роскошная тема в цветах Империи Ахенара.','Luxurious theme in the colours of the Achenar Empire.',3200,420,'legendary','admiral',75,'{"color":"#eab308","accentColor":"#f5f5f4","hudSkinClass":"skin-imperial-gold"}'::jsonb,true,false,23),
  ('skin-emerald','skin','Изумрудный Аванпост','Emerald Outpost','Спокойная зелёная тема терраформированных миров.','Calm green theme of terraformed worlds.',1500,200,'common',NULL,15,'{"color":"#10b981","accentColor":"#34d399","hudSkinClass":"skin-emerald-outpost"}'::jsonb,true,false,24),
  ('glow-hyperspace','glow','Гиперпространственный След','Hyperspace Trail','Анимированный хроматический градиент позывного.','Animated chromatic gradient callsign.',2900,380,'legendary','admiral',75,'{"color":"#8b5cf6","gradient":"linear-gradient(90deg, #ec4899, #8b5cf6, #06b6d4, #ec4899)"}'::jsonb,true,true,30),
  ('glow-neutron','glow','Нейтронное Сияние','Neutron Glow','Холодное бело-голубое свечение нейтронной звезды.','Cold white-blue neutron star glow.',1700,220,'epic',NULL,25,'{"color":"#38bdf8","gradient":"linear-gradient(90deg, #38bdf8, #e0f2fe, #38bdf8)"}'::jsonb,true,false,31),
  ('glow-solar','glow','Солнечная Корона','Solar Corona','Тёплое золотое свечение звезды класса G.','Warm golden G-class star glow.',1100,150,'rare',NULL,20,'{"color":"#f59e0b","gradient":"linear-gradient(90deg, #f59e0b, #fef08a, #f59e0b)"}'::jsonb,true,false,32),
  ('glow-voidpulse','glow','Пульс Пустоты','Void Pulse','Глубокое фиолетовое пульсирующее свечение.','Deep violet pulsing glow.',1300,170,'rare',NULL,20,'{"color":"#9333ea","gradient":"linear-gradient(90deg, #9333ea, #e9d5ff, #9333ea)"}'::jsonb,true,false,33),
  ('title-architect','title','Архитектор Нового Рубежа','Architect of the New Frontier','Почётный титул строителя колоний.','Honorary colony builder title.',1800,230,'epic',NULL,25,'{"color":"#f97316","subTitle":"ARCHITECT OF THE NEW FRONTIER"}'::jsonb,true,false,40),
  ('title-trailblazer','title','Первопроходец Бездны','Void Trailblazer','Титул исследователя неизведанных секторов.','Explorer of uncharted sectors title.',1400,180,'rare',NULL,20,'{"color":"#a855f7","subTitle":"VOID TRAILBLAZER"}'::jsonb,true,false,41),
  ('title-jaques','title','Легенда Жак-Стейшн','Jaques Station Legend','Титул в честь легендарной станции Колонии.','Title honouring the legendary Colonia station.',2200,290,'legendary','elite',50,'{"color":"#38bdf8","subTitle":"JAQUES STATION LEGEND"}'::jsonb,true,true,42),
  ('title-marshal','title','Маршал Звездного Пути','Starway Marshal','Титул координатора маршрутов экспедиции.','Expedition route coordinator title.',1600,210,'epic',NULL,25,'{"color":"#eab308","subTitle":"STARWAY MARSHAL"}'::jsonb,true,false,43)
ON CONFLICT (id) DO NOTHING;

-- 9. Public read model for cosmetics (joined preview data for rendering across the site)
CREATE OR REPLACE VIEW public.user_cosmetics_public AS
SELECT
  e.user_id,
  p.cmdr_name,
  e.frame_id, e.badge_id, e.skin_id, e.glow_id, e.title_id,
  s.plan_id AS subscription_plan_id,
  bp.badge_label AS subscription_badge
FROM public.user_cosmetics_equipped e
LEFT JOIN public.profiles p ON p.id = e.user_id
LEFT JOIN LATERAL (
  SELECT plan_id FROM public.user_subscriptions us
  WHERE us.user_id = e.user_id AND us.status = 'active'
    AND (us.expires_at IS NULL OR us.expires_at > now())
  ORDER BY us.expires_at DESC NULLS LAST LIMIT 1
) s ON true
LEFT JOIN public.billing_plans bp ON bp.id = s.plan_id;

GRANT SELECT ON public.user_cosmetics_public TO anon, authenticated;

-- End of migration

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260922010000_tbank_provider.sql                   │
-- └────────────────────────────────────────────────────────────────┘

-- T-Bank hosted one-stage payments. No credentials in migrations.
INSERT INTO public.payment_providers (id, name, is_enabled, test_mode, methods, display_order)
VALUES ('tbank', 'Т-Банк', false, true, ARRAY['card'], 5)
ON CONFLICT (id) DO NOTHING;

COMMENT ON COLUMN public.payment_intents.status IS
  'pending, processing (atomically claimed; stalled fulfilment requires reconciliation), paid, failed, canceled, expired';

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260923000000_vk_identities.sql                    │
-- └────────────────────────────────────────────────────────────────┘

-- VK ID (id.vk.com) вход и привязка. Self-hosted GoTrue не имеет провайдера VK,
-- поэтому соответствие «VK user_id ↔ auth.users.id» хранится здесь.
-- Пишет только service_role (сервер сайта); пользователь видит лишь свою строку.
CREATE TABLE IF NOT EXISTS public.vk_identities (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  vk_user_id   TEXT NOT NULL UNIQUE,
  email        TEXT,
  display_name TEXT,
  avatar_url   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.vk_identities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vk_identities_select_own ON public.vk_identities;
CREATE POLICY vk_identities_select_own ON public.vk_identities
  FOR SELECT USING (auth.uid() = user_id);
-- INSERT/UPDATE/DELETE: политик нет → только service_role.

CREATE INDEX IF NOT EXISTS idx_vk_identities_vk_user_id ON public.vk_identities(vk_user_id);

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260924000000_galaxy_systems_finish.sql            │
-- └────────────────────────────────────────────────────────────────┘

-- Finish the Spansh galaxy catalog: nearest-in-cube lookups (atlas + route
-- finder), a trigram index for name autocomplete, and a public bucket the
-- import uploads the map point cloud into (the web image does not contain it).

-- ─── Nearest exotic/giant stars inside an axis-aligned cube ───
CREATE OR REPLACE FUNCTION public.galaxy_star_candidates(
  cx double precision,
  cy double precision,
  cz double precision,
  half double precision,
  star_types text[],
  giant_classes text[],
  lim integer
)
RETURNS SETOF public.galaxy_systems
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM public.galaxy_systems
  WHERE x BETWEEN cx - half AND cx + half
    AND y BETWEEN cy - half AND cy + half
    AND z BETWEEN cz - half AND cz + half
    AND (
      (cardinality(star_types) > 0 AND star_type = ANY(star_types))
      OR (cardinality(giant_classes) > 0 AND star_giant_class = ANY(giant_classes))
    )
  ORDER BY ((x - cx) ^ 2 + (y - cy) ^ 2 + (z - cz) ^ 2)
  LIMIT GREATEST(1, LEAST(COALESCE(lim, 2000), 2000));
$$;

-- ─── Any systems inside a cube, nearest first (route finder) ───
CREATE OR REPLACE FUNCTION public.galaxy_systems_near(
  cx double precision,
  cy double precision,
  cz double precision,
  half double precision,
  lim integer
)
RETURNS TABLE(name text, x double precision, y double precision, z double precision)
LANGUAGE sql
STABLE
AS $$
  SELECT g.name, g.x, g.y, g.z
  FROM public.galaxy_systems g
  WHERE g.x BETWEEN cx - half AND cx + half
    AND g.y BETWEEN cy - half AND cy + half
    AND g.z BETWEEN cz - half AND cz + half
  ORDER BY ((g.x - cx) ^ 2 + (g.y - cy) ^ 2 + (g.z - cz) ^ 2)
  LIMIT GREATEST(1, LEAST(COALESCE(lim, 800), 2000));
$$;

GRANT EXECUTE ON FUNCTION public.galaxy_star_candidates(
  double precision, double precision, double precision, double precision, text[], text[], integer
) TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.galaxy_systems_near(
  double precision, double precision, double precision, double precision, integer
) TO anon, authenticated, service_role;

-- Substring autocomplete. Prefix search already uses the name_lc btree.
-- pg_trgm is shipped with Supabase; skip quietly if this Postgres lacks it.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_galaxy_systems_name_trgm ON public.galaxy_systems USING gin (name_lc gin_trgm_ops)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'galaxy name trigram index skipped: %', SQLERRM;
END $$;

-- Map point cloud (~36 MB). The web image does not contain the file, so the
-- importer uploads it here. Service-role writes bypass RLS; the policy only
-- covers a direct public read. Wrapped so a DB without the storage schema
-- still gets the lookup functions above.
DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES (
    'galaxy-data',
    'galaxy-data',
    true,
    52428800,
    ARRAY['application/octet-stream']::text[]
  )
  ON CONFLICT (id) DO UPDATE SET
    public = true,
    file_size_limit = GREATEST(storage.buckets.file_size_limit, EXCLUDED.file_size_limit);

  DROP POLICY IF EXISTS galaxy_data_select ON storage.objects;
  CREATE POLICY galaxy_data_select ON storage.objects
    FOR SELECT TO anon, authenticated
    USING (bucket_id = 'galaxy-data');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'galaxy-data bucket skipped: %', SQLERRM;
END $$;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260924010000_reconcile_galnet_news_structure.sql  │
-- └────────────────────────────────────────────────────────────────┘

-- Reconcile public.galnet_news with the exported table structure.
--
-- The CSV export contains the following columns:
--   id, nid, title, body, image, published_at, fetched_at, created_at,
--   title_<language>, body_<language>, translated_at, translation_status,
--   guid, slug, source_lang
--
-- This migration is intentionally idempotent so it can be applied to an
-- existing Supabase project regardless of which earlier Galnet migrations
-- have already been run.

BEGIN;

-- Core article fields. Existing installations normally already have these
-- from 20260830152500_galnet_news.sql.
ALTER TABLE public.galnet_news
  ADD COLUMN IF NOT EXISTS nid TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS body TEXT,
  ADD COLUMN IF NOT EXISTS image TEXT,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- Translation metadata.
ALTER TABLE public.galnet_news
  ADD COLUMN IF NOT EXISTS translated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS translation_status TEXT,
  ADD COLUMN IF NOT EXISTS guid TEXT,
  ADD COLUMN IF NOT EXISTS slug TEXT,
  ADD COLUMN IF NOT EXISTS source_lang TEXT;

-- Localized title and body fields represented by the export.
ALTER TABLE public.galnet_news
  ADD COLUMN IF NOT EXISTS title_ru TEXT,
  ADD COLUMN IF NOT EXISTS title_en TEXT,
  ADD COLUMN IF NOT EXISTS title_de TEXT,
  ADD COLUMN IF NOT EXISTS title_it TEXT,
  ADD COLUMN IF NOT EXISTS title_ko TEXT,
  ADD COLUMN IF NOT EXISTS title_zh TEXT,
  ADD COLUMN IF NOT EXISTS title_ja TEXT,
  ADD COLUMN IF NOT EXISTS body_ru TEXT,
  ADD COLUMN IF NOT EXISTS body_en TEXT,
  ADD COLUMN IF NOT EXISTS body_de TEXT,
  ADD COLUMN IF NOT EXISTS body_it TEXT,
  ADD COLUMN IF NOT EXISTS body_ko TEXT,
  ADD COLUMN IF NOT EXISTS body_zh TEXT,
  ADD COLUMN IF NOT EXISTS body_ja TEXT;

-- Preserve the existing English source content and make the defaults apply
-- to newly inserted rows. NULL checks keep this safe for existing data.
UPDATE public.galnet_news
SET title_en = title
WHERE title_en IS NULL AND title IS NOT NULL;

UPDATE public.galnet_news
SET body_en = body
WHERE body_en IS NULL AND body IS NOT NULL;

UPDATE public.galnet_news
SET source_lang = 'en'
WHERE source_lang IS NULL;

UPDATE public.galnet_news
SET translation_status = 'pending'
WHERE translation_status IS NULL;

ALTER TABLE public.galnet_news
  ALTER COLUMN source_lang SET DEFAULT 'en',
  ALTER COLUMN translation_status SET DEFAULT 'pending';

-- Keep the identifiers used by the sync and translation jobs efficient and
-- unique when they are available. Partial indexes allow legacy NULL values.
CREATE UNIQUE INDEX IF NOT EXISTS idx_galnet_news_nid
  ON public.galnet_news (nid)
  WHERE nid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_galnet_news_guid
  ON public.galnet_news (guid)
  WHERE guid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_galnet_news_slug
  ON public.galnet_news (slug)
  WHERE slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_galnet_news_published_at
  ON public.galnet_news (published_at DESC);

CREATE INDEX IF NOT EXISTS idx_galnet_news_translation_status
  ON public.galnet_news (translation_status);

COMMIT;

-- Expected final columns:
-- id, nid, title, body, image, published_at, fetched_at, created_at,
-- title_ru, title_en, title_de, title_it, title_ko, title_zh, title_ja,
-- body_ru, body_en, body_de, body_it, body_ko, body_zh, body_ja,
-- translated_at, translation_status, guid, slug, source_lang

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260925000000_galaxy_systems_scale.sql             │
-- └────────────────────────────────────────────────────────────────┘

-- ════════════════════════════════════════════════════════════════
-- Migration: galaxy_systems на масштабе всей галактики
--
-- Каталог — это не 1.3M строк. Spansh `systems.json.gz` (5.9 GiB) содержит все
-- исследованные системы: EDAstro считает 203 642 699 систем (99.9M visited +
-- 103.8M route-only). Порядок величины — 10⁸ строк, и прежняя схема для него
-- не годится:
--
--   · три b-tree по x/y/z + bitmap AND на куб — это сотни тысяч обращений к
--     странице на каждый запрос Атласа, а сортировка по расстоянию всё равно
--     требует прочитать весь куб;
--   · b-tree по star_type (16 значений) и star_giant_class (3 значения)
--     планировщик не использует никогда: селективность слишком мала;
--   · autovacuum по умолчанию ждёт 20% мёртвых строк — на 2×10⁸ это 4×10⁷
--     строк до первой уборки.
--
-- Что делает миграция:
--   1. GiST-индекс по cube(ARRAY[x,y,z]) — куб-фильтр и KNN-сортировка
--      «ближайшие сначала» одним индексным сканированием;
--   2. функции Атласа переписаны на этот индекс (`&&` + `<->`);
--   3. пять устаревших индексов удаляются (только когда новый построен);
--   4. fillfactor/autovacuum настраиваются под большую таблицу.
--
-- На большой таблице GiST создаётся БЕЗ блокировки записи отдельным скриптом
-- supabase/maintenance/galaxy_systems_spatial_index.sql — миграция в этом
-- случае только заменит функции и напишет NOTICE.
--
-- Проверка после применения (см. SPANSH-IMPORT.md → «Масштаб»):
--   SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid))
--   FROM pg_stat_user_indexes WHERE relname = 'galaxy_systems';
-- ════════════════════════════════════════════════════════════════

DO $$
DECLARE
  spatial_ready boolean;
  total_rows bigint;
BEGIN
  -- cube входит в contrib и есть в образе Supabase; если расширения нет,
  -- блок откатится целиком и схема останется прежней (функции включительно).
  CREATE EXTENSION IF NOT EXISTS cube;

  SELECT COALESCE(c.reltuples, 0)::bigint INTO total_rows
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'galaxy_systems';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'galaxy_systems'
      AND indexname = 'idx_galaxy_systems_coord'
  ) INTO spatial_ready;

  IF NOT spatial_ready AND total_rows < 5000000 THEN
    -- Пустая/небольшая таблица (свежая установка): строим сразу.
    EXECUTE 'CREATE INDEX idx_galaxy_systems_coord ON public.galaxy_systems USING gist (cube(ARRAY[x, y, z]))';
    spatial_ready := true;
  ELSIF NOT spatial_ready THEN
    RAISE NOTICE
      'galaxy_systems: ~% строк — GiST-индекс создайте без блокировки записи: psql -f supabase/maintenance/galaxy_systems_spatial_index.sql',
      total_rows;
  END IF;

  -- ─── Ближайшие звёзды нужных классов в кубе ───
  -- `&&` отсекает куб индексом, `<->` отдаёт строки уже в порядке расстояния,
  -- поэтому LIMIT не требует читать и сортировать весь куб.
  CREATE OR REPLACE FUNCTION public.galaxy_star_candidates(
    cx double precision,
    cy double precision,
    cz double precision,
    half double precision,
    star_types text[],
    giant_classes text[],
    lim integer
  )
  RETURNS SETOF public.galaxy_systems
  LANGUAGE sql
  STABLE
  AS $fn$
    SELECT g.*
    FROM public.galaxy_systems g
    WHERE cube(ARRAY[g.x, g.y, g.z]) && cube(
            ARRAY[cx - half, cy - half, cz - half],
            ARRAY[cx + half, cy + half, cz + half]
          )
      AND (
        (cardinality(star_types) > 0 AND g.star_type = ANY(star_types))
        OR (cardinality(giant_classes) > 0 AND g.star_giant_class = ANY(giant_classes))
      )
    ORDER BY cube(ARRAY[g.x, g.y, g.z]) <-> cube(ARRAY[cx, cy, cz])
    LIMIT GREATEST(1, LEAST(COALESCE(lim, 2000), 2000));
  $fn$;

  -- ─── Любые системы в кубе, ближайшие сначала (поиск маршрута) ───
  CREATE OR REPLACE FUNCTION public.galaxy_systems_near(
    cx double precision,
    cy double precision,
    cz double precision,
    half double precision,
    lim integer
  )
  RETURNS TABLE(name text, x double precision, y double precision, z double precision)
  LANGUAGE sql
  STABLE
  AS $fn$
    SELECT g.name, g.x, g.y, g.z
    FROM public.galaxy_systems g
    WHERE cube(ARRAY[g.x, g.y, g.z]) && cube(
            ARRAY[cx - half, cy - half, cz - half],
            ARRAY[cx + half, cy + half, cz + half]
          )
    ORDER BY cube(ARRAY[g.x, g.y, g.z]) <-> cube(ARRAY[cx, cy, cz])
    LIMIT GREATEST(1, LEAST(COALESCE(lim, 800), 2000));
  $fn$;

  GRANT EXECUTE ON FUNCTION public.galaxy_star_candidates(
    double precision, double precision, double precision, double precision, text[], text[], integer
  ) TO anon, authenticated, service_role;

  GRANT EXECUTE ON FUNCTION public.galaxy_systems_near(
    double precision, double precision, double precision, double precision, integer
  ) TO anon, authenticated, service_role;

  IF spatial_ready THEN
    -- Куб и KNN закрывает один GiST; классы звезды фильтруются внутри куба.
    DROP INDEX IF EXISTS public.idx_galaxy_systems_x;
    DROP INDEX IF EXISTS public.idx_galaxy_systems_y;
    DROP INDEX IF EXISTS public.idx_galaxy_systems_z;
    DROP INDEX IF EXISTS public.idx_galaxy_systems_star_type;
    DROP INDEX IF EXISTS public.idx_galaxy_systems_star_giant_class;
  END IF;

  -- ─── Хранение и autovacuum под 10⁸ строк ───
  -- fillfactor 100: апсерт меняет только реально обновившиеся системы, HOT нам
  -- всё равно не доступен (индексируемые колонки), а 10% пустого места на
  -- таблице такого размера — это гигабайты.
  -- scale_factor 0.01/0.002: уборка и сбор статистики чаще, чем раз в 4×10⁷ строк.
  ALTER TABLE public.galaxy_systems SET (
    fillfactor = 100,
    autovacuum_vacuum_scale_factor = 0.01,
    autovacuum_analyze_scale_factor = 0.002,
    autovacuum_vacuum_cost_limit = 2000,
    autovacuum_vacuum_cost_delay = 2
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'galaxy_systems scale migration skipped: %', SQLERRM;
END $$;

-- Статистика по фактическим данным: без неё планировщик оценивает куб
-- по прежнему (пустому) состоянию таблицы.
ANALYZE public.galaxy_systems;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260925010000_yandex_identities.sql                │
-- └────────────────────────────────────────────────────────────────┘

-- Яндекс ID (oauth.yandex.ru) вход и привязка. Self-hosted GoTrue не имеет
-- провайдера Яндекса, поэтому соответствие «Yandex user_id ↔ auth.users.id»
-- хранится здесь. Пишет только service_role (сервер сайта); пользователь
-- видит лишь свою строку.
CREATE TABLE IF NOT EXISTS public.yandex_identities (
  user_id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  yandex_user_id  TEXT NOT NULL UNIQUE,
  email           TEXT,
  display_name    TEXT,
  avatar_url      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.yandex_identities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS yandex_identities_select_own ON public.yandex_identities;
CREATE POLICY yandex_identities_select_own ON public.yandex_identities
  FOR SELECT USING (auth.uid() = user_id);
-- INSERT/UPDATE/DELETE: политик нет → только service_role.

CREATE INDEX IF NOT EXISTS idx_yandex_identities_yandex_user_id ON public.yandex_identities(yandex_user_id);

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260926000000_site_content_footer_translations.sql │
-- └────────────────────────────────────────────────────────────────┘

-- ============================================================
-- SITE_CONTENT — колонки переводов для подвала
--
-- Админка («Контент» → «Подвал сайта») пишет footer_copyright_ru /
-- footer_discord_en / … , а миграция 20260920000000 добавила такие колонки
-- только для kicker/title1/title2/manifest. Из-за этого:
--   • upsert из админки падал с «column … does not exist», либо
--   • GET /api/home-data не мог выбрать список колонок и молча откатывался
--     на базовые footer_copyright/… — правки админки на сайте не появлялись.
--
-- Миграция идемпотентна: можно запускать повторно.
-- ============================================================

ALTER TABLE public.site_content
  ADD COLUMN IF NOT EXISTS footer_copyright_ru text,
  ADD COLUMN IF NOT EXISTS footer_copyright_en text,
  ADD COLUMN IF NOT EXISTS footer_copyright_de text,
  ADD COLUMN IF NOT EXISTS footer_copyright_it text,
  ADD COLUMN IF NOT EXISTS footer_copyright_ko text,
  ADD COLUMN IF NOT EXISTS footer_copyright_zh text,
  ADD COLUMN IF NOT EXISTS footer_copyright_ja text,
  ADD COLUMN IF NOT EXISTS footer_discord_ru text,
  ADD COLUMN IF NOT EXISTS footer_discord_en text,
  ADD COLUMN IF NOT EXISTS footer_discord_de text,
  ADD COLUMN IF NOT EXISTS footer_discord_it text,
  ADD COLUMN IF NOT EXISTS footer_discord_ko text,
  ADD COLUMN IF NOT EXISTS footer_discord_zh text,
  ADD COLUMN IF NOT EXISTS footer_discord_ja text,
  ADD COLUMN IF NOT EXISTS footer_edsm_ru text,
  ADD COLUMN IF NOT EXISTS footer_edsm_en text,
  ADD COLUMN IF NOT EXISTS footer_edsm_de text,
  ADD COLUMN IF NOT EXISTS footer_edsm_it text,
  ADD COLUMN IF NOT EXISTS footer_edsm_ko text,
  ADD COLUMN IF NOT EXISTS footer_edsm_zh text,
  ADD COLUMN IF NOT EXISTS footer_edsm_ja text,
  ADD COLUMN IF NOT EXISTS footer_inara_ru text,
  ADD COLUMN IF NOT EXISTS footer_inara_en text,
  ADD COLUMN IF NOT EXISTS footer_inara_de text,
  ADD COLUMN IF NOT EXISTS footer_inara_it text,
  ADD COLUMN IF NOT EXISTS footer_inara_ko text,
  ADD COLUMN IF NOT EXISTS footer_inara_zh text,
  ADD COLUMN IF NOT EXISTS footer_inara_ja text;

-- На базах, где применялся только «свободный» файл
-- supabase/add_site_content_translations.sql (он не внесён в migrations),
-- kicker/title1/title2/manifest могли остаться без *_ru. Докидываем, если
-- чего-то нет: ADD COLUMN IF NOT EXISTS повторяет то, что уже есть безопасно.
ALTER TABLE public.site_content
  ADD COLUMN IF NOT EXISTS kicker_ru text,
  ADD COLUMN IF NOT EXISTS title1_ru text,
  ADD COLUMN IF NOT EXISTS title2_ru text,
  ADD COLUMN IF NOT EXISTS manifest_ru text,
  ADD COLUMN IF NOT EXISTS kicker_en text,
  ADD COLUMN IF NOT EXISTS kicker_de text,
  ADD COLUMN IF NOT EXISTS kicker_it text,
  ADD COLUMN IF NOT EXISTS kicker_ko text,
  ADD COLUMN IF NOT EXISTS kicker_zh text,
  ADD COLUMN IF NOT EXISTS kicker_ja text,
  ADD COLUMN IF NOT EXISTS title1_en text,
  ADD COLUMN IF NOT EXISTS title1_de text,
  ADD COLUMN IF NOT EXISTS title1_it text,
  ADD COLUMN IF NOT EXISTS title1_ko text,
  ADD COLUMN IF NOT EXISTS title1_zh text,
  ADD COLUMN IF NOT EXISTS title1_ja text,
  ADD COLUMN IF NOT EXISTS title2_en text,
  ADD COLUMN IF NOT EXISTS title2_de text,
  ADD COLUMN IF NOT EXISTS title2_it text,
  ADD COLUMN IF NOT EXISTS title2_ko text,
  ADD COLUMN IF NOT EXISTS title2_zh text,
  ADD COLUMN IF NOT EXISTS title2_ja text,
  ADD COLUMN IF NOT EXISTS manifest_en text,
  ADD COLUMN IF NOT EXISTS manifest_de text,
  ADD COLUMN IF NOT EXISTS manifest_it text,
  ADD COLUMN IF NOT EXISTS manifest_ko text,
  ADD COLUMN IF NOT EXISTS manifest_zh text,
  ADD COLUMN IF NOT EXISTS manifest_ja text;

-- Русская колонка = базовая колонка (админка считает каноническим именно ru).
UPDATE public.site_content SET
  footer_copyright_ru = COALESCE(footer_copyright_ru, footer_copyright),
  footer_discord_ru   = COALESCE(footer_discord_ru,   footer_discord),
  footer_edsm_ru      = COALESCE(footer_edsm_ru,      footer_edsm),
  footer_inara_ru     = COALESCE(footer_inara_ru,     footer_inara),
  kicker_ru           = COALESCE(kicker_ru,          kicker),
  title1_ru           = COALESCE(title1_ru,          title1),
  title2_ru           = COALESCE(title2_ru,          title2),
  manifest_ru         = COALESCE(manifest_ru,        manifest)
WHERE id = 1;

-- ВАЖНО: остальные языки (en, de, it, ko, zh, ja) намеренно остаются NULL.
-- Фронт уже подставляет базовую колонку, когда перевода нет (localizedValue),
-- а «предзаполнение» русским текстом только усыпило бы админку: кнопка
-- «перевести недостающее» считает заполненную колонку переведённой и никогда
-- не принесла бы настоящий перевод.

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260927000000_app_flags_maintenance.sql            │
-- └────────────────────────────────────────────────────────────────┘

-- ══════════════════════════════════════════════════════════════════════
-- Флаги приложения: технические работы и отметка о последней копии БД.
--
-- Зачем отдельная таблица, а не память веб-процесса:
--   1. заглушку «Ведутся технические работы» отдаёт прокси (src/proxy.ts),
--      который работает в отдельном рантайме и не видит переменные Node;
--   2. контейнер web может перезапуститься посреди резервного копирования —
--      признак с `expires_at` переживёт перезапуск и сам «отлипнет»;
--   3. веб-контейнер не имеет доступа к файловой системе хоста, поэтому
--      дата последней копии (для «прошла неделя — пора») хранится здесь.
--
-- Запись идёт только сервисным ключом (service_role обходит RLS); чтение
-- разрешено всем — прокси должен узнать признак без секретов.
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.app_flags (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.app_flags IS
    'Служебные флаги приложения: maintenance (заглушка техработ) и db_backup (отметка о последней копии).';
COMMENT ON COLUMN public.app_flags.key IS
    'maintenance — сайт под заглушкой; db_backup — когда и какая копия БД сделана последней.';

ALTER TABLE public.app_flags ENABLE ROW LEVEL SECURITY;

-- Чтение: прокси и заглушка читают признак анонимным ключом.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'app_flags' AND policyname = 'app_flags_public_read'
    ) THEN
        CREATE POLICY app_flags_public_read ON public.app_flags FOR SELECT USING (true);
    END IF;
END
$$;

GRANT SELECT ON TABLE public.app_flags TO anon, authenticated;
-- INSERT/UPDATE/DELETE намеренно не выдаём никому: с включённым RLS и без
-- политик записать флаг может только роль, обходящая RLS (service_role).

-- updated_at пишется самим приложением (upsert в src/lib/maintenance.ts);
-- триггер не заводим: в $fn$-телах этого репозитория по соглашению только SQL,
-- а польза от автообновления метки при ручной правке из psql невелика.

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260928000000_colonisation_events_source_hash.sql  │
-- └────────────────────────────────────────────────────────────────┘

-- ─────────────────────────────────────────────────────────────────────────
-- colonisation_events.source_hash — устойчивый ключ состояния стройки
-- ─────────────────────────────────────────────────────────────────────────
--
-- Зачем. Уникальный ключ схемы `(user_id, event_timestamp, system_name,
-- construction_id)` не удерживает повторы:
--
--   * `construction_id` бывает NULL — так пишутся `ColonisationContribution`
--     и события без `ConstructionID`. В PostgreSQL NULL не равен NULL, поэтому
--     уникальное ограничение такие строки не останавливает: повторная загрузка
--     того же журнала добавляла копии;
--   * журнал пишет `ColonisationConstructionDepot` каждые несколько секунд,
--     пока игрок стоит у площадки, а состояние меняется редко. Метка времени
--     при этом новая, поэтому по ключу схемы это «новое» событие — и таблица
--     набирала тысячи строк об одном и том же состоянии стройки;
--   * CAPI-синхронизация вставляла строки голым `insert()` и молча теряла
--     пачку на первом же конфликте, а события без системы (CAPI не всегда
--     отдаёт `StarSystem`) оседали строками с пустым `system_name`.
--
-- `source_hash` считает сервер (`src/lib/colonisationEvents.ts`) по состоянию
-- стройки: система, MarketID, ConstructionID, имя, прогресс и список
-- ресурсов. Для событий, которые не описывают состояние (вклад командира),
-- в ключ входит и метка времени: это отдельные факты, а не снимки.
--
-- Как и у `deliveries.source_hash`, колонка добавляется nullable:
-- переписывать историю на живой базе миграция не имеет права. Уникальный
-- индекс по ней строится отдельно, после разбора уже накопленных дублей:
--   supabase/maintenance/colonisation_events_source_hash_dedup.sql
-- Пока индекса нет, API пишет прежним путём (сверка с уже записанным перед
-- вставкой) — загрузка журнала из-за непрокатанной миграции не падает.

ALTER TABLE public.colonisation_events
  ADD COLUMN IF NOT EXISTS source_hash TEXT;

COMMENT ON COLUMN public.colonisation_events.source_hash IS
  'Устойчивый ключ состояния стройки (colony-v1-…). Считается сервером; NULL у строк, записанных до миграции.';

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260929000000_system_plans.sql                     │
-- └────────────────────────────────────────────────────────────────┘

-- ─────────────────────────────────────────────────────────────────────────
-- system_plans — серверное хранение и публикация планов застройки («Архитектор»)
-- ─────────────────────────────────────────────────────────────────────────
--
-- Зачем. До этой миграции план архитектора жил только в `localStorage`
-- браузера (`ed-architect:plan:<система>`): показать замысел эскадрилье было
-- нечем, кроме выгрузки JSON вручную, а два командира не могли работать над
-- одной системой. Таблица переносит план на сервер и добавляет три режима
-- видимости:
--
--   * `private`  — видит только автор;
--   * `unlisted` — читается по прямой ссылке `/architect?plan=<id>`, но в
--     общем списке системы не показывается (то, что называют «поделиться
--     ссылкой»);
--   * `public`   — попадает в список планов системы и виден всем.
--
-- Что хранится. Сам план — JSONB той же структуры, что и в браузере
-- (`src/lib/architect/types.ts` → `ArchitectPlan`), плюс версии формата и
-- каталога: импорт обязан честно говорить, что план считался по другому
-- набору стоимостей. Рядом лежат сводные числа (`site_count`, `haul_tons`,
-- `score`, `tier2_points`, `tier3_points`, `cargo_items`) — их считает сервер
-- движком `evaluatePlan()` при каждой записи, поэтому в списке планов не
-- может оказаться «оценка 999», нарисованная клиентом, а список строится без
-- чтения каждого JSONB целиком.
--
-- RLS. Читать разрешено всё, что не `private` (иначе `unlisted` нельзя было
-- бы открыть по ссылке неавтору); в список система-страница берёт только
-- `public` — фильтр по «unlisted» делается в API, а не политикой. Писать,
-- менять видимость и удалять может только автор; админ/модератор удаляет
-- чужое (как в `comments`).

CREATE TABLE IF NOT EXISTS public.system_plans (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  system_name       TEXT NOT NULL CHECK (LENGTH(TRIM(system_name)) BETWEEN 1 AND 128),
  -- Поиск планов системы идёт без учёта регистра: `HIP 90297` и `hip 90297`
  -- обязаны находить одно и то же.
  system_name_lc    TEXT GENERATED ALWAYS AS (lower(TRIM(system_name))) STORED,
  title             TEXT NOT NULL DEFAULT '',
  author_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  author_name       TEXT NOT NULL DEFAULT '',
  visibility        TEXT NOT NULL DEFAULT 'private'
                    CHECK (visibility IN ('private', 'unlisted', 'public')),
  plan              JSONB NOT NULL,
  format_version    INTEGER NOT NULL DEFAULT 1,
  catalogue_version INTEGER NOT NULL DEFAULT 0,
  site_count        INTEGER NOT NULL DEFAULT 0,
  haul_tons         BIGINT NOT NULL DEFAULT 0,
  score             INTEGER NOT NULL DEFAULT 0,
  tier2_points      INTEGER NOT NULL DEFAULT 0,
  tier3_points      INTEGER NOT NULL DEFAULT 0,
  cargo_items       INTEGER NOT NULL DEFAULT 0,
  notes             TEXT NOT NULL DEFAULT '',
  published_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.system_plans IS
  'Планы застройки систем из «Архитектора» (/architect). plan — JSONB формата ArchitectPlan, сводные числа считает сервер.';

CREATE INDEX IF NOT EXISTS idx_system_plans_system
  ON public.system_plans (system_name_lc, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_plans_author
  ON public.system_plans (author_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_plans_public
  ON public.system_plans (system_name_lc, updated_at DESC)
  WHERE visibility = 'public';

ALTER TABLE public.system_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS system_plans_select ON public.system_plans;
CREATE POLICY system_plans_select ON public.system_plans
  FOR SELECT TO anon, authenticated USING (
    visibility <> 'private' OR author_id = auth.uid()
  );

DROP POLICY IF EXISTS system_plans_insert ON public.system_plans;
CREATE POLICY system_plans_insert ON public.system_plans
  FOR INSERT TO authenticated WITH CHECK (author_id = auth.uid());

DROP POLICY IF EXISTS system_plans_update ON public.system_plans;
CREATE POLICY system_plans_update ON public.system_plans
  FOR UPDATE TO authenticated USING (author_id = auth.uid())
  WITH CHECK (author_id = auth.uid());

DROP POLICY IF EXISTS system_plans_delete ON public.system_plans;
CREATE POLICY system_plans_delete ON public.system_plans
  FOR DELETE TO authenticated USING (
    author_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'moderator')
    )
  );

GRANT SELECT ON public.system_plans TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.system_plans TO authenticated;

-- `update_updated_at_column()` уже создаёт миграция комментариев; повторяем
-- определение, чтобы файл применялся и сам по себе.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS system_plans_updated_at ON public.system_plans;
CREATE TRIGGER system_plans_updated_at
  BEFORE UPDATE ON public.system_plans
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260930000000_raven_sync_log_synced_at.sql         │
-- └────────────────────────────────────────────────────────────────┘

-- Колонка public.raven_sync_log.synced_at: её пишет API
-- (src/app/api/ravencolonial/sync/log/route.ts, src/app/api/projects/[id]/progress/route.ts),
-- по ней сортирует лог админка (src/components/Admin/RavenSyncTab.tsx), но в
-- схеме она нигде не была описана.
--
-- Из-за этого на базе, поднятой из 000_base_schema.sql, падал индекс
-- idx_raven_sync_log_synced_at в 20260830110258_rls_policies_v2.sql
-- («column "synced_at" does not exist»), а сам лог не заполнялся.
ALTER TABLE public.raven_sync_log
  ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ DEFAULT NOW();

-- Свежие строки без явного synced_at не должны «проваливаться» в конец сортировки.
UPDATE public.raven_sync_log SET synced_at = created_at WHERE synced_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_raven_sync_log_synced_at ON public.raven_sync_log(synced_at);

