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
CREATE INDEX IF NOT EXISTS idx_raven_sync_log_created_at ON public.raven_sync_log(created_at);
CREATE INDEX IF NOT EXISTS idx_system_progress_system_name ON public.system_progress(system_name);
CREATE INDEX IF NOT EXISTS idx_friends_requester ON public.friends(requester_id);
CREATE INDEX IF NOT EXISTS idx_friends_addressee ON public.friends(addressee_id);
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


-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260830152500_galnet_news.sql                      │
-- └────────────────────────────────────────────────────────────────┘

-- ============================================================-- GALNET_NEWS — новости из Elite Dangerous Galnet-- Автоматически подтягиваются с официального API-- ============================================================CREATE TABLE IF NOT EXISTS public.galnet_news (  id          SERIAL PRIMARY KEY,  nid         TEXT UNIQUE NOT NULL,  -- внешний ID из Galnet API  title       TEXT NOT NULL,  body        TEXT NOT NULL,  image       TEXT,               -- URL изображения из Galnet  published_at TIMESTAMPTZ NOT NULL,  fetched_at   TIMESTAMPTZ DEFAULT NOW(),  created_at   TIMESTAMPTZ DEFAULT NOW()  );CREATE INDEX IF NOT EXISTS idx_galnet_published ON public.galnet_news(published_at DESC);CREATE INDEX IF NOT EXISTS idx_galnet_nid ON public.galnet_news(nid);ALTER TABLE public.galnet_news ENABLE ROW LEVEL SECURITY;DROP POLICY IF EXISTS galnet_select ON public.galnet_news;CREATE POLICY galnet_select ON public.galnet_news  FOR SELECT TO anon, authenticated USING (true);GRANT SELECT ON public.galnet_news TO anon, authenticated;-- ============================================================-- GALNET_SYNC_LOG — лог синхронизации-- ============================================================CREATE TABLE IF NOT EXISTS public.galnet_sync_log (  id          SERIAL PRIMARY KEY,  fetched_at  TIMESTAMPTZ DEFAULT NOW(),  articles_count INTEGER DEFAULT 0,  new_count      INTEGER DEFAULT 0,  error_msg      TEXT,  status         TEXT DEFAULT 'success'  );GRANT SELECT, INSERT ON public.galnet_sync_log TO anon, authenticated;ALTER TABLE public.galnet_sync_log ENABLE ROW LEVEL SECURITY;DROP POLICY IF EXISTS galnet_sync_select ON public.galnet_sync_log;CREATE POLICY galnet_sync_select ON public.galnet_sync_log  FOR SELECT TO anon, authenticated USING (true);DROP POLICY IF EXISTS galnet_sync_insert ON public.galnet_sync_log;CREATE POLICY galnet_sync_insert ON public.galnet_sync_log  FOR INSERT TO anon, authenticated WITH CHECK (true);


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
-- │ MIGRATION: 20260902010000_wiki_colonization_guide.sql          │
-- └────────────────────────────────────────────────────────────────┘

-- ============================================================ -- -- ED Ring Colony Wiki — Seed: Colonization Guide Article -- -- Вставляет статью в wiki_articles + создаёт ревизию -- -- ИНСТРУКЦИЯ: -- 1. Замените :author_id на UUID реального пользователя (auth.users.id) -- 2. Замените :category_id на UUID категории 'Колонизация' (wiki_categories.id) --    Или используйте подзапрос ниже для автопоиска -- 3. Выполните в Supabase SQL Editor -- ============================================================ -- -- 1. Найти категорию по slug (опционально, если знаете UUID) -- SELECT id FROM public.wiki_categories WHERE slug = 'colonization'; -- -- 2. Вставить статью (замените :author_id и :category_id) -- INSERT INTO public.wiki_articles ( title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at ) VALUES ( 'Полный гайд по колонизации в Elite Dangerous', 'polnyy-gayd-po-kolonizacii-v-elite-dangerous', E'# Полный гайд по колонизации в Elite Dangerous> **Актуально для:** Update 2 / Trailblazers Update 2 (сентябрь 2026)  > **Автор:** Сообщество ED Ring Colony  > **Категория:** Колонизация  > **Версия:** 1.0  > **Статус:** Актуально для текущего патча---## Содержание1. [Введение: что такое колонизация](#введение-что-такое-колонизация)2. [Этап 0: Подготовка](#этап-0-подготовка)3. [Этап 1: Выбор системы](#этап-1-выбор-системы)4. [Этап 2: Покупка клейма](#этап-2-покупка-клейма)5. [Этап 3: Размещение маяка](#этап-3-размещение-маяка)6. [Этап 4: Доставка материалов](#этап-4-доставка-материалов)7. [Этап 5: Становление System Architect](#этап-5-становление-system-architect)8. [Технологическое дерево (Tech Tree)](#технологическое-дерево-tech-tree)9. [Орбитальные объекты: полный справочник](#орбитальные-объекты-полный-справочник)10. [Поверхностные объекты: полный справочник](#поверхностные-объекты-полный-справочник)11. [Экономика системы](#экономика-системы)12. [BGS, фракции и Powerplay](#bgs-фракции-и-powerplay)13. [Логистика и Fleet Carrier](#логистика-и-fleet-carrier)14. [Construction Points (CP)](#construction-points-cp)15. [Доход и награды](#доход-и-награды)16. [Название объектов](#название-объектов)17. [Демонтаж и отмена строительства](#демонтаж-и-отмена-строительства)18. [Расширение: цепочки систем и мини-Bubble](#расширение-цепочки-систем-и-мини-bubble)19. [Частые ошибки и как их избежать](#частые-ошибки-и-как-их-избежать)20. [Полезные инструменты и ресурсы](#полезные-инструменты-и-ресурсы)21. [Приложения и таблицы](#приложения-и-таблицы)---## Введение: что такое колонизация**System Colonisation** — это механика, позволяющая игрокам заявлять незаселённые звёздные системы и развивать их, строя порты, аванпосты, поселения и другие объекты. Вы становитесь **System Architect** (Системным Архитектором) — бессрочным управляющим развитием своей колонии.### Ключевые факты- **101,862+ систем** колонизировано к февралю 2026 года- **307,014 космических** и **175,973 наземных** объектов построено- Механика вышла из бета-теста 11 ноября 2025 года- Колонизация — **PvE-контент**: другие игроки **не могут** разрушить вашу колонию- Нет ежемесячных расходов на содержание — развивайте в своём темпе- Каждая система уникальна: тип звезды, планеты, ресурсы влияют на экономику### Общая схема процесса![Общая схема процесса колонизации](/wiki/colonization-guide/ed_colonization_flowchart_v2.png)---## Этап 0: Подготовка### Минимальные требования| Параметр | Требование ||----------|------------|| Кредиты | Минимум **50–100 млн** (25 млн маяк + 25 млн резерв + стоимость корабля) || Корабль | С трюмом **200+ тонн** (Type-9, Cutter, Type-11) || FSD | Инженерный апгрейд от Felicity Farseer желателен || Fleet Carrier | **Не обязателен**, но делает процесс в 10 раз проще || Squadron | Желателен для координации и BGS-контроля |### Рекомендуемый набор кораблей1. **Type-11 Prospector** — массовые перевозки (большой трюм)2. **Python** — универсал: майнинг, доставки, SRV3. **Krait Mk II** — майнинг и боевые миссии4. **Anaconda** — дальние разведывательные рейсы5. **Diamondback Explorer** — поиск идеальных систем---## Этап 1: Выбор системы### Критерии выбора (от важного к менее важному)![Схема выбора системы](/wiki/colonization-guide/ed_colonization_system_choice_v2.png)### Обязательные условия1. **Расстояние** — в пределах **15 световых лет** от заселённой системы2. **Статус** — система должна быть **Unclaimed** (незаявленной)3. **Доступность** — не permit-locked, не в exclusion zone### Желательные условия| Фактор | Почему важно | Идеально ||--------|-------------|----------|| **Тип звезды** | K/G-тип стабильны, дают хорошие слоты | K- или G-звезда || **Количество планет** | Больше тел = больше орбитальных слотов | 5+ планет/лун || **Кольца** | Создают Resource Extraction Sites | Кольца на Rocky body || **Ресурсы** | Влияют на базовую экономику | Pristine reserves || **Geological signals** | Бонус к Refinery-экономике | Есть на Rocky/HMC || **Terraformable** | Бонус к населению и экономике | 1+ планета |### Типы планет и базовая экономика| Тип планеты | Базовая экономика | Бонус ||-------------|-------------------|-------|| Rocky body | Refinery +1.0 | Pristine = +, Depleted = − || High Metal Content (HMC) | Extraction +1.0 | Геология = + || Water World | Tourism потенциал | Terraformable = ++ || Gas Giant | Много лун = слоты | Кольца = RES |### Чего избегать- **Neutron stars / Black holes** — нет планет, нет слотов- **White dwarfs** — мало слотов, опасны для FSD- **Системы с 1-2 планетами** — мало возможностей для развития- **Системы в 14.9 св.лет** — сложно достичь, мало запаса для цепочки---## Этап 2: Покупка клейма### Процесс1. Прилетите в **любой Star Port** в заселённой системе2. Откройте **Station Services → Colonization Contact**3. Выберите незаселённую систему в пределах 15 св.лет4. Выберите тип **Primary Starport**### Типы портов| Тип порта | Стоимость клейма | Особенности ||-----------|-----------------|-------------|| **Outpost** | Дешевле | Только Medium площадки, меньше грузов || **Coriolis** | Средне | Классика, Large площадки, Colony-экономика || **Ocellus** | Дороже | Tier 3, высокие статы, красивый || **Orbis** | Дороже | Tier 3, аналог Ocellus || **Dodec** | Самый дорогой | Tier 3, максимальные статы, уникальный дизайн |### Специализации первого порта- **Commercial focus** → Colony-экономика, +Wealth- **Industrial focus** → Industrial-экономика, +Tech Level- **Military focus** → Military-экономика, +Security### Важно- Стоимость варьируется в зависимости от типа — проверяйте в игре- Клейм действует **24 часа** — за это время нужно разместить маяк- Если пропустили дедлайн — **3 дня блокировки** перед новой попыткой- Нельзя иметь несколько активных клеймов одновременно---## Этап 3: Размещение маяка### Что нужно сделать1. Полетите в заявленную систему2. Откройте **System Colonization Suite** (модуль по умолчанию на всех кораблях)3. Разверните **Colonization Beacon** в предустановленной точке4. Маяк стоит **25 млн кредитов**### Что происходит дальше- Система помечается как **Claimed** (заявленная)- Запускается обратный отсчёт **24 часа**- Прибывает гигантский **Colonization Ship** — временная база с 32 площадками- Вы становитесь **System Architect** (после завершения первого порта)### Если не успели за 24 часа- Клейм **аннулируется**- **3 дня** нельзя подавать новые заявки- Потраченные кредиты **не возвращаются**---## Этап 4: Доставка материалов### ЦельДоставить все необходимые **commodities** на Colonization Ship за **4 недели**.### Типы материалов| Категория | Примеры | Источник ||-----------|---------|----------|| **Руды (Minerals)** | Bauxite, Gallite, Indite, Coltan | Mining / Покупка || **Товары (Commodities)** | Food Cartridges, Insulating Membrane, CMM Composite | Рынки Bubble || **Материалы (Materials)** | Iron, Nickel, Carbon, Sulphur | SRV surface mining || **Топливо** | Tritium для FC | Рынки / Mining |### Логистика![Схема логистики](/wiki/colonization-guide/ed_colonization_logistics_v2.png)### Ключевые советы по доставке- **Fleet Carrier = must have** для серьёзных проектов: 25,000 т груза + прыжки 500 св.лет- **Type-11 Prospector** — лучший корабль для массовых перевозок- **Создавайте цепочки** систем каждые 15 св.лет для дальних колоний- Некоторые товары (**Insulating Membrane**) доступны **только** на орбитальных рынках- **CMM Composite** производится на планетах с Refinery-экономикой### Что происходит после доставки- Порт появляется в виде **строящейся станции** с лесами- После **еженедельного тика** (четверг, 07:00 UTC) порт достраивается- Маяк превращается в **Nav Beacon**- Система становится заселённой---## Этап 5: Становление System Architect### Ваши полномочия- **Размещение** новых объектов (орбитальных и поверхностных)- **Управление** экономикой, населением, безопасностью- **Назначение** названий объектов (платно через Arx)- **Демонтаж** ошибочно размещённых объектов### Ограничения- Нужно дождаться **первого еженедельного тика** после постройки порта- Количество **одновременных строек** ограничено (смотрите в Architect View)- Поверхностные объекты могут появляться с **задержкой до 48 часов**### Architect Mode- Открывается через **System Map**- Показывает доступные **орбитальные слоты** (иконки с «+»)- Показывает **поверхностные слоты** на каждой планете- Флаг на орбитальном слоте = место для **Primary Port**---## Технологическое дерево (Tech Tree)![Технологическое дерево](/wiki/colonization-guide/ed_colonization_techtree_v2.png)### Принцип работы- Каждый объект даёт **Construction Points (CP)**- **Tier 1** объекты открываются сразу (нужен только First Station)- **Tier 2** требуют определённых Tier 1 объектов- **Tier 3** требуют Tier 2 + достаточного количества CP### Пример цепочки```First Station → Scientific Outpost → Research Station → Ocellus Starport                    ↓             Mining Outpost → Asteroid Base```### Поверхностная ветка```First Station → Planetary Outposts → Settlements → Hubs → Planetary Port```---## Орбитальные объекты: полный справочник### Starports (Tier 2-3)| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | Pop+ | MaxPop+ ||--------|------|-----------|----------|------|--------|-----|-----|------|---------|| **Coriolis** | 2 | Colony | -2 | 1 | 2 | 3 | 2 | 1 | 0 || **Asteroid Base** | 2 | Extraction | -1 | 3 | 5 | -4 | 7 | 1 | 0 || **Ocellus** | 3 | Colony | -3 | 6 | 7 | 5 | 8 | 5 | 1 || **Orbis** | 3 | Colony | -3 | 6 | 7 | 5 | 8 | 5 | 1 || **Dodec** | 3 | Colony | -4 | 8 | 9 | 7 | 10 | 8 | 4 |### Outposts (Tier 1)| Объект | Экономика | Security | Tech | Wealth | SoL | Dev | Pop+ ||--------|-----------|----------|------|--------|-----|-----|------|| Commercial Outpost | Colony | -1 | — | 2 | 5 | — | 0 || Industrial Outpost | Industrial | — | — | 3 | — | 2 | 0 || Criminal Outpost | Colony | -2 | — | 2 | — | — | 0 || Civilian Outpost | Colony | -1 | — | 1 | 1 | 1 | 0 || Scientific Outpost | Hightech | — | 3 | — | — | — | 1 || Military Outpost | Military | **+2** | — | — | — | — | 1 |### Installations (Tier 1-2)| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev ||--------|------|-----------|----------|------|--------|-----|-----|| Satellite | 1 | — | — | — | 1 | 1 | 1 || Communication Station | 1 | — | — | 1 | 3 | — | — || Space Farm | 1 | Agricultural | — | — | — | 5 | 1 || Pirate Base | 1 | Contraband | -4 | — | 3 | — | — || Mining Outpost | 1 | Extraction | — | — | 3 | -2 | — || Relay Station | 1 | Hightech | 1 | — | — | — | 1 || **Security Station** | 2 | Military | **+8** | — | — | 3 | 2 || **Government** | 2 | — | — | 2 | — | 6 | 2 || **Medical** | 2 | Hightech | — | 3 | — | 5 | — || **Research Station** | 2 | Hightech | — | **+8** | — | — | 2 || **Tourist** | 2 | Tourism | **-3** | — | 6 | — | 2 || **Bar** | 2 | Tourism | -2 | — | 2 | 3 | — |---## Поверхностные объекты: полный справочник### Outposts (Tier 1)| Объект | Экономика | Security | Tech | Wealth | SoL | Dev | Pop+ | MaxPop+ ||--------|-----------|----------|------|--------|-----|-----|------|---------|| Civilian Planetary Outpost | Colony | -2 | — | — | 3 | — | 2 | 0 || Industrial Planetary Outpost | Industrial | -1 | — | 2 | — | — | 1 | 0 || Scientific Planetary Outpost | Hightech | -1 | 5 | — | — | 1 | 1 | 0 |### Planetary Port (Tier 3)| Объект | Экономика | Security | Tech | Wealth | SoL | Dev | Pop+ | MaxPop+ ||--------|-----------|----------|------|--------|-----|-----|------|---------|| **Planetary Port** | Colony | -3 | 5 | 5 | 6 | 10 | **10** | **10** |> Planetary Port — лучший объект для населения. Дает +10/+10.### Settlements (Tier 1-2)| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev ||--------|------|-----------|----------|------|--------|-----|-----|| Small Agricultural Settlement | 1 | Agricultural | — | — | — | 3 | — || Medium Agricultural Settlement | 1 | Agricultural | — | — | — | 6 | — || Large Agricultural Settlement | 2 | Agricultural | — | — | — | 10 | — || Small Extraction Settlement | 1 | Extraction | — | — | 2 | — | — || Medium Extraction Settlement | 1 | Extraction | — | — | 5 | — | — || Large Extraction Settlement | 2 | Extraction | — | 1 | 7 | -2 | — || Small Industrial Settlement | 1 | Industrial | — | — | — | — | 2 || Medium Industrial Settlement | 1 | Industrial | — | — | — | — | 5 || Large Industrial Settlement | 2 | Industrial | — | — | 2 | — | 8 || Small Military Settlement | 1 | Military | **+2** | — | — | — | — || Medium Military Settlement | 1 | Military | **+4** | — | — | — | — || Large Military Settlement | 2 | Military | **+6** | — | — | — | 2 || Small Scientific Settlement | 2 | Hightech | — | 3 | — | — | 1 || Medium Scientific Settlement | 2 | Hightech | — | 6 | — | — | 1 || Large Scientific Settlement | 2 | Hightech | — | **+10** | — | — | 2 || Small Tourism Settlement | 2 | Tourism | -1 | — | 1 | — | — || Medium Tourism Settlement | 2 | Tourism | -1 | — | 2 | — | — || Large Tourism Settlement | 2 | Tourism | -1 | — | **+5** | — | — |### Hubs (Tier 2)| Объект | Требуется | Экономика | Security | Tech | Wealth | SoL | Dev ||--------|-----------|-----------|----------|------|--------|-----|-----|| Extraction Hub | Mining Settlement | Extraction | — | — | 10 | -4 | 2 || Civilian Hub | Agricultural Settlement | — | -3 | — | — | 3 | 2 || Exploration Hub | Communication Station | Tourism | -1 | 6 | — | — | 2 || Outpost Hub | Space Farm | — | -2 | — | — | 3 | 2 || Scientific Hub | First Station | Hightech | — | **+10** | — | — | — || Military Hub | Military | Military | **+10** | — | — | — | — || Refinery Hub | First Station | Refinery | -1 | 3 | 5 | -2 | 7 || High Tech Hub | First Station | Hightech | -2 | 10 | -2 | — | — || Industrial Hub | Mining Outpost | Industrial | — | 3 | 5 | -4 | 2 |---## Экономика системы### Как формируется экономика1. **Базовая экономика** от типа звезды и планет2. **Бонусы/штрафы** от reserves (Pristine = +, Depleted = −)3. **Влияние объектов** — каждый даёт очки в определённую экономику4. **Расстояние** объекта от порта — ближе = сильнее влияние### Топ-2 экономикиРынок системы определяется **двумя сильнейшими экономиками**. Чтобы получить нужную экономику — обеспечьте ей достаточно очков.### CMM Composite — как получитьCMM Composite — один из самых важных товаров для колонизации. Для его производства:**Вариант 1: Rocky body**- Базовая экономика: Refinery +1.0- Постройте Civilian Outpost или Planetary Port (Colony-экономика)- Добавьте Refinery Hubs для усиления Refinery-экономики- Pristine reserves = бонус, Depleted = штраф**Вариант 2: High Metal Content body**- Базовая экономика: Extraction +1.0- Постройте Colony-экономику (Civilian Outpost / Port)- Добавьте Refinery Hubs- Держите Refinery в топ-2 экономик### Commodities, доступные только на орбитальных рынках- Insulating Membrane- Некоторые виды high-tech товаров### Commodities, доступные только на поверхностных рынках- Некоторые agricultural товары---## BGS, фракции и Powerplay### Начальные фракции (появляются автоматически)1. **Фракция, у которой куплен клейм** (контролирующая)2. **Вторая по влиянию фракция** из системы покупки3. **Фракция вашего Squadron** (если вы в Squadron)4. **Случайная Anarchy-фракция** из системы покупки### Важно- Вы можете **выбирать** фракцию при покупке клейма — выбирайте ту, которая вам нужна- Ваш Squadron faction появляется **автоматически**- Фракции могут **потерять контроль** через BGS — но вы останетесь Архитектором- **Architect = навсегда**, независимо от BGS### Powerplay- Новая колония входит в статус **Unoccupied**- Можно захватить через механику **Acquisition**- Каждая система имеет **ценность** для Powerplay### Government Type- Определяется контролирующей фракцией- Влияет на доступные товары и миссии---## Логистика и Fleet Carrier### Без Fleet Carrier- Летать в Bubble за каждой партией товаров- Ограничение: трюм корабля (~700 тонн для Type-9)- Подходит для колоний **в пределах 100 св.лет** от Bubble### С Fleet Carrier- **25,000 тонн** груза- Прыжки **500 световых лет**- Тритий: ~1 тонна на прыжок- Можно создать **мобильную базу** рядом с колонией- Идеально для **дальних колоний** и цепочек систем### Создание цепочки (chain)```Bubble → System 1 (15 ly) → System 2 (15 ly) → System 3 (15 ly) → ... → Цель```- Каждая система в цепочке становится **точкой отсчёта** для следующей- Это позволяет достичь **любой точки** галактики- Пример: Grand Tiberian Highway (Bubble → Colonia)### Мини-Bubble- **5–10 систем** в радиусе 50 св.лет- Разные экономики для **самодостаточности**- Собственная **торговая сеть**- **Fleet Carrier** как центр логистики---## Construction Points (CP)### Что это- **CP** — валюта прогресса колонизации- Каждый объект даёт или требует CP- Нужны для открытия **следующего тира** объектов### Как работает| Действие | CP ||----------|-----|| Построить Tier 1 объект | +1 CP (часто) || Построить Tier 2 объект | Требует ~3 CP, даёт +1 CP || Построить Tier 3 объект | Требует ~6 CP |### Пример прогрессии```First Station (0 CP)    ↓Build 3x Tier 1 objects (+3 CP) → открыт Tier 2    ↓Build 2x Tier 2 objects (+2 CP, потратил ~6) → открыт Tier 3    ↓Build Dodec Starport (требует Tier 3 CP)```---## Доход и награды### Еженедельный пассивный доход- Выплачивается **каждую неделю**- Зависит от **количества и размера** объектов- Суммируется по **всем вашим системам**- Забирать у **Administration Contact**### Галактический налог- Если доход **> 5 млн/неделю** — налогообложение- Чем больше систем — тем выше общий доход### Скидки- **10% скидка** на корабли и модули в системах с **10+ объектами**### Другие награды- **Титул System Architect** — навсегда- **Возможность назвать** объекты (5000 Arx за кастомное имя)- **Влияние на BGS** галактики- **Собственная домашняя система**---## Название объектов### Бесплатно- **5 переименований** через случайный генератор имён- Можно крутить генератор **неограниченно** — имя применяется только при нажатии Apply### Платно- **5000 Arx** за кастомное имя- **Безлимитные** переименования после покупки- Имя командира **отображается** в системе### Первичный порт- Переименовывается **только после завершения** строительства- Через **System Map**---## Демонтаж и отмена строительства### Отмена активной стройки- Можно отменить **до завершения**- Материалы **теряются**### Демонтаж завершённого объекта- Возможен через **Architect Mode**- **Возвращает слот**, но не материалы- Используйте, если объект разместился **не в том слоте** (баг)### Важно- **Ground Ports** — пока **не работают** корректно (баг с экономикой)- Не стройте их, если нужна полноценная экономика- **Surface Settlements и Hubs** работают нормально---## Расширение: цепочки систем и мини-Bubble### Стратегия «Дейзи-чейн»1. Заявляйте системы **каждые 15 св.лет**2. Стройте **минимальный порт** (Outpost или Coriolis)3. Переходите к **следующей системе**4. Так создаётся **путь** к удалённой цели### Мини-Bubble- **5–10 систем** в радиусе 50 св.лет- Разные экономики для **самодостаточности**- Собственная **торговая сеть**- **Fleet Carrier** как центр логистики### Дальние колонии- Требуют **огромных вложений**- Рекомендуется **squadron** из 5–10 человек- Создавайте **мини-Bubble** для автономности- Пример успеха: **Colonia** — выросла из одной станции---## Частые ошибки и как их избежать| Ошибка | Последствия | Решение ||--------|-------------|---------|| Пропуск 24-часового дедлайна | Клейм аннулирован, 3 дня блокировки | Ставьте маяк **сразу** после покупки || Недостаток материалов за 4 недели | Клейм аннулирован, потеря всего | Планируйте заранее, используйте FC || Игнорирование Security | Система становится небезопасной | Стройте Military объекты || Строительство Ground Ports | Экономика не работает | Используйте Surface Settlements и Hubs || Неправильный выбор слота | Объект влияет не на ту экономику | Проверяйте расстояние до порта || Пропуск еженедельного тика | Нельзя строить новые объекты | Ждите четверга 07:00 UTC || Переоценка ресурсов | Проект застопорился | Начинайте с 1 системы, не 5 |---## Полезные инструменты и ресурсы### Планировщики| Инструмент | Ссылка | Описание ||------------|--------|----------|| **ED Colonisation Planner** | raven-colonial.com | Лучший планировщик: экономика, CP, зависимости || **Colonization Construction Details** | DaftMav (Reddit) | Таблицы со всеми статами || **ED Colony** | edcolony.app | Отслеживание активных строек || **ED Colonization Helper** | CMDR Mr.Smile | Мульти-CMDR поддержка |### Навигация и поиск| Инструмент | Ссылка | Описание ||------------|--------|----------|| **Spansh** | spansh.co.uk | Планирование маршрутов || **EDSM** | edsm.net | Карта галактики || **Inara** | inara.cz | Товары, рынки, фракции || **EDDB** | eddb.io | Поиск товаров и станций |### Сообщества- **r/EliteDangerous** — основной сабреддит- **r/EliteColonists** — специализированный по колонизации- **Frontier Forums** — официальные форумы- **Discord:** Elite Dangerous Community, New Pilots Initiative### Видео-гайды- **ObsidianAnt** — обзоры обновлений- **Down to Earth Astronomy** — гайды по механикам- **Exigeous** — быстрые туториалы- **TheYamiks** — подробные разборы---## Приложения и таблицы### Таблица A: Влияние объектов на параметры системы![Таблица влияния](/wiki/colonization-guide/ed_colonization_stats_v2.png)### Таблица B: Быстрый выбор объекта по цели| Ваша цель | Лучший объект | Альтернатива ||-----------|--------------|--------------|| Максимальное население | Planetary Port (+10/+10) | Dodec Starport (+8/+4) || Максимальная безопасность | Military Hub (+10) | Security Station (+8) || Максимальный Tech Level | Scientific Hub (+10) | Research Station (+8) || Максимальное развитие | Dodec Starport (+10) | Planetary Port (+10) || Максимальное богатство | Dodec Starport (+9) | Ocellus/Orbis (+7) || Быстрый старт Security | Military Outpost (+2) | Small Military Settlement (+2) || Самодостаточная экономика | Refinery Hub + Planetary Port | Asteroid Base + Extraction Hub |### Таблица C: Требования к материалам (примеры)> **Важно:** Точные требования меняются с обновлениями. Используйте ED Colonisation Planner для актуальных цифр.| Объект | Примерные товары | Объём ||--------|-----------------|-------|| Primary Port (Coriolis) | Bauxite, Food Cartridges, Indite, CMM Composite | ~5000–8000 т || Outpost | Меньше объём | ~1000–2000 т || Settlement | Зависит от типа | ~500–1500 т || Hub | Зависит от типа | ~1000–3000 т || Starport Tier 3 | Максимальный объём | ~10000+ т |### Таблица D: Время и инвестиции| Масштаб | Кредиты | Время | Сложность ||---------|---------|-------|-----------|| Первая колония (1 порт) | 50–100 млн | 2–4 недели | Легко || Развитая система (10 объектов) | 200–500 млн | 1–3 месяца | Средне || Мега-колония (50+ объектов) | 2–5 млрд | 6–12 месяцев | Сложно || Дальняя цепочка (10 систем) | 1–3 млрд | 3–6 месяцев | Очень сложно || Мини-Bubble (20+ систем) | 5+ млрд | 1+ год | Экстремально |---## ЗаключениеКолонизация в Elite Dangerous — это **марафон, а не спринт**. Не гонитесь за скоростью. Наслаждайтесь процессом: выбором системы, планированием, доставкой первой партии товаров, наблюдением за ростом вашей колонии.Ваша система — это **ваш вклад** в 400-миллиардную галактику. Как сказал Arthur Tolmie из Frontier: *«Мы доверили судьбу галактики в руки игроков»*. Идите и создавайте историю.**o7, командир. Удачи в колонизации. Увидимся в звёздах.**---*Дата: 2026-09-01 | Версия: 1.0 | Elite Dangerous © Frontier Developments plc. Данный гайд создан сообществом ED Ring Colony для сообщества Elite Dangerous.*', -- category_id: замените на UUID категории 'Колонизация' или используйте подзапрос: -- (SELECT id FROM public.wiki_categories WHERE slug = 'colonization') :category_id, -- author_id: замените на UUID пользователя :author_id, -- last_editor_id: замените на UUID пользователя :last_editor_id, 'published', TRUE, 0, 1, NOW(), NOW() ); -- -- 3. Создать начальную ревизию (опционально) -- INSERT INTO public.wiki_revisions ( --   article_id, --   content, --   editor_id, --   revision_number, --   change_summary -- ) VALUES ( --   (SELECT id FROM public.wiki_articles WHERE slug = 'polnyy-gayd-po-kolonizacii-v-elite-dangerous'), --   E'...', --   :author_id, --   1, --   'Initial publication' -- );


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

-- ============================================================ -- ED Ring Colony Wiki — Update: Colonization guide + 2 new articles -- Выполнено: 2026-09-03 -- Автор: Noobo_GreeenD -- ============================================================ DO $$ DECLARE     v_admin_id UUID := 'd0680fc1-5fa0-4a54-b9bd-6918f88de63a';     v_cat_colonization UUID := '117fddde-9c52-4741-b00d-edb2788e4e42';     v_article_id UUID; BEGIN     -- ============================================================     -- ОБНОВЛЕНИЕ: Гайд по колонизации (версия 2.0)     -- ============================================================     UPDATE public.wiki_articles     SET content = $c$# Полный гайд по колонизации в Elite Dangerous$nl$$nl$> **Актуально для:** Update 2 / Trailblazers (февраль 2026)  $nl$> **Автор:** Сообщество ED Ring Colony  $nl$> **Категория:** Колонизация  $nl$> **Версия:** 2.0  $nl$> **Статус:** Актуально для текущего патча$nl$$nl$---$nl$$nl$## Содержание$nl$$nl$1. [Введение: что такое колонизация](#введение-что-такое-колонизация)$nl$2. [Этап 0: Подготовка](#этап-0-подготовка)$nl$3. [Этап 1: Выбор системы](#этап-1-выбор-системы)$nl$4. [Этап 2: Покупка клейма](#этап-2-покупка-клейма)$nl$5. [Этап 3: Размещение маяка](#этап-3-размещение-маяка)$nl$6. [Этап 4: Доставка материалов](#этап-4-доставка-материалов)$nl$7. [Этап 5: Становление System Architect](#этап-5-становление-system-architect)$nl$8. [Защита клейма от перехвата](#защита-клейма-от-перехвата)$nl$9. [Технологическое дерево (Tech Tree)](#технологическое-дерево-tech-tree)$nl$10. [Орбитальные объекты: полный справочник](#орбитальные-объекты-полный-справочник)$nl$11. [Поверхностные объекты: полный справочник](#поверхностные-объекты-полный-справочник)$nl$12. [Экономика системы](#экономика-системы)$nl$13. [BGS, фракции и Powerplay](#bgs-фракции-и-powerplay)$nl$14. [Логистика и Fleet Carrier](#логистика-и-fleet-carrier)$nl$15. [Construction Points (CP)](#construction-points-cp)$nl$16. [Доход и награды](#доход-и-награды)$nl$17. [Название объектов](#название-объектов)$nl$18. [Демонтаж и отмена строительства](#демонтаж-и-отмена-строительства)$nl$19. [Расширение: цепочки систем и мини-Bubble](#расширение-цепочки-систем-и-мини-bubble)$nl$20. [Частые ошибки и как их избежать](#частые-ошибки-и-как-их-избежать)$nl$21. [Полезные инструменты и ресурсы](#полезные-инструменты-и-ресурсы)$nl$$nl$---$nl$$nl$## Введение: что такое колонизация$nl$$nl$**System Colonisation** — это механика, позволяющая игрокам заявлять незаселённые звёздные системы и развивать их, строя порты, аванпосты, поселения и другие объекты. Вы становитесь **System Architect** (Системным Архитектором) — бессрочным управляющим развитием своей колонии.$nl$$nl$### Ключевые факты (февраль 2026)$nl$$nl$- **101,862+ систем** колонизировано по всей галактике$nl$- **307,014 космических** и **175,973 наземных** объектов построено$nl$- Механика вышла из бета-теста **11 ноября 2025 года** (Dodec Update)$nl$- **Trailblazer megaships** были удалены из игры — колонии теперь самодостаточны$nl$- Колонизация — **PvE-контент**: другие игроки **не могут** разрушить вашу колонию$nl$- **Нет ежемесячных расходов** на содержание — развивайте в своём темпе$nl$- Каждая система уникальна: тип звезды, планеты, ресурсы влияют на экономику$nl$$nl$### Общая схема процесса$nl$$nl$```$nl$Выбор системы → Покупка клейма → Размещение маяка → Доставка материалов → $nl$→ Постройка первого порта → System Architect → Расширение системы$nl$```$nl$$nl$---$nl$$nl$## Этап 0: Подготовка$nl$$nl$### Минимальные требования$nl$$nl$| Параметр | Требование |$nl$|----------|------------|$nl$| Кредиты | Минимум **50–100 млн** (25 млн маяк + 25 млн резерв + стоимость корабля) |$nl$| Корабль | С трюмом **200+ тонн** (Type-9, Cutter, Type-11, Panther Clipper Mk II) |$nl$| FSD | Инженерный апгрейд от Felicity Farseer желателен |$nl$| Fleet Carrier | **Не обязателен**, но делает процесс в 10 раз проще |$nl$| Squadron | Желателен для координации и BGS-контроля |$nl$$nl$### Рекомендуемый набор кораблей$nl$$nl$1. **Panther Clipper Mk II** — новый король грузоперевозок (до 1238 т, Large)$nl$2. **Type-11 Prospector** — массовые перевозки, SCO-optimized$nl$3. **Corsair** — быстрый средний корабль с хорошим трюмом (318 т, SCO)$nl$4. **Python** — универсал: доставки, SRV, майнинг$nl$5. **Krait Mk II** — боевые миссии и защита$nl$6. **Diamondback Explorer** — разведка и поиск систем$nl$$nl$---$nl$$nl$## Этап 1: Выбор системы$nl$$nl$### Критерии выбора (от важного к менее важному)$nl$$nl$### Обязательные условия$nl$$nl$1. **Расстояние** — в пределах **15 световых лет** от заселённой системы$nl$2. **Статус** — система должна быть **Unclaimed** (незаявленной)$nl$3. **Доступность** — не permit-locked, не в exclusion zone$nl$$nl$### Желательные условия$nl$$nl$| Фактор | Почему важно | Идеально |$nl$|--------|-------------|----------|$nl$| **Тип звезды** | K/G-тип стабильны, дают хорошие слоты | K- или G-звезда |$nl$| **Количество планет** | Больше тел = больше орбитальных слотов | 5+ планет/лун |$nl$| **Кольца** | Создают Resource Extraction Sites | Кольца на Rocky body |$nl$| **Ресурсы** | Влияют на базовую экономику | Pristine reserves |$nl$| **Geological signals** | Бонус к Refinery-экономике | Есть на Rocky/HMC |$nl$| **Terraformable** | Бонус к населению и экономике | 1+ планета |$nl$$nl$### Типы планет и базовая экономика$nl$$nl$| Тип планеты | Базовая экономика | Бонус |$nl$|-------------|-------------------|-------|$nl$| Rocky body | Refinery +1.0 | Pristine = +, Depleted = − |$nl$| High Metal Content (HMC) | Extraction +1.0 | Геология = + |$nl$| Water World | Tourism потенциал | Terraformable = ++ |$nl$| Gas Giant | Много лун = слоты | Кольца = RES |$nl$$nl$### Чего избегать$nl$$nl$- **Neutron stars / Black holes** — нет планет, нет слотов$nl$- **White dwarfs** — мало слотов, опасны для FSD$nl$- **Системы с 1-2 планетами** — мало возможностей для развития$nl$- **Системы в 14.9 св.лет** — сложно достичь, мало запаса для цепочки$nl$$nl$---$nl$$nl$## Этап 2: Покупка клейма$nl$$nl$### Процесс$nl$$nl$1. Прилетите в **любой Star Port** в заселённой системе$nl$2. Откройте **Station Services → Colonization Contact**$nl$3. Выберите незаселённую систему в пределах 15 св.лет$nl$4. Выберите тип **Primary Starport**$nl$$nl$### Типы портов$nl$$nl$| Тип порта | Стоимость клейма | Особенности |$nl$|-----------|-----------------|-------------|$nl$| **Outpost** | Дешевле | Только Medium площадки, меньше грузов |$nl$| **Coriolis** | Средне | Классика, Large площадки, Colony-экономика |$nl$| **Ocellus** | Дороже | Tier 3, высокие статы |$nl$| **Orbis** | Дороже | Tier 3, аналог Ocellus |$nl$| **Dodec** | Самый дорогой | Tier 3, максимальные статы, уникальный дизайн |$nl$$nl$### Важно$nl$$nl$- Клейм действует **24 часа** — за это время нужно разместить маяк$nl$- Если пропустили дедлайн — **3 дня блокировки** перед новой попыткой$nl$- Нельзя иметь несколько активных клеймов одновременно$nl$- После завершения первого порта можно заявлять следующую систему$nl$$nl$---$nl$$nl$## Этап 3: Размещение маяка$nl$$nl$### Что нужно сделать$nl$$nl$1. Полетите в заявленную систему$nl$2. Откройте **System Colonization Suite** (модуль по умолчанию на всех кораблях)$nl$3. Разверните **Colonization Beacon** в предустановленной точке$nl$4. Маяк стоит **25 млн кредитов**$nl$$nl$### Что происходит дальше$nl$$nl$- Система помечается как **Claimed** (заявленная)$nl$- Запускается обратный отсчёт **24 часа**$nl$- Прибывает гигантский **Colonization Ship** — временная база с 32 площадками$nl$- Вы становитесь **System Architect** (после завершения первого порта)$nl$$nl$### Если не успели за 24 часа$nl$$nl$- Клейм **аннулируется**$nl$- **3 дня** нельзя подавать новые заявки$nl$- Потраченные кредиты **не возвращаются**$nl$$nl$---$nl$$nl$## Этап 4: Доставка материалов$nl$$nl$### Цель$nl$$nl$Доставить все необходимые **commodities** на Colonization Ship за **4 недели**.$nl$$nl$### Типы материалов$nl$$nl$| Категория | Примеры | Источник |$nl$|-----------|---------|----------|$nl$| **Руды (Minerals)** | Bauxite, Gallite, Indite, Coltan | Mining / Покупка |$nl$| **Товары (Commodities)** | Food Cartridges, Insulating Membrane, CMM Composite | Рынки Bubble |$nl$| **Материалы (Materials)** | Iron, Nickel, Carbon, Sulphur | SRV surface mining |$nl$| **Топливо** | Tritium для FC | Рынки / Mining |$nl$$nl$### Ключевые советы по доставке$nl$$nl$- **Fleet Carrier = must have** для серьёзных проектов: 25,000 т груза + прыжки 500 св.лет$nl$- **Panther Clipper Mk II** — новый лучший корабль для массовых перевозок (1238 т)$nl$- **Type-11 Prospector** — SCO-optimized, хорошая альтернатива$nl$- **Создавайте цепочки** систем каждые 15 св.лет для дальних колоний$nl$- Некоторые товары (**Insulating Membrane**) доступны **только** на орбитальных рынках$nl$- **CMM Composite** производится на планетах с Refinery-экономикой$nl$$nl$### Что происходит после доставки$nl$$nl$- Порт появляется в виде **строящейся станции** с лесами$nl$- После **еженедельного тика** (четверг, 07:00 UTC) порт достраивается$nl$- Маяк превращается в **Nav Beacon**$nl$- Система становится заселённой$nl$$nl$---$nl$$nl$## Этап 5: Становление System Architect$nl$$nl$### Ваши полномочия$nl$$nl$- **Размещение** новых объектов (орбитальных и поверхностных)$nl$- **Управление** экономикой, населением, безопасностью$nl$- **Назначение** названий объектов (платно через Arx)$nl$- **Демонтаж** ошибочно размещённых объектов$nl$$nl$### Ограничения$nl$$nl$- Нужно дождаться **первого еженедельного тика** после постройки порта$nl$- Количество **одновременных строек** ограничено (смотрите в Architect View)$nl$- Поверхностные объекты могут появляться с **задержкой до 48 часов**$nl$- **Ground Ports (Planetary Port)** не работают с экономическими влияниями — используйте Orbital Ports$nl$$nl$### Architect Mode$nl$$nl$- Открывается через **System Map**$nl$- Показывает доступные **орбитальные слоты** (иконки с «+»)$nl$- Показывает **поверхностные слоты** на каждой планете$nl$- Флаг на орбитальном слоте = место для **Primary Port**$nl$$nl$---$nl$$nl$## Защита клейма от перехвата$nl$$nl$### Механика «Claim Sniping Protection»$nl$$nl$После завершения первого порта в новой системе действует **эксклюзивная блокировка** на подачу клеймов ИЗ этой системы:$nl$$nl$| Фаза | Длительность | Кто может заявлять |$nl$|------|-------------|-------------------|$nl$| **Phase 1** | 30 минут | Только System Architect |$nl$| **Phase 2** | 23.5 часа | Члены Squadron Architect'а |$nl$| **Phase 3** | После 24 часов | Любой игрок |$nl$$nl$### Важно$nl$$nl$- Если Architect **не в Squadron** — действует только 30-минутная блокировка$nl$- Блокировка отображается в панели клейма с таймером$nl$- Это позволяет строить **цепочки систем** без опасения, что кто-то «перехватит» ваш маршрут$nl$- Даже одиночный игрок в своём собственном Squadron получает полные 24 часа защиты$nl$$nl$---$nl$$nl$## Технологическое дерево (Tech Tree)$nl$$nl$### Принцип работы$nl$$nl$- Каждый объект даёт **Construction Points (CP)**$nl$- **Tier 1** объекты открываются сразу (нужен только First Station)$nl$- **Tier 2** требуют определённых Tier 1 объектов$nl$- **Tier 3** требуют Tier 2 + достаточного количества CP$nl$$nl$### Пример цепочки$nl$$nl$```$nl$First Station → Scientific Outpost → Research Station → Ocellus Starport$nl$                    ↓$nl$             Mining Outpost → Asteroid Base$nl$```$nl$$nl$### Поверхностная ветка$nl$$nl$```$nl$First Station → Planetary Outposts → Settlements → Hubs → Planetary Port$nl$```$nl$$nl$---$nl$$nl$## Орбитальные объекты: полный справочник$nl$$nl$### Starports (Tier 2-3)$nl$$nl$| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | Pop+ | MaxPop+ |$nl$|--------|------|-----------|----------|------|--------|-----|-----|------|---------|$nl$| **Coriolis** | 2 | Colony | -2 | 1 | 2 | 3 | 2 | 1 | 0 |$nl$| **Asteroid Base** | 2 | Extraction | -1 | 3 | 5 | -4 | 7 | 1 | 0 |$nl$| **Ocellus** | 3 | Colony | -3 | 6 | 7 | 5 | 8 | 5 | 1 |$nl$| **Orbis** | 3 | Colony | -3 | 6 | 7 | 5 | 8 | 5 | 1 |$nl$| **Dodec** | 3 | Colony | -4 | 8 | 9 | 7 | 10 | 8 | 4 |$nl$$nl$### Outposts (Tier 1)$nl$$nl$| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | Pop+ | CP Reward |$nl$|--------|------|-----------|----------|------|--------|-----|-----|------|-----------|$nl$| **Commercial Outpost** | 1 | Colony | -1 | — | 2 | 5 | — | 0 | Tier 2: 1 |$nl$| **Industrial Outpost** | 1 | Industrial | — | 3 | — | — | 2 | 0 | Tier 2: 1 |$nl$| **Criminal Outpost** | 1 | Colony | -2 | — | 2 | — | — | 0 | Tier 2: 1 |$nl$| **Civilian Outpost** | 1 | Colony | -1 | — | 1 | 1 | 1 | 0 | Tier 2: 1 |$nl$| **Scientific Outpost** | 1 | Hightech | — | 3 | — | — | — | 1 | Tier 2: 1 |$nl$| **Military Outpost** | 1 | Military | 2 | — | — | — | — | 1 | Tier 2: 1 |$nl$$nl$### Installations (Tier 1-2)$nl$$nl$| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | CP Cost | CP Reward |$nl$|--------|------|-----------|----------|------|--------|-----|-----|---------|-----------|$nl$| **Satellite** | 1 | — | — | — | 1 | 1 | 1 | — | Tier 2: 1 |$nl$| **Communication Station** | 1 | — | — | 1 | 3 | — | — | — | Tier 2: 1 |$nl$| **Space Farm** | 1 | Agricultural | — | — | — | 5 | 1 | — | Tier 2: 1 |$nl$| **Pirate Base** | 1 | Contraband | -4 | — | 3 | — | — | — | Tier 2: 1 |$nl$| **Mining Outpost** | 1 | Extraction | — | — | 3 | -2 | — | — | Tier 2: 1 |$nl$| **Relay Station** | 1 | Hightech | 1 | — | — | — | 1 | — | Tier 2: 1 |$nl$| **Military Installation** | 2 | Military | 6 | — | — | — | — | Tier 2: 1 | Tier 3: 1 |$nl$$nl$---$nl$$nl$## Поверхностные объекты: полный справочник$nl$$nl$### Planetary Outposts (Tier 1)$nl$$nl$| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | Pop+ | CP Reward |$nl$|--------|------|-----------|----------|------|--------|-----|-----|------|-----------|$nl$| **Civilian Planetary Outpost** | 1 | Colony | -2 | — | — | 3 | — | 2 | Tier 2: 1 |$nl$| **Industrial Planetary Outpost** | 1 | Industrial | -1 | — | 2 | — | — | 1 | Tier 2: 1 |$nl$| **Scientific Planetary Outpost** | 1 | Hightech | -1 | 5 | — | — | 1 | 1 | Tier 2: 1 |$nl$$nl$### Planetary Port (Tier 3)$nl$$nl$| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | Pop+ | MaxPop+ | CP Cost |$nl$|--------|------|-----------|----------|------|--------|-----|-----|------|---------|---------|$nl$| **Planetary Port** | 3 | Colony | -3 | 5 | 5 | 6 | 10 | 10 | 10 | Tier 3: 6 |$nl$$nl$**Важно:** Planetary Port не получает экономических бонусов от других объектов. Используйте Orbital Ports для торговли.$nl$$nl$### Settlements (Tier 1-2)$nl$$nl$| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | CP Cost | CP Reward |$nl$|--------|------|-----------|----------|------|--------|-----|-----|---------|-----------|$nl$| **Small Agricultural Settlement** | 1 | Agricultural | — | — | — | 3 | — | — | Tier 2: 1 |$nl$| **Medium Agricultural Settlement** | 1 | Agricultural | — | — | — | 6 | — | — | Tier 2: 1 |$nl$| **Large Agricultural Settlement** | 2 | Agricultural | — | — | — | 10 | — | Tier 2: 1 | Tier 3: 2 |$nl$| **Small Extraction Settlement** | 1 | Extraction | — | — | 2 | — | — | — | Tier 2: 1 |$nl$| **Medium Extraction Settlement** | 1 | Extraction | — | — | 5 | — | — | — | Tier 2: 1 |$nl$| **Large Extraction Settlement** | 2 | Extraction | — | 1 | 7 | -2 | — | Tier 2: 1 | Tier 3: 2 |$nl$| **Small Industrial Settlement** | 1 | Industrial | — | — | — | — | 2 | — | Tier 2: 1 |$nl$| **Medium Industrial Settlement** | 1 | Industrial | — | — | — | — | 5 | — | Tier 2: 1 |$nl$| **Large Industrial Settlement** | 2 | Industrial | — | — | 2 | — | 8 | Tier 2: 1 | Tier 3: 2 |$nl$| **Small Military Settlement** | 1 | Military | 2 | — | — | — | — | — | Tier 2: 1 |$nl$| **Medium Military Settlement** | 1 | Military | 4 | — | — | — | — | — | Tier 2: 1 |$nl$| **Large Military Settlement** | 2 | Military | 6 | — | — | — | 2 | Tier 2: 1 | Tier 3: 2 |$nl$| **Small Scientific Settlement** | 2 | Hightech | — | 3 | — | — | 1 | Tier 2: 1 | Tier 3: 1 |$nl$| **Medium Scientific Settlement** | 2 | Hightech | — | 6 | — | — | 1 | Tier 2: 1 | Tier 3: 1 |$nl$| **Large Scientific Settlement** | 2 | Hightech | — | 10 | — | — | 2 | Tier 2: 1 | Tier 3: 2 |$nl$| **Small Tourism Settlement** | 2 | Tourism | -1 | — | 1 | — | — | Tier 2: 1 | Tier 3: 1 |$nl$| **Medium Tourism Settlement** | 2 | Tourism | -1 | — | 2 | — | — | Tier 2: 1 | Tier 3: 1 |$nl$| **Large Tourism Settlement** | 2 | Tourism | -1 | — | 5 | — | — | Tier 2: 1 | Tier 3: 2 |$nl$$nl$### Hubs (Tier 2)$nl$$nl$| Объект | Требует | Экономика | Security | Tech | Wealth | SoL | Dev | CP Cost | CP Reward |$nl$|--------|---------|-----------|----------|------|--------|-----|-----|---------|-----------|$nl$| **Extraction Hub** | Small/Medium/Large Mining Settlement | Extraction | — | — | 10 | -4 | 2 | Tier 2: 1 | Tier 3: 1 |$nl$| **Civilian Hub** | Small/Medium/Large Agricultural Settlement | — | -3 | — | — | 3 | 2 | Tier 2: 1 | Tier 3: 1 |$nl$| **Exploration Hub** | Communication Station | Tourism | -1 | 6 | — | — | 2 | Tier 2: 1 | Tier 3: 1 |$nl$| **Outpost Hub** | Space Farm | — | -2 | — | — | 3 | 2 | Tier 2: 1 | Tier 3: 1 |$nl$| **Scientific Hub** | First Station | Hightech | — | 10 | — | — | — | Tier 2: 1 | Tier 3: 1 |$nl$| **Military Hub** | Military Installation | Military | 10 | — | — | — | — | Tier 2: 1 | Tier 3: 1 |$nl$| **Refinery Hub** | First Station | Refinery | -1 | 3 | 5 | -2 | 7 | Tier 2: 1 | Tier 3: 1 |$nl$| **High Tech Hub** | First Station | Hightech | -2 | 10 | -2 | — | — | Tier 2: 1 | Tier 3: 1 |$nl$| **Industrial Hub** | Mining Outpost | Industrial | — | 3 | 5 | -4 | 2 | Tier 2: 1 | Tier 3: 1 |$nl$$nl$---$nl$$nl$## Экономика системы$nl$$nl$### Как работает экономика$nl$$nl$Каждый объект влияет на **6 параметров** системы:$nl$$nl$| Параметр | Описание | Что влияет |$nl$|----------|----------|------------|$nl$| **Security** | Уровень безопасности | Высокий = меньше пиратов, налоги |$nl$| **Tech Level** | Технологический уровень | Доступность модулей и кораблей |$nl$| **Wealth** | Богатство | Цены на товары, миссии |$nl$| **Standard of Living** | Уровень жизни | Пассажирские миссии, tourism |$nl$| **Development Level** | Уровень развития | Рост населения, BGS |$nl$| **Population** | Население | Количество миссий, размер рынка |$nl$$nl$### Базовая экономика планет$nl$$nl$| Тип тела | Базовая экономика | Бонус |$nl$|----------|-------------------|-------|$nl$| Rocky body | Refinery +1.0 | Pristine/Major reserves = + |$nl$| High Metal Content | Extraction +1.0 | Геология = + |$nl$| Water World | Tourism потенциал | Terraformable = ++ |$nl$| Icy body | — | — |$nl$| Gas Giant | — | Кольца = RES |$nl$$nl$### CMM Composite$nl$$nl$Для производства **CMM Composite** нужна **Refinery-экономика** в топ-2:$nl$$nl$1. **Rocky body** + Planetary Port (Civilian) + Refinery Hub$nl$2. **High Metal Content** + Planetary Port (Civilian) + Refinery Hub$nl$$nl$Если на планете есть geological/biological signals — может потребоваться больше Refinery Hub'ов.$nl$$nl$### Расположение объектов$nl$$nl$- Объекты **ближе к планете** сильнее влияют на экономику$nl$- Объекты **дальше от Starport** имеют **слабое рыночное соединение**$nl$- Экономика объекта влияет на рынки портов на **том же теле**$nl$$nl$---$nl$$nl$## BGS, фракции и Powerplay$nl$$nl$### Фракции$nl$$nl$- **Фракция, у которой куплен клейм**, становится доминирующей в системе$nl$- Существующие BGS-фракции могут расширяться в вашу систему$nl$- Player Minor Factions можно привезти через прокси$nl$- Супердержавы расширяют влияние через фракции-прокси$nl$$nl$### Government Type$nl$$nl$| Тип | Эффект |$nl$|-----|--------|$nl$| **Anarchy** | Сниженная безопасность, легальны все товары |$nl$| **Corporate** | Баланс между порядком и свободой |$nl$| **Democracy** | Высокий SoL, средняя безопасность |$nl$| **Dictatorship** | Высокая безопасность, низкий SoL |$nl$| **Theocracy** | Специфические ограничения на товары |$nl$$nl$### Powerplay$nl$$nl$- После постройки первого порта система **НЕ контролируется Power**$nl$- Фракция переносится из исходной системы$nl$- Для Powerplay-контроля нужно отдельное влияние$nl$$nl$---$nl$$nl$## Логистика и Fleet Carrier$nl$$nl$### Fleet Carrier — must have?$nl$$nl$| Без FC | С FC |$nl$|--------|------|$nl$| Множество рейсов в Bubble | Один рейс = 25,000 т |$nl$| Зависимость от рынков | Собственный рынок |$nl$| Ограниченная дальность | Прыжки 500 св.лет |$nl$| Высокие временные затраты | Автономность месяцами |$nl$$nl$### Топливо для FC$nl$$nl$- **Tritium** — покупается на рынках или добывается$nl$- Расход: ~1 тонна на прыжок$nl$- Всегда держите запас на 2 прыжка + 500 тонн$nl$$nl$### Lynx Highliner$nl$$nl$- Новый пассажирский лайнер (Zorgon Peterson)$nl$- Отличен для пассажирских миссий в/из вашей колонии$nl$- Business-class каюты = высокий доход$nl$$nl$---$nl$$nl$## Construction Points (CP)$nl$$nl$### Как получить$nl$$nl$| Источник | CP | Условие |$nl$|----------|-----|---------|$nl$| Tier 1 объект | — | Даёт CP для Tier 2 |$nl$| Tier 2 объект | Тратит CP | Даёт CP для Tier 3 |$nl$| Tier 3 объект | Тратит CP | Максимальный уровень |$nl$$nl$### Пример прогрессии$nl$$nl$```$nl$First Station (бесплатно)$nl$    ↓$nl$Scientific Outpost → даёт 1 CP (Tier 2)$nl$    ↓$nl$Research Station → тратит 3 CP (Tier 2 cost)$nl$    ↓$nl$Ocellus Starport → тратит 6 CP (Tier 3 cost)$nl$```$nl$$nl$### Ускорение CP$nl$$nl$- **Boom state** — +25% к генерации$nl$- **Player activity** — миссии в системе ускоряют рост$nl$- **Powerplay** — некоторые Power дают бонусы$nl$$nl$---$nl$$nl$## Доход и награды$nl$$nl$### Пассивный доход$nl$$nl$- **Торговля** — ваши порты генерируют товары$nl$- **Миссии** — чем выше население, тем больше миссий$nl$- **Tourist** — Tourism-экономика = высокооплачиваемые пассажирские миссии$nl$- **Mining** — Extraction/Refinery = ресурсы для продажи$nl$$nl$### Активный доход$nl$$nl$- **Доставка товаров** в вашу систему = высокие цены$nl$- **Stackable massacre missions** — если Military-экономика$nl$- **Passenger missions** — если Tourism/High SoL$nl$$nl$### Нет upkeep costs!$nl$$nl$В отличие от Fleet Carrier, колонии **не требуют** еженедельных платежей. Развивайте в своём темпе.$nl$$nl$---$nl$$nl$## Название объектов$nl$$nl$### Процесс$nl$$nl$1. Откройте **System Map → Architect View**$nl$2. Выберите объект$nl$3. Нажмите **Rename**$nl$4. Стоимость: **Arx** (внутриигровая премиум-валюта)$nl$$nl$### Правила$nl$$nl$- Модерация Frontier — оскорбления и товарные знаки запрещены$nl$- Единый стиль важен для иммерсии$nl$- Названия остаются **навсегда**$nl$$nl$---$nl$$nl$## Демонтаж и отмена строительства$nl$$nl$### Как снести объект$nl$$nl$1. Откройте **Galaxy Map**$nl$2. Найдите систему с объектом$nl$3. Откройте **System Map → Architect View**$nl$4. Выберите объект$nl$5. Нажмите **Demolish** внизу списка commodities$nl$6. Подтвердите$nl$$nl$### Что происходит$nl$$nl$- Демонтаж завершается после **серверного тика**$nl$- Таймер отображается в UI$nl$- **Возвращается только часть ресурсов**$nl$- Если объект строился — строительство отменяется$nl$$nl$### Важно$nl$$nl$- Демонтаж **Primary Port** невозможен$nl$- Некоторые объекты нельзя снести, если они требуются для других$nl$- Планируйте заранее — демонтаж дорогой$nl$$nl$---$nl$$nl$## Расширение: цепочки систем и мини-Bubble$nl$$nl$### Цепочки (Highways)$nl$$nl$- Каждая новая система должна быть в **15 св.лет** от существующей$nl$- Создавайте «ступеньки» каждые 10–15 св.лет$nl$- Используйте **Neutron Highway** для ускорения$nl$$nl$### Мини-Bubble$nl$$nl$- Группа систем в радиусе 30–50 св.лет$nl$- Общая логистика через Fleet Carrier$nl$- Специализация: одна система — добыча, другая — производство, третья — торговля$nl$$nl$### Omega Nebula$nl$$nl$- Популярное направление для колонизации$nl$- **40+ ringed water worlds** по маршруту$nl$- **31 чёрная дыра** и **57 нейтронных звёзд** в радиусе 50 св.лет$nl$- Достигнута сообществом **6 января 2026**$nl$$nl$---$nl$$nl$## Частые ошибки и как их избежать$nl$$nl$| Ошибка | Последствие | Решение |$nl$|--------|-------------|---------|$nl$| **Пропустили 24 часа на маяк** | Потеря 25 млн + 3 дня блокировки | Ставьте таймер, не откладывайте |$nl$| **Построили Ground Port для торговли** | Нет экономических бонусов | Используйте Orbital Ports |$nl$| **Неправильное расположение** | Слабое влияние на экономику | Объекты ближе к планете = сильнее |$nl$| **Забыли про CP** | Нельзя строить Tier 3 | Планируйте Tech Tree заранее |$nl$| **Нет резерва Tritium** | FC застрял в пустоте | Всегда 2 прыжка + 500 тонн |$nl$| **Соло в дальней системе** | Сложно доставлять материалы | Squadron или FC-логистика |$nl$$nl$---$nl$$nl$## Полезные инструменты и ресурсы$nl$$nl$### Внеигровые инструменты$nl$$nl$| Инструмент | Ссылка | Описание |$nl$|------------|--------|----------|$nl$| **ED Colonisation Planner** | [edcolonisationplanner.com](https://edcolonisationplanner.com) | Автоматический планировщик: загрузите журнал, выберите цель — он рассчитает порядок строительства |$nl$| **DaftMav Spreadsheet** | [Google Sheets](https://docs.google.com) | Таблица со всеми объектами, CP, экономикой |$nl$| **Raven Colonial Corp** | [raven-colonial.org](https://raven-colonial.org) | Планирование колоний, экономика, логистика |$nl$| **Inara** | [inara.cz](https://inara.cz) | Поиск товаров, commodities, инженеры |$nl$| **Spansh** | [spansh.co.uk](https://spansh.co.uk) | Neutron Highway, маршруты |$nl$$nl$### Сообщества$nl$$nl$- **Frontier Forums** — [forums.frontier.co.uk/forums/system-colonisation](https://forums.frontier.co.uk/forums/system-colonisation/)$nl$- **Reddit** — r/EliteDangerous, r/EliteColonization$nl$- **Discord** — серверы Squadron и проектов$nl$$nl$---$nl$$nl$## Оценка$nl$$nl$Колонизация — это **конечная цель** для многих пилотов Elite Dangerous. Это не даёт прямого преимущества в PvP или PvE, но предоставляет **беспрецедентный уровень креативного контроля** над игровой вселенной. Ваша система останется в галактике **навсегда** — это ваш перманентный след в истории Elite Dangerous.$c$,         last_editor_id = v_admin_id,         version = 2,         updated_at = NOW()     WHERE slug = 'polnyy-gayd-po-kolonizacii-v-elite-dangerous';     -- Add revision for updated guide     INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)     SELECT id, content, v_admin_id, 2, 'Updated for February 2026: added claim sniping protection, Dodec stats, new ships (Panther Clipper, Corsair), ground port warnings, demolition info, updated statistics', NOW()     FROM public.wiki_articles WHERE slug = 'polnyy-gayd-po-kolonizacii-v-elite-dangerous';     -- ============================================================     -- НОВАЯ СТАТЬЯ 1: Выбор системы для колонизации     -- ============================================================     INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)     VALUES (         'Выбор системы для колонизации',         'vybor-sistemy-dlya-kolonizacii',         $c$# Выбор системы для колонизации$nl$$nl$**Тип:** Колонизация / Гайд$nl$**Сложность:** Начальный–Средний$nl$**Время чтения:** 10 минут$nl$$nl$## Описание$nl$$nl$Выбор правильной системы — это 50% успеха колонизации. Плохой выбор = ограниченное развитие, сложная логистика, разочарование. Этот гайд научит находить идеальные системы за 15 минут сканирования.$nl$$nl$## Чек-лист идеальной системы$nl$$nl$### Обязательно (без этого не начинайте)$nl$$nl$| Критерий | Почему важно | Минимум |$nl$|----------|-------------|---------|$nl$| **Unclaimed статус** | Иначе нельзя заявить | Да |$nl$| **В пределах 15 св.лет от inhabited** | Требование механики | ≤ 15 св.лет |$nl$| **Не permit-locked** | Иначе доступ закрыт | Да |$nl$| **Есть планеты** | Нужны слоты для объектов | 3+ тела |$nl$$nl$### Желательно (влияет на потенциал)$nl$$nl$| Критерий | Идеально | Хорошо | Плохо |$nl$|----------|----------|--------|-------|$nl$| **Тип звезды** | K, G | F, M | Neutron, WD, BH |$nl$| **Планеты** | 8+ | 5–7 | 1–2 |$nl$| **Rocky bodies** | 2+ с кольцами | 1 с кольцами | 0 |$nl$| **HMC планеты** | 2+ с геологией | 1 с геологией | 0 |$nl$| **Water Worlds** | 1 terraformable | 1 обычный | 0 |$nl$| **Резервы** | Pristine | Major | Low/Depleted |$nl$$nl$### Бонусы (делают систему уникальной)$nl$$nl$- **Кольца на Rocky body** → Resource Extraction Sites$nl$- **Terraformable Water World** → Tourism + Population$nl$- **Geological signals** → Refinery бонус$nl$- **Biological signals** → Exploration / Tourism$nl$- **Близость к Neutron star** → Быстрые путешествия$nl$$nl$## Пошаговый поиск$nl$$nl$### Шаг 1: Найти anchor-систему$nl$$nl$1. Откройте **Galaxy Map**$nl$2. Включите фильтр **«Inhabited Systems»**$nl$3. Найдите систему на **границе Bubble** или вашей мини-Bubble$nl$4. Запомните координаты$nl$$nl$### Шаг 2: Поиск в радиусе 15 св.лет$nl$$nl$1. Переключитесь на **«Unclaimed Systems»**$nl$2. Ищите в радиусе 15 св.лет от anchor$nl$3. Сканируйте каждую кандидатку FSS$nl$$nl$### Шаг 3: Быстрая оценка (FSS)$nl$$nl$| Что смотреть | За сколько секунд | Что значит |$nl$|--------------|-------------------|------------|$nl$| Тип звезды | 2 сек | K/G = хорошо, иначе skip |$nl$| Количество тел | 5 сек | 5+ = продолжаем, 3-4 = возможно, 1-2 = skip |$nl$| Кольца | 10 сек | Есть = отлично |$nl$| Terraformable | 15 сек | Есть = бонус |$nl$$nl$### Шаг 4: Детальное сканирование (если прошла отбор)$nl$$nl$1. Прилетите в систему$nl$2. Отсканируйте **Discovery Scanner**$nl$3. Откройте **System Map** и изучите каждое тело$nl$4. Проверьте **Planetary Information**:$nl$   - Composition (для ресурсов)$nl$   - Signals (геология/биология)$nl$   - Terraformable status$nl$$nl$### Шаг 5: Проверка слотов$nl$$nl$1. Откройте **Galaxy Map → System Colonisation view**$nl$2. Выберите систему$nl$3. Посмотрите **иконки слотов**:$nl$   - **+** = доступный слот$nl$   - **Флаг** = слот для Primary Port$nl$   - Чем больше слотов — тем лучше$nl$$nl$## Типы систем по назначению$nl$$nl$### Тип A: Промышленная$nl$$nl$**Цель:** Производство CMM Composite, Refinery, Industrial$nl$$nl$**Идеальные условия:**$nl$- Rocky body с Pristine reserves$nl$- Geological signals$nl$- 2+ HMC планеты$nl$- Много слотов$nl$$nl$**Что строить:**$nl$- Refinery Hub$nl$- Industrial Settlement (Large)$nl$- Mining Outpost$nl$- Planetary Port на Rocky body$nl$$nl$### Тип B: Туристическая$nl$$nl$**Цель:** Высокий доход от пассажиров$nl$$nl$**Идеальные условия:**$nl$- Terraformable Water World$nl$- Красивые виды (туманности, кольца)$nl$- Высокий SoL потенциал$nl$$nl$**Что строить:**$nl$- Tourism Settlement (Large)$nl$- Exploration Hub$nl$- Luxury Starport (Ocellus/Dodec)$nl$- Communication Station$nl$$nl$### Тип C: Военная$nl$$nl$**Цель:** Stackable massacre missions, высокая безопасность$nl$$nl$**Идеальные условия:**$nl$- Близость к Conflict Zones$nl$- Возможность Military-экономики$nl$$nl$**Что строить:**$nl$- Military Settlement (Large)$nl$- Military Hub$nl$- Military Outpost$nl$- Starport с высоким Security$nl$$nl$### Тип D: Исследовательская$nl$$nl$**Цель:** High Tech, продажа данных, Universal Cartographics$nl$$nl$**Идеальные условия:**$nl$- Необычная звезда (Wolf-Rayet, T Tauri)$nl$- Интересные планеты$nl$- Далеко от Bubble (для продажи данных)$nl$$nl$**Что строить:**$nl$- Scientific Settlement (Large)$nl$- Scientific Hub$nl$- Research Station$nl$- High Tech Hub$nl$$nl$## Красные флаги (пропускайте)$nl$$nl$| Проблема | Почему плохо |$nl$|----------|-------------|$nl$| **Только 1-2 планеты** | Мало слотов, нет развития |$nl$| **Нет Rocky/HMC** | Нет добычи, нет Refinery |$nl$| **White Dwarf primary** | Опасно, мало слотов |$nl$| **14.9 св.лет от inhabited** | Сложно достичь, нет запаса |$nl$| **Permit-locked** | Просто нельзя |$nl$| **Уже Claimed** | Кто-то успел раньше |$nl$$nl$## Инструменты для поиска$nl$$nl$| Инструмент | Как использовать |$nl$|------------|-----------------|$nl$| **EDSM** | Поиск систем по параметрам |$nl$| **Spansh** | Маршруты, neutron highway |$nl$| **Inara** | Проверка статуса системы |$nl$| **ED Colonisation Planner** | Загрузите скан — получите рекомендации |$nl$$nl$## Оценка$nl$$nl$Идеальная система — это баланс между логистикой (близость к Bubble), потенциалом (планеты, ресурсы) и вашими целями. Не гонитесь за «идеалом» — хорошая система в 5 св.лет лучше идеальной в 14.9. Помните: вы можете иметь **неограниченное количество** колоний, так что первую можно использовать для обучения.$c$,         v_cat_colonization, v_admin_id, v_admin_id, 'published', false, 0, 1, NOW(), NOW()     ) RETURNING id INTO v_article_id;     INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)     VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed', NOW());     -- ============================================================     -- НОВАЯ СТАТЬЯ 2: Экономика колонии и BGS     -- ============================================================     INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)     VALUES (         'Экономика колонии и BGS',         'ekonomiya-kolonii-i-bgs',         $c$# Экономика колонии и BGS$nl$$nl$**Тип:** Колонизация / Механика$nl$**Сложность:** Средний–Высокий$nl$**Время чтения:** 12 минут$nl$$nl$## Описание$nl$$nl$Экономика колонии — это не просто цифры. Это живой организм, который определяет, какие товары продаются на ваших рынках, какие миссии доступны пилотам и как быстро растёт ваше население. Понимание BGS (Background Simulation) позволяет создавать системы, которые приносят **пассивный доход** и служат якорем для сообщества.$nl$$nl$## Шесть столпов экономики$nl$$nl$Каждый объект влияет на 6 параметров:$nl$$nl$| Параметр | Что делает | Как повысить |$nl$|----------|-----------|--------------|$nl$| **Security** | Уровень безопасности | Military объекты, Starports |$nl$| **Tech Level** | Технологический уровень | Scientific/High Tech объекты |$nl$| **Wealth** | Богатство | Commercial, Tourism, Refinery |$nl$| **Standard of Living (SoL)** | Пассажирские миссии, tourism | Agricultural, Civilian объекты |$nl$| **Development Level** | Уровень развития | Рост населения, BGS |$nl$| **Population** | Население | Starports, Planetary Port |$nl$$nl$## Как работает влияние объектов$nl$$nl$### Принцип близости$nl$$nl$- Объекты **ближе к планете** = **сильнее влияние**$nl$- Объекты **дальше от Starport** = **слабое рыночное соединение**$nl$- Экономика объекта влияет на рынки портов **на том же теле**$nl$$nl$### Пример$nl$$nl$```$nl$Планета A (Rocky body, Pristine)$nl$├── Orbital: Coriolis Starport (Slot 0) ← РЫНОК$nl$├── Orbital: Mining Outpost (Slot 1)    ← Влияет на Coriolis$nl$├── Orbital: Refinery Hub (Slot 2)      ← Влияет слабее$nl$└── Surface: Large Extraction Settlement  ← Влияет на Coriolis$nl$$nl$Планета B (Water World)$nl$├── Orbital: Ocellus Starport (Slot 0)  ← Свой рынок$nl$└── Orbital: Tourism Settlement           ← Влияет на Ocellus$nl$```$nl$$nl$## Создание CMM Composite$nl$$nl$CMM Composite — **ключевой товар** для колонизации. Без него сложно строить Tier 2-3 объекты.$nl$$nl$### Способ 1: Rocky body + Refinery$nl$$nl$1. Найдите **Rocky body** с **Pristine reserves**$nl$2. Постройте **Planetary Port (Civilian)** или **Planetary Outpost (Civilian)**$nl$3. Добавьте **Refinery Hub** на поверхности$nl$4. Убедитесь, что Refinery в **топ-2 экономик** системы$nl$$nl$### Способ 2: HMC + Refinery$nl$$nl$1. Найдите **High Metal Content** body$nl$2. Постройте **Planetary Port (Civilian)**$nl$3. Добавьте **Refinery Hub**$nl$4. Если есть geological signals — может потребоваться **2+ Refinery Hub**$nl$$nl$### Проверка$nl$$nl$- Откройте рынок на Starport$nl$- Посмотрите **Commodities → CMM Composite**$nl$- Если есть в продаже — Refinery работает$nl$- Если нет — добавьте ещё Refinery-объектов$nl$$nl$## Government Type и рынок$nl$$nl$| Government | Эффект на рынок | Особенности |$nl$|------------|----------------|-------------|$nl$| **Anarchy** | Все товары легальны | Низкая безопасность, пиратство |$nl$| **Corporate** | Баланс | Средние цены, стабильность |$nl$| **Democracy** | Высокий SoL | Больше пассажирских миссий |$nl$| **Dictatorship** | Высокая безопасность | Низкий SoL, строгий контроль |$nl$| **Theocracy** | Ограничения на товары | Некоторые товары illegal |$nl$$nl$**Важно:** Если government type считает товар **illegal** — он **не появится** на рынке, даже если экономика подходит.$nl$$nl$## BGS-циклы и состояния$nl$$nl$### Как работает BGS в колониях$nl$$nl$1. Каждая система имеет **фракцию-владельца** (та, у которой куплен клейм)$nl$2. Фракция может находиться в разных **состояниях (states)**$nl$3. Состояния меняются каждый **tick** (ежедневно)$nl$$nl$### Полезные состояния$nl$$nl$| State | Эффект | Как вызвать |$nl$|-------|--------|-------------|$nl$| **Boom** | +25% доход, быстрый рост | Торговля, миссии на доход |$nl$| **Expansion** | Расширение в соседние системы | Высокое влияние, население |$nl$| **Investment** | Бонусы к строительству | Продажа товаров, доходы |$nl$| **Civil Liberty** | Высокий SoL | Миссии на безопасность |$nl$$nl$### Вредные состояния$nl$$nl$| State | Эффект | Как избежать |$nl$|-------|--------|--------------|$nl$| **Bust** | -25% доход, замедление | Не допускайте дефицита товаров |$nl$| **Civil Unrest** | Низкая безопасность | Поддерживайте Security |$nl$| **Famine** | Нет еды, кризис | Стройте Agricultural объекты |$nl$| **Outbreak** | Медицинский кризис | Стройте медицинские объекты |$nl$$nl$## Манипуляция BGS$nl$$nl$### Для одиночек$nl$$nl$1. Выполняйте **миссии** для вашей фракции$nl$2. **Продавайте товары** на рынках вашей системы$nl$3. **Сканируйте** данные и продавайте их$nl$4. Участвуйте в **Conflict Zones** (если Military)$nl$$nl$### Для Squadron$nl$$nl$1. **Координируйте миссии** — 10 пилотов = 10x эффект$nl$2. **Организуйте торговые рейсы** — массовые продажи товаров$nl$3. **Stackable massacre missions** — Military-экономика + CZ$nl$4. **Bounty hunting** — повышает Security$nl$$nl$### Типичная BGS-рутина (30 минут)$nl$$nl$```$nl$1. Взять 3 миссии на доставку для вашей фракции$nl$2. Купить товары и доставить$nl$3. Взять 2 миссии на bounty hunting$nl$4. Полететь в RES, заработать 500k+ bounties$nl$5. Сдать миссии и bounties$nl$6. Повторить на следующей системе$nl$```$nl$$nl$## Экономические стратегии$nl$$nl$### Стратегия 1: Торговый хаб$nl$$nl$**Цель:** Максимальный Wealth + Population$nl$$nl$**Объекты:**$nl$- Coriolis / Ocellus (Commercial focus)$nl$- Commercial Outpost$nl$- Space Farm$nl$- Civilian Hub$nl$$nl$**Результат:** Высокие цены, много миссий, пассивный доход$nl$$nl$### Стратегия 2: Промышленный комплекс$nl$$nl$**Цель:** CMM Composite + Industrial товары$nl$$nl$**Объекты:**$nl$- Asteroid Base (Extraction)$nl$- Industrial Settlement (Large)$nl$- Refinery Hub$nl$- Mining Outpost$nl$$nl$**Результат:** Производство ключевых товаров, экспорт в Bubble$nl$$nl$### Стратегия 3: Военная база$nl$$nl$**Цель:** Stackable massacre missions$nl$$nl$**Объекты:**$nl$- Military Settlement (Large)$nl$- Military Hub$nl$- Military Outpost$nl$- Starport с высоким Security$nl$$nl$**Результат:** 50–100 млн/час на massacre missions$nl$$nl$### Стратегия 4: Научный центр$nl$$nl$**Цель:** High Tech + продажа данных$nl$$nl$**Объекты:**$nl$- Scientific Settlement (Large)$nl$- Scientific Hub$nl$- Research Station$nl$- Communication Station$nl$$nl$**Результат:** Доступ к G5 модулям, высокие цены на данные$nl$$nl$## Частые вопросы$nl$$nl$### Q: Почему на моём рынке нет товаров?$nl$$nl$A: Проверьте:$nl$1. Прошёл ли **первый тик** после постройки?$nl$2. Правильная ли **экономика** (Refinery для CMM)?$nl$3. Не считает ли **government** товар illegal?$nl$4. Достаточно ли **населения**?$nl$$nl$### Q: Как быстрее растить население?$nl$$nl$A:$nl$1. Стройте объекты с **Population Increase** (Starports, Planetary Port)$nl$2. Поддерживайте **Boom** state$nl$3. Стройте **Agricultural** объекты (SoL → рост населения)$nl$4. Ждите — рост пассивный, но ускоряется активностью$nl$$nl$### Q: Можно ли изменить government type?$nl$$nl$A: Напрямую — нет. Но можно привезти **Player Minor Faction** с нужным government type и вырастить её влияние до 75%+.$nl$$nl$### Q: Что делать, если фракция уходит в Bust?$nl$$nl$A:$nl$1. Массово продавайте товары на рынок$nl$2. Выполняйте миссии на доход$nl$3. Избегайте миссий, которые забирают товары из системы$nl$4. Подождите 3–7 дней — BGS самокорректируется$nl$$nl$## Оценка$nl$$nl$BGS — это «тёмная материя» Elite Dangerous. Она невидима, но определяет всё. Понимание экономики колонии позволяет превратить пустую систему в **процветающий торговый хаб** или **неприступную военную крепость**. Не игнорируйте BGS — это разница между «построил и забыл» и «построил и процветаю».$c$,         v_cat_colonization, v_admin_id, v_admin_id, 'published', false, 0, 1, NOW(), NOW()     ) RETURNING id INTO v_article_id;     INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)     VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed', NOW()); END $$;


-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260903020000_wiki_lore_articles.sql               │
-- └────────────────────────────────────────────────────────────────┘

-- ED Ring Colony Wiki — Seed: 5 Lore Articles (History, CMDRs, Colonia, Generation Ships, Raxxla) -- ============================================================ -- Run this in Supabase SQL Editor after deployment DO $$ DECLARE v_admin_id UUID := 'd0680fc1-5fa0-4a54-b9bd-6918f88de63a'; v_cat_lore UUID := 'ceb24c42-7d36-483c-880b-e0e08d5c4d99'; v_article_id UUID; BEGIN -- ============================================================ -- 1. История человечества — хронология от 2090 до 3308+ -- ============================================================ INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at) VALUES ( 'История человечества: хронология от 2090 до 3308+', 'istoriya-chelovechestva-hronologiya', $c$# История человечества: хронология от 2090 до 3308+$nl$$nl$**Тип:** Лор$nl$**Категория:** История вселенной$nl$**Время чтения:** 20 минут$nl$$nl$## XXI век: Первые шаги (2090–2200)$nl$$nl$### 2090 — Первые колонии за пределами Солнечной системы$nl$$nl$После decades of resource depletion и климатического кризиса человечество обратило взор к звёздам. Первые межзвёздные колонизационные корабли, оснащённые прототипами Frame Shift Drive, отправились к ближайшим системам: Alpha Centauri, Tau Ceti и Barnard's Star. Эти миссии были односторонними — колонисты знали, что связь с Землёй займёт годы.$nl$$nl$### 2150 — Формирование Федерации (Federation)$nl$$nl$Крупные корпорации, финансировавшие колонизацию, начали требовать политического представительства. Рождается **Federation of Star Systems** — первое наднациональное правительство, контролируемое корпоративными интересами. Земля (Sol) становится административным центром, но реальная власть переходит к совету акционеров.$nl$$nl$### 2200 — Открытие первых инопланетных артефактов$nl$$nl$На планете в системе Tau Ceti археологи находят странные структуры, предшествующие человеческой колонизации на миллионы лет. Эти находки засекречены, но слухи порождают первые культы, посвящённые «Древним» — предтечам современных теорий о Guardians и Thargoids.$nl$$nl$## XXIII век: Распад и войны (2200–2400)$nl$$nl$### 2242 — Война за независимость Achenar$nl$$nl$Колония в системе **Achenar** отказывается платить налоги Федерации. В ответ Федерация отправляет военный флот. Но колонисты, возглавляемые семьёй **Duval**, оказывают ожесточённое сопротивление. Война заканчивается поражением Федерации и провозглашением **Empire of Achenar** — будущей галактической сверхдержавы.$nl$$nl$### 2300 — Эра Generation Ships$nl$$nl$До массового распространения FSD человечество отправляет сотни **кораблей-поколений** (Generation Ships) к далёким звёздам. Эти гигантские арки с замороженными экипажами или замкнутыми экосистемами уходят в путь на сотни лет. Многие из них так и не выходят на связь — их судьба станет одной из величайших тайн галактики.$nl$$nl$### 2380 — Первый контакт с Thargoids$nl$$nl$На окраине исследованного пространства патрульный корабль Федерации сталкивается с неизвестными объектами органической формы. Контакт быстро переходит в бой. **Thargoids** — раса насекомоподобных существ с биологическими кораблями — объявляют человечеству войну. Конфликт затихает после разработки противотаргоидного оружия, но вражда не забыта.$nl$$nl$## XXV век: Технологический рывок (2400–2800)$nl$$nl$### 2800 — Изобретение Frame Shift Drive$nl$$nl$Прорыв в понимании пространственно-временной метрики приводит к созданию современного **FSD**. Путешествие между звёздами, занимавшее десятилетия, сокращается до секунд. Человечество взрывается в галактику — начинается **Великая Экспансия**.$nl$$nl$### 2850 — Основание Alliance$nl$$nl$Мелкие независимые системы, уставшие от геополитического противостояния Федерации и Империи, формируют **Alliance of Independent Systems**. Alliance провозглашает принципы самоопределения, свободной торговли и взаимной обороны. Становится третьей доминирующей силой в галактике.$nl$$nl$### 2900 — Эра пиратства и частных армий$nl$$nl$Быстрая колонизация порождает правовой вакуум. На окраинах появляются пиратские королевства, охотничьи кланы и корпоративные армии. В ответ появляются первые **Squadron** — объединения независимых пилотов, берущих на себя защиту слабых.$nl$$nl$## XXXIV век: Современность (3300–3308+)$nl$$nl$### 3301 — Возвращение командера Jameson$nl$$nl$Командер **John Jameson**, легендарный пилот эпохи первых войн с Thargoids, обнаруживается в криокамере на заброшенной станции. Его возвращение становится символом новой эры — эры, в которой один пилот может изменить судьбу галактики.$nl$$nl$### 3303 — Вторжение Thargoids$nl$$nl$Thargoids возвращаются в полную силу. Их биологические корабли — **Interceptors** и **Scouts** — атакуют станции в Pleiades и за её пределами. Начинается системная война, в которой пилоты-независимки играют ключевую роль в эвакуации и обороне.$nl$$nl$### 3305 — Открытие Colonia Bridge$nl$$nl$Построен маршрут станций между Bubble и Colonia — **Colonia Bridge**. Это событие окончательно интегрирует дальний регион в жизнь галактики и открывает эпоху массовой миграции.$nl$$nl$### 3307 — Распад и новые союзы$nl$$nl$Политическая напряжённость достигает пика. Федерация и Империя сталкиваются в прокси-войнах. Alliance укрепляет позиции через **Alliance Chieftain** и военные контракты. В тени этого противостояния растёт влияние **Project Dynasty** и других секретных программ.$nl$$nl$### 3308 — Эра колонизации$nl$$nl$Начинается новая волна экспансии. Система **Colonia** становится центром самоуправляемого региона. Пилоты-независимки получают инструменты для создания собственных станций и фракций. Человечество выходит за пределы известного пространства — в глубокий космос.$nl$$nl$## Будущее (3308+)$nl$$nl$Галактика стоит на пороге новых открытий. Слухи о **Stargoids**, таинственных объектах, движущихся через галактику, настораживают учёных. Проекты вроде **The Galaxy Ring** обещают соединить отдалённые регионы. А где-то в туманности **Raxxla** всё ещё ждёт своего первооткрывателя.$nl$$nl$---$nl$$nl$*«Мы смотрим на звёзды не потому, что они близки, а потому, что мы смелы»* — неизвестный пилот, 3301.$c$, v_cat_lore, v_admin_id, v_admin_id, 'published', true, 0, 1, NOW(), NOW() ) RETURNING id INTO v_article_id; INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at) VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed', NOW()); -- ============================================================ -- 2. CMDR: кто такие пилоты — ранг Elite, легендарные пилоты, Squadron -- ============================================================ INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at) VALUES ( 'CMDR: кто такие пилоты — ранг Elite, легендарные пилоты, Squadron', 'cmdr-kto-takie-piloty', $c$# CMDR: кто такие пилоты$nl$$nl$**Тип:** Лор / Геймплей$nl$**Категория:** Пилоты и общество$nl$**Время чтения:** 15 минут$nl$$nl$## Кто такие CMDR?$nl$$nl$**CMDR** (Commander) — стандартное обращение к лицензированным пилотам космических аппаратов в галактике человечества. Каждый CMDR — это независимый оператор, владеющий собственным кораблём и действующий на свой страх и риск. Система лицензирования появилась в середине XXIX века как способ контролировать хаос частного звёздного флота.$nl$$nl$CMDR может быть торговцем, наёмником, исследователем, спасателем или пиратом — закон не различает моральные качества, только квалификацию.$nl$$nl$## Система рангов$nl$$nl$Пилотская федерация (Pilots Federation) ведёт учёт достижений каждого CMDR в четырёх ключевых областях:$nl$$nl$| Ранг | Торговля (Trader) | Бой (Combat) | Исследования (Explorer) | CQC (Arena) |$nl$|------|-------------------|--------------|-------------------------|-------------|$nl$| Harmless / Penniless / Aimless / Helpless | — | — | — | — |$nl$| Mostly Harmless | + | + | + | + |$nl$| Novice | ++ | ++ | ++ | ++ |$nl$| Competent | +++ | +++ | +++ | +++ |$nl$| Expert | ++++ | ++++ | ++++ | ++++ |$nl$| Master | +++++ | +++++ | +++++ | +++++ |$nl$| Dangerous / Merchant / Scout / Amateur | — | — | — | — |$nl$| Deadly / Broker | — | — | — | — |$nl$| **Elite** | **Elite** | **Elite** | **Elite** | **Elite** |$nl$$nl$### Ранг Elite$nl$$nl$Достичь ранга **Elite** — значит войти в 0,1% лучших пилотов галактики. Это не просто статус: Elite-пилоты получают доступ к закрытым станциям, эксклюзивным контрактам и особым зонам вроде **Shinrarta Dezhra** (система, где продаются все корабли и модули со скидкой).$nl$$nl$Существует также звание **Elite Dangerous** — пожизненный статус, присваиваемый за достижение ранга Elite во всех трёх основных дисциплинах (Combat, Trade, Exploration).$nl$$nl$## Легендарные пилоты$nl$$nl$### John Jameson$nl$$nl$Герой Первой Таргоидской Войны. Его имя носит станция **Jameson Memorial** в Shinrarta Dezhra. Считается погибшим, но в 3301 году был найден в криостазе. Его корабль и записи раскрыли правду о секретных биологических программах INRA.$nl$$nl$### CMDR Besieger$nl$$nl$Один из первых пилотов, достигших Colonia в одиночку без Fleet Carrier. Его маршрут через neutron stars стал классикой для экспедиций.$nl$$nl$### CMDR Erimus Kamzel$nl$$nl$«Первопроходец Colonia». Именно его экспедиция 3302 года заложила основы для миграции в регион **Colonia**. В его честь названа станция **Kamzel's Reach**.$nl$$nl$### CMDR DoveEnigma13$nl$$nl$Легенда исследовательского сообщества. Первый, кто достиг галактического центра (Sagittarius A*) на стоковом Sidewinder без инженерных модификаций.$nl$$nl$### CMDR Harry Potter$nl$$nl$Пожалуй, самый известный PvP-пилот в истории игры. Его бои против кораблей класса «Анаконда» на лёгких истребителях вошли в учебники асимметричного боя.$nl$$nl$## Squadron — братва звёзд$nl$$nl$**Squadron** — объединение пилотов под единым командованием. Это может быть военная эскадрилья, торговая гильдия, исследовательская экспедиция или банда пиратов.$nl$$nl$### Типы Squadron$nl$$nl$| Тип | Фокус | Особенности |$nl$|-----|-------|-------------|$nl$| **PCC** (Player-created faction) | BGS | Контроль фракций в системах |$nl$| **Expedition** | Исследования | Дальние миры, совместные маршруты |$nl$| **PMF** (Private Military Force) | PvP / PvE | Наёмные операции, охрана конвоев |$nl$| **Trade Union** | Торговля | Совместные маршруты, защита цен |$nl$| **Explorer Corps** | Наука | Картография, первооткрытие |$nl$$nl$### Как создать Squadron$nl$$nl$1. Наберите минимум 4 пилотов$nl$2. Оплатите регистрацию в Pilots Federation (10 млн CR)$nl$3. Выберите тег (tag) — короткое обозначение вроде [RING] или [AXI]$nl$4. Настройте иерархию ролей: Leader, Deputy, Ambassador, Lieutenant, Agent, Rookie$nl$5. Выберите цветовую схему и лор$nl$$nl$### Крупнейшие Squadron галактики$nl$$nl$- **The Fuel Rats** — спасатели, вытащившие тысячи пилотов из без топлива$nl$- **The Hull Seals** — инженерная поддержка и ремонт в дальнем космосе$nl$- **Canonn Research** — научное сообщество, изучающее аномалии$nl$- **Anti-Xeno Initiative** — организованная оборона от Thargoids$nl$- **The Dark Wheel** — тайное общество, охотящееся за Raxxla (по слухам)$nl$$nl$---$nl$$nl$*«CMDR — это не просто позывной. Это обещание: где бы ты ни был, ты никогда не один»*.$c$, v_cat_lore, v_admin_id, v_admin_id, 'published', true, 0, 1, NOW(), NOW() ) RETURNING id INTO v_article_id; INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at) VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed', NOW()); -- ============================================================ -- 3. Colonia: край света — история Jaques Station, миграция, современная Colonia -- ============================================================ INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at) VALUES ( 'Colonia: край света — история Jaques Station, миграция, современная Colonia', 'colonia-kray-sveta', $c$# Colonia: край света$nl$$nl$**Тип:** Лор / География$nl$**Категория:** Регионы галактики$nl$**Время чтения:** 15 минут$nl$$nl$## Где находится Colonia?$nl$$nl$**Colonia** — регион галактики, расположенный примерно в **22 000 световых лет** от Sol в направлении галактического центра. Это самое крупное человеческое поселение за пределами Bubble (основной зоны цивилизации).$nl$$nl$Координаты: **Colonia (Eol Prou RS-T d3-94)**$nl$$nl$## История Jaques Station$nl$$nl$### 3302 — Побег орбитальной станции$nl$$nl$**Jaques Station** — уникальная **орбитальная станция с двигателями**, принадлежавшая цыганскому бармену **Jaques**. Она была единственной станцией в галактике, способной совершать межзвёздные прыжки.$nl$$nl$Jaques планировал перепрыгнуть в **Beagle Point** — самую дальнюю точку галактики. Но что-то пошло не так. Во время прыжка станция была повреждена неизвестным объектом и выброшена в систему **Eol Prou RS-T d3-94** — посреди ничего, в 22 000 св. лет от дома.$nl$$nl$### 3302–3303 — Спасательная операция$nl$$nl$Сообщество пилотов организовало масштабную спасательную операцию. Тысячи CMDR доставляли металлы, food cartridges и machinery для ремонта станции. Эта операция стала одним из первых примеров truly player-driven narrative в Elite Dangerous.$nl$$nl$### 3303 — Рождение Colonia$nl$$nl$После ремонта Jaques Station стала центром нового региона. Вокруг неё начали строиться новые станции, прибывали колонисты. Регион получил имя **Colonia** — по названию первой станции.$nl$$nl$## Великая миграция$nl$$nl$### Почему люди уезжают в Colonia?$nl$$nl$| Причина | Описание |$nl$|---------|----------|$nl$| **Свобода** | Нет давления BGS крупных фракций |$nl$| **Тишина** | Никаких гриферов, никакой перегруженности |$nl$| **Природа** | Уникальные планеты, близость к туманностям |$nl$| **Сообщество** | Тесные связи между пилотами |$nl$| **Новый старт** | Возможность создать что-то своё |$nl$$nl$### Маршруты в Colonia$nl$$nl$1. **Neutron Highway** — самый быстрый путь (500–800 прыжков). Требует Fuel Scoop и терпения.$nl$2. **Colonia Bridge** — цепочка станций и Fleet Carriers, построенная к 3305 году.$nl$3. **Fleet Carrier Taxi** — многие владельцы FC предлагают бесплатные рейсы.$nl$$nl$## Современная Colonia (3308)$nl$$nl$### Инфраструктура$nl$$nl$- **Jaques Station** — центр региона, орбитальный хаб$nl$- **Colonia Orbital** — промышленная станция$nl$- **Dove Enigma** — исследовательский аванпост$nl$- **Rohini** — первая система на пути из Bubble, точка сбора$nl$- **Eagle's Landing** — военный аванпост$nl$$nl$### Экономика$nl$$nl$Colonia живёт за счёт:$nl$- **Туризма** — пилоты со всей галактики$nl$- **Ремонта и дозаправки** — станции обслуживают путешественников$nl$- **Научных программ** — изучение уникальной флоры и геологии$nl$- **Миграционных услуг** — переезд кораблей и модулей$nl$$nl$### Проблемы$nl$$nl$- **Отдалённость** — доставка товаров из Bubble занимает недели$nl$- **Ограниченный выбор кораблей** — не все модели доступны$nl$- **Зависимость от пилотов** — без постоянного притока CMDR регион вымирает$nl$$nl$---$nl$$nl$*«Colonia — это не просто место. Это доказательство того, что человечество может начать всё сначала»* — Jaques, 3303.$c$, v_cat_lore, v_admin_id, v_admin_id, 'published', true, 0, 1, NOW(), NOW() ) RETURNING id INTO v_article_id; INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at) VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed', NOW()); -- ============================================================ -- 4. Generation Ships: призраки прошлого -- ============================================================ INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at) VALUES ( 'Generation Ships: призраки прошлого — заброшенные корабли-поколения', 'generation-ships-prizraki-proshlogo', $c$# Generation Ships: призраки прошлого$nl$$nl$**Тип:** Лор / Мистика$nl$**Категория:** Забытая история$nl$**Время чтения:** 12 минут$nl$$nl$## Что такое Generation Ships?$nl$$nl$**Корабли-поколения** (Generation Ships) — гигантские межзвёздные арки, запущенные до изобретения современного FSD. Они предназначались для путешествий, длящихся сотни лет. Экипажи либо жили в замкнутых экосистемах, передавая миссию из поколения в поколение, либо находились в анабиозе.$nl$$nl$Каждый такой корабль — это целый мир: жилые купола, фермы, фабрики, школы, больницы. Некоторые весили миллионы тонн и несли десятки тысяч колонистов.$nl$$nl$## Сколько их было?$nl$$nl$Точное число неизвестно. Историки насчитывают от **70 000 до 100 000** кораблей-поколений, запущенных между 2200 и 2700 годами. Из них связь поддерживала лишь горстка. Остальные исчезли в бездне.$nl$$nl$## Известные находки$nl$$nl$### The Golconda$nl$$nl$Самая известная находка. **The Golconda** был обнаружен в 3305 году в системе **Upaniklis**. На борту жили потомки оригинального экипажа, которые тысячу лет развивали собственную культуру, религию и язык.$nl$$nl$Они отказались покидать корабль, но согласились на компромисс: **Federation** построила для них станцию **Forester's Choice**, сохранив их образ жизни.$nl$$nl$### The Hesperus$nl$$nl$Корабль-призрак, найденный в 3307. На борту обнаружены следы борьбы за выживание и записи о «чём-то за бортом». Судьба экипажа неизвестна — корабль был пуст.$nl$$nl$### The Demeter$nl$$nl$Обнаружен с повреждёнными системами жизнеобеспечения. Экипаж погиб от отказа экосистемы за десятилетия до находки. Записи показывают, как они пытались починить корабль, используя поколенческие знания.$nl$$nl$### The Phobos$nl$$nl$Корабль, где экипаж разделился на две враждующие фракции. Гражданская война в замкнутом пространстве привела к полному уничтожению населения.$nl$$nl$### The Artemis$nl$$nl$Самая мрачная находка. Экипаж совершил массовый суицид после получения (или имитации) сигнала от инопланетного разума. Записи содержат описания «голосов из гиперпространства».$nl$$nl$## Что с ними случилось?$nl$$nl$| Сценарий | Доля кораблей | Примеры |$nl$|----------|---------------|---------|$nl$| Достигли цели и основали колонию | ~5% | Неизвестны |$nl$| Погибли от технических сбоев | ~30% | The Demeter |$nl$| Внутренние конфликты / социальный коллапс | ~20% | The Phobos |$nl$| Встреча с неизвестным (Thargoids?) | ~10% | The Artemis, The Hesperus |$nl$| Потерялись / сбились с курса | ~25% | Большинство |$nl$| Ещё в пути | ~10% | Теоретически возможно |$nl$$nl$## Можно ли их найти сегодня?$nl$$nl$Да. Каждый год пилоты-исследователи находят новые корабли-поколения. Обычно они обнаруживаются в виде сигналов «**Distress Call**» или «**Degraded Emissions**» в системах, не имеющих других объектов.$nl$$nl$Если вы нашли Generation Ship:$nl$1. Не стыкуйтесь без подготовки — атмосфера может быть токсичной$nl$2. Сканируйте все терминалы данных$nl$3. Фотографируйте — Canonn Research выплачивает награды за новые находки$nl$4. Уважайте погибших — это исторические памятники$nl$$nl$---$nl$$nl$*«Каждый Generation Ship — это гробница мечты. Но иногда мечта переживает тех, кто её нёс»*.$c$, v_cat_lore, v_admin_id, v_admin_id, 'published', true, 0, 1, NOW(), NOW() ) RETURNING id INTO v_article_id; INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at) VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed', NOW()); -- ============================================================ -- 5. Raxxla и The Dark Wheel — мистика, тайны, что известно -- ============================================================ INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at) VALUES ( 'Raxxla и The Dark Wheel — мистика, тайны, что известно', 'raxxla-i-the-dark-wheel', $c$# Raxxla и The Dark Wheel$nl$$nl$**Тип:** Лор / Мистика / Конспирология$nl$**Категория:** Великие тайны$nl$**Время чтения:** 15 минут$nl$**Важно:** Эта статья основана на подтверждённых фактах, слухах и теориях сообщества.$nl$$nl$## Что такое Raxxla?$nl$$nl$**Raxxla** — легендарный объект, место или состояние бытия, существование которого упоминается в пилотском фольклоре с XXIII века. Официально ни одна фракция не подтвердила его нахождение.$nl$$nl$### Официально известные факты$nl$$nl$1. **Название впервые задокументировано в 2296 году** — пилот-курьер упомянул «врата в Raxxla» в своём дневнике перед исчезновением.$nl$2. **В 2800-х годах** несколько экспедиций искали объект в секторе **Formidine Rift** — ни одна не вернулась.$nl$3. **В 3301 году** инженер **Brosa Meree** заявил, что «Raxxla — это не место, это путь». Он был объявлен невменяемым.$nl$4. **В 3303 году** сигнал, похожий на описания «песни Raxxla», был зарегистрирован в **Cone Sector** — но сектор был немедленно закрыт для посещения Аegis.$nl$$nl$### Теории сообщества$nl$$nl$| Теория | Описание | Статус |$nl$|--------|----------|--------|$nl$| Планета с вратами | Raxxla — планета с древней технологией телепортации | Неподтверждено |$nl$| Корабль-звезда | Объект размером с луну, движущийся по галактике | Неподтверждено |$nl$| Другое измерение | Raxxla — точка входа в параллельное пространство | Спекуляция |$nl$| Метафора | «Raxxla» — кодовое слово для секретной программы | Возможно |$nl$| Thargoid origin | Объект создан Thargoids как ловушка | Теория заговора |$nl$$nl$## The Dark Wheel — охотники за тайной$nl$$nl$### Что это?$nl$$nl$**The Dark Wheel** — тайное общество (или сеть агентов), посвящённое поиску Raxxla. Их существование не доказано, но упоминания встречаются в записях с 2700-х годов.$nl$$nl$### Что известно$nl$$nl$1. **Символ** — восьмиконечная звезда в круге.$nl$2. **Методы** — агенты внедряются во все крупные фракции, включая Pilots Federation.$nl$3. **Финансирование** — предположительно, неограниченное. Некоторые находки Generation Ships были «случайно» оплачены анонимными благотворителями.$nl$4. **Связь с Shinrarta Dezhra** — станция **Jameson Memorial** построена на орбите планеты, которая по некоторым данным была «точкой отсчёта» для первых карт Dark Wheel.$nl$$nl$### Точки интереса$nl$$nl$| Локация | Почему важна |$nl$|---------|--------------|$nl$| **Formidine Rift** | Здесь пропали первые экспедиции |$nl$| **Cone Sector** | Зарегистрирован «сигнал Raxxla», затем закрыт |$nl$| **Siren Sector** | Необъяснимые аномалии сканирования |$nl$| **Delphi** | Центр Anti-Xeno Initiative, но также — странные руины |$nl$| **Guardian Space** | Некоторые тексты Guardians упоминают «врата» |$nl$$nl$## Закрытые досье$nl$$nl$### Проект Dynasty$nl$$nl$Секретная программа Федерации (3300–3305) по поиску Raxxla. Финансировалась через чёрный бюджет. Была закрыта после инцидента в **HIP 22460**.$nl$$nl$### Записи CMDR Salomé$nl$$nl$Пилот и конспиролог **Salomé** утверждала, что Raxxla — это «ключ к свободе человечества от контроля элит». Она была убита в 3303 году при попытке передать координаты. Данные так и не были восстановлены.$nl$$nl$## Как искать Raxxla?$nl$$nl$Разработчики подтвердили, что Raxxla **действительно существует в игре** и может быть найдена. Вот что рекомендуют охотники:$nl$$nl$1. **Изучайте лор** — ключи спрятаны в GalNet и записях Generation Ships$nl$2. **Сканируйте необитаемые системы** — Raxxla не там, где все ищут$nl$3. **Обращайте внимание на аномалии** — странные сигналы, геологические образования, «ошибки» карт$nl$4. **Следите за патчами** — иногда разработчики добавляют подсказки$nl$5. **Не верьте всему** — 90% «координат Raxxla» — фейки$nl$$nl$---$nl$$nl$*«Raxxla — это не сокровище. Это зеркало. Кто ищет власть — найдёт погибель. Кто ищет знание — найдёт вопросы»* — предположительно, запись The Dark Wheel, 2844 год.$c$, v_cat_lore, v_admin_id, v_admin_id, 'published', true, 0, 1, NOW(), NOW() ) RETURNING id INTO v_article_id; INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at) VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed', NOW()); END $$;


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

-- ════════════════════════════════════════════════════════════════ -- Migration 026: System Coordinates Cache + Map Pilots Support -- ════════════════════════════════════════════════════════════════ -- ─── system_coords: кэш координат систем для карты и пилотов ─── CREATE TABLE IF NOT EXISTS system_coords ( id SERIAL PRIMARY KEY, system_name TEXT NOT NULL UNIQUE, x NUMERIC(10,4), y NUMERIC(10,4), z NUMERIC(10,4), source TEXT DEFAULT 'edsm', updated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW() ); ALTER TABLE system_coords ENABLE ROW LEVEL SECURITY; DO $$ BEGIN IF NOT EXISTS ( SELECT 1 FROM pg_policies WHERE tablename = 'system_coords' AND policyname = 'system_coords_public' ) THEN CREATE POLICY system_coords_public ON system_coords FOR SELECT USING (true); END IF; END $$; CREATE INDEX IF NOT EXISTS idx_system_coords_name ON system_coords(system_name); -- ─── Индексы для быстрого поиска пилотов на карте ─── CREATE INDEX IF NOT EXISTS idx_capi_profiles_current_system ON capi_profiles(current_system); CREATE INDEX IF NOT EXISTS idx_capi_profiles_last_updated ON capi_profiles(last_updated DESC);


-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260908010000_wiki_exobiology.sql                  │
-- └────────────────────────────────────────────────────────────────┘

-- ED Ring Colony Wiki — Seed: Exobiology Category + 12 Articles
-- ============================================================
-- Run this in Supabase SQL Editor after deployment

DO $$
DECLARE
  v_admin_id UUID := 'd0680fc1-5fa0-4a54-b9bd-6918f88de63a';
  v_cat_exo UUID;
  v_article_id UUID;
BEGIN

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
  v_cat_exo, v_admin_id, v_admin_id, 'published', true, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed: Exobiology guide', NOW());

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
  v_cat_exo, v_admin_id, v_admin_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed: Bacteria', NOW());


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
  v_cat_exo, v_admin_id, v_admin_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed: Fungoida', NOW());

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
  v_cat_exo, v_admin_id, v_admin_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed: Osseus', NOW());

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
  v_cat_exo, v_admin_id, v_admin_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed: Frutexa', NOW());


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
  v_cat_exo, v_admin_id, v_admin_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed: Tussock', NOW());

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
  v_cat_exo, v_admin_id, v_admin_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed: Cactoida', NOW());

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
  v_cat_exo, v_admin_id, v_admin_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed: Concha', NOW());


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
  v_cat_exo, v_admin_id, v_admin_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed: Electricae', NOW());

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
  v_cat_exo, v_admin_id, v_admin_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed: Stratum', NOW());

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
  v_cat_exo, v_admin_id, v_admin_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed: Recepta', NOW());


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
  v_cat_exo, v_admin_id, v_admin_id, 'published', false, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed: Top-10 systems', NOW());

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
  v_cat_exo, v_admin_id, v_admin_id, 'published', true, 0, 1, NOW(), NOW()
) RETURNING id INTO v_article_id;

INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_admin_id, 1, 'Initial seed: Exobiology and Elite rank', NOW());

END $$;


-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20260908020000_wiki_exobiology_update.sql           │
-- └────────────────────────────────────────────────────────────────┘

-- Exobiology articles update with actual data from Elite Dangerous Wiki (Fandom)
-- Applied: 2026-09-08
-- Source: elite-dangerous.fandom.com/wiki/Exobiologist

-- All 18 articles updated/inserted via Management API
-- See previous migration 20260908010000 for initial seed


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
-- │ MIGRATION: 20260911030000_squadron_read_models_and_profile_sync.sql│
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
-- │ MIGRATION: 20260911040000_delivery_import_placement_resolver.sql│
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
-- │ MIGRATION: 20260919000000_delivery_import_timeout_hardening.sql│
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
-- │ MIGRATION: 20260928000000_colonisation_events_source_hash.sql   │
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

