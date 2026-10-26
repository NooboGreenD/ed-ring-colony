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
--   • supabase/maintenance/colonisation_sites_cutover.sql
--     (перенос состояний площадок и удаление старой colonisation_events — вручную)
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
  inara_url       TEXT,
  source_updated_at TIMESTAMPTZ,
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

-- Frontier CAPI: дополнительные поля для полной карточки пилота.
--
-- Привязка выполняется по user_id (UUID), а cmdr_name используется только
-- для ссылки /cmdr/<name>. Поэтому смена имени Frontier не должна создавать
-- второй профиль или затирать пользовательский ник сайта.

ALTER TABLE public.capi_profiles
  ADD COLUMN IF NOT EXISTS cqc_rank INTEGER,
  ADD COLUMN IF NOT EXISTS loan BIGINT,
  ADD COLUMN IF NOT EXISTS frontier_id TEXT;

CREATE INDEX IF NOT EXISTS idx_capi_profiles_cmdr_name
  ON public.capi_profiles (cmdr_name);

COMMENT ON COLUMN public.capi_profiles.frontier_id IS 'Идентификатор командира Frontier, если его отдаёт CAPI';
COMMENT ON COLUMN public.capi_profiles.loan IS 'Текущий кредитный займ командира из Frontier CAPI';

-- Сохраняем большую полуось из события Scan для орбитальной сверки в Архитекторе.
ALTER TABLE public.system_scans
  ADD COLUMN IF NOT EXISTS semi_major_axis_ls DOUBLE PRECISION;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261001000000_body_signals.sql                     │
-- └────────────────────────────────────────────────────────────────┘

-- ═══════════════════════════════════════════════════════════════
-- Migration: сигналы тел — не только биология
-- ═══════════════════════════════════════════════════════════════
--
-- `system_scans` умел считать лишь биологические сигналы. Игра сообщает
-- в `FSSBodySignals`/`SAASignalsFound` и остальные: геологические точки
-- (материалы), следы людей (чужое присутствие рядом со стройкой),
-- сигналы стражей и таргоидов. Архитектору системы они нужны на карточке
-- тела и на 3D-карте, поэтому храним их рядом с биологией.
--
-- Колонки добавляются отдельно от `bio_signals_count`, а не заменяют его:
-- на него ссылаются уже записанные строки, импорт EDSM и приложение-помощник.

ALTER TABLE public.system_scans
  ADD COLUMN IF NOT EXISTS geo_signals_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS human_signals_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS thargoid_signals_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS guardian_signals_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_signals_count INTEGER DEFAULT 0,
  -- Сырой список сигналов события: тип + количество. Хранится «как есть»,
  -- чтобы новые типы сигналов не требовали новой миграции.
  ADD COLUMN IF NOT EXISTS signals JSONB DEFAULT '[]'::jsonb;

-- Выборка «где есть сигналы» по системе: карточки тел в архитекторе и
-- фильтр «есть сигналы» на 3D-карте ходят именно так.
CREATE INDEX IF NOT EXISTS idx_system_scans_signals
  ON public.system_scans (system_name)
  WHERE bio_signals_count > 0
     OR geo_signals_count > 0
     OR human_signals_count > 0
     OR thargoid_signals_count > 0
     OR guardian_signals_count > 0
     OR other_signals_count > 0;

COMMENT ON COLUMN public.system_scans.geo_signals_count IS 'Геологические сигналы тела (FSSBodySignals/SAASignalsFound)';
COMMENT ON COLUMN public.system_scans.human_signals_count IS 'Сигналы человеческого присутствия на теле';
COMMENT ON COLUMN public.system_scans.thargoid_signals_count IS 'Сигналы таргоидов на теле';
COMMENT ON COLUMN public.system_scans.guardian_signals_count IS 'Сигналы стражей на теле';
COMMENT ON COLUMN public.system_scans.other_signals_count IS 'Прочие сигналы, которые игра не отнесла к известным типам';
COMMENT ON COLUMN public.system_scans.signals IS 'Сырой список сигналов: [{"type": "...", "count": N}]';

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261002000000_capi_profile_binding_and_fleet.sql   │
-- └────────────────────────────────────────────────────────────────┘

-- Frontier CAPI: дополнительные поля для полной карточки пилота.
--
-- Привязка выполняется по user_id (UUID), а cmdr_name используется только
-- для ссылки /cmdr/<name>. Поэтому смена имени Frontier не должна создавать
-- второй профиль или затирать пользовательский ник сайта.

ALTER TABLE public.capi_profiles
  ADD COLUMN IF NOT EXISTS cqc_rank INTEGER,
  ADD COLUMN IF NOT EXISTS loan BIGINT,
  ADD COLUMN IF NOT EXISTS frontier_id TEXT;

CREATE INDEX IF NOT EXISTS idx_capi_profiles_cmdr_name
  ON public.capi_profiles (cmdr_name);

COMMENT ON COLUMN public.capi_profiles.frontier_id IS 'Идентификатор командира Frontier, если его отдаёт CAPI';
COMMENT ON COLUMN public.capi_profiles.loan IS 'Текущий кредитный займ командира из Frontier CAPI';

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261002010000_system_scans_orbit.sql               │
-- └────────────────────────────────────────────────────────────────┘

-- Сохраняем большую полуось из события Scan для орбитальной сверки в Архитекторе.
ALTER TABLE public.system_scans
  ADD COLUMN IF NOT EXISTS semi_major_axis_ls DOUBLE PRECISION;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261003000000_capi_binding_diagnostics.sql         │
-- └────────────────────────────────────────────────────────────────┘

-- ─────────────────────────────────────────────────────────────
-- Frontier CAPI: состояние привязки должно быть видно, а не угадываться.
--
-- Зачем
-- -----
-- Жалоба «все этапы проходят, но привязка не делается» была неотличима от
-- «Companion API временно недоступен» и от «база отстала на миграцию»:
-- в capi_tokens хранился только сам токен, а причина сбоя нигде не
-- фиксировалась. Ниже — минимум полей, по которым сайт и cron понимают,
-- жива ли связь и что с ней случилось в последний раз.
--
--   platform      — на каком аккаунте авторизовался пилот (audience OAuth:
--                   frontier/steam/epic/xbox/psn). Нужен, чтобы предложить
--                   тот же способ входа при переподключении.
--   linked_at     — когда привязка создана. Refresh-токен Frontier живёт не
--                   дольше 25 дней от авторизации, и по этой дате видно,
--                   что пора просить пилота авторизоваться заново.
--   last_error    — текст последнего сбоя синхронизации.
--   last_error_at — когда он случился.
--
-- Колонки добавляются NULL'ами: у существующих привязок истории нет, а
-- «нет данных» и «ошибок не было» — разные состояния.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.capi_tokens
  ADD COLUMN IF NOT EXISTS platform      TEXT,
  ADD COLUMN IF NOT EXISTS linked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error    TEXT,
  ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;

-- Один аккаунт Frontier — одна учётная запись сайта. Индекс нужен колбэку:
-- он проверяет, не привязан ли этот customer_id к кому-то ещё, прежде чем
-- перезаписывать токены.
CREATE INDEX IF NOT EXISTS idx_capi_tokens_frontier_id
  ON public.capi_tokens (frontier_id)
  WHERE frontier_id IS NOT NULL;

-- Cron берёт привязки по времени последнего синка, начиная с тех, которых
-- не синхронизировали ни разу.
CREATE INDEX IF NOT EXISTS idx_capi_tokens_sync_queue
  ON public.capi_tokens (last_synced_at NULLS FIRST)
  WHERE is_active;

COMMENT ON COLUMN public.capi_tokens.platform IS 'Платформа аккаунта Frontier (audience OAuth): frontier, steam, epic, xbox, psn';
COMMENT ON COLUMN public.capi_tokens.linked_at IS 'Когда пилот прошёл авторизацию Frontier; refresh-токен живёт не дольше 25 дней от этой даты';
COMMENT ON COLUMN public.capi_tokens.last_error IS 'Последняя ошибка синхронизации CAPI — показывается в /account/capi';

-- Ранги Odyssey из CAPI (commander.rank.soldier / .exobiologist): колонки
-- уже есть в capi_profiles с миграции 20260916000000, но у баз, залитых
-- ранним снимком схемы, их может не быть — повторяем идемпотентно, иначе
-- синк молча теряет эти два ранга.
ALTER TABLE public.capi_profiles
  ADD COLUMN IF NOT EXISTS mercenary_rank    INTEGER,
  ADD COLUMN IF NOT EXISTS exobiologist_rank INTEGER,
  ADD COLUMN IF NOT EXISTS cqc_rank          INTEGER,
  ADD COLUMN IF NOT EXISTS loan              BIGINT,
  ADD COLUMN IF NOT EXISTS frontier_id       TEXT;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261004000000_profile_avatars_fallback.sql         │
-- └────────────────────────────────────────────────────────────────┘

-- ─────────────────────────────────────────────────────────────
-- Аватары профиля: запасное хранилище и гарантированный бакет.
--
-- Зачем
-- -----
-- Жалоба: «картинки профиля не загружаются, при смене аватарки ошибка 503».
-- 503 отдаёт не сайт: браузер грузил файл НАПРЯМУЮ в Supabase Storage
-- (`supabase.<домен>/storage/v1/...`), и когда контейнер storage не поднят
-- или Kong не видит живой upstream, шлюз отвечает 503 Service Unavailable.
-- Пилот при этом видел только текст ошибки из SDK и терял аватар.
--
-- Теперь загрузка идёт через сайт (`POST /api/account/avatar`), а если
-- Storage недоступен, картинка сохраняется прямо в базе и отдаётся
-- маршрутом `/api/avatars/<user_id>`. Аватары продолжают работать даже при
-- мёртвом storage-контейнере, а починка инфраструктуры перестаёт быть
-- условием для смены картинки.
--
-- Размер намеренно ограничен приложением (≤ 1 МБ после проверки MIME):
-- база — не файловое хранилище, это именно запасной путь.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.profile_avatars (
  user_id    UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  mime       TEXT        NOT NULL,
  bytes      BYTEA       NOT NULL,
  byte_size  INTEGER     NOT NULL,
  checksum   TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.profile_avatars IS
  'Запасное хранилище аватаров: используется, когда Supabase Storage недоступен (см. /api/account/avatar)';
COMMENT ON COLUMN public.profile_avatars.checksum IS
  'SHA-256 содержимого: служит версией в адресе /api/avatars/<id>?v=… и ETag при отдаче';

ALTER TABLE public.profile_avatars ENABLE ROW LEVEL SECURITY;

-- Пишет и читает эти строки сервер под service_role (он RLS не подчиняется).
-- Пилоту оставляем чтение собственной строки: полезно для отладки и не даёт
-- выгрузить чужие картинки одним запросом PostgREST.
DROP POLICY IF EXISTS profile_avatars_select_own ON public.profile_avatars;
CREATE POLICY profile_avatars_select_own ON public.profile_avatars
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON public.profile_avatars FROM anon;
GRANT SELECT ON public.profile_avatars TO authenticated;

-- ── Бакет avatars ────────────────────────────────────────────
-- В 000_base_schema.sql он создаётся внутри DO-блока, который молча
-- пропускается, если схема storage ещё не развёрнута (частый порядок при
-- self-hosted установке: сначала SQL, потом контейнеры). Повторяем создание
-- идемпотентно — иначе Storage отвечает «Bucket not found» и после починки
-- 503 загрузка всё равно не работает.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public)
    VALUES ('avatars', 'avatars', true)
    ON CONFLICT (id) DO UPDATE SET public = true;

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
      RAISE NOTICE 'storage.objects принадлежит supabase_admin — политики бакета avatars настройте через Dashboard';
    END;
  ELSE
    RAISE NOTICE 'Схема storage не найдена: бакет avatars будет создан приложением при первой загрузке';
  END IF;
END $$;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261004010000_saved_outfitting_builds.sql           │
-- └────────────────────────────────────────────────────────────────┘

create table if not exists public.outfitting_builds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  ship text not null,
  code text not null,
  created_at timestamptz not null default now()
);
create index if not exists outfitting_builds_user_created_idx on public.outfitting_builds(user_id, created_at desc);
alter table public.outfitting_builds enable row level security;
create policy "users manage own outfitting builds" on public.outfitting_builds
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261005000000_squadron_tag_optional.sql            │
-- └────────────────────────────────────────────────────────────────┘

-- ─────────────────────────────────────────────────────────────
-- Эскадрильи: тег перестаёт быть обязательным в базе.
--
-- Зачем
-- -----
-- Жалоба «не создаются эскадрильи». Одна из причин — расхождение между
-- интерфейсом и схемой: форма считает тег необязательным (в личном кабинете
-- он отправляется как `undefined`), а колонка объявлена
-- `tag TEXT NOT NULL` ещё в 000_base_schema.sql. Insert падал с
-- «null value in column "tag" violates not-null constraint», и пилот видел
-- общее «Could not create squadron».
--
-- Приложение теперь собирает тег из названия, когда пилот его не ввёл
-- (см. src/lib/squadronForm.ts), но держать в схеме требование, которого нет
-- в интерфейсе, всё равно неправильно: любой другой клиент (мобильное
-- приложение, скрипт) наступит на те же грабли.
--
-- Идемпотентно: DROP NOT NULL можно выполнять повторно.
-- ─────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.squadrons') IS NULL THEN
    RAISE NOTICE 'Таблицы public.squadrons нет — миграция пропущена';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'squadrons'
      AND column_name = 'tag' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.squadrons ALTER COLUMN tag DROP NOT NULL;
    RAISE NOTICE 'squadrons.tag теперь необязателен';
  END IF;
END $$;

COMMENT ON COLUMN public.squadrons.tag IS
  'Тег эскадрильи (2–10 латинских букв/цифр). Необязателен: приложение собирает его из названия, если пилот не ввёл свой';

-- Поиск по тегу — частый путь (страница эскадрилий, проверка занятости).
CREATE INDEX IF NOT EXISTS idx_squadrons_tag_lower
  ON public.squadrons (lower(tag))
  WHERE tag IS NOT NULL;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261006000000_system_architects.sql                │
-- └────────────────────────────────────────────────────────────────┘

-- ─────────────────────────────────────────────────────────────────────────
-- system_architects — назначенный архитектор системы и права на планы
-- ─────────────────────────────────────────────────────────────────────────
--
-- Зачем. До этой миграции планы застройки (`system_plans`) были полностью
-- демократичными: сохранить план системы мог любой авторизованный командир,
-- и договориться «кто в системе главный» было негде. Для совместной
-- колонизации этого мало — нужен именованный архитектор системы, как в игре.
--
-- Правило редактирования плана:
--
--   * пока у системы НЕТ назначенного архитектора — ничего не меняется:
--     планы сохраняет любой, свои планы правят их авторы;
--   * как только архитектор НАЗНАЧЕН — создавать и изменять планы этой
--     системы может только он (и администратор сайта). Чужие сохранённые
--     планы не исчезают, просто править их больше нельзя, пока их автор
--     не станет архитектором системы.
--
-- Кто меняет архитектора:
--
--   * назначить или сменить архитектора — только `admin` (панель
--     «Администрирование системы» в разделе /architect);
--   * сам архитектор может отказаться от системы (DELETE своей строки).
--
-- Почему права здесь, а не только в API: маршруты /api/architect/plans
-- ходят в базу через cookie-клиент, то есть RLS — последняя линия обороны.
-- Проверки в маршрутах остаются (дают человеческие сообщения об ошибке),
-- политики ниже делают невозможным обход через прямые запросы. Проверка
-- вынесена в SECURITY DEFINER-функции, чтобы политика не зависела от
-- RLS-порядка чтения profiles/system_architects и не уходила в рекурсию.

CREATE TABLE IF NOT EXISTS public.system_architects (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  system_name      TEXT NOT NULL CHECK (LENGTH(BTRIM(system_name)) BETWEEN 1 AND 128),
  -- Ключ системы в нижнем регистре пишет API (`systemKey`): имена систем
  -- сравниваются без учёта регистра, как и в system_plans/system_progress.
  system_name_lc   TEXT NOT NULL UNIQUE CHECK (
    system_name_lc = BTRIM(system_name_lc)
    AND system_name_lc = lower(system_name_lc)
  ),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  architect_name   TEXT NOT NULL DEFAULT '',
  assigned_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_by_name TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.system_architects IS
  'Назначенные архитекторы систем: одна строка = система закреплена за архитектором, после этого править её планы может только он и admin.';

CREATE INDEX IF NOT EXISTS idx_system_architects_user
  ON public.system_architects (user_id);

ALTER TABLE public.system_architects ENABLE ROW LEVEL SECURITY;

-- Кто архитектор системы — не секрет: читают все, включая гостей.
DROP POLICY IF EXISTS system_architects_select ON public.system_architects;
CREATE POLICY system_architects_select ON public.system_architects
  FOR SELECT TO anon, authenticated USING (true);

GRANT SELECT ON public.system_architects TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.system_architects TO authenticated;

-- Признак «текущий пользователь — администратор»: собрано одной функцией,
-- чтобы все политики ниже читались одинаково.
CREATE OR REPLACE FUNCTION public.request_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;

-- Назначать и менять архитектора системы может только админ.
DROP POLICY IF EXISTS system_architects_insert ON public.system_architects;
CREATE POLICY system_architects_insert ON public.system_architects
  FOR INSERT TO authenticated WITH CHECK (public.request_is_admin());

DROP POLICY IF EXISTS system_architects_update ON public.system_architects;
CREATE POLICY system_architects_update ON public.system_architects
  FOR UPDATE TO authenticated
  USING (public.request_is_admin())
  WITH CHECK (public.request_is_admin());

-- Снять архитектора: админ или он сам («отказаться от системы»).
DROP POLICY IF EXISTS system_architects_delete ON public.system_architects;
CREATE POLICY system_architects_delete ON public.system_architects
  FOR DELETE TO authenticated USING (
    user_id = auth.uid() OR public.request_is_admin()
  );

-- Право создать план системы: без назначенного архитектора — как раньше,
-- с назначенным — только архитектор системы или админ.
CREATE OR REPLACE FUNCTION public.system_plan_can_create(p_system_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.request_is_admin()
    OR NOT EXISTS (
      SELECT 1 FROM public.system_architects sa
      WHERE sa.system_name_lc = lower(BTRIM(p_system_name))
    )
    OR EXISTS (
      SELECT 1 FROM public.system_architects sa
      WHERE sa.system_name_lc = lower(BTRIM(p_system_name))
        AND sa.user_id = auth.uid()
    );
$$;

-- Право изменить существующий план: автор — пока у системы нет архитектора;
-- иначе только назначенный архитектор или админ (независимо от автора:
-- архитектор получает власть над планами «своей» системы целиком).
CREATE OR REPLACE FUNCTION public.system_plan_can_edit(p_system_name text, p_author_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.request_is_admin()
    OR EXISTS (
      SELECT 1 FROM public.system_architects sa
      WHERE sa.system_name_lc = lower(BTRIM(p_system_name))
        AND sa.user_id = auth.uid()
    )
    OR (
      p_author_id = auth.uid()
      AND NOT EXISTS (
        SELECT 1 FROM public.system_architects sa
        WHERE sa.system_name_lc = lower(BTRIM(p_system_name))
      )
    );
$$;

-- Право удалить план: автор (уборка собственных черновиков не отменяется
-- назначением архитектора), модератор/админ — как раньше, плюс архитектор
-- системы может чистить планы своей системы.
CREATE OR REPLACE FUNCTION public.system_plan_can_delete(p_system_name text, p_author_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p_author_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'moderator')
    )
    OR EXISTS (
      SELECT 1 FROM public.system_architects sa
      WHERE sa.system_name_lc = lower(BTRIM(p_system_name))
        AND sa.user_id = auth.uid()
    );
$$;

DROP POLICY IF EXISTS system_plans_insert ON public.system_plans;
CREATE POLICY system_plans_insert ON public.system_plans
  FOR INSERT TO authenticated WITH CHECK (
    author_id = auth.uid()
    AND public.system_plan_can_create(system_name)
  );

DROP POLICY IF EXISTS system_plans_update ON public.system_plans;
CREATE POLICY system_plans_update ON public.system_plans
  FOR UPDATE TO authenticated
  USING (public.system_plan_can_edit(system_name, author_id))
  WITH CHECK (public.system_plan_can_edit(system_name, author_id));

DROP POLICY IF EXISTS system_plans_delete ON public.system_plans;
CREATE POLICY system_plans_delete ON public.system_plans
  FOR DELETE TO authenticated USING (
    public.system_plan_can_delete(system_name, author_id)
  );

-- Триггер updated_at: функция уже создана прошлыми миграциями; повторяем
-- определение, чтобы файл применялся и сам по себе.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS system_architects_updated_at ON public.system_architects;
CREATE TRIGGER system_architects_updated_at
  BEFORE UPDATE ON public.system_architects
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261007000000_squadron_branding.sql                │
-- └────────────────────────────────────────────────────────────────┘

-- Оформление публичной страницы эскадрильи.
ALTER TABLE public.squadrons
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS banner_url TEXT,
  ADD COLUMN IF NOT EXISTS banner_position TEXT NOT NULL DEFAULT 'center',
  ADD COLUMN IF NOT EXISTS motto TEXT;

ALTER TABLE public.squadrons DROP CONSTRAINT IF EXISTS squadrons_banner_position_check;
ALTER TABLE public.squadrons
  ADD CONSTRAINT squadrons_banner_position_check
  CHECK (banner_position IN ('top', 'center', 'bottom'));

COMMENT ON COLUMN public.squadrons.logo_url IS 'Публичный логотип эскадрильи';
COMMENT ON COLUMN public.squadrons.banner_url IS 'Фоновое изображение шапки эскадрильи';
COMMENT ON COLUMN public.squadrons.motto IS 'Короткий девиз на публичной странице';

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261008000000_colonisation_events_slim_retention.sql │
-- └────────────────────────────────────────────────────────────────┘

-- ─────────────────────────────────────────────────────────────────────────
-- colonisation_events: маркер вместо сырого события + политика хранения
-- ─────────────────────────────────────────────────────────────────────────
--
-- `raw_event` хранил полную копию события журнала (включая ResourcesRequired
-- и Name_Localised), дублируя `resources_total` — таблица на ~3 ГБ полезных
-- состояний вырастала до 12+. Новый код пишет только {"event":"…"}. На живой
-- базе старые строки худеют миграцией; в свежей схеме колонка сразу
-- создаётся с комментарием-договором.
--
-- `colonisation_events_prune(days)` — политика хранения (вызывается задачей
-- /api/cron/colonisation-cleanup): удаляет вклады ColonisationContribution
-- (их никто не читает), состояния старше окна (кроме последнего снимка
-- площадки — он нужен Raven) и старые снимки construction_depot_snapshots.

COMMENT ON COLUMN public.colonisation_events.raw_event IS
  'Маркер типа события ({"event":"ColonisationConstructionDepot"}). Полное событие журнала больше не хранится: всё нужное лежит в колонках и resources_total.';

UPDATE public.pilot_stats
   SET mercenary_coins = 0
 WHERE mercenary_coins IS NOT NULL
   AND mercenary_coins > 100000;

CREATE OR REPLACE FUNCTION public.colonisation_events_prune(
  p_retain_days integer DEFAULT 60
)
RETURNS TABLE(deleted_events bigint, deleted_snapshots bigint, deleted_contributions bigint)
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff timestamptz;
  events_deleted bigint;
  snapshots_deleted bigint;
  contributions_deleted bigint;
BEGIN
  IF p_retain_days IS NULL OR p_retain_days < 7 THEN
    cutoff := now() - interval '60 days';
  ELSE
    cutoff := now() - make_interval(days => p_retain_days);
  END IF;

  DELETE FROM public.colonisation_events
   WHERE coalesce(raw_event->>'event', '') = 'ColonisationContribution';
  GET DIAGNOSTICS contributions_deleted = ROW_COUNT;

  DELETE FROM public.colonisation_events
   WHERE event_timestamp < cutoff
     AND id NOT IN (
       SELECT latest.id
         FROM (
           SELECT DISTINCT ON (user_id, market_id) id
             FROM public.colonisation_events
            WHERE market_id IS NOT NULL
            ORDER BY user_id, market_id, event_timestamp DESC
         ) AS latest
     );
  GET DIAGNOSTICS events_deleted = ROW_COUNT;

  DELETE FROM public.construction_depot_snapshots
   WHERE snapshot_at < cutoff;
  GET DIAGNOSTICS snapshots_deleted = ROW_COUNT;

  RETURN QUERY SELECT events_deleted, snapshots_deleted, contributions_deleted;
END;
$$;

COMMENT ON FUNCTION public.colonisation_events_prune(integer) IS
  'Политика хранения colonisation_events: удалить вклады, состояния старше N дней (кроме последнего снимка площадки) и старые снимки прогресса. Вызывается /api/cron/colonisation-cleanup.';

CREATE INDEX IF NOT EXISTS idx_colonisation_events_user_market_time
  ON public.colonisation_events (user_id, market_id, event_timestamp DESC);

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261009000000_galaxy_points_scale.sql                │
-- └────────────────────────────────────────────────────────────────┘

-- Масштаб облака точек карты: больше точек в файле и выборка на стороне базы.
--
-- Контекст. «Собрать облако точек» читает `galaxy_systems` (~2×10⁸ строк) и
-- кладёт бинарник в бакет `galaxy-data`. Раньше потолок числа точек был жёсткой
-- константой (1 400 000 = сколько влезало в файл под лимит бакета 50 МиБ),
-- а при нехватке места строки просто отбрасывались в конце чтения — то есть
-- облако было не «равномерная выборка галактики», а «первые N систем по id»,
-- и любое изменение порядка строк меняло карту.
--
-- Здесь: (1) лимит бакета поднят до 64 МиБ — этого хватает на 2 307 040 точек,
-- т.е. потолок файла (2 000 000 точек = 58 МиБ) перестаёт упираться в бакет;
-- (2) появляется `galaxy_points_sample` — равномерная выборка строк по id,
-- которую использует путь PostgREST (прямое подключение к Postgres делает то же
-- самое через `mod(id, stride)` в своём запросе, RPC ему не нужен).
--
-- GREATEST в обновлении бакета — чтобы откат миграции не уменьшил лимит и не
-- сломал уже лежащие в бакете файлы.

-- ─── Бакет под облако побольше ───
DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES (
    'galaxy-data',
    'galaxy-data',
    true,
    67108864,
    ARRAY['application/octet-stream']::text[]
  )
  ON CONFLICT (id) DO UPDATE SET
    public = true,
    file_size_limit = GREATEST(storage.buckets.file_size_limit, EXCLUDED.file_size_limit);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'galaxy-data bucket limit skipped: %', SQLERRM;
END $$;

-- ─── Равномерная выборка систем для облака точек ───
-- Вызывается как `POST /rest/v1/rpc/galaxy_points_sample` со страницы
-- `readPointsFromSupabase` (src/lib/galaxyImport.ts). Ключ пагинации — `id`
-- (PK таблицы), шаг — `mod(id, stride)`: выборка не зависит от того, в каком
-- порядке физически лежат строки, и одинакова при любом числе страниц.
CREATE OR REPLACE FUNCTION public.galaxy_points_sample(
  after_id bigint default 0,
  stride integer default 1,
  lim integer default 5000
)
RETURNS TABLE(
  id bigint,
  id64 text,
  x double precision,
  y double precision,
  z double precision,
  star_type text
)
LANGUAGE sql
STABLE
AS $$
  SELECT g.id, g.id64, g.x, g.y, g.z, g.star_type
  FROM public.galaxy_systems g
  WHERE g.id > COALESCE(after_id, 0)
    AND mod(g.id, GREATEST(COALESCE(stride, 1), 1)) = 0
  ORDER BY g.id
  LIMIT GREATEST(1, LEAST(COALESCE(lim, 5000), 20000));
$$;

-- Чтение каталога и так открыто для всех (RLS-политика `galaxy_systems_public`),
-- функция ничего не добавляет; service_role нужен импорту.
GRANT EXECUTE ON FUNCTION public.galaxy_points_sample(bigint, integer, integer)
  TO anon, authenticated, service_role;

-- ┌──────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261009010000_colonisation_sites.sql                 │
-- └──────────────────────────────────────────────────────────────────┘

-- ─────────────────────────────────────────────────────────────────────────
-- colonisation_sites: одна строка на площадку вместо истории colonisation_events
--
-- Что на самом деле читает сайт: обогащение Raven Colonial берёт ПОСЛЕДНИЙ
-- известный список ресурсов каждой площадки (по MarketID) — и больше ничего
-- из истории не нужно. А писали все клиенты (браузер, Colonial Helper, CAPI,
-- страница журнала) строку на КАЖДОЕ событие ColonisationConstructionDepot и
-- на каждого командира отдельно, с полным ResourcesRequired (включая Payment
-- и Name_Localised) плюс raw_event, source_hash и journal_import_id. Отсюда
-- 12+ ГБ при ~3 ГБ логов: история, размноженная по пилотам, и копии одного
-- состояния.
--
-- Эта миграция ничего не удаляет и не переписывает. Она нужна, чтобы код
-- нового релиза уже мог писать в новую таблицу, а старая продолжала работать
-- до переключения (обновление применяет миграции ДО перезапуска сайта):
--   • public.colonisation_sites — текущее состояние площадки, PK = MarketID;
--   • colonisation_sites_write(jsonb) — запись «новее побеждает» в одной
--     транзакции; возвращает, какие площадки реально изменились (по ним
--     строятся снимки прогресса, повтор состояния снимка не даёт);
--   • colonisation_retention_prune(days) — чистка снимков прогресса вместо
--     colonisation_events_prune, которая ходила в историю состояний.
-- Перенос последнего состояния и удаление старой таблицы (освобождает место)
-- — вручную: supabase/maintenance/colonisation_sites_cutover.sql.
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Текущее состояние площадки ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.colonisation_sites (
  market_id             BIGINT PRIMARY KEY,
  system_name           TEXT NOT NULL,
  construction_id       BIGINT,
  construction_name     TEXT,
  construction_progress NUMERIC(5,2),
  resources_total       JSONB NOT NULL DEFAULT '[]'::jsonb,
  event_timestamp       TIMESTAMPTZ NOT NULL,
  -- Кто последним прислал состояние. ON DELETE SET NULL: удаление аккаунта
  -- не должно стирать состояние площадки, которое нужно всем (Raven-карте).
  user_id               UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.colonisation_sites IS
  'Текущее состояние каждой стройплощадки (ключ — MarketID из журнала). Одна строка на площадку; история прогресса — в construction_depot_snapshots.';
COMMENT ON COLUMN public.colonisation_sites.resources_total IS
  'Компактный список ресурсов: Name, Name_Localised (если есть), RequiredAmount, ProvidedAmount. Payment и прочие поля журнала не хранятся.';
COMMENT ON COLUMN public.colonisation_sites.event_timestamp IS
  'Момент журнала, которому соответствует состояние. Более старое состояние не перезаписывает более новое.';

-- Клиенты (anon/authenticated) таблицу не читают и не пишут: ни прав, ни
-- политик для них нет. Сервер работает под service_role — ей выдаём права
-- явно (не полагаясь на DEFAULT PRIVILEGES) и единственную политику.
ALTER TABLE public.colonisation_sites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.colonisation_sites FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.colonisation_sites TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'colonisation_sites'
       AND policyname = 'colonisation_sites_service_role'
  ) THEN
    CREATE POLICY colonisation_sites_service_role ON public.colonisation_sites
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 2. Компактный список ресурсов ───────────────────────────────────────────
-- Хранятся только поля, которые читает обогащение Raven и отпечаток «ничего
-- не изменилось». Элементы без имени или с нечисловыми суммами отбрасываются.
-- Список сортируется по имени, чтобы один и тот же набор в другом порядке не
-- выглядел как изменение. Функция серверная: старые Helper'ы пришлют полный
-- ResourcesRequired, и таблица останется лёгкой и при них.
CREATE OR REPLACE FUNCTION public.colonisation_compact_resources(p_resources jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  WITH src AS (
    SELECT e.r,
           coalesce(e.r->>'Name', e.r->>'name', '') AS name,
           nullif(coalesce(e.r->>'Name_Localised', e.r->>'nameLocalised', ''), '') AS localised,
           btrim(coalesce(e.r->>'RequiredAmount', e.r->>'requiredAmount')) AS required_text,
           btrim(coalesce(e.r->>'ProvidedAmount', e.r->>'providedAmount')) AS provided_text
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(p_resources) = 'array' THEN p_resources ELSE '[]'::jsonb END
           ) AS e(r)
     WHERE jsonb_typeof(e.r) = 'object'
  )
  SELECT coalesce(
           jsonb_agg(
             jsonb_strip_nulls(jsonb_build_object(
               'Name', src.name,
               'Name_Localised', src.localised,
               'RequiredAmount', greatest(src.required_text::numeric, 0),
               'ProvidedAmount', greatest(src.provided_text::numeric, 0)
             ))
             ORDER BY src.name
           ),
           '[]'::jsonb
         )
    FROM src
   WHERE src.name <> ''
     AND src.required_text ~ '^-?[0-9]+(\.[0-9]+)?$'
     AND src.provided_text ~ '^-?[0-9]+(\.[0-9]+)?$';
$$;

-- Отпечаток состояния для проверки «ничего не изменилось»: то же, что
-- хранится, но без Name_Localised. Смена языка журнала у клиента — не новое
-- состояние стройки, и снимок прогресса из-за неё не пишется.
CREATE OR REPLACE FUNCTION public.colonisation_resources_state(p_resources jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT coalesce(
           jsonb_agg((e.elem - 'Name_Localised') ORDER BY e.elem->>'Name'),
           '[]'::jsonb
         )
    FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(p_resources) = 'array' THEN p_resources ELSE '[]'::jsonb END
         ) AS e(elem);
$$;

-- 3. Запись состояний: «новее побеждает» ───────────────────────────────────
-- Вход — массив строк (см. src/lib/colonisationEvents.ts). Внутри одной пачки
-- на площадку остаётся самое позднее состояние; при равной метке времени
-- побеждает строка, пришедшая позже в пачке. Строка в базе обновляется, только
-- если метка времени новее — повтор старого состояния ничего не меняет.
-- Возвращает market_id текстом: MarketID — 64-битное число, и JSON-числа
-- клиента могут потерять точность.
-- `changed` = площадка новая или изменился прогресс/список ресурсов (имена
-- и суммы; локализация и Payment не в счёт): только такие состояния дают снимок.
CREATE OR REPLACE FUNCTION public.colonisation_sites_write(p_rows jsonb)
RETURNS TABLE (market_id text, changed boolean)
LANGUAGE sql
SET search_path = public
AS $$
  WITH parsed AS (
    SELECT r.market_id, r.system_name, r.construction_id, r.construction_name,
           r.construction_progress, r.resources_total, r.event_timestamp, r.user_id,
           e.ord
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(p_rows) = 'array' THEN p_rows ELSE '[]'::jsonb END
           ) WITH ORDINALITY AS e(elem, ord)
     CROSS JOIN LATERAL jsonb_to_record(e.elem) AS r(
             market_id bigint,
             system_name text,
             construction_id bigint,
             construction_name text,
             construction_progress numeric,
             resources_total jsonb,
             event_timestamp timestamptz,
             user_id uuid)
     WHERE jsonb_typeof(e.elem) = 'object'
  ),
  incoming AS (
    SELECT DISTINCT ON (p.market_id)
           p.market_id,
           btrim(p.system_name)                                 AS system_name,
           p.construction_id,
           nullif(btrim(coalesce(p.construction_name, '')), '') AS construction_name,
           round(p.construction_progress, 2)                    AS construction_progress,
           public.colonisation_compact_resources(p.resources_total) AS resources_total,
           p.event_timestamp,
           p.user_id
      FROM parsed AS p
     WHERE p.market_id IS NOT NULL
       AND p.market_id <> 0
       AND p.event_timestamp IS NOT NULL
       AND btrim(coalesce(p.system_name, '')) <> ''
     ORDER BY p.market_id, p.event_timestamp DESC, p.ord DESC
  ),
  before AS (
    SELECT s.market_id, s.construction_progress, s.resources_total
      FROM public.colonisation_sites AS s
      JOIN incoming AS i ON i.market_id = s.market_id
  ),
  upserted AS (
    INSERT INTO public.colonisation_sites AS s (
      market_id, system_name, construction_id, construction_name,
      construction_progress, resources_total, event_timestamp, user_id
    )
    SELECT i.market_id, i.system_name, i.construction_id, i.construction_name,
           i.construction_progress, i.resources_total, i.event_timestamp, i.user_id
      FROM incoming AS i
    ON CONFLICT (market_id) DO UPDATE SET
      system_name           = EXCLUDED.system_name,
      construction_id       = EXCLUDED.construction_id,
      construction_name     = EXCLUDED.construction_name,
      construction_progress = EXCLUDED.construction_progress,
      resources_total       = EXCLUDED.resources_total,
      event_timestamp       = EXCLUDED.event_timestamp,
      user_id               = EXCLUDED.user_id
    WHERE EXCLUDED.event_timestamp > s.event_timestamp
    RETURNING s.market_id
  )
  SELECT u.market_id::text,
         (
           NOT EXISTS (SELECT 1 FROM before b WHERE b.market_id = u.market_id)
           OR EXISTS (
             SELECT 1
               FROM before b
               JOIN incoming i ON i.market_id = b.market_id
              WHERE b.market_id = u.market_id
                AND (
                  b.construction_progress IS DISTINCT FROM i.construction_progress
                  OR public.colonisation_resources_state(b.resources_total)
                     IS DISTINCT FROM public.colonisation_resources_state(i.resources_total)
                )
           )
         ) AS changed
    FROM upserted AS u;
$$;

-- 4. Чистка снимков прогресса ──────────────────────────────────────────────
-- Вызывается /api/cron/colonisation-cleanup. Состояния площадок чистить не
-- нужно: в таблице одна строка на площадку. Старая таблица colonisation_events
-- (если ещё не удалена maintenance-скриптом) функцией не трогается.
DROP FUNCTION IF EXISTS public.colonisation_events_prune(integer);

CREATE OR REPLACE FUNCTION public.colonisation_retention_prune(
  p_retain_days integer DEFAULT 60
)
RETURNS TABLE (deleted_snapshots bigint, legacy_events_present boolean)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  cutoff timestamptz;
  snapshots_deleted bigint;
BEGIN
  IF p_retain_days IS NULL OR p_retain_days < 7 THEN
    cutoff := now() - interval '60 days';
  ELSE
    cutoff := now() - make_interval(days => p_retain_days);
  END IF;

  DELETE FROM public.construction_depot_snapshots
   WHERE snapshot_at < cutoff;
  GET DIAGNOSTICS snapshots_deleted = ROW_COUNT;

  RETURN QUERY SELECT snapshots_deleted, to_regclass('public.colonisation_events') IS NOT NULL;
END;
$$;

COMMENT ON FUNCTION public.colonisation_retention_prune(integer) IS
  'Удаляет снимки прогресса старше окна (по умолчанию 60 дней). Возвращает число удалённых снимков и признак, что старая таблица colonisation_events ещё существует.';

-- 5. Доступ: функции записи и чистки — только для сервера ─────────────────
-- У функций по умолчанию EXECUTE есть у PUBLIC, а PostgREST отдаёт их anon и
-- authenticated. Без этих REVOKE любой клиент с публичным ключом мог бы писать
-- в таблицу или чистить снимки.
REVOKE ALL ON FUNCTION public.colonisation_compact_resources(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.colonisation_resources_state(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.colonisation_sites_write(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.colonisation_retention_prune(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.colonisation_compact_resources(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.colonisation_resources_state(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.colonisation_sites_write(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.colonisation_retention_prune(integer) TO service_role;

-- 6. Старая таблица ───────────────────────────────────────────────────────
-- Пустую colonisation_events (новая установка, где журнал ещё не грузили)
-- удаляем сразу. Непустую не трогаем: её переносит maintenance-скрипт.
-- Блокировка берётся с NOWAIT: если в таблицу сейчас пишут, миграция её не
-- ждёт и не рискует удалить строку, которая появилась в этот момент.
DO $$
BEGIN
  IF to_regclass('public.colonisation_events') IS NOT NULL THEN
    BEGIN
      LOCK TABLE public.colonisation_events IN ACCESS EXCLUSIVE MODE NOWAIT;
      IF NOT EXISTS (SELECT 1 FROM public.colonisation_events) THEN
        DROP TABLE public.colonisation_events;
      ELSE
        COMMENT ON TABLE public.colonisation_events IS
          'УСТАРЕЛО: история состояний стройки заменена таблицей colonisation_sites. Перенос и удаление — supabase/maintenance/colonisation_sites_cutover.sql.';
      END IF;
    EXCEPTION WHEN lock_not_available THEN
      RAISE NOTICE 'colonisation_events занята записью — проверка на пустоту пропущена';
    END;
  END IF;
END $$;

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261010000000_pilot_stats_source.sql                 │
-- └──────────────────────────────────────────────────────────────────┘

-- ═══════════════════════════════════════════════════════════════════
-- pilot_stats: источник последней записи сводки пилота
-- ═══════════════════════════════════════════════════════════════════
--
-- Одни и те же сводные данные пилота (баланс, ранги, счётчики находок) сайт
-- принимает из двух каналов: загрузка журналов в браузере (`/api/logs/import`,
-- сессия) и десктопная программа Colonial Helper (`/api/logs/upload`,
-- `/api/cmdr/stats`, API-токен). Раньше побеждал последний записавший, и
-- данные программы перетирали данные, загруженные через сайт.
--
-- Теперь каждая запись несёт источник: 'web' (сайт), 'helper' (программа),
-- 'capi' (синхронизация Frontier CAPI). Запись от программы не перетирает
-- строку, последним источником которой был сайт; запись от сайта, наоборот,
-- всегда принимается и снимает защиту.
--
-- Миграция идемпотентна (ADD COLUMN IF NOT EXISTS) и ничего не удаляет:
-- существующие строки остаются без источника, для них защита не действует.

ALTER TABLE public.pilot_stats
  ADD COLUMN IF NOT EXISTS stats_source TEXT,
  ADD COLUMN IF NOT EXISTS stats_source_at TIMESTAMPTZ;

COMMENT ON COLUMN public.pilot_stats.stats_source IS
  'Последний источник записи сводки: web (загрузка журналов на сайте), helper (Colonial Helper), capi (синхронизация Frontier CAPI)';
COMMENT ON COLUMN public.pilot_stats.stats_source_at IS
  'Когда источник в последний раз записал сводку пилота';

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261010010000_outfitting_catalog.sql                  │
-- └──────────────────────────────────────────────────────────────────┘

-- Catalogue overlays, separate from the shipped EDCD/Coriolis dataset.
-- One row + revision allows an atomic compare-and-swap for entire edit batches.
-- Includes tombstones and the last 100 audit events; no saved builds are touched.
CREATE TABLE IF NOT EXISTS public.outfitting_catalog (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  changes JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(changes) = 'object'),
  history JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(history) = 'array'),
  updated_at TIMESTAMPTZ
);

INSERT INTO public.outfitting_catalog (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.outfitting_catalog ENABLE ROW LEVEL SECURITY;
-- All access goes through server routes; even admins cannot bypass validation
-- by issuing a direct browser PostgREST write. The public API omits audit data.
REVOKE ALL ON public.outfitting_catalog FROM anon, authenticated;
GRANT SELECT, UPDATE ON public.outfitting_catalog TO service_role;

COMMENT ON TABLE public.outfitting_catalog IS
  'Верфь: изменения модулей, групп и брони, архив и журнал действий; поверх статического справочника. Запись только через admin API с проверкой role=admin и revision.';

NOTIFY pgrst, 'reload schema';

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261010020000_raven_keys.sql                          │
-- └──────────────────────────────────────────────────────────────────┘
-- RCC-ключ Raven Colonial пользователя для создания проектов с сайта (Архитектор).
-- Значение зашифровано приложением (AES-256-GCM, ключ RAVEN_KEY_SECRET) —
-- в базе лежит только шифротекст. Доступ только через серверные маршруты.
CREATE TABLE IF NOT EXISTS public.raven_keys (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  key_cipher   TEXT NOT NULL,
  key_mask     TEXT NOT NULL,
  cmdr_name    TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.raven_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.raven_keys FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.raven_keys TO service_role;

COMMENT ON TABLE public.raven_keys IS
  'RCC-ключи Raven Colonial (шифротекст). Читается и пишется только сервером под service_role.';

NOTIFY pgrst, 'reload schema';

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261011000000_atlas_search_caches.sql                 │
-- └──────────────────────────────────────────────────────────────────┘
-- Кэши и сессии поисковиков Atlas.
--
-- Зачем: каждый поиск (миры, маршрут A→B, галактическое кольцо) заново
-- выкачивал одни и те же данные из EDSM/Spansh. Из-за этого кольцо упиралось
-- в таймаут соединения («network error» после 3–4 сегментов), а повторные
-- поиски в том же районе не ускорялись.
--
-- Теперь всё полезное, что нашёл поисковик, складывается в БД проекта:
--   • atlas_system_cache — координаты систем (каталог Spansh / EDSM / Spansh API);
--   • atlas_body_cache   — тела с их параметрами (планеты, звёзды);
--   • atlas_ring_sessions — пошаговые сессии построения галактического кольца,
--     которые можно продолжить после обрыва связи или перезагрузки страницы.

-- ════════════════════════════════════════════════════════════════════
-- Общий кэш систем
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.atlas_system_cache (
  system_name   TEXT PRIMARY KEY,
  -- Нормализованное имя для поиска без учёта регистра и кратных пробелов.
  name_lc       TEXT NOT NULL,
  x             DOUBLE PRECISION NOT NULL,
  y             DOUBLE PRECISION NOT NULL,
  z             DOUBLE PRECISION NOT NULL,
  id64          TEXT,
  -- Откуда координаты: catalog (ночной дамп Spansh), edsm, spansh, manual.
  source        TEXT NOT NULL DEFAULT 'edsm',
  raw_data      JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_atlas_system_cache_coords
  ON public.atlas_system_cache (x, y, z);
CREATE INDEX IF NOT EXISTS idx_atlas_system_cache_name_lc
  ON public.atlas_system_cache (name_lc);

ALTER TABLE public.atlas_system_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS atlas_system_cache_select ON public.atlas_system_cache;
CREATE POLICY atlas_system_cache_select ON public.atlas_system_cache
  FOR SELECT TO anon, authenticated USING (true);
-- Пишет только сервер (service_role): клиенты не должны засорять кэш.
GRANT SELECT ON public.atlas_system_cache TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.atlas_system_cache TO service_role;

COMMENT ON TABLE public.atlas_system_cache IS
  'Кэш координат систем, найденных поисковиками Atlas. Повторный поиск в том же районе идёт без внешних запросов.';

-- ════════════════════════════════════════════════════════════════════
-- Кэш тел (планет и звёзд)
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.atlas_body_cache (
  body_name            TEXT PRIMARY KEY,
  system_name          TEXT NOT NULL,
  system_lc            TEXT NOT NULL,
  x                    DOUBLE PRECISION NOT NULL,
  y                    DOUBLE PRECISION NOT NULL,
  z                    DOUBLE PRECISION NOT NULL,
  -- Категория Atlas: earth_like, water_world, neutron_star, terraformable …
  world_type           TEXT NOT NULL,
  body_type            TEXT,
  subtype              TEXT,
  distance_from_ref    DOUBLE PRECISION,
  distance_to_arrival  DOUBLE PRECISION,
  estimated_value      DOUBLE PRECISION,
  is_terraformable     BOOLEAN,
  is_main_star         BOOLEAN,
  has_atmosphere       BOOLEAN,
  gravity              DOUBLE PRECISION,
  temperature          DOUBLE PRECISION,
  atmosphere           TEXT,
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  source               TEXT NOT NULL DEFAULT 'spansh',
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_atlas_body_cache_coords
  ON public.atlas_body_cache (x, y, z);
CREATE INDEX IF NOT EXISTS idx_atlas_body_cache_type
  ON public.atlas_body_cache (world_type);
CREATE INDEX IF NOT EXISTS idx_atlas_body_cache_system_lc
  ON public.atlas_body_cache (system_lc);

ALTER TABLE public.atlas_body_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS atlas_body_cache_select ON public.atlas_body_cache;
CREATE POLICY atlas_body_cache_select ON public.atlas_body_cache
  FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.atlas_body_cache TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.atlas_body_cache TO service_role;

COMMENT ON TABLE public.atlas_body_cache IS
  'Кэш тел (планет, звёзд) из Spansh/EDSM для поиска миров Atlas. Позволяет повторять поиск без внешних запросов.';

-- ════════════════════════════════════════════════════════════════════
-- Сессии построения галактического кольца
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.atlas_ring_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  start_system  TEXT NOT NULL,
  ring_radius   DOUBLE PRECISION NOT NULL,
  search_radius DOUBLE PRECISION NOT NULL,
  -- Сколько сегментов кольца и сколько уже пройдено (шаг за шагом).
  sectors       INTEGER NOT NULL,
  sectors_done  INTEGER NOT NULL DEFAULT 0,
  center        JSONB NOT NULL,
  basis         JSONB NOT NULL,
  anchors       JSONB NOT NULL DEFAULT '[]'::jsonb,
  discovered    INTEGER NOT NULL DEFAULT 0,
  stats         JSONB NOT NULL DEFAULT '{}'::jsonb,
  route         JSONB,
  -- scanning → ready (все сегменты) → completed (маршрут собран) | failed
  status        TEXT NOT NULL DEFAULT 'scanning',
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_atlas_ring_sessions_created
  ON public.atlas_ring_sessions (created_at DESC);

ALTER TABLE public.atlas_ring_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS atlas_ring_sessions_select ON public.atlas_ring_sessions;
CREATE POLICY atlas_ring_sessions_select ON public.atlas_ring_sessions
  FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.atlas_ring_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.atlas_ring_sessions TO service_role;

COMMENT ON TABLE public.atlas_ring_sessions IS
  'Пошаговые сессии построения галактического кольца: прогресс сохраняется, поиск продолжается после обрыва связи.';

-- ════════════════════════════════════════════════════════════════════
-- Живой прогресс поиска миров
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.atlas_searches
  ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.atlas_searches.progress IS
  'Текущий этап поиска: percent/stage/message и последние найденные точки для карты (обновляет сервер).';

NOTIFY pgrst, 'reload schema';

-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261012000000_atlas_ring_cache_near.sql │
-- └──────────────────────────────────────────────────────────────────┘
-- Ближайшие системы кэша Atlas в кубе — для поиска галактического кольца.
--
-- Зачем: поиск кольца читал кэш систем через листание коробки по 1000 строк
-- (до 40 последовательных запросов на каждый сегмент). При большом радиусе
-- поиска шаг не укладывался в таймаут шлюза и отвечал 504. Здесь ближайшие
-- системы выбираются одним запросом по GiST-индексу, по возрастанию расстояния.

CREATE EXTENSION IF NOT EXISTS cube;

CREATE INDEX IF NOT EXISTS idx_atlas_system_cache_cube
  ON public.atlas_system_cache USING gist (cube(ARRAY[x, y, z]));

CREATE OR REPLACE FUNCTION public.atlas_system_cache_near(
  cx double precision,
  cy double precision,
  cz double precision,
  half double precision,
  lim integer
)
RETURNS TABLE(system_name text, x double precision, y double precision, z double precision, id64 text, source text)
LANGUAGE sql
STABLE
AS $$
  SELECT c.system_name, c.x, c.y, c.z, c.id64, c.source
  FROM public.atlas_system_cache c
  WHERE cube(ARRAY[c.x, c.y, c.z]) && cube(
          ARRAY[cx - half, cy - half, cz - half],
          ARRAY[cx + half, cy + half, cz + half]
        )
  ORDER BY cube(ARRAY[c.x, c.y, c.z]) <-> cube(ARRAY[cx, cy, cz])
  LIMIT GREATEST(1, LEAST(COALESCE(lim, 800), 2000));
$$;

GRANT EXECUTE ON FUNCTION public.atlas_system_cache_near(
  double precision, double precision, double precision, double precision, integer
) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';


-- ═══ MIGRATION: 20261013000000_ring_key_systems_and_deviation.sql ═══

-- Дополнительные колонки для сессий галактического кольца:
--   • deviation_limit — пользовательский допуск отклонения от окружности (св.л.)
--   • key_systems     — JSONB-массив обязательных (ключевых) систем с координатами
-- Обе колонки опциональны (NULL = значение по умолчанию), чтобы не ломать
-- существующие сессии.

ALTER TABLE public.atlas_ring_sessions
  ADD COLUMN IF NOT EXISTS deviation_limit DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS key_systems    JSONB;

COMMENT ON COLUMN public.atlas_ring_sessions.deviation_limit
  IS 'Пользовательский допуск отклонения от окружности кольца, св.л. NULL = 100 (по умолчанию).';
COMMENT ON COLUMN public.atlas_ring_sessions.key_systems
  IS 'Массив ключевых (обязательных) систем: [{name, x, y, z}], через которые должен пройти маршрут.';


-- ═══ MIGRATION: 20261013010000_ring_tilt_and_center.sql ═══

-- Поддержка некомпланарных галактических колец:
--   * возможность сменить центр расчёта (не только Sagittarius A*);
--   * высотное смещение центра кольца относительно галактической плоскости (-5000..+5000 св.л);
--   * наклон (tilt) плоскости кольца в градусах 0..180.
-- При tilt=0 кольцо лежит в галактической плоскости (поведение не меняется);
-- при больших наклонах серверная логика зажимает высотное смещение так, чтобы
-- кольцо не выходило за ±6000 св.л от галактической плоскости (толщина диска).

ALTER TABLE atlas_ring_sessions
  ADD COLUMN IF NOT EXISTS center_system TEXT,
  ADD COLUMN IF NOT EXISTS height_offset DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS tilt_degrees DOUBLE PRECISION;

-- Ограничения на диапазоны (NULL == значение по умолчанию).
ALTER TABLE atlas_ring_sessions
  ADD CONSTRAINT ring_height_offset_range
    CHECK (height_offset IS NULL OR (height_offset >= -5000 AND height_offset <= 5000)),
  ADD CONSTRAINT ring_tilt_degrees_range
    CHECK (tilt_degrees IS NULL OR (tilt_degrees >= 0 AND tilt_degrees <= 180));


-- ═══ MIGRATION: 20261013020000_ring_tilt_axis.sql ═══

-- Двусторонний наклон и азимут оси. NULL/0 сохраняет геометрию старых сессий.
ALTER TABLE public.atlas_ring_sessions
  ADD COLUMN IF NOT EXISTS tilt_axis_degrees DOUBLE PRECISION;

ALTER TABLE public.atlas_ring_sessions
  DROP CONSTRAINT IF EXISTS ring_tilt_degrees_range;
ALTER TABLE public.atlas_ring_sessions
  ADD CONSTRAINT ring_tilt_degrees_range
    CHECK (tilt_degrees IS NULL OR tilt_degrees BETWEEN -180 AND 180);

ALTER TABLE public.atlas_ring_sessions
  DROP CONSTRAINT IF EXISTS ring_tilt_axis_degrees_range;
ALTER TABLE public.atlas_ring_sessions
  ADD CONSTRAINT ring_tilt_axis_degrees_range
    CHECK (tilt_axis_degrees IS NULL OR (tilt_axis_degrees >= 0 AND tilt_axis_degrees < 360));


-- ═══ MIGRATION: 20261013030000_market_construction_blueprints.sql ═══

-- Pin a search to its selected construction recipe instead of the generic list.
ALTER TABLE public.market_search_jobs ADD COLUMN IF NOT EXISTS build_type TEXT;
COMMENT ON COLUMN public.market_search_jobs.build_type IS 'Construction blueprint key; null/all uses the complete construction commodity list.';

-- Commander purchase price, distinct from legacy sell_price cache values.
ALTER TABLE public.market_search_cache ADD COLUMN IF NOT EXISTS buy_price INTEGER;


-- ═══ MIGRATION: 20261014000000_station_commerce.sql ═══

-- Durable station metadata and independently versioned COMPLETE inventories.
CREATE TABLE IF NOT EXISTS public.commerce_systems (
  system_name TEXT NOT NULL,
  name_lc TEXT PRIMARY KEY,
  x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION,
  population BIGINT CHECK (population >= 0),
  has_stations BOOLEAN NOT NULL DEFAULT false,
  observed_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS commerce_systems_position ON public.commerce_systems (x, y, z)
  WHERE population > 0 OR has_stations;

CREATE TABLE IF NOT EXISTS public.station_commerce (
  station_key TEXT PRIMARY KEY,
  market_id TEXT,
  system_name TEXT NOT NULL,
  system_lc TEXT NOT NULL REFERENCES public.commerce_systems(name_lc),
  station_name TEXT NOT NULL,
  station_type TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  observed_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS station_commerce_system ON public.station_commerce(system_lc);
CREATE TABLE IF NOT EXISTS public.station_inventory_snapshots (
  station_key TEXT NOT NULL REFERENCES public.station_commerce(station_key) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('market', 'outfitting', 'shipyard')),
  items JSONB NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  observed_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (station_key, kind)
);
CREATE INDEX IF NOT EXISTS station_inventory_items ON public.station_inventory_snapshots USING gin(items jsonb_path_ops);
CREATE INDEX IF NOT EXISTS station_inventory_age ON public.station_inventory_snapshots(observed_at);
ALTER TABLE public.commerce_systems ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.station_commerce ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.station_inventory_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_systems, public.station_commerce, public.station_inventory_snapshots FROM anon, authenticated;
GRANT ALL ON public.commerce_systems, public.station_commerce, public.station_inventory_snapshots TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_source_rank(source TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE source WHEN 'colonial-helper' THEN 4 WHEN 'eddn' THEN 3 WHEN 'edsm' THEN 2 ELSE 1 END;
$$;

-- One atomic transaction: identity, location and snapshots. Row-level conflict
-- locks prevent an old import from overwriting a newer live docking report.
CREATE OR REPLACE FUNCTION public.save_station_commerce(report JSONB) RETURNS VOID
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  sys_key TEXT := lower(trim(report->>'system_name'));
  identity_key TEXT := report->>'station_key';
  stamp TIMESTAMPTZ := (report->>'observed_at')::timestamptz;
  origin TEXT := report->>'source';
  inventory RECORD;
  known_identity TEXT;
  previous_station RECORD;
BEGIN
  IF origin NOT IN ('colonial-helper','eddn','edsm','spansh') OR stamp > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Invalid source or observation time';
  END IF;
  IF report->>'market_id' IS NULL THEN
    SELECT station_key INTO known_identity FROM public.station_commerce
      WHERE system_lc = sys_key AND lower(trim(station_name)) = lower(trim(report->>'station_name'))
        AND market_id IS NOT NULL ORDER BY observed_at DESC LIMIT 1;
    identity_key := coalesce(known_identity,identity_key);
  END IF;
  SELECT system_name,station_name,observed_at,source INTO previous_station
    FROM public.station_commerce WHERE station_key = identity_key FOR UPDATE;
  IF FOUND AND lower(previous_station.system_name) <> sys_key AND
      (stamp > previous_station.observed_at OR (stamp = previous_station.observed_at AND
       public.commerce_source_rank(origin) >= public.commerce_source_rank(previous_station.source))) THEN
    -- Old discovery/EDDN rows must not keep a moved carrier trading in the
    -- previous system. Canonical inventories remain attached to MarketID.
    DELETE FROM public.market_prices WHERE lower(system_name) = lower(previous_station.system_name)
      AND lower(station_name) = lower(previous_station.station_name);
    DELETE FROM public.market_search_cache WHERE market_id::text = report->>'market_id';
  END IF;
  INSERT INTO public.commerce_systems(system_name,name_lc,x,y,z,population,has_stations,observed_at,source)
    VALUES(report->>'system_name',sys_key,(report->>'x')::float8,(report->>'y')::float8,(report->>'z')::float8,
      (report->>'population')::bigint,true,stamp,origin)
  ON CONFLICT(name_lc) DO UPDATE SET
    has_stations = true,
    x = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN coalesce(EXCLUDED.x,commerce_systems.x) ELSE coalesce(commerce_systems.x,EXCLUDED.x) END,
    y = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN coalesce(EXCLUDED.y,commerce_systems.y) ELSE coalesce(commerce_systems.y,EXCLUDED.y) END,
    z = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN coalesce(EXCLUDED.z,commerce_systems.z) ELSE coalesce(commerce_systems.z,EXCLUDED.z) END,
    population = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN coalesce(EXCLUDED.population,commerce_systems.population) ELSE coalesce(commerce_systems.population,EXCLUDED.population) END,
    observed_at = greatest(EXCLUDED.observed_at,commerce_systems.observed_at),
    source = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN EXCLUDED.source ELSE commerce_systems.source END;

  UPDATE public.commerce_systems SET has_stations = true WHERE name_lc = sys_key;

  INSERT INTO public.station_commerce(station_key,market_id,system_name,system_lc,station_name,station_type,metadata,observed_at,source)
    VALUES(identity_key,report->>'market_id',report->>'system_name',sys_key,report->>'station_name',report->>'station_type',
      coalesce(report->'metadata','{}'),stamp,origin)
  ON CONFLICT(station_key) DO UPDATE SET
    system_name = EXCLUDED.system_name, system_lc = EXCLUDED.system_lc,
    station_name = EXCLUDED.station_name, station_type = coalesce(EXCLUDED.station_type,station_commerce.station_type),
    -- Orbital/body metadata from the previous system is not valid after a carrier jump.
    metadata = CASE WHEN station_commerce.system_lc <> EXCLUDED.system_lc THEN EXCLUDED.metadata
      ELSE station_commerce.metadata || EXCLUDED.metadata END,
    observed_at = EXCLUDED.observed_at, source = EXCLUDED.source
  WHERE EXCLUDED.observed_at > station_commerce.observed_at OR
    (EXCLUDED.observed_at = station_commerce.observed_at AND public.commerce_source_rank(EXCLUDED.source) >= public.commerce_source_rank(station_commerce.source));

  -- EDDN may lack MarketID. When EDSM/Helper later supplies it, reconcile
  -- the natural-name identity rather than keeping duplicate legacy stations.
  IF report->>'market_id' IS NOT NULL THEN
    INSERT INTO public.station_inventory_snapshots(station_key,kind,items,observed_at,source)
    SELECT identity_key,s.kind,s.items,s.observed_at,s.source
    FROM public.station_inventory_snapshots s JOIN public.station_commerce st USING(station_key)
    WHERE st.station_key = 'name:' || sys_key || ':' || lower(trim(report->>'station_name'))
      AND st.station_key <> identity_key
    ON CONFLICT(station_key,kind) DO UPDATE SET
      items = EXCLUDED.items, observed_at = EXCLUDED.observed_at, source = EXCLUDED.source, received_at = now()
    WHERE EXCLUDED.observed_at > station_inventory_snapshots.observed_at OR
      (EXCLUDED.observed_at = station_inventory_snapshots.observed_at AND
       public.commerce_source_rank(EXCLUDED.source) >= public.commerce_source_rank(station_inventory_snapshots.source));
    DELETE FROM public.station_commerce
    WHERE station_key = 'name:' || sys_key || ':' || lower(trim(report->>'station_name')) AND station_key <> identity_key;
  END IF;

  FOR inventory IN SELECT key,value FROM jsonb_each(coalesce(report->'inventories','{}')) LOOP
    IF (inventory.value->>'observed_at')::timestamptz > now() + interval '5 minutes' THEN
      RAISE EXCEPTION 'Invalid inventory observation time';
    END IF;
    INSERT INTO public.station_inventory_snapshots(station_key,kind,items,observed_at,source)
      VALUES(identity_key,inventory.key,inventory.value->'items',(inventory.value->>'observed_at')::timestamptz,origin)
    ON CONFLICT(station_key,kind) DO UPDATE SET
      items = EXCLUDED.items, observed_at = EXCLUDED.observed_at, source = EXCLUDED.source, received_at = now()
    WHERE EXCLUDED.observed_at > station_inventory_snapshots.observed_at OR
      (EXCLUDED.observed_at = station_inventory_snapshots.observed_at AND
       public.commerce_source_rank(EXCLUDED.source) >= public.commerce_source_rank(station_inventory_snapshots.source));
  END LOOP;
END;
$$;

-- Indexed box prefilter + exact sphere + nearest-first ordering, not a scan of
-- millions of uninhabited stars. Includes systems learned from station visits.
CREATE OR REPLACE FUNCTION public.nearby_commerce_systems(cx FLOAT8, cy FLOAT8, cz FLOAT8, radius_ly FLOAT8)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(nearby), '[]'::jsonb) FROM (
  SELECT s.system_name,s.x,s.y,s.z,sqrt(power(s.x-cx,2)+power(s.y-cy,2)+power(s.z-cz,2)) AS distance
  FROM public.commerce_systems s
  WHERE (s.population > 0 OR s.has_stations)
    AND s.x BETWEEN cx-radius_ly AND cx+radius_ly
    AND s.y BETWEEN cy-radius_ly AND cy+radius_ly
    AND s.z BETWEEN cz-radius_ly AND cz+radius_ly
    AND power(s.x-cx,2)+power(s.y-cy,2)+power(s.z-cz,2) <= power(radius_ly,2)
  ORDER BY distance LIMIT 5000) nearby;
$$;
REVOKE ALL ON FUNCTION public.save_station_commerce(JSONB), public.nearby_commerce_systems(FLOAT8,FLOAT8,FLOAT8,FLOAT8) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_station_commerce(JSONB), public.nearby_commerce_systems(FLOAT8,FLOAT8,FLOAT8,FLOAT8) TO service_role;

-- Known stations discovered by the old search immediately participate in stage one.
INSERT INTO public.commerce_systems(system_name,name_lc,x,y,z,has_stations,observed_at,source)
SELECT system_name,lower(trim(system_name)),x,y,z,true,coalesce(last_checked_at,now()),'edsm'
FROM public.colonisation_market_systems WHERE has_market
ON CONFLICT(name_lc) DO NOTHING;

ALTER TABLE public.market_search_jobs ADD COLUMN IF NOT EXISTS discovery_complete BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.market_search_jobs ADD COLUMN IF NOT EXISTS reference_coords JSONB;
NOTIFY pgrst, 'reload schema';

-- Rich Spansh systems also carry population even when no station has yet been
-- observed. Import one system at a time, without buffering the galaxy in RAM.
CREATE OR REPLACE FUNCTION public.save_spansh_commerce(payload JSONB) RETURNS VOID
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE station JSONB;
BEGIN
  INSERT INTO public.commerce_systems(system_name,name_lc,x,y,z,population,has_stations,observed_at,source)
  VALUES(payload->>'system_name',lower(trim(payload->>'system_name')),
    (payload->>'x')::float8,(payload->>'y')::float8,(payload->>'z')::float8,
    (payload->>'population')::bigint,false,(payload->>'observed_at')::timestamptz,'spansh')
  ON CONFLICT(name_lc) DO UPDATE SET
    x = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN coalesce(EXCLUDED.x,commerce_systems.x) ELSE coalesce(commerce_systems.x,EXCLUDED.x) END,
    y = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN coalesce(EXCLUDED.y,commerce_systems.y) ELSE coalesce(commerce_systems.y,EXCLUDED.y) END,
    z = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN coalesce(EXCLUDED.z,commerce_systems.z) ELSE coalesce(commerce_systems.z,EXCLUDED.z) END,
    population = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN coalesce(EXCLUDED.population,commerce_systems.population) ELSE coalesce(commerce_systems.population,EXCLUDED.population) END,
    observed_at = greatest(EXCLUDED.observed_at,commerce_systems.observed_at),
    source = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN EXCLUDED.source ELSE commerce_systems.source END;
  FOR station IN SELECT value FROM jsonb_array_elements(payload->'reports') LOOP
    PERFORM public.save_station_commerce(station);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.save_spansh_commerce(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_spansh_commerce(JSONB) TO service_role;
NOTIFY pgrst, 'reload schema';

-- The standalone Atlas market page uses the same durable snapshots. JSONB
-- result avoids PostgREST's default row cap; complete empty snapshots exclude
-- obsolete legacy reports for that station as well.
CREATE OR REPLACE FUNCTION public.search_station_commodity(search_name TEXT, system_filter TEXT DEFAULT NULL, row_limit INTEGER DEFAULT 50)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public AS $$
  WITH prices AS (
    SELECT st.station_name,st.system_name,item->>'name' AS commodity_name,
      (item->>'buyPrice')::numeric AS buy_price,(item->>'sellPrice')::numeric AS sell_price,
      (item->>'stock')::numeric AS stock,(item->>'demand')::numeric AS demand,
      snap.observed_at AS reported_at,snap.source,
      snap.observed_at < now() - interval '1 hour' AS stale
    FROM public.station_commerce st JOIN public.station_inventory_snapshots snap USING(station_key)
    CROSS JOIN LATERAL jsonb_array_elements(snap.items) item
    WHERE snap.kind = 'market'
    UNION ALL
    SELECT p.station_name,p.system_name,p.commodity_name,p.buy_price,p.sell_price,p.stock,p.demand,
      p.reported_at,p.source,p.reported_at < now() - interval '1 hour'
    FROM public.market_prices p
    WHERE NOT EXISTS (
      SELECT 1 FROM public.station_commerce st JOIN public.station_inventory_snapshots snap USING(station_key)
      WHERE snap.kind = 'market' AND lower(st.station_name) = lower(p.station_name)
        AND (lower(st.system_name) = lower(p.system_name) OR st.station_type ILIKE '%carrier%')
    )
  ), matches AS (
    SELECT * FROM prices WHERE stock > 0
      AND lower(regexp_replace(regexp_replace(commodity_name,'_name;?$','','i'),'[^a-z0-9]','','gi')) =
          lower(regexp_replace(regexp_replace(search_name,'_name;?$','','i'),'[^a-z0-9]','','gi'))
      AND (system_filter IS NULL OR position(lower(system_filter) in lower(system_name)) > 0)
    ORDER BY buy_price NULLS LAST,reported_at DESC LIMIT greatest(1,least(row_limit,100))
  ) SELECT coalesce(jsonb_agg(matches),'[]'::jsonb) FROM matches;
$$;
REVOKE ALL ON FUNCTION public.search_station_commodity(TEXT,TEXT,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.search_station_commodity(TEXT,TEXT,INTEGER) TO service_role;
NOTIFY pgrst, 'reload schema';


-- ═══ MIGRATION: 20261014010000_station_search.sql ═══

-- Unified station search: only observed project-DB availability, never the
-- static outfitting/engineer catalogue as a substitute for a station report.
CREATE OR REPLACE FUNCTION public.station_search_key(value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT regexp_replace(lower(coalesce(value,'')), '[[:space:]_\-.$;()]', '', 'g');
$$;
CREATE OR REPLACE FUNCTION public.search_station_catalog(
  search_kind TEXT, needles TEXT[], cx FLOAT8 DEFAULT NULL, cy FLOAT8 DEFAULT NULL, cz FLOAT8 DEFAULT NULL,
  radius_ly FLOAT8 DEFAULT 500, minimum_stock NUMERIC DEFAULT 1, filter_class INTEGER DEFAULT NULL,
  filter_rating TEXT DEFAULT NULL, fresh_only BOOLEAN DEFAULT false, sort_by TEXT DEFAULT 'distance',
  page_offset INTEGER DEFAULT 0, row_limit INTEGER DEFAULT 50
) RETURNS JSONB LANGUAGE sql STABLE SET search_path = public AS $$
  WITH stations AS (
    SELECT st.*,sys.x,sys.y,sys.z,
      CASE WHEN cx IS NOT NULL AND cy IS NOT NULL AND cz IS NOT NULL AND sys.x IS NOT NULL AND sys.y IS NOT NULL AND sys.z IS NOT NULL
        THEN sqrt(power(sys.x-cx,2)+power(sys.y-cy,2)+power(sys.z-cz,2)) END AS distance
    FROM public.station_commerce st JOIN public.commerce_systems sys ON st.system_lc = sys.name_lc
    WHERE cx IS NULL OR (sys.x BETWEEN cx-radius_ly AND cx+radius_ly AND sys.y BETWEEN cy-radius_ly AND cy+radius_ly
      AND sys.z BETWEEN cz-radius_ly AND cz+radius_ly AND power(sys.x-cx,2)+power(sys.y-cy,2)+power(sys.z-cz,2) <= power(radius_ly,2))
  ), inventory AS (
    SELECT st.*,item,snap.observed_at AS inventory_at,snap.source AS inventory_source
    FROM stations st JOIN public.station_inventory_snapshots snap USING(station_key)
    CROSS JOIN LATERAL jsonb_array_elements(snap.items) item
    WHERE search_kind IN ('market','outfitting','shipyard') AND snap.kind = search_kind
    UNION ALL
    SELECT st.*,jsonb_build_object('name',service),st.observed_at,st.source
    FROM stations st CROSS JOIN LATERAL jsonb_array_elements_text(
      coalesce(st.metadata->'services','[]'::jsonb) ||
      (SELECT coalesce(jsonb_agg('Engineer: ' || engineer),'[]'::jsonb) FROM jsonb_array_elements_text(coalesce(st.metadata->'engineers','[]'::jsonb)) engineer)
    ) service WHERE search_kind = 'services'
  ), matches AS (
    SELECT DISTINCT station_key,station_name,station_type,system_name,market_id,x,y,z,distance,metadata,item,
      inventory_at AS observed_at,inventory_source AS source,inventory_at < now()-interval '1 hour' AS stale
    FROM inventory WHERE EXISTS (
      SELECT 1 FROM unnest(needles) needle WHERE length(public.station_search_key(needle)) >= 2 AND
      (position(public.station_search_key(needle) in public.station_search_key(item->>'name')) > 0 OR
       position(public.station_search_key(needle) in public.station_search_key(item->>'symbol')) > 0)
    ) AND (search_kind <> 'market' OR coalesce((item->>'stock')::numeric,0) >= minimum_stock)
    AND (NOT fresh_only OR inventory_at >= now()-interval '1 hour')
    AND (search_kind <> 'outfitting' OR filter_class IS NULL OR
      coalesce(item->>'class',substring(coalesce(item->>'symbol',item->>'name') FROM '(?i)_size([0-9]+)_')) = filter_class::text)
    AND (search_kind <> 'outfitting' OR filter_rating IS NULL OR
      coalesce(upper(item->>'rating'),CASE substring(coalesce(item->>'symbol',item->>'name') FROM '(?i)_class([1-5])')
        WHEN '5' THEN 'A' WHEN '4' THEN 'B' WHEN '3' THEN 'C' WHEN '2' THEN 'D' WHEN '1' THEN 'E' END) = filter_rating)
  ), page AS (
    SELECT * FROM matches ORDER BY
      CASE WHEN sort_by = 'price' THEN coalesce((item->>'price')::numeric,(item->>'buyPrice')::numeric) END NULLS LAST,
      CASE WHEN sort_by = 'updated' THEN observed_at END DESC NULLS LAST,
      distance NULLS LAST,station_key,item->>'name'
    LIMIT greatest(1,least(row_limit,100))+1 OFFSET greatest(0,least(page_offset,5000))
  ) SELECT coalesce(jsonb_agg(page),'[]'::jsonb) FROM page;
$$;
REVOKE ALL ON FUNCTION public.search_station_catalog(TEXT,TEXT[],FLOAT8,FLOAT8,FLOAT8,FLOAT8,NUMERIC,INTEGER,TEXT,BOOLEAN,TEXT,INTEGER,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.search_station_catalog(TEXT,TEXT[],FLOAT8,FLOAT8,FLOAT8,FLOAT8,NUMERIC,INTEGER,TEXT,BOOLEAN,TEXT,INTEGER,INTEGER) TO service_role;
NOTIFY pgrst, 'reload schema';

-- Named engineers annotate only station rows already reported to this DB.
UPDATE public.station_commerce st SET metadata = st.metadata || jsonb_build_object('engineers',jsonb_build_array(ref.engineer))
FROM (VALUES
  ('Deciat','Farseer Inc','Felicity Farseer'),
  ('Khun','Long Sight Base','Elvira Martuuk'),
  ('Wyrd','Black Hide','The Dweller'),
  ('Wolf 397','Trophy Camp','Tod "The Blaster" McQuinn'),
  ('Eurybia','Demolition Unlimited','Liz Ryder'),
  ('Giryak','Pater''s Memorial','Juri Ishmaak'),
  ('Yoru','Nemo Cyber Party Base','Zacariah Nemo'),
  ('Sirius','Qwent Research Base','Marco Qwent'),
  ('Laksak','Trader''s Rest','Lei Cheung'),
  ('Kuk','Prospector''s Rest','Selene Jean'),
  ('Kuwemaki','The Jet''s Hole','Hera Tani'),
  ('Arque','Abel Laboratory','Professor Palin'),
  ('Shenve','Cinder Dock','Chloe Sedesi'),
  ('Shinrarta Dezhra','Jameson Base','Lori Jameson'),
  ('Meene','Phoenix Base','Ram Tah'),
  ('Sol','Dekker''s Yard','Colonel Bris Dekker'),
  ('Beta-3 Tucani','The Beach','The Sarge'),
  ('Leesti','Vatermann LLC','Didi Vatermann'),
  ('Alioth','Turner Metallics Inc','Bill Turner'),
  ('Muang','Broo''s Legacy','Broo Tarquin'),
  ('Achenar','Fortune''s Loss','Tiana Fortune'),
  ('Luchtaine','The Brig','Mel Brandon'),
  ('Tir','The Watchtower','Marsha Hicks'),
  ('Asura','Sanctuary','Petra Olmanova'),
  ('Los','Kraken''s Retreat','Etienne Dorn'),
  ('Aurai','Marshall''s Drift','Jude Navarro'),
  ('Shou Xing','Rascal''s Choice','Terra Velasquez'),
  ('Candiaei','Ankh''s Promise','Oden Geiger'),
  ('Siris','Nevermore Terrace','Hero Ferrari'),
  ('Jolapa','Beck Facility','Wellington Beck'),
  ('Xuane','Laszlo''s Resolve','Uma Laszlo'),
  ('Orishis','The Jackrabbit','Domino Green'),
  ('Capoya','The Last Call','Kit Fowler'),
  ('Bayan','Salamander Bank','Yarden Bond'),
  ('Deriso','The Divine Apparatus','Baltanos'),
  ('Desy','Bresa Modifications','Eleanor Bresa'),
  ('Kojeara','Rosa''s Shop','Rosa Dayette'),
  ('Einheriar','Eidolon Hold','Yi Shen')
) AS ref(system_name,station_name,engineer)
WHERE lower(st.system_name) = lower(ref.system_name) AND regexp_replace(lower(st.station_name),'[^a-z0-9]','','g') = regexp_replace(lower(ref.station_name),'[^a-z0-9]','','g');


-- ═══ MIGRATION: 20261015000000_profiles_rls_hardening.sql ═══

-- КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: персональные данные и права в profiles.
-- Подробное описание причин и последствий — в файле миграции.

CREATE OR REPLACE FUNCTION public.request_is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role IN ('admin', 'moderator', 'support_manager')
  );
$$;

DROP POLICY IF EXISTS profiles_select ON public.profiles;
CREATE POLICY profiles_select ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.request_is_staff());

REVOKE SELECT ON public.profiles FROM anon;

CREATE OR REPLACE VIEW public.public_profiles AS
SELECT
  p.id,
  p.cmdr_name,
  p.avatar_url,
  p.squadron,
  p.created_at,
  p.updated_at,
  p.forum_posts_count
FROM public.profiles p;

REVOKE ALL ON public.public_profiles FROM PUBLIC;
GRANT SELECT ON public.public_profiles TO anon, authenticated, service_role;

COMMENT ON VIEW public.public_profiles IS
  'Публичные колонки profiles (имена авторов, составы, поиск пилотов). '
  'email/role/privacy_settings/language остаются во внутренней таблице, '
  'которую видит только владелец строки и персонал.';

CREATE OR REPLACE FUNCTION public.protect_profile_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (auth.uid() IS NULL OR public.request_is_admin()) THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.role IS DISTINCT FROM 'user' THEN
        RAISE EXCEPTION 'profiles.role может задать только администратор'
          USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NEW.role IS DISTINCT FROM OLD.role THEN
        RAISE EXCEPTION 'profiles.role может изменить только администратор'
          USING ERRCODE = '42501';
      END IF;
      IF NEW.email IS DISTINCT FROM OLD.email THEN
        RAISE EXCEPTION 'profiles.email синхронизируется только сервером'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profile_privileged_columns ON public.profiles;
CREATE TRIGGER trg_protect_profile_privileged_columns
  BEFORE INSERT OR UPDATE OF role, email ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_privileged_columns();

DROP POLICY IF EXISTS deliveries_select ON public.deliveries;
CREATE POLICY deliveries_select ON public.deliveries
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.request_is_staff());

REVOKE SELECT ON public.deliveries FROM anon;

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- MIGRATION: 20261016000000_credentials_and_views_hardening.sql
-- =============================================================================

-- =============================================================================
-- Защита хранилищ внешних токенов/ключей и исправление представлений с RLS
-- 1. public.capi_tokens: отзываем прямой доступ у PUBLIC, anon, authenticated
--    (все обращения идут только через серверный service_role, чтобы скомпрометированный
--    клиентский JWT не позволял выгрузить access_token/refresh_token Frontier через PostgREST).
-- 2. public.inara_profiles: отзываем прямой доступ у PUBLIC, anon, authenticated
--    (inara_api_key используется только сервером через service_role).
-- 3. public.api_tokens: запрещаем чтение колонки token_hash и прямые INSERT/UPDATE/DELETE
--    через PostgREST для authenticated/anon (выпуск и отзыв токенов только через API).
-- 4. public.delivery_scope_summary: включаем security_invoker = true и убираем доступ anon,
--    чтобы представление уважало RLS на public.deliveries.
-- 5. public.squadron_member_detail: переключаем JOIN с закрытой таблицы public.profiles
--    на безопасное представление public.public_profiles без изменения набора колонок.
-- =============================================================================

SET client_min_messages TO warning;

-- ── 1. public.capi_tokens: доступ только для service_role ─────────────────────
DO $$
BEGIN
  IF to_regclass('public.capi_tokens') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.capi_tokens ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "capi_tokens_select_own" ON public.capi_tokens';
    EXECUTE 'REVOKE ALL ON public.capi_tokens FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT ALL ON public.capi_tokens TO service_role';
  END IF;
END
$$;

-- ── 2. public.inara_profiles: доступ только для service_role ──────────────────
DO $$
BEGIN
  IF to_regclass('public.inara_profiles') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.inara_profiles ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "inara_profiles_select_own" ON public.inara_profiles';
    EXECUTE 'REVOKE ALL ON public.inara_profiles FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT ALL ON public.inara_profiles TO service_role';
  END IF;
END
$$;

-- ── 3. public.api_tokens: скрытие token_hash и запрет прямой записи ───────────
DO $$
BEGIN
  IF to_regclass('public.api_tokens') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE public.api_tokens
      ADD COLUMN IF NOT EXISTS scopes TEXT[] DEFAULT ARRAY[''upload'']::text[],
      ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ';

    EXECUTE 'DROP POLICY IF EXISTS "api_tokens_insert" ON public.api_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "api_tokens_update" ON public.api_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "api_tokens_delete" ON public.api_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "Users insert own api_tokens" ON public.api_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "Users update own api_tokens" ON public.api_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "Users delete own api_tokens" ON public.api_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "Users can manage own tokens" ON public.api_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "Users can insert own tokens" ON public.api_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "Users can delete own tokens" ON public.api_tokens';

    EXECUTE 'REVOKE ALL ON public.api_tokens FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT SELECT (id, user_id, name, scopes, is_revoked, revoked_at, last_used_at, expires_at, created_at)
      ON public.api_tokens TO authenticated';
    EXECUTE 'GRANT ALL ON public.api_tokens TO service_role';
  END IF;
END
$$;

-- ── 4. public.delivery_scope_summary: уважение RLS таблицы deliveries ─────────
DO $$
BEGIN
  IF to_regclass('public.delivery_scope_summary') IS NOT NULL THEN
    EXECUTE 'ALTER VIEW public.delivery_scope_summary SET (security_invoker = true)';
    EXECUTE 'REVOKE ALL ON public.delivery_scope_summary FROM PUBLIC, anon';
    EXECUTE 'GRANT SELECT ON public.delivery_scope_summary TO authenticated, service_role';
  END IF;
END
$$;

-- ── 5. public.squadron_member_detail: чтение из public_profiles ───────────────
DO $$
DECLARE
  v_def text;
BEGIN
  IF to_regclass('public.squadron_member_detail') IS NOT NULL
     AND to_regclass('public.public_profiles') IS NOT NULL THEN
    v_def := pg_get_viewdef('public.squadron_member_detail'::regclass, true);
    IF v_def ~* '\mprofiles\M' THEN
      v_def := regexp_replace(v_def, '\mpublic\.profiles\M', 'public.public_profiles', 'gi');
      v_def := regexp_replace(v_def, '(?<!\.)\mprofiles\M', 'public.public_profiles', 'gi');
      EXECUTE 'CREATE OR REPLACE VIEW public.squadron_member_detail WITH (security_invoker = true) AS ' || v_def;
    ELSE
      EXECUTE 'ALTER VIEW public.squadron_member_detail SET (security_invoker = true)';
    END IF;
    EXECUTE 'GRANT SELECT ON public.squadron_member_detail TO anon, authenticated, service_role';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';


-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261017000000_fleet_carriers.sql                   │
-- └────────────────────────────────────────────────────────────────┘

-- ══════════════════════════════════════════════════════════════════════════
-- Авианосцы (Fleet Carrier / Squadron Carrier): собственный учёт проекта.
--
-- Зачем: оверлей Colonial Helper брал груз авианосца только из Raven Colonial,
-- а туда уходили одни аддитивные дельты (PATCH) — без корректировок по рынку,
-- без банка эскадры и с риском повторной отправки истории. Цифры «протухали»,
-- а при недоступности Raven блок CARRIER оставался пустым. Теперь сервер
-- проекта сам ведёт состояние каждого носителя:
--
--   * fleet_carriers       — реестр: тип, позывной, имя, привязка к пилоту и
--                            эскадрилье, система/прыжок, службы, статус;
--   * fleet_carrier_cargo  — груз поимённо: базовый снимок + дельты после него;
--   * fleet_carrier_events — журнал грузовых дельт (идемпотентность по хешу).
--
-- Груз считается так (для каждой пары носитель+товар):
--
--     quantity = max(0, baseline_qty + Σ delta(event_at > baseline_at))
--
-- Базовый снимок бывает полным (трюм пуст по CarrierStats, CarrierBuy,
-- Frontier CAPI) и частичным (рынок авианосца: товары на продажу). Дельты,
-- пришедшие раньше снимка, в нём уже учтены и в сумму не входят — поэтому
-- повторная загрузка старых журналов (сайт + Helper, сброс кэша) ничего не
-- удваивает и не откатывает.
--
-- Все записи идут через service_role (маршруты Next.js проверяют права);
-- anon/authenticated к таблицам и функциям доступа не имеют.
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.fleet_carriers (
  carrier_id            BIGINT PRIMARY KEY CHECK (carrier_id > 0),
  carrier_type          TEXT NOT NULL DEFAULT 'FleetCarrier'
                          CHECK (carrier_type IN ('FleetCarrier', 'SquadronCarrier')),
  callsign              TEXT,
  name                  TEXT,
  name_at               TIMESTAMPTZ,
  -- Привязка к профилю пилота (личный Drake-Class).
  owner_id              UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  owner_source          TEXT CHECK (owner_source IN ('journal', 'capi', 'manual')),
  owner_at              TIMESTAMPTZ,
  -- Привязка к эскадрилье (Javelin-Class или носитель, отданный эскадре).
  squadron_id           BIGINT REFERENCES public.squadrons(id) ON DELETE SET NULL,
  squadron_source       TEXT CHECK (squadron_source IN ('journal', 'manual', 'legacy')),
  squadron_at           TIMESTAMPTZ,
  -- Где стоит.
  system_name           TEXT,
  system_address        BIGINT,
  body_name             TEXT,
  body_id               INTEGER,
  x                     DOUBLE PRECISION,
  y                     DOUBLE PRECISION,
  z                     DOUBLE PRECISION,
  location_at           TIMESTAMPTZ,
  location_source       TEXT,
  -- Запланированный прыжок (CarrierJumpRequest).
  jump_system_name      TEXT,
  jump_system_address   BIGINT,
  jump_body_name        TEXT,
  jump_body_id          INTEGER,
  jump_departure_at     TIMESTAMPTZ,
  jump_requested_at     TIMESTAMPTZ,
  -- Статус.
  docking_access        TEXT,
  allow_notorious       BOOLEAN,
  docking_at            TIMESTAMPTZ,
  pending_decommission  BOOLEAN NOT NULL DEFAULT false,
  decommission_at       TIMESTAMPTZ,
  fuel_level            INTEGER,
  jump_range_curr       DOUBLE PRECISION,
  jump_range_max        DOUBLE PRECISION,
  space_usage           JSONB CHECK (space_usage IS NULL OR jsonb_typeof(space_usage) = 'object'),
  finance               JSONB CHECK (finance IS NULL OR jsonb_typeof(finance) = 'object'),
  stats_at              TIMESTAMPTZ,
  -- Службы экипажа (CarrierStats.Crew + CarrierCrewServices).
  services              JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(services) = 'array'),
  services_at           TIMESTAMPTZ,
  -- Службы станции из Docked.StationServices (видны любому пилоту).
  station_services      JSONB CHECK (station_services IS NULL OR jsonb_typeof(station_services) = 'array'),
  station_services_at   TIMESTAMPTZ,
  -- Ордера рынка владельца (CarrierTradeOrder): товар → {purchase, sale, price, ...}.
  trade_orders          JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(trade_orders) = 'object'),
  -- Последний ПОЛНЫЙ снимок трюма.
  cargo_baseline_at     TIMESTAMPTZ,
  cargo_baseline_source TEXT,
  cargo_updated_at      TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Один личный авианосец на профиль: у командира в игре он тоже один.
CREATE UNIQUE INDEX IF NOT EXISTS fleet_carriers_one_personal
  ON public.fleet_carriers(owner_id)
  WHERE owner_id IS NOT NULL AND carrier_type = 'FleetCarrier';
CREATE INDEX IF NOT EXISTS fleet_carriers_squadron
  ON public.fleet_carriers(squadron_id) WHERE squadron_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fleet_carriers_callsign
  ON public.fleet_carriers(upper(callsign)) WHERE callsign IS NOT NULL;
CREATE INDEX IF NOT EXISTS fleet_carriers_system
  ON public.fleet_carriers(lower(system_name)) WHERE system_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.fleet_carrier_cargo (
  carrier_id      BIGINT NOT NULL REFERENCES public.fleet_carriers(carrier_id) ON DELETE CASCADE,
  commodity       TEXT NOT NULL CHECK (commodity ~ '^[a-z0-9]{1,80}$'),
  name_localised  TEXT,
  baseline_qty    INTEGER NOT NULL DEFAULT 0 CHECK (baseline_qty >= 0),
  baseline_at     TIMESTAMPTZ,
  baseline_source TEXT,
  quantity        INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (carrier_id, commodity)
);

CREATE TABLE IF NOT EXISTS public.fleet_carrier_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carrier_id  BIGINT NOT NULL REFERENCES public.fleet_carriers(carrier_id) ON DELETE CASCADE,
  -- Хеш считает сервер из полей самого журнального события: один и тот же
  -- MarketSell из Helper'а и из загрузки на сайте даёт один хеш.
  event_hash  TEXT NOT NULL UNIQUE CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  source      TEXT NOT NULL,
  event       TEXT NOT NULL,
  commodity   TEXT NOT NULL CHECK (commodity ~ '^[a-z0-9]{1,80}$'),
  delta       INTEGER NOT NULL CHECK (delta <> 0),
  event_at    TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fleet_carrier_events_ledger
  ON public.fleet_carrier_events(carrier_id, commodity, event_at);

ALTER TABLE public.fleet_carriers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_carrier_cargo ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_carrier_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fleet_carriers, public.fleet_carrier_cargo, public.fleet_carrier_events
  FROM anon, authenticated;
GRANT ALL ON public.fleet_carriers, public.fleet_carrier_cargo, public.fleet_carrier_events
  TO service_role;

-- ── Перенос старой ручной таблицы squadron_carriers ─────────────────────────
-- Она создавалась, но так и не использовалась интерфейсом. Данные, если они
-- есть, становятся привязками эскадрилий в новой модели.
DO $$
BEGIN
  IF to_regclass('public.squadron_carriers') IS NOT NULL THEN
    INSERT INTO public.fleet_carriers(
      carrier_id, callsign, name, name_at, squadron_id, squadron_source, squadron_at,
      system_name, x, y, z, location_at, location_source)
    SELECT DISTINCT ON (sc.carrier_id::bigint)
      sc.carrier_id::bigint, NULLIF(trim(sc.callsign), ''), NULLIF(trim(sc.carrier_name), ''),
      sc.created_at, sc.squadron_id, 'legacy', sc.created_at,
      NULLIF(trim(sc.current_system), ''), sc.x, sc.y, sc.z,
      CASE WHEN NULLIF(trim(sc.current_system), '') IS NULL THEN NULL ELSE sc.updated_at END,
      'legacy'
    FROM public.squadron_carriers sc
    JOIN public.squadrons s ON s.id = sc.squadron_id
    WHERE sc.carrier_id ~ '^[0-9]{1,18}$' AND sc.carrier_id::bigint > 0
    ORDER BY sc.carrier_id::bigint, sc.updated_at DESC NULLS LAST
    ON CONFLICT (carrier_id) DO NOTHING;
  END IF;
END $$;

-- ── Перенос рынка авианосца вслед за самим авианосцем ──────────────────────
-- Каталог станций (station_commerce) хранит рынок FC по MarketID, но систему
-- обновлял только при следующей стыковке. После прыжка рынок оставался
-- «торговать» в старой системе. Здесь строка каталога переезжает вместе с
-- носителем, снимки рынка остаются привязанными к MarketID.
CREATE OR REPLACE FUNCTION public.move_fleet_carrier_station(
  p_carrier_id BIGINT, p_system TEXT, p_x DOUBLE PRECISION, p_y DOUBLE PRECISION,
  p_z DOUBLE PRECISION, p_at TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  previous RECORD;
  sys_key TEXT := lower(trim(coalesce(p_system, '')));
BEGIN
  IF sys_key = '' OR p_at IS NULL OR to_regclass('public.station_commerce') IS NULL THEN
    RETURN false;
  END IF;
  SELECT system_name, station_name, observed_at INTO previous
    FROM station_commerce WHERE station_key = 'market:' || p_carrier_id FOR UPDATE;
  IF NOT FOUND OR lower(previous.system_name) = sys_key OR previous.observed_at >= p_at THEN
    RETURN false;
  END IF;
  INSERT INTO commerce_systems(system_name, name_lc, x, y, z, has_stations, observed_at, source)
    VALUES (trim(p_system), sys_key, p_x, p_y, p_z, true, p_at, 'colonial-helper')
  ON CONFLICT (name_lc) DO UPDATE SET
    has_stations = true,
    x = coalesce(commerce_systems.x, EXCLUDED.x),
    y = coalesce(commerce_systems.y, EXCLUDED.y),
    z = coalesce(commerce_systems.z, EXCLUDED.z);
  IF to_regclass('public.market_prices') IS NOT NULL THEN
    DELETE FROM market_prices
      WHERE lower(system_name) = lower(previous.system_name)
        AND lower(station_name) = lower(previous.station_name);
  END IF;
  IF to_regclass('public.market_search_cache') IS NOT NULL THEN
    DELETE FROM market_search_cache WHERE market_id::text = p_carrier_id::text;
  END IF;
  UPDATE station_commerce SET
    system_name = trim(p_system), system_lc = sys_key,
    -- Орбита/тело старой системы после прыжка недействительны.
    metadata = coalesce(metadata, '{}'::jsonb) - 'body_name' - 'body_id' - 'distance_to_arrival'
               - 'latitude' - 'longitude' - 'local_position',
    observed_at = p_at, source = 'colonial-helper'
  WHERE station_key = 'market:' || p_carrier_id;
  RETURN true;
END;
$$;

-- ── Применение пакета наблюдений ────────────────────────────────────────────
-- p_ops — массив операций, уже нормализованных сервером из журнальных событий
-- (см. src/lib/fleetCarriers.ts). Порядок не важен: каждое поле обновляется
-- только более свежим наблюдением, груз пересчитывается из журнала дельт.
CREATE OR REPLACE FUNCTION public.apply_fleet_carrier_batch(
  p_user_id UUID, p_source TEXT, p_ops JSONB)
RETURNS JSONB
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  op JSONB;
  item JSONB;
  kind TEXT;
  cid BIGINT;
  at TIMESTAMPTZ;
  car public.fleet_carriers%ROWTYPE;
  touched BIGINT[] := ARRAY[]::BIGINT[];
  user_squadron BIGINT;
  other_personal RECORD;
  inserted_id BIGINT;
  applied INTEGER := 0;
  duplicates INTEGER := 0;
  ignored INTEGER := 0;
  moved INTEGER := 0;
  patch JSONB;
  role_key TEXT;
  found_role BOOLEAN;
  services_new JSONB;
  same_system BOOLEAN;
  cargo_touched BIGINT[] := ARRAY[]::BIGINT[];
BEGIN
  IF p_source NOT IN ('helper', 'web', 'capi', 'manual') THEN
    RAISE EXCEPTION 'Invalid carrier source %', p_source;
  END IF;
  IF p_ops IS NULL OR jsonb_typeof(p_ops) <> 'array' THEN
    RAISE EXCEPTION 'Carrier ops must be an array';
  END IF;
  IF jsonb_array_length(p_ops) > 5000 THEN
    RAISE EXCEPTION 'Too many carrier ops';
  END IF;

  -- Носители пакета: создаём и блокируем в стабильном порядке. Блокировка
  -- нужна, чтобы два Helper'а эскадрильи, пишущие в один носитель, не
  -- пересчитали груз по неполному журналу дельт.
  SELECT coalesce(array_agg(DISTINCT (o->>'carrier_id')::bigint), ARRAY[]::BIGINT[]) INTO touched
    FROM jsonb_array_elements(p_ops) o
   WHERE (o->>'carrier_id') ~ '^[0-9]{1,18}$' AND (o->>'carrier_id')::bigint > 0;
  INSERT INTO fleet_carriers(carrier_id)
    SELECT unnest(touched) ON CONFLICT (carrier_id) DO NOTHING;
  PERFORM 1 FROM fleet_carriers WHERE carrier_id = ANY(touched) ORDER BY carrier_id FOR UPDATE;

  IF p_user_id IS NOT NULL THEN
    SELECT squadron_id INTO user_squadron
      FROM squadron_members WHERE user_id = p_user_id ORDER BY squadron_id LIMIT 1;
  END IF;

  -- Порядок: по времени события, при равном времени — как прислал сервер
  -- (identity → stats → owner одного CarrierStats идут друг за другом).
  FOR op IN
    SELECT e.value FROM jsonb_array_elements(p_ops) WITH ORDINALITY AS e(value, n)
    ORDER BY (e.value->>'at')::timestamptz NULLS FIRST, e.n
  LOOP
    kind := op->>'op';
    IF (op->>'carrier_id') !~ '^[0-9]{1,18}$' THEN
      ignored := ignored + 1;
      CONTINUE;
    END IF;
    cid := (op->>'carrier_id')::bigint;
    at := (op->>'at')::timestamptz;
    IF at IS NULL OR at > now() + interval '10 minutes' THEN
      ignored := ignored + 1;
      CONTINUE;
    END IF;
    SELECT * INTO car FROM fleet_carriers WHERE carrier_id = cid;

    IF kind = 'identity' THEN
      -- weak_name: имя из Docked.StationName — только если настоящего ещё нет
      -- (у непереименованного носителя там позывной, а не имя).
      UPDATE fleet_carriers SET
        carrier_type = CASE WHEN op->>'carrier_type' = 'SquadronCarrier' THEN 'SquadronCarrier' ELSE carrier_type END,
        -- Эскадренный носитель принадлежит эскадрилье, а не пилоту.
        owner_id = CASE WHEN op->>'carrier_type' = 'SquadronCarrier' THEN NULL ELSE owner_id END,
        owner_source = CASE WHEN op->>'carrier_type' = 'SquadronCarrier' THEN NULL ELSE owner_source END,
        owner_at = CASE WHEN op->>'carrier_type' = 'SquadronCarrier' THEN NULL ELSE owner_at END,
        callsign = coalesce(NULLIF(op->>'callsign', ''), callsign),
        name = CASE
          WHEN NULLIF(op->>'name', '') IS NULL THEN name
          WHEN coalesce((op->>'weak_name')::boolean, false) THEN coalesce(name, op->>'name')
          WHEN name_at IS NULL OR at >= name_at THEN op->>'name'
          ELSE name END,
        name_at = CASE
          WHEN NULLIF(op->>'name', '') IS NULL OR coalesce((op->>'weak_name')::boolean, false) THEN name_at
          WHEN name_at IS NULL OR at >= name_at THEN at
          ELSE name_at END,
        station_services = CASE WHEN jsonb_typeof(op->'station_services') = 'array'
                                  AND (station_services_at IS NULL OR at >= station_services_at)
                                THEN op->'station_services' ELSE station_services END,
        station_services_at = CASE WHEN jsonb_typeof(op->'station_services') = 'array'
                                     AND (station_services_at IS NULL OR at >= station_services_at)
                                   THEN at ELSE station_services_at END,
        updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'stats' THEN
      IF car.stats_at IS NOT NULL AND at < car.stats_at THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        carrier_type = CASE WHEN op->>'carrier_type' = 'SquadronCarrier' THEN 'SquadronCarrier' ELSE carrier_type END,
        callsign = coalesce(NULLIF(op->>'callsign', ''), callsign),
        name = CASE WHEN NULLIF(op->>'name', '') IS NOT NULL AND (name_at IS NULL OR at >= name_at)
                    THEN op->>'name' ELSE name END,
        name_at = CASE WHEN NULLIF(op->>'name', '') IS NOT NULL AND (name_at IS NULL OR at >= name_at)
                       THEN at ELSE name_at END,
        docking_access = CASE WHEN op ? 'docking_access' AND (docking_at IS NULL OR at >= docking_at)
                              THEN op->>'docking_access' ELSE docking_access END,
        allow_notorious = CASE WHEN op ? 'allow_notorious' AND (docking_at IS NULL OR at >= docking_at)
                               THEN (op->>'allow_notorious')::boolean ELSE allow_notorious END,
        docking_at = CASE WHEN op ? 'docking_access' AND (docking_at IS NULL OR at >= docking_at)
                          THEN at ELSE docking_at END,
        pending_decommission = CASE WHEN op ? 'pending_decommission' AND (decommission_at IS NULL OR at >= decommission_at)
                                    THEN (op->>'pending_decommission')::boolean ELSE pending_decommission END,
        decommission_at = CASE WHEN op ? 'pending_decommission' AND (decommission_at IS NULL OR at >= decommission_at)
                               THEN at ELSE decommission_at END,
        fuel_level = coalesce((op->>'fuel_level')::integer, fuel_level),
        jump_range_curr = coalesce((op->>'jump_range_curr')::double precision, jump_range_curr),
        jump_range_max = coalesce((op->>'jump_range_max')::double precision, jump_range_max),
        space_usage = CASE WHEN jsonb_typeof(op->'space_usage') = 'object' THEN op->'space_usage' ELSE space_usage END,
        finance = CASE WHEN jsonb_typeof(op->'finance') = 'object' THEN op->'finance' ELSE finance END,
        services = CASE WHEN jsonb_typeof(op->'services') = 'array' AND (services_at IS NULL OR at >= services_at)
                        THEN op->'services' ELSE services END,
        services_at = CASE WHEN jsonb_typeof(op->'services') = 'array' AND (services_at IS NULL OR at >= services_at)
                           THEN at ELSE services_at END,
        stats_at = at,
        updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'owner' THEN
      -- Личная привязка. Доказательства: CarrierStats/CarrierBuy (приходят
      -- только владельцу) и Frontier CAPI; «мягкое» — CarrierLocation.
      IF p_user_id IS NULL OR car.carrier_type = 'SquadronCarrier' THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      IF car.owner_id = p_user_id THEN
        UPDATE fleet_carriers SET
          owner_at = greatest(coalesce(owner_at, at), at),
          owner_source = CASE WHEN owner_source = 'manual' AND op->>'proof' IN ('journal', 'capi')
                              THEN op->>'proof' ELSE owner_source END
        WHERE carrier_id = cid;
        applied := applied + 1;
        CONTINUE;
      END IF;
      IF op->>'proof' = 'soft' AND car.owner_id IS NOT NULL AND car.owner_source <> 'manual' THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      IF car.owner_id IS NOT NULL AND car.owner_source <> 'manual' AND car.owner_at IS NOT NULL
         AND at < car.owner_at THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      SELECT carrier_id, owner_at, owner_source INTO other_personal FROM fleet_carriers
        WHERE owner_id = p_user_id AND carrier_type = 'FleetCarrier' AND carrier_id <> cid
        LIMIT 1;
      IF FOUND THEN
        -- Старый журнал с прежним (списанным) носителем не отбирает привязку
        -- у текущего; «мягкое» доказательство не отбирает её никогда.
        IF op->>'proof' = 'soft' OR (other_personal.owner_source <> 'manual'
             AND other_personal.owner_at IS NOT NULL AND other_personal.owner_at > at) THEN
          ignored := ignored + 1;
          CONTINUE;
        END IF;
        UPDATE fleet_carriers SET owner_id = NULL, owner_source = NULL, owner_at = NULL
          WHERE carrier_id = other_personal.carrier_id;
      END IF;
      UPDATE fleet_carriers SET
        owner_id = p_user_id,
        owner_source = CASE WHEN op->>'proof' = 'capi' THEN 'capi' ELSE 'journal' END,
        owner_at = at,
        updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'squadron_claim' THEN
      -- Эскадренный носитель: пилот, видящий его CarrierStats/CarrierLocation
      -- или стыкующийся к нему (только для членов эскадрильи), привязывает
      -- его к своей эскадрилье на сайте — если носитель ещё ничей.
      IF user_squadron IS NULL OR car.carrier_type <> 'SquadronCarrier'
         OR (car.squadron_id IS NOT NULL AND car.squadron_id <> user_squadron) THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        squadron_id = user_squadron,
        squadron_source = coalesce(squadron_source, 'journal'),
        squadron_at = greatest(coalesce(squadron_at, at), at),
        updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'location' THEN
      IF NULLIF(op->>'system_name', '') IS NULL
         OR (car.location_at IS NOT NULL AND at < car.location_at) THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      same_system := lower(op->>'system_name') = lower(coalesce(car.system_name, ''));
      UPDATE fleet_carriers SET
        system_name = op->>'system_name',
        -- Тело, координаты и адрес прежней системы после прыжка недействительны.
        system_address = CASE WHEN op ? 'system_address' THEN (op->>'system_address')::bigint
                              WHEN same_system THEN system_address ELSE NULL END,
        body_name = CASE WHEN op ? 'body_name' THEN NULLIF(op->>'body_name', '')
                         WHEN same_system THEN body_name ELSE NULL END,
        body_id = CASE WHEN op ? 'body_id' THEN (op->>'body_id')::integer
                       WHEN same_system THEN body_id ELSE NULL END,
        x = CASE WHEN op ? 'x' THEN (op->>'x')::double precision WHEN same_system THEN x ELSE NULL END,
        y = CASE WHEN op ? 'y' THEN (op->>'y')::double precision WHEN same_system THEN y ELSE NULL END,
        z = CASE WHEN op ? 'z' THEN (op->>'z')::double precision WHEN same_system THEN z ELSE NULL END,
        location_at = at,
        location_source = coalesce(op->>'source_event', location_source),
        updated_at = now()
      WHERE carrier_id = cid;
      -- Прыжок завершён (или сорвался без события): носитель уже не там,
      -- где был в момент запроса.
      IF car.jump_departure_at IS NOT NULL AND at >= car.jump_departure_at THEN
        UPDATE fleet_carriers SET
          jump_system_name = NULL, jump_system_address = NULL, jump_body_name = NULL,
          jump_body_id = NULL, jump_departure_at = NULL, jump_requested_at = NULL
        WHERE carrier_id = cid;
      END IF;
      applied := applied + 1;
      IF public.move_fleet_carrier_station(cid, op->>'system_name', (op->>'x')::double precision,
           (op->>'y')::double precision, (op->>'z')::double precision, at) THEN
        moved := moved + 1;
      END IF;

    ELSIF kind = 'jump' THEN
      IF (car.jump_requested_at IS NOT NULL AND at < car.jump_requested_at)
         OR (car.location_at IS NOT NULL AND (op->>'departure_at') IS NOT NULL
             AND (op->>'departure_at')::timestamptz <= car.location_at)
         OR (car.location_at IS NOT NULL AND at < car.location_at AND (op->>'departure_at') IS NULL) THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        jump_system_name = NULLIF(op->>'system_name', ''),
        jump_system_address = (op->>'system_address')::bigint,
        jump_body_name = NULLIF(op->>'body_name', ''),
        jump_body_id = (op->>'body_id')::integer,
        jump_departure_at = (op->>'departure_at')::timestamptz,
        jump_requested_at = at,
        updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'jump_cancel' THEN
      IF car.jump_requested_at IS NULL OR at < car.jump_requested_at THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        jump_system_name = NULL, jump_system_address = NULL, jump_body_name = NULL,
        jump_body_id = NULL, jump_departure_at = NULL, jump_requested_at = NULL,
        updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'decommission' THEN
      IF car.decommission_at IS NOT NULL AND at < car.decommission_at THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        pending_decommission = coalesce((op->>'pending')::boolean, false),
        decommission_at = at, updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'docking' THEN
      IF car.docking_at IS NOT NULL AND at < car.docking_at THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        docking_access = coalesce(op->>'docking_access', docking_access),
        allow_notorious = coalesce((op->>'allow_notorious')::boolean, allow_notorious),
        docking_at = at, updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'service' THEN
      role_key := lower(coalesce(op->>'role', ''));
      IF role_key = '' OR (car.services_at IS NOT NULL AND at < car.services_at) THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      patch := CASE op->>'operation'
        WHEN 'activate' THEN jsonb_build_object('activated', true, 'enabled', true)
        WHEN 'deactivate' THEN jsonb_build_object('activated', false, 'enabled', false)
        WHEN 'pause' THEN jsonb_build_object('enabled', false)
        WHEN 'resume' THEN jsonb_build_object('enabled', true)
        ELSE '{}'::jsonb END;
      IF NULLIF(op->>'crew_name', '') IS NOT NULL THEN
        patch := patch || jsonb_build_object('crew_name', op->>'crew_name');
      END IF;
      SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(car.services) s WHERE lower(s->>'role') = role_key)
        INTO found_role;
      IF found_role THEN
        SELECT coalesce(jsonb_agg(CASE WHEN lower(s->>'role') = role_key THEN s || patch ELSE s END), '[]'::jsonb)
          INTO services_new FROM jsonb_array_elements(car.services) s;
      ELSE
        services_new := car.services || jsonb_build_array(
          jsonb_build_object('role', op->>'role', 'activated', false, 'enabled', false) || patch);
      END IF;
      UPDATE fleet_carriers SET services = services_new, services_at = at, updated_at = now()
        WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'order' THEN
      item := car.trade_orders -> (op->>'commodity');
      IF NULLIF(op->>'commodity', '') IS NULL
         OR (item IS NOT NULL AND (item->>'at')::timestamptz > at) THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      IF coalesce((op->>'cancel')::boolean, false) THEN
        UPDATE fleet_carriers SET trade_orders = trade_orders - (op->>'commodity'), updated_at = now()
          WHERE carrier_id = cid;
      ELSE
        UPDATE fleet_carriers SET trade_orders = trade_orders || jsonb_build_object(op->>'commodity',
            jsonb_strip_nulls(jsonb_build_object(
              'name', NULLIF(op->>'name_localised', ''),
              'purchase', (op->>'purchase')::integer,
              'sale', (op->>'sale')::integer,
              'price', (op->>'price')::integer,
              'black_market', coalesce((op->>'black_market')::boolean, false),
              'at', at))),
          updated_at = now()
        WHERE carrier_id = cid;
      END IF;
      applied := applied + 1;

    ELSIF kind = 'delta' THEN
      IF (op->>'commodity') !~ '^[a-z0-9]{1,80}$' OR coalesce((op->>'delta')::integer, 0) = 0
         OR (op->>'hash') !~ '^[0-9a-f]{64}$' THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      inserted_id := NULL;
      INSERT INTO fleet_carrier_events(carrier_id, event_hash, user_id, source, event, commodity, delta, event_at)
        VALUES (cid, op->>'hash', p_user_id, p_source, coalesce(op->>'event', 'unknown'),
                op->>'commodity', (op->>'delta')::integer, at)
      ON CONFLICT (event_hash) DO NOTHING
      RETURNING id INTO inserted_id;
      IF inserted_id IS NULL THEN
        duplicates := duplicates + 1;
        CONTINUE;
      END IF;
      INSERT INTO fleet_carrier_cargo(carrier_id, commodity, name_localised, baseline_qty, baseline_at, baseline_source)
        VALUES (cid, op->>'commodity', NULLIF(op->>'name_localised', ''), 0,
                car.cargo_baseline_at, car.cargo_baseline_source)
      ON CONFLICT (carrier_id, commodity) DO UPDATE SET
        name_localised = coalesce(fleet_carrier_cargo.name_localised, EXCLUDED.name_localised);
      cargo_touched := array_append(cargo_touched, cid);
      applied := applied + 1;

    ELSIF kind = 'baseline' THEN
      IF jsonb_typeof(op->'items') <> 'array' THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      IF coalesce((op->>'full')::boolean, false) THEN
        IF car.cargo_baseline_at IS NOT NULL AND at <= car.cargo_baseline_at THEN
          ignored := ignored + 1;
          CONTINUE;
        END IF;
        UPDATE fleet_carriers SET cargo_baseline_at = at, cargo_baseline_source = op->>'source_event'
          WHERE carrier_id = cid;
        UPDATE fleet_carrier_cargo SET baseline_qty = 0, baseline_at = at, baseline_source = op->>'source_event'
          WHERE carrier_id = cid AND (baseline_at IS NULL OR baseline_at < at);
        -- Дельты до полного снимка в нём уже учтены и больше не нужны.
        DELETE FROM fleet_carrier_events WHERE carrier_id = cid AND event_at <= at;
      ELSIF car.cargo_baseline_at IS NOT NULL AND at <= car.cargo_baseline_at THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(op->'items') LOOP
        IF (item->>'commodity') !~ '^[a-z0-9]{1,80}$' OR coalesce((item->>'qty')::integer, -1) < 0 THEN
          CONTINUE;
        END IF;
        INSERT INTO fleet_carrier_cargo(carrier_id, commodity, name_localised, baseline_qty, baseline_at, baseline_source)
          VALUES (cid, item->>'commodity', NULLIF(item->>'name_localised', ''), (item->>'qty')::integer,
                  at, op->>'source_event')
        ON CONFLICT (carrier_id, commodity) DO UPDATE SET
          baseline_qty = EXCLUDED.baseline_qty,
          baseline_at = EXCLUDED.baseline_at,
          baseline_source = EXCLUDED.baseline_source,
          name_localised = coalesce(EXCLUDED.name_localised, fleet_carrier_cargo.name_localised)
        WHERE fleet_carrier_cargo.baseline_at IS NULL OR fleet_carrier_cargo.baseline_at <= EXCLUDED.baseline_at;
      END LOOP;
      cargo_touched := array_append(cargo_touched, cid);
      applied := applied + 1;

    ELSE
      ignored := ignored + 1;
    END IF;
  END LOOP;

  -- Пересчёт груза затронутых носителей одним проходом.
  IF cardinality(cargo_touched) > 0 THEN
    UPDATE fleet_carrier_cargo c SET
      quantity = greatest(0, c.baseline_qty + coalesce((
        SELECT sum(e.delta) FROM fleet_carrier_events e
         WHERE e.carrier_id = c.carrier_id AND e.commodity = c.commodity
           AND (c.baseline_at IS NULL OR e.event_at > c.baseline_at)), 0)),
      updated_at = now()
    WHERE c.carrier_id = ANY(cargo_touched);
    UPDATE fleet_carriers SET cargo_updated_at = now() WHERE carrier_id = ANY(cargo_touched);
  END IF;

  RETURN jsonb_build_object(
    'applied', applied, 'duplicates', duplicates, 'ignored', ignored,
    'stations_moved', moved, 'carriers', to_jsonb(touched));
END;
$$;

REVOKE ALL ON FUNCTION public.apply_fleet_carrier_batch(UUID, TEXT, JSONB),
  public.move_fleet_carrier_station(BIGINT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_fleet_carrier_batch(UUID, TEXT, JSONB),
  public.move_fleet_carrier_station(BIGINT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ)
  TO service_role;

COMMENT ON TABLE public.fleet_carriers IS
  'Авианосцы: личные (owner_id) и эскадренные (squadron_id). Пишется только сервером (service_role).';
COMMENT ON TABLE public.fleet_carrier_cargo IS
  'Груз авианосца: quantity = baseline_qty + сумма дельт после baseline_at.';
COMMENT ON TABLE public.fleet_carrier_events IS
  'Грузовые дельты из журналов (MarketSell/MarketBuy/CargoTransfer/банк эскадры); event_hash — идемпотентность.';

NOTIFY pgrst, 'reload schema';


-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261017120000_architect_projects.sql               │
-- └────────────────────────────────────────────────────────────────┘

-- ══════════════════════════════════════════════════════════════════════════
-- «Проекты систем» в Архитекторе (/architect/projects).
--
-- Проект — группа систем, которые эскадрилья или команда пилотов строит
-- вместе. К проекту привязываются участники (создатель, модераторы,
-- участники), системы (с планом архитектора и ответственным пилотом) и
-- авианосцы. Прогресс систем и проекта считается из уже существующих данных
-- (кэш Raven Colonial `system_progress`, состояние стройплощадок из журналов
-- `colonisation_sites`, планы `system_plans`), вклад пилотов — из `deliveries`
-- и грузовых дельт авианосцев `fleet_carrier_events`.
--
-- Доступ:
--   * проект видят только его участники (и администратор сайта);
--   * создатель (`owner`) назначает модераторов, передаёт и удаляет проект;
--   * модератор ведёт системы, участников и авианосцы;
--   * участник смотрит прогресс, лидеров и привязывает свой авианосец.
--
-- Запись идёт только через service_role: права решают маршруты Next.js
-- (`src/app/api/architect/projects/**`). Политики SELECT для authenticated —
-- вторая линия защиты на случай прямого чтения таблиц клиентом.
--
-- Вклад пилотов чужим участникам виден только агрегатом: функции
-- architect_project_contributions/activity доступны лишь service_role, а
-- маршрут отдаёт суммы и скрывает имена пилотов вне проекта, закрывших
-- поставки в настройках приватности.
-- ══════════════════════════════════════════════════════════════════════════

-- 1. Проект ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.architect_projects (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description      TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('planning', 'active', 'paused', 'completed', 'archived')),
  color            TEXT NOT NULL DEFAULT '#e67e22' CHECK (color ~ '^#[0-9a-f]{6}$'),
  target_date      DATE,
  -- С какого момента считать вклад пилотов (NULL — за всё время). Нужен,
  -- когда в систему проекта уже возили груз под прежнюю, чужую стройку.
  tracking_since   TIMESTAMPTZ,
  -- Последняя посчитанная сводка прогресса: список проектов показывает её,
  -- не пересчитывая каждую систему каждого проекта.
  progress_summary JSONB CHECK (progress_summary IS NULL OR jsonb_typeof(progress_summary) = 'object'),
  progress_at      TIMESTAMPTZ,
  created_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.architect_projects IS
  'Проекты систем Архитектора: группа систем под застройку с участниками, ролями и авианосцами.';

-- 2. Участники ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.architect_project_members (
  project_id  UUID NOT NULL REFERENCES public.architect_projects(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'moderator', 'member')),
  -- Обязанность в проекте свободным текстом: «перевозчик», «архитектор HIP 1»…
  duty        TEXT NOT NULL DEFAULT '' CHECK (length(duty) <= 80),
  added_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- Ровно один создатель на проект: передача проекта — функция ниже.
CREATE UNIQUE INDEX IF NOT EXISTS architect_project_members_one_owner
  ON public.architect_project_members(project_id) WHERE role = 'owner';
CREATE INDEX IF NOT EXISTS architect_project_members_user
  ON public.architect_project_members(user_id);

-- 3. Системы проекта ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.architect_project_systems (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES public.architect_projects(id) ON DELETE CASCADE,
  system_name     TEXT NOT NULL CHECK (length(btrim(system_name)) BETWEEN 1 AND 128),
  -- Тот же ключ, что у system_plans: `HIP 1` и `hip 1` — одна система.
  system_name_lc  TEXT GENERATED ALWAYS AS (lower(btrim(system_name))) STORED,
  -- Этап, который ведут люди; фактический прогресс считается из данных.
  stage           TEXT NOT NULL DEFAULT 'planned'
                    CHECK (stage IN ('planned', 'claimed', 'building', 'done', 'on_hold')),
  priority        SMALLINT NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  plan_id         UUID REFERENCES public.system_plans(id) ON DELETE SET NULL,
  responsible_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  target_date     DATE,
  notes           TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  added_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, system_name_lc)
);

CREATE INDEX IF NOT EXISTS architect_project_systems_lc
  ON public.architect_project_systems(system_name_lc);

-- 4. Авианосцы проекта ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.architect_project_carriers (
  project_id   UUID NOT NULL REFERENCES public.architect_projects(id) ON DELETE CASCADE,
  carrier_id   BIGINT NOT NULL REFERENCES public.fleet_carriers(carrier_id) ON DELETE CASCADE,
  -- Какую систему проекта обслуживает (необязательно).
  system_id    UUID REFERENCES public.architect_project_systems(id) ON DELETE SET NULL,
  purpose      TEXT NOT NULL DEFAULT '' CHECK (length(purpose) <= 80),
  -- Груз носителя виден участникам проекта, только если привязал его тот,
  -- кто и так видит груз: владелец личного носителя или офицер эскадрильи.
  share_cargo  BOOLEAN NOT NULL DEFAULT false,
  added_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, carrier_id)
);

CREATE INDEX IF NOT EXISTS architect_project_carriers_carrier
  ON public.architect_project_carriers(carrier_id);

-- 5. Права и RLS ────────────────────────────────────────────────────────────
-- Роль вызывающего в проекте. SECURITY DEFINER: политика на members сама
-- читает members, без этого RLS ушла бы в бесконечную рекурсию.
CREATE OR REPLACE FUNCTION public.architect_project_role(p_project UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.role
    FROM public.architect_project_members AS m
   WHERE m.project_id = p_project
     AND m.user_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.architect_project_role(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.architect_project_role(UUID) TO authenticated, service_role;

ALTER TABLE public.architect_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.architect_project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.architect_project_systems ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.architect_project_carriers ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.architect_projects, public.architect_project_members,
              public.architect_project_systems, public.architect_project_carriers
  FROM anon, authenticated;
GRANT SELECT ON public.architect_projects, public.architect_project_members,
                public.architect_project_systems, public.architect_project_carriers
  TO authenticated;
GRANT ALL ON public.architect_projects, public.architect_project_members,
             public.architect_project_systems, public.architect_project_carriers
  TO service_role;

DROP POLICY IF EXISTS architect_projects_select ON public.architect_projects;
CREATE POLICY architect_projects_select ON public.architect_projects
  FOR SELECT TO authenticated
  USING (public.architect_project_role(id) IS NOT NULL OR public.request_is_admin());

DROP POLICY IF EXISTS architect_project_members_select ON public.architect_project_members;
CREATE POLICY architect_project_members_select ON public.architect_project_members
  FOR SELECT TO authenticated
  USING (public.architect_project_role(project_id) IS NOT NULL OR public.request_is_admin());

DROP POLICY IF EXISTS architect_project_systems_select ON public.architect_project_systems;
CREATE POLICY architect_project_systems_select ON public.architect_project_systems
  FOR SELECT TO authenticated
  USING (public.architect_project_role(project_id) IS NOT NULL OR public.request_is_admin());

DROP POLICY IF EXISTS architect_project_carriers_select ON public.architect_project_carriers;
CREATE POLICY architect_project_carriers_select ON public.architect_project_carriers
  FOR SELECT TO authenticated
  USING (public.architect_project_role(project_id) IS NOT NULL OR public.request_is_admin());

-- 6. Уход участника ─────────────────────────────────────────────────────────
-- Ушедший пилот перестаёт быть ответственным за системы проекта. Если ушёл
-- создатель (удалил аккаунт), проект достаётся старейшему модератору, а без
-- модераторов — старейшему участнику; пустой проект удаляется. При удалении
-- всего проекта (каскад) ничего не делаем: строки проекта уже нет.
CREATE OR REPLACE FUNCTION public.architect_project_member_removed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_heir UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.architect_projects WHERE id = OLD.project_id) THEN
    RETURN OLD;
  END IF;

  UPDATE public.architect_project_systems
     SET responsible_id = NULL,
         updated_at = now()
   WHERE project_id = OLD.project_id
     AND responsible_id = OLD.user_id;

  IF OLD.role = 'owner' THEN
    SELECT m.user_id INTO v_heir
      FROM public.architect_project_members AS m
     WHERE m.project_id = OLD.project_id
     ORDER BY (m.role = 'moderator') DESC, m.created_at, m.user_id
     LIMIT 1;

    IF v_heir IS NULL THEN
      DELETE FROM public.architect_projects WHERE id = OLD.project_id;
    ELSE
      UPDATE public.architect_project_members
         SET role = 'owner',
             updated_at = now()
       WHERE project_id = OLD.project_id
         AND user_id = v_heir;
    END IF;
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS architect_project_member_removed ON public.architect_project_members;
CREATE TRIGGER architect_project_member_removed
  AFTER DELETE ON public.architect_project_members
  FOR EACH ROW EXECUTE FUNCTION public.architect_project_member_removed();

-- 7. Создание проекта одной транзакцией ─────────────────────────────────────
-- Проект без создателя-участника не должен появиться даже на миг: иначе его
-- никто, кроме администратора, не увидит.
CREATE OR REPLACE FUNCTION public.architect_project_create(
  p_owner       UUID,
  p_name        TEXT,
  p_description TEXT DEFAULT '',
  p_color       TEXT DEFAULT NULL,
  p_systems     TEXT[] DEFAULT '{}'
)
RETURNS UUID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_owner IS NULL THEN
    RAISE EXCEPTION 'architect_project_create: owner is required' USING ERRCODE = '22004';
  END IF;

  INSERT INTO public.architect_projects (name, description, color, created_by)
  VALUES (
    btrim(p_name),
    coalesce(p_description, ''),
    coalesce(nullif(lower(btrim(coalesce(p_color, ''))), ''), '#e67e22'),
    p_owner
  )
  RETURNING id INTO v_id;

  INSERT INTO public.architect_project_members (project_id, user_id, role, added_by)
  VALUES (v_id, p_owner, 'owner', p_owner);

  INSERT INTO public.architect_project_systems (project_id, system_name, sort_order, added_by)
  SELECT v_id, picked.name, picked.ord, p_owner
    FROM (
      SELECT DISTINCT ON (lower(cleaned.name)) cleaned.name, cleaned.ord
        FROM (
          SELECT btrim(regexp_replace(raw.value, '\s+', ' ', 'g')) AS name, raw.ord::int AS ord
            FROM unnest(coalesce(p_systems, '{}'::text[])) WITH ORDINALITY AS raw(value, ord)
        ) AS cleaned
       WHERE cleaned.name <> ''
       ORDER BY lower(cleaned.name), cleaned.ord
    ) AS picked
   ORDER BY picked.ord;

  RETURN v_id;
END;
$$;

-- 8. Передача проекта ───────────────────────────────────────────────────────
-- Прежний создатель становится модератором. Одна функция — одна транзакция:
-- проект не останется без создателя, если что-то пойдёт не так.
CREATE OR REPLACE FUNCTION public.architect_project_transfer(p_project UUID, p_to UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.architect_project_members
     WHERE project_id = p_project AND user_id = p_to
  ) THEN
    RAISE EXCEPTION 'architect_project_transfer: new owner is not a member' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.architect_project_members
     SET role = 'moderator',
         updated_at = now()
   WHERE project_id = p_project
     AND role = 'owner'
     AND user_id <> p_to;

  UPDATE public.architect_project_members
     SET role = 'owner',
         updated_at = now()
   WHERE project_id = p_project
     AND user_id = p_to;

  UPDATE public.architect_projects SET updated_at = now() WHERE id = p_project;
END;
$$;

-- 9. Источники прогресса одним запросом ─────────────────────────────────────
-- Кэш Raven и журнальные площадки ищутся без учёта регистра (в кэше
-- встречаются варианты написания), планы — по ссылкам систем проекта.
-- Полный JSON плана нужен только сводке прогресса, лидерборду — нет.
CREATE OR REPLACE FUNCTION public.architect_project_progress_sources(
  p_project_id    UUID,
  p_include_plans BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH systems AS (
    SELECT DISTINCT s.system_name_lc AS key
      FROM public.architect_project_systems AS s
     WHERE s.project_id = p_project_id
  )
  SELECT jsonb_build_object(
    'raven', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'system_key', systems.key,
               'system_name', sp.system_name,
               'progress', sp.progress,
               'updated_at', sp.updated_at,
               'data', sp.data))
        FROM systems
        JOIN public.system_progress AS sp
          ON lower(btrim(sp.system_name)) = systems.key
    ), '[]'::jsonb),
    'depots', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'system_key', systems.key,
               'market_id', cs.market_id::text,
               'system_name', cs.system_name,
               'construction_name', cs.construction_name,
               'construction_progress', cs.construction_progress,
               'resources_total', cs.resources_total,
               'event_timestamp', cs.event_timestamp))
        FROM systems
        JOIN public.colonisation_sites AS cs
          ON lower(btrim(cs.system_name)) = systems.key
    ), '[]'::jsonb),
    'plans', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', p.id,
               'system_name', p.system_name,
               'title', p.title,
               'author_id', p.author_id,
               'author_name', p.author_name,
               'visibility', p.visibility,
               'site_count', p.site_count,
               'haul_tons', p.haul_tons,
               'catalogue_version', p.catalogue_version,
               'updated_at', p.updated_at,
               'plan', CASE WHEN p_include_plans THEN p.plan ELSE NULL END))
        FROM public.system_plans AS p
       WHERE p.id IN (
         SELECT s.plan_id
           FROM public.architect_project_systems AS s
          WHERE s.project_id = p_project_id
            AND s.plan_id IS NOT NULL
       )
    ), '[]'::jsonb)
  );
$$;

-- 10. Вклад пилотов ─────────────────────────────────────────────────────────
-- Строки — уже сгруппированные суммы: пилот × цель × площадка × товар.
--   target = 'site'    — строительные поставки в системы проекта (та же
--                         выборка, что «тоннаж на стройплощадки» в досье:
--                         стройплощадка, колонизационный корабль, старые
--                         строки без признака);
--   target = 'carrier' — продажа груза на авианосцы проекта (MarketSell) и
--                         чистая загрузка владельцем/эскадрой (CargoTransfer,
--                         SquadronBankTransfer; выгрузка обратно вычитается,
--                         чтобы перевалка «на борт и обратно» не считалась).
-- Нижняя граница времени — позднейшая из p_since и tracking_since проекта.
CREATE OR REPLACE FUNCTION public.architect_project_contributions(
  p_project_id UUID,
  p_since      TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  user_id      UUID,
  target       TEXT,
  system_name  TEXT,
  market_id    TEXT,
  station_name TEXT,
  commodity    TEXT,
  tons         BIGINT,
  ops          BIGINT,
  first_at     TIMESTAMPTZ,
  last_at      TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT greatest(
             coalesce(p_since, '-infinity'::timestamptz),
             coalesce(p.tracking_since, '-infinity'::timestamptz)
           ) AS since
      FROM public.architect_projects AS p
     WHERE p.id = p_project_id
  ),
  systems AS (
    SELECT s.system_name_lc AS key
      FROM public.architect_project_systems AS s
     WHERE s.project_id = p_project_id
  ),
  carriers AS (
    SELECT c.carrier_id
      FROM public.architect_project_carriers AS c
     WHERE c.project_id = p_project_id
  ),
  site_rows AS (
    SELECT d.user_id,
           lower(btrim(d.system_name))                        AS system_key,
           btrim(d.system_name)                               AS system_name,
           nullif(btrim(coalesce(d.market_id, '')), '')       AS market_id,
           nullif(btrim(coalesce(d.station_name, '')), '')    AS station_name,
           coalesce(nullif(btrim(d.commodity), ''), 'unknown') AS commodity,
           d.amount::bigint                                   AS amount,
           coalesce(d.delivered_at, d.created_at)             AS at
      FROM public.deliveries AS d
      CROSS JOIN bounds AS b
     WHERE lower(btrim(d.system_name)) IN (SELECT key FROM systems)
       AND d.amount > 0
       AND coalesce(d.delivered_at, d.created_at) >= b.since
       AND (
         d.delivery_kind IN ('construction_site', 'colonisation_ship', 'legacy_site')
         OR (d.delivery_kind IS NULL AND d.is_construction IS DISTINCT FROM false)
       )
  ),
  site_groups AS (
    SELECT r.user_id, 'site'::text AS target, max(r.system_name) AS system_name,
           r.market_id, max(r.station_name) AS station_name, r.commodity,
           sum(r.amount)::bigint AS tons, count(*)::bigint AS ops,
           min(r.at) AS first_at, max(r.at) AS last_at
      FROM site_rows AS r
     GROUP BY r.user_id, r.system_key, r.market_id, r.commodity
  ),
  carrier_rows AS (
    SELECT d.user_id,
           btrim(d.market_id)                                   AS market_id,
           nullif(btrim(coalesce(d.station_name, '')), '')      AS station_name,
           coalesce(nullif(btrim(d.commodity), ''), 'unknown')  AS commodity,
           d.amount::bigint                                     AS tons,
           1::bigint                                            AS ops,
           coalesce(d.delivered_at, d.created_at)               AS first_at,
           coalesce(d.delivered_at, d.created_at)               AS last_at
      FROM public.deliveries AS d
      CROSS JOIN bounds AS b
     WHERE d.delivery_kind = 'fleet_carrier'
       AND btrim(d.market_id) IN (SELECT carrier_id::text FROM carriers)
       AND d.amount > 0
       AND coalesce(d.delivered_at, d.created_at) >= b.since
    UNION ALL
    SELECT e.user_id, e.carrier_id::text, NULL::text, e.commodity,
           sum(e.delta)::bigint, count(*)::bigint, min(e.event_at), max(e.event_at)
      FROM public.fleet_carrier_events AS e
      CROSS JOIN bounds AS b
     WHERE e.carrier_id IN (SELECT carrier_id FROM carriers)
       AND e.event IN ('CargoTransfer', 'SquadronBankTransfer')
       AND e.user_id IS NOT NULL
       AND e.event_at >= b.since
     GROUP BY e.user_id, e.carrier_id, e.commodity
    HAVING sum(e.delta) > 0
  ),
  carrier_groups AS (
    SELECT r.user_id, 'carrier'::text AS target, NULL::text AS system_name,
           r.market_id, max(r.station_name) AS station_name, r.commodity,
           sum(r.tons)::bigint AS tons, sum(r.ops)::bigint AS ops,
           min(r.first_at) AS first_at, max(r.last_at) AS last_at
      FROM carrier_rows AS r
     GROUP BY r.user_id, r.market_id, r.commodity
  )
  -- Ключ (user_id, target, system_name, market_id, commodity) уникален:
  -- маршрут читает результат страницами (PostgREST режет выдачу max_rows)
  -- и сортирует по нему же, поэтому страницы не пересекаются.
  SELECT * FROM site_groups
  UNION ALL
  SELECT * FROM carrier_groups
  ORDER BY 1, 2, 3 NULLS FIRST, 4 NULLS FIRST, 6;
$$;

-- Активность по дням (UTC) для графика: только суммы пилота за день.
CREATE OR REPLACE FUNCTION public.architect_project_activity(
  p_project_id UUID,
  p_since      TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  day     DATE,
  user_id UUID,
  target  TEXT,
  tons    BIGINT,
  ops     BIGINT
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT greatest(
             coalesce(p_since, '-infinity'::timestamptz),
             coalesce(p.tracking_since, '-infinity'::timestamptz)
           ) AS since
      FROM public.architect_projects AS p
     WHERE p.id = p_project_id
  ),
  systems AS (
    SELECT s.system_name_lc AS key
      FROM public.architect_project_systems AS s
     WHERE s.project_id = p_project_id
  ),
  carriers AS (
    SELECT c.carrier_id
      FROM public.architect_project_carriers AS c
     WHERE c.project_id = p_project_id
  ),
  activity_rows AS (
    SELECT (coalesce(d.delivered_at, d.created_at) AT TIME ZONE 'UTC')::date AS day,
           d.user_id, 'site'::text AS target, d.amount::bigint AS amount
      FROM public.deliveries AS d
      CROSS JOIN bounds AS b
     WHERE lower(btrim(d.system_name)) IN (SELECT key FROM systems)
       AND d.amount > 0
       AND coalesce(d.delivered_at, d.created_at) >= b.since
       AND (
         d.delivery_kind IN ('construction_site', 'colonisation_ship', 'legacy_site')
         OR (d.delivery_kind IS NULL AND d.is_construction IS DISTINCT FROM false)
       )
    UNION ALL
    SELECT (coalesce(d.delivered_at, d.created_at) AT TIME ZONE 'UTC')::date,
           d.user_id, 'carrier'::text, d.amount::bigint
      FROM public.deliveries AS d
      CROSS JOIN bounds AS b
     WHERE d.delivery_kind = 'fleet_carrier'
       AND btrim(d.market_id) IN (SELECT carrier_id::text FROM carriers)
       AND d.amount > 0
       AND coalesce(d.delivered_at, d.created_at) >= b.since
  )
  SELECT r.day, r.user_id, r.target, sum(r.amount)::bigint AS tons, count(*)::bigint AS ops
    FROM activity_rows AS r
   GROUP BY r.day, r.user_id, r.target
   ORDER BY 1, 2, 3;
$$;

REVOKE ALL ON FUNCTION public.architect_project_create(UUID, TEXT, TEXT, TEXT, TEXT[]),
                       public.architect_project_transfer(UUID, UUID),
                       public.architect_project_progress_sources(UUID, BOOLEAN),
                       public.architect_project_contributions(UUID, TIMESTAMPTZ),
                       public.architect_project_activity(UUID, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.architect_project_create(UUID, TEXT, TEXT, TEXT, TEXT[]),
                          public.architect_project_transfer(UUID, UUID),
                          public.architect_project_progress_sources(UUID, BOOLEAN),
                          public.architect_project_contributions(UUID, TIMESTAMPTZ),
                          public.architect_project_activity(UUID, TIMESTAMPTZ)
  TO service_role;

-- 11. Индексы под выборки проекта ───────────────────────────────────────────
-- Поставки ищутся по системе без учёта регистра (имя в проекте вводит
-- человек), продажи на авианосец — по MarketID носителя.
CREATE INDEX IF NOT EXISTS idx_deliveries_system_lc
  ON public.deliveries (lower(btrim(system_name)));
CREATE INDEX IF NOT EXISTS idx_deliveries_fleet_carrier_market
  ON public.deliveries (btrim(market_id))
  WHERE delivery_kind = 'fleet_carrier';
CREATE INDEX IF NOT EXISTS idx_system_progress_name_lc
  ON public.system_progress (lower(btrim(system_name)));
CREATE INDEX IF NOT EXISTS idx_colonisation_sites_system_lc
  ON public.colonisation_sites (lower(btrim(system_name)));


-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261018000000_fleet_carrier_squadron_claims.sql    │
-- └────────────────────────────────────────────────────────────────┘

-- ══════════════════════════════════════════════════════════════════════════
-- Авианосцы: эскадренный носитель привязывается только к своей эскадрилье.
--
-- Жалоба: «все авианосцы эскадрилий на карте отображаются как авианосцы
-- эскадрильи [DNHG] DRUNK HEDGEHOG».
--
-- Причина. Сервер считал доказательством членства и стыковку к Javelin
-- (Docked/Location/CarrierJump со службой squadronBank): «к эскадренному
-- носителю пускают только членов эскадры». Это неверно: доступ к стыковке у
-- Javelin настраивается так же, как у Drake, и может быть открыт всем пилотам.
-- Пилот эскадрильи, пристыковавшийся к чужому Javelin, приписывал его своей
-- эскадрилье, а правило «первая привязка навсегда» не давало это исправить ни
-- журналам настоящих хозяев, ни их офицерам (ручная привязка отвечала 409).
-- Вместе с подписью на карте носитель получал права «эскадрильи»: её участники
-- видели его груз, офицеры — финансы.
--
-- Что меняется (функция apply_fleet_carrier_batch, операция squadron_claim):
--   1. Привязку дают только события, которые игра пишет членам эскадрильи
--      носителя (поле proof): CarrierLocation — при каждом запуске игры, сразу
--      после SquadronStartup; CarrierStats — управление носителем;
--      CarrierBuy. Операции без proof шлёт сервер прежней версии (в том числе
--      пока после этой миграции пересобирается образ) — они игнорируются.
--   2. Тег. Позывной Javelin — тег его эскадрильи в игре (четыре символа,
--      «ENEX» у ENDURANCE EXPLORATION). Если и он, и тег эскадрильи на сайте
--      известны и не совпадают, носитель к ней не привязывается, а уже
--      сделанная журналом привязка снимается (fleet_carrier_tag_conflict).
--   3. Свежесть: события старше 30 дней привязку не дают — старый журнал
--      помнит прежнюю эскадрилью пилота.
--   4. Отвязку офицерами журналы больше не отменяют: эскадрилья попадает в
--      squadron_rejected, и журналы её участников носитель к ней не вернут
--      (вернуть можно ручной привязкой).
--   5. Источник 'member' — привязка по этим правилам. 'journal' остаётся
--      только у старых непроверенных привязок: подтверждённая заявка другой
--      эскадрильи её перехватывает.
--   6. Ремонт данных: имя стоянки Javelin из четырёх символов — это тег, он
--      переезжает в callsign; старые привязки 'journal' снимаются, кроме тех,
--      где тег носителя совпадает с тегом эскадрильи (они становятся
--      'member'). Настоящие привязки вернутся сами: CarrierLocation пишется
--      участникам при каждом запуске игры. Повторный прогон миграции
--      безопасен — привязки по новым правилам имеют источник 'member'.
-- ══════════════════════════════════════════════════════════════════════════

-- 1. Источник привязки 'member' ─────────────────────────────────────────────
-- Ограничение создавалось в определении колонки, поэтому его имя ищем по
-- тексту: снимаем любое прежнее и ставим новое (повторный прогон безопасен).
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.fleet_carriers'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%squadron_source%'
  LOOP
    EXECUTE format('ALTER TABLE public.fleet_carriers DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE public.fleet_carriers ADD CONSTRAINT fleet_carriers_squadron_source_check
  CHECK (squadron_source IN ('journal', 'member', 'manual', 'legacy'));

-- 2. Эскадрильи, отказавшиеся от носителя ────────────────────────────────────
ALTER TABLE public.fleet_carriers
  ADD COLUMN IF NOT EXISTS squadron_rejected BIGINT[] NOT NULL DEFAULT '{}'::BIGINT[];

-- 3. Тег носителя против тега эскадрильи ─────────────────────────────────────
-- Позывной Javelin — тег эскадрильи в игре (ровно четыре символа). Тег
-- эскадрильи на сайте сравнивается без скобок и пробелов; тег другой длины
-- ничего не доказывает (его могли собрать из названия). То же правило — в
-- src/lib/carrierTags.ts.
CREATE OR REPLACE FUNCTION public.fleet_carrier_tag_conflict(p_callsign TEXT, p_squadron_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce((
    SELECT t.carrier_tag <> t.squadron_tag
      FROM (SELECT upper(btrim(coalesce(p_callsign, ''))) AS carrier_tag,
                   upper(regexp_replace(coalesce(s.tag, ''), '[^A-Za-z0-9]', '', 'g')) AS squadron_tag
              FROM squadrons s
             WHERE s.id = p_squadron_id) AS t
     WHERE t.carrier_tag ~ '^[A-Z0-9]{4}$' AND t.squadron_tag ~ '^[A-Z0-9]{4}$'), false);
$$;

-- 4. Применение пакета наблюдений ────────────────────────────────────────────
-- Тело — из 20261017000000_fleet_carriers.sql; изменены ветки identity (тег
-- снимает ошибочную привязку журнала) и squadron_claim (правила выше).
CREATE OR REPLACE FUNCTION public.apply_fleet_carrier_batch(
  p_user_id UUID, p_source TEXT, p_ops JSONB)
RETURNS JSONB
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  op JSONB;
  item JSONB;
  kind TEXT;
  cid BIGINT;
  at TIMESTAMPTZ;
  car public.fleet_carriers%ROWTYPE;
  touched BIGINT[] := ARRAY[]::BIGINT[];
  user_squadron BIGINT;
  other_personal RECORD;
  inserted_id BIGINT;
  applied INTEGER := 0;
  duplicates INTEGER := 0;
  ignored INTEGER := 0;
  moved INTEGER := 0;
  patch JSONB;
  role_key TEXT;
  found_role BOOLEAN;
  services_new JSONB;
  same_system BOOLEAN;
  cargo_touched BIGINT[] := ARRAY[]::BIGINT[];
BEGIN
  IF p_source NOT IN ('helper', 'web', 'capi', 'manual') THEN
    RAISE EXCEPTION 'Invalid carrier source %', p_source;
  END IF;
  IF p_ops IS NULL OR jsonb_typeof(p_ops) <> 'array' THEN
    RAISE EXCEPTION 'Carrier ops must be an array';
  END IF;
  IF jsonb_array_length(p_ops) > 5000 THEN
    RAISE EXCEPTION 'Too many carrier ops';
  END IF;

  -- Носители пакета: создаём и блокируем в стабильном порядке. Блокировка
  -- нужна, чтобы два Helper'а эскадрильи, пишущие в один носитель, не
  -- пересчитали груз по неполному журналу дельт.
  SELECT coalesce(array_agg(DISTINCT (o->>'carrier_id')::bigint), ARRAY[]::BIGINT[]) INTO touched
    FROM jsonb_array_elements(p_ops) o
   WHERE (o->>'carrier_id') ~ '^[0-9]{1,18}$' AND (o->>'carrier_id')::bigint > 0;
  INSERT INTO fleet_carriers(carrier_id)
    SELECT unnest(touched) ON CONFLICT (carrier_id) DO NOTHING;
  PERFORM 1 FROM fleet_carriers WHERE carrier_id = ANY(touched) ORDER BY carrier_id FOR UPDATE;

  IF p_user_id IS NOT NULL THEN
    SELECT squadron_id INTO user_squadron
      FROM squadron_members WHERE user_id = p_user_id ORDER BY squadron_id LIMIT 1;
  END IF;

  -- Порядок: по времени события, при равном времени — как прислал сервер
  -- (identity → stats → owner одного CarrierStats идут друг за другом).
  FOR op IN
    SELECT e.value FROM jsonb_array_elements(p_ops) WITH ORDINALITY AS e(value, n)
    ORDER BY (e.value->>'at')::timestamptz NULLS FIRST, e.n
  LOOP
    kind := op->>'op';
    IF (op->>'carrier_id') !~ '^[0-9]{1,18}$' THEN
      ignored := ignored + 1;
      CONTINUE;
    END IF;
    cid := (op->>'carrier_id')::bigint;
    at := (op->>'at')::timestamptz;
    IF at IS NULL OR at > now() + interval '10 minutes' THEN
      ignored := ignored + 1;
      CONTINUE;
    END IF;
    SELECT * INTO car FROM fleet_carriers WHERE carrier_id = cid;

    IF kind = 'identity' THEN
      -- weak_name: имя из Docked.StationName — только если настоящего ещё нет
      -- (у непереименованного носителя там позывной, а не имя).
      UPDATE fleet_carriers SET
        carrier_type = CASE WHEN op->>'carrier_type' = 'SquadronCarrier' THEN 'SquadronCarrier' ELSE carrier_type END,
        -- Эскадренный носитель принадлежит эскадрилье, а не пилоту.
        owner_id = CASE WHEN op->>'carrier_type' = 'SquadronCarrier' THEN NULL ELSE owner_id END,
        owner_source = CASE WHEN op->>'carrier_type' = 'SquadronCarrier' THEN NULL ELSE owner_source END,
        owner_at = CASE WHEN op->>'carrier_type' = 'SquadronCarrier' THEN NULL ELSE owner_at END,
        callsign = coalesce(NULLIF(op->>'callsign', ''), callsign),
        name = CASE
          WHEN NULLIF(op->>'name', '') IS NULL THEN name
          WHEN coalesce((op->>'weak_name')::boolean, false) THEN coalesce(name, op->>'name')
          WHEN name_at IS NULL OR at >= name_at THEN op->>'name'
          ELSE name END,
        name_at = CASE
          WHEN NULLIF(op->>'name', '') IS NULL OR coalesce((op->>'weak_name')::boolean, false) THEN name_at
          WHEN name_at IS NULL OR at >= name_at THEN at
          ELSE name_at END,
        station_services = CASE WHEN jsonb_typeof(op->'station_services') = 'array'
                                  AND (station_services_at IS NULL OR at >= station_services_at)
                                THEN op->'station_services' ELSE station_services END,
        station_services_at = CASE WHEN jsonb_typeof(op->'station_services') = 'array'
                                     AND (station_services_at IS NULL OR at >= station_services_at)
                                   THEN at ELSE station_services_at END,
        updated_at = now()
      WHERE carrier_id = cid;
      -- Позывной Javelin — тег его эскадрильи в игре. Стал известен и не
      -- совпадает с тегом эскадрильи, к которой носитель привязал журнал, —
      -- привязка ошибочная (пилот на сайте не в той эскадрилье, что в игре).
      -- Ручную привязку решали офицеры — её не трогаем.
      IF car.squadron_id IS NOT NULL AND car.squadron_source IN ('journal', 'member') THEN
        UPDATE fleet_carriers SET squadron_id = NULL, squadron_source = NULL, squadron_at = NULL
          WHERE carrier_id = cid AND public.fleet_carrier_tag_conflict(callsign, squadron_id);
      END IF;
      applied := applied + 1;

    ELSIF kind = 'stats' THEN
      IF car.stats_at IS NOT NULL AND at < car.stats_at THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        carrier_type = CASE WHEN op->>'carrier_type' = 'SquadronCarrier' THEN 'SquadronCarrier' ELSE carrier_type END,
        callsign = coalesce(NULLIF(op->>'callsign', ''), callsign),
        name = CASE WHEN NULLIF(op->>'name', '') IS NOT NULL AND (name_at IS NULL OR at >= name_at)
                    THEN op->>'name' ELSE name END,
        name_at = CASE WHEN NULLIF(op->>'name', '') IS NOT NULL AND (name_at IS NULL OR at >= name_at)
                       THEN at ELSE name_at END,
        docking_access = CASE WHEN op ? 'docking_access' AND (docking_at IS NULL OR at >= docking_at)
                              THEN op->>'docking_access' ELSE docking_access END,
        allow_notorious = CASE WHEN op ? 'allow_notorious' AND (docking_at IS NULL OR at >= docking_at)
                               THEN (op->>'allow_notorious')::boolean ELSE allow_notorious END,
        docking_at = CASE WHEN op ? 'docking_access' AND (docking_at IS NULL OR at >= docking_at)
                          THEN at ELSE docking_at END,
        pending_decommission = CASE WHEN op ? 'pending_decommission' AND (decommission_at IS NULL OR at >= decommission_at)
                                    THEN (op->>'pending_decommission')::boolean ELSE pending_decommission END,
        decommission_at = CASE WHEN op ? 'pending_decommission' AND (decommission_at IS NULL OR at >= decommission_at)
                               THEN at ELSE decommission_at END,
        fuel_level = coalesce((op->>'fuel_level')::integer, fuel_level),
        jump_range_curr = coalesce((op->>'jump_range_curr')::double precision, jump_range_curr),
        jump_range_max = coalesce((op->>'jump_range_max')::double precision, jump_range_max),
        space_usage = CASE WHEN jsonb_typeof(op->'space_usage') = 'object' THEN op->'space_usage' ELSE space_usage END,
        finance = CASE WHEN jsonb_typeof(op->'finance') = 'object' THEN op->'finance' ELSE finance END,
        services = CASE WHEN jsonb_typeof(op->'services') = 'array' AND (services_at IS NULL OR at >= services_at)
                        THEN op->'services' ELSE services END,
        services_at = CASE WHEN jsonb_typeof(op->'services') = 'array' AND (services_at IS NULL OR at >= services_at)
                           THEN at ELSE services_at END,
        stats_at = at,
        updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'owner' THEN
      -- Личная привязка. Доказательства: CarrierStats/CarrierBuy (приходят
      -- только владельцу) и Frontier CAPI; «мягкое» — CarrierLocation.
      IF p_user_id IS NULL OR car.carrier_type = 'SquadronCarrier' THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      IF car.owner_id = p_user_id THEN
        UPDATE fleet_carriers SET
          owner_at = greatest(coalesce(owner_at, at), at),
          owner_source = CASE WHEN owner_source = 'manual' AND op->>'proof' IN ('journal', 'capi')
                              THEN op->>'proof' ELSE owner_source END
        WHERE carrier_id = cid;
        applied := applied + 1;
        CONTINUE;
      END IF;
      IF op->>'proof' = 'soft' AND car.owner_id IS NOT NULL AND car.owner_source <> 'manual' THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      IF car.owner_id IS NOT NULL AND car.owner_source <> 'manual' AND car.owner_at IS NOT NULL
         AND at < car.owner_at THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      SELECT carrier_id, owner_at, owner_source INTO other_personal FROM fleet_carriers
        WHERE owner_id = p_user_id AND carrier_type = 'FleetCarrier' AND carrier_id <> cid
        LIMIT 1;
      IF FOUND THEN
        -- Старый журнал с прежним (списанным) носителем не отбирает привязку
        -- у текущего; «мягкое» доказательство не отбирает её никогда.
        IF op->>'proof' = 'soft' OR (other_personal.owner_source <> 'manual'
             AND other_personal.owner_at IS NOT NULL AND other_personal.owner_at > at) THEN
          ignored := ignored + 1;
          CONTINUE;
        END IF;
        UPDATE fleet_carriers SET owner_id = NULL, owner_source = NULL, owner_at = NULL
          WHERE carrier_id = other_personal.carrier_id;
      END IF;
      UPDATE fleet_carriers SET
        owner_id = p_user_id,
        owner_source = CASE WHEN op->>'proof' = 'capi' THEN 'capi' ELSE 'journal' END,
        owner_at = at,
        updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'squadron_claim' THEN
      -- Эскадренный носитель привязывается к эскадрилье пилота на сайте только
      -- по событию, которое игра пишет членам эскадрильи носителя (proof):
      -- CarrierLocation при запуске игры, CarrierStats, CarrierBuy. Стыковка
      -- не доказывает ничего — Javelin пускает и чужих; операции без proof
      -- (сервер прежней версии) игнорируются. Кроме того, привязку не дают:
      --   * события старше 30 дней — старый журнал помнит прежнюю эскадрилью;
      --   * эскадрилья, чьи офицеры отвязали носитель (squadron_rejected);
      --   * тег носителя, не совпадающий с тегом эскадрильи;
      --   * чужая подтверждённая или ручная привязка — её перехватывает только
      --     заявка против старой непроверенной ('journal').
      IF coalesce(op->>'proof', '') NOT IN ('CarrierStats', 'CarrierBuy', 'CarrierLocation')
         OR at < now() - interval '30 days'
         OR user_squadron IS NULL OR car.carrier_type <> 'SquadronCarrier'
         OR user_squadron = ANY(car.squadron_rejected)
         OR public.fleet_carrier_tag_conflict(car.callsign, user_squadron)
         OR (car.squadron_id IS NOT NULL AND car.squadron_id <> user_squadron
             AND car.squadron_source IS DISTINCT FROM 'journal') THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        squadron_id = user_squadron,
        squadron_source = CASE WHEN squadron_id = user_squadron AND squadron_source IN ('manual', 'legacy')
                               THEN squadron_source ELSE 'member' END,
        squadron_at = CASE WHEN squadron_id = user_squadron THEN greatest(coalesce(squadron_at, at), at)
                           ELSE at END,
        updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'location' THEN
      IF NULLIF(op->>'system_name', '') IS NULL
         OR (car.location_at IS NOT NULL AND at < car.location_at) THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      same_system := lower(op->>'system_name') = lower(coalesce(car.system_name, ''));
      UPDATE fleet_carriers SET
        system_name = op->>'system_name',
        -- Тело, координаты и адрес прежней системы после прыжка недействительны.
        system_address = CASE WHEN op ? 'system_address' THEN (op->>'system_address')::bigint
                              WHEN same_system THEN system_address ELSE NULL END,
        body_name = CASE WHEN op ? 'body_name' THEN NULLIF(op->>'body_name', '')
                         WHEN same_system THEN body_name ELSE NULL END,
        body_id = CASE WHEN op ? 'body_id' THEN (op->>'body_id')::integer
                       WHEN same_system THEN body_id ELSE NULL END,
        x = CASE WHEN op ? 'x' THEN (op->>'x')::double precision WHEN same_system THEN x ELSE NULL END,
        y = CASE WHEN op ? 'y' THEN (op->>'y')::double precision WHEN same_system THEN y ELSE NULL END,
        z = CASE WHEN op ? 'z' THEN (op->>'z')::double precision WHEN same_system THEN z ELSE NULL END,
        location_at = at,
        location_source = coalesce(op->>'source_event', location_source),
        updated_at = now()
      WHERE carrier_id = cid;
      -- Прыжок завершён (или сорвался без события): носитель уже не там,
      -- где был в момент запроса.
      IF car.jump_departure_at IS NOT NULL AND at >= car.jump_departure_at THEN
        UPDATE fleet_carriers SET
          jump_system_name = NULL, jump_system_address = NULL, jump_body_name = NULL,
          jump_body_id = NULL, jump_departure_at = NULL, jump_requested_at = NULL
        WHERE carrier_id = cid;
      END IF;
      applied := applied + 1;
      IF public.move_fleet_carrier_station(cid, op->>'system_name', (op->>'x')::double precision,
           (op->>'y')::double precision, (op->>'z')::double precision, at) THEN
        moved := moved + 1;
      END IF;

    ELSIF kind = 'jump' THEN
      IF (car.jump_requested_at IS NOT NULL AND at < car.jump_requested_at)
         OR (car.location_at IS NOT NULL AND (op->>'departure_at') IS NOT NULL
             AND (op->>'departure_at')::timestamptz <= car.location_at)
         OR (car.location_at IS NOT NULL AND at < car.location_at AND (op->>'departure_at') IS NULL) THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        jump_system_name = NULLIF(op->>'system_name', ''),
        jump_system_address = (op->>'system_address')::bigint,
        jump_body_name = NULLIF(op->>'body_name', ''),
        jump_body_id = (op->>'body_id')::integer,
        jump_departure_at = (op->>'departure_at')::timestamptz,
        jump_requested_at = at,
        updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'jump_cancel' THEN
      IF car.jump_requested_at IS NULL OR at < car.jump_requested_at THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        jump_system_name = NULL, jump_system_address = NULL, jump_body_name = NULL,
        jump_body_id = NULL, jump_departure_at = NULL, jump_requested_at = NULL,
        updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'decommission' THEN
      IF car.decommission_at IS NOT NULL AND at < car.decommission_at THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        pending_decommission = coalesce((op->>'pending')::boolean, false),
        decommission_at = at, updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'docking' THEN
      IF car.docking_at IS NOT NULL AND at < car.docking_at THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        docking_access = coalesce(op->>'docking_access', docking_access),
        allow_notorious = coalesce((op->>'allow_notorious')::boolean, allow_notorious),
        docking_at = at, updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'service' THEN
      role_key := lower(coalesce(op->>'role', ''));
      IF role_key = '' OR (car.services_at IS NOT NULL AND at < car.services_at) THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      patch := CASE op->>'operation'
        WHEN 'activate' THEN jsonb_build_object('activated', true, 'enabled', true)
        WHEN 'deactivate' THEN jsonb_build_object('activated', false, 'enabled', false)
        WHEN 'pause' THEN jsonb_build_object('enabled', false)
        WHEN 'resume' THEN jsonb_build_object('enabled', true)
        ELSE '{}'::jsonb END;
      IF NULLIF(op->>'crew_name', '') IS NOT NULL THEN
        patch := patch || jsonb_build_object('crew_name', op->>'crew_name');
      END IF;
      SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(car.services) s WHERE lower(s->>'role') = role_key)
        INTO found_role;
      IF found_role THEN
        SELECT coalesce(jsonb_agg(CASE WHEN lower(s->>'role') = role_key THEN s || patch ELSE s END), '[]'::jsonb)
          INTO services_new FROM jsonb_array_elements(car.services) s;
      ELSE
        services_new := car.services || jsonb_build_array(
          jsonb_build_object('role', op->>'role', 'activated', false, 'enabled', false) || patch);
      END IF;
      UPDATE fleet_carriers SET services = services_new, services_at = at, updated_at = now()
        WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'order' THEN
      item := car.trade_orders -> (op->>'commodity');
      IF NULLIF(op->>'commodity', '') IS NULL
         OR (item IS NOT NULL AND (item->>'at')::timestamptz > at) THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      IF coalesce((op->>'cancel')::boolean, false) THEN
        UPDATE fleet_carriers SET trade_orders = trade_orders - (op->>'commodity'), updated_at = now()
          WHERE carrier_id = cid;
      ELSE
        UPDATE fleet_carriers SET trade_orders = trade_orders || jsonb_build_object(op->>'commodity',
            jsonb_strip_nulls(jsonb_build_object(
              'name', NULLIF(op->>'name_localised', ''),
              'purchase', (op->>'purchase')::integer,
              'sale', (op->>'sale')::integer,
              'price', (op->>'price')::integer,
              'black_market', coalesce((op->>'black_market')::boolean, false),
              'at', at))),
          updated_at = now()
        WHERE carrier_id = cid;
      END IF;
      applied := applied + 1;

    ELSIF kind = 'delta' THEN
      IF (op->>'commodity') !~ '^[a-z0-9]{1,80}$' OR coalesce((op->>'delta')::integer, 0) = 0
         OR (op->>'hash') !~ '^[0-9a-f]{64}$' THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      inserted_id := NULL;
      INSERT INTO fleet_carrier_events(carrier_id, event_hash, user_id, source, event, commodity, delta, event_at)
        VALUES (cid, op->>'hash', p_user_id, p_source, coalesce(op->>'event', 'unknown'),
                op->>'commodity', (op->>'delta')::integer, at)
      ON CONFLICT (event_hash) DO NOTHING
      RETURNING id INTO inserted_id;
      IF inserted_id IS NULL THEN
        duplicates := duplicates + 1;
        CONTINUE;
      END IF;
      INSERT INTO fleet_carrier_cargo(carrier_id, commodity, name_localised, baseline_qty, baseline_at, baseline_source)
        VALUES (cid, op->>'commodity', NULLIF(op->>'name_localised', ''), 0,
                car.cargo_baseline_at, car.cargo_baseline_source)
      ON CONFLICT (carrier_id, commodity) DO UPDATE SET
        name_localised = coalesce(fleet_carrier_cargo.name_localised, EXCLUDED.name_localised);
      cargo_touched := array_append(cargo_touched, cid);
      applied := applied + 1;

    ELSIF kind = 'baseline' THEN
      IF jsonb_typeof(op->'items') <> 'array' THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      IF coalesce((op->>'full')::boolean, false) THEN
        IF car.cargo_baseline_at IS NOT NULL AND at <= car.cargo_baseline_at THEN
          ignored := ignored + 1;
          CONTINUE;
        END IF;
        UPDATE fleet_carriers SET cargo_baseline_at = at, cargo_baseline_source = op->>'source_event'
          WHERE carrier_id = cid;
        UPDATE fleet_carrier_cargo SET baseline_qty = 0, baseline_at = at, baseline_source = op->>'source_event'
          WHERE carrier_id = cid AND (baseline_at IS NULL OR baseline_at < at);
        -- Дельты до полного снимка в нём уже учтены и больше не нужны.
        DELETE FROM fleet_carrier_events WHERE carrier_id = cid AND event_at <= at;
      ELSIF car.cargo_baseline_at IS NOT NULL AND at <= car.cargo_baseline_at THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(op->'items') LOOP
        IF (item->>'commodity') !~ '^[a-z0-9]{1,80}$' OR coalesce((item->>'qty')::integer, -1) < 0 THEN
          CONTINUE;
        END IF;
        INSERT INTO fleet_carrier_cargo(carrier_id, commodity, name_localised, baseline_qty, baseline_at, baseline_source)
          VALUES (cid, item->>'commodity', NULLIF(item->>'name_localised', ''), (item->>'qty')::integer,
                  at, op->>'source_event')
        ON CONFLICT (carrier_id, commodity) DO UPDATE SET
          baseline_qty = EXCLUDED.baseline_qty,
          baseline_at = EXCLUDED.baseline_at,
          baseline_source = EXCLUDED.baseline_source,
          name_localised = coalesce(EXCLUDED.name_localised, fleet_carrier_cargo.name_localised)
        WHERE fleet_carrier_cargo.baseline_at IS NULL OR fleet_carrier_cargo.baseline_at <= EXCLUDED.baseline_at;
      END LOOP;
      cargo_touched := array_append(cargo_touched, cid);
      applied := applied + 1;

    ELSE
      ignored := ignored + 1;
    END IF;
  END LOOP;

  -- Пересчёт груза затронутых носителей одним проходом.
  IF cardinality(cargo_touched) > 0 THEN
    UPDATE fleet_carrier_cargo c SET
      quantity = greatest(0, c.baseline_qty + coalesce((
        SELECT sum(e.delta) FROM fleet_carrier_events e
         WHERE e.carrier_id = c.carrier_id AND e.commodity = c.commodity
           AND (c.baseline_at IS NULL OR e.event_at > c.baseline_at)), 0)),
      updated_at = now()
    WHERE c.carrier_id = ANY(cargo_touched);
    UPDATE fleet_carriers SET cargo_updated_at = now() WHERE carrier_id = ANY(cargo_touched);
  END IF;

  RETURN jsonb_build_object(
    'applied', applied, 'duplicates', duplicates, 'ignored', ignored,
    'stations_moved', moved, 'carriers', to_jsonb(touched));
END;
$$;

REVOKE ALL ON FUNCTION public.apply_fleet_carrier_batch(UUID, TEXT, JSONB),
  public.fleet_carrier_tag_conflict(TEXT, BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_fleet_carrier_batch(UUID, TEXT, JSONB),
  public.fleet_carrier_tag_conflict(TEXT, BIGINT)
  TO service_role;

-- 5. Ремонт данных ───────────────────────────────────────────────────────────
-- Имя стоянки Javelin из четырёх символов (слабое имя из Docked.StationName,
-- name_at пуст) — это его позывной, тег эскадрильи.
UPDATE public.fleet_carriers
   SET callsign = coalesce(callsign, upper(btrim(name))), name = NULL, updated_at = now()
 WHERE carrier_type = 'SquadronCarrier' AND name_at IS NULL
   AND btrim(name) ~ '^[A-Za-z0-9]{4}$';

-- Старые привязки журнала: подтверждённые тегом остаются (уже по новым
-- правилам), остальные — в основном «по стыковке» — снимаются.
UPDATE public.fleet_carriers c
   SET squadron_source = 'member', updated_at = now()
 WHERE c.squadron_source = 'journal' AND c.squadron_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM public.squadrons s
      WHERE s.id = c.squadron_id
        AND upper(regexp_replace(coalesce(s.tag, ''), '[^A-Za-z0-9]', '', 'g')) ~ '^[A-Z0-9]{4}$'
        AND upper(regexp_replace(coalesce(s.tag, ''), '[^A-Za-z0-9]', '', 'g')) = upper(btrim(c.callsign)));
UPDATE public.fleet_carriers
   SET squadron_id = NULL, squadron_source = NULL, squadron_at = NULL, updated_at = now()
 WHERE squadron_source = 'journal';

COMMENT ON COLUMN public.fleet_carriers.squadron_source IS
  'Откуда привязка к эскадрилье: member — журнал участника (CarrierLocation/CarrierStats/CarrierBuy), manual — офицер, legacy — старая таблица squadron_carriers, journal — старая непроверенная.';
COMMENT ON COLUMN public.fleet_carriers.squadron_rejected IS
  'Эскадрильи, чьи офицеры отвязали носитель: журналы их участников его больше не привязывают.';

NOTIFY pgrst, 'reload schema';


-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261018120000_powerplay_systems.sql                │
-- └────────────────────────────────────────────────────────────────┘

-- ══════════════════════════════════════════════════════════════════════════
-- PowerPlay 2.0: системы под контролем держав для карты Atlas.
--
-- Источник — ночной дамп EDSM `powerPlay.json.gz` (≈3,5 МБ, обновляется раз
-- в сутки): все системы, чьё состояние PowerPlay пилоты присылали в EDDN за
-- последние ~30 дней. Импорт — `src/lib/powerplaySync.ts` (задача
-- `powerplay-sync` и ленивое обновление из `GET /api/powerplay/systems`).
--
-- Хранится только «под контролем»: Stronghold, Fortified, Exploited. Состояние
-- Unoccupied в дампе приходит с одной державой из нескольких претендентов,
-- поэтому оно отбрасывается ещё в разборе.
--
-- Полная пересборка: каждая строка импорта помечается `sync_run`, а
-- `powerplay_finish_sync` удаляет всё, чего в новом дампе не было (держава
-- потеряла систему или про неё месяц никто не сообщал).
--
-- Миграция идемпотентна: снимок full_schema.sql и повторный прогон
-- deploy/update-project.sh не ломают уже созданные объекты.
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.powerplay_systems (
  id64         BIGINT PRIMARY KEY,
  name         TEXT NOT NULL,
  -- Имя в нижнем регистре: сортировка слоя и поиск без учёта регистра.
  name_lc      TEXT NOT NULL,
  x            DOUBLE PRECISION NOT NULL,
  y            DOUBLE PRECISION NOT NULL,
  z            DOUBLE PRECISION NOT NULL,
  power        TEXT NOT NULL,
  power_state  TEXT NOT NULL,
  allegiance   TEXT,
  government   TEXT,
  -- Когда источник видел систему в этом состоянии (поле `date` дампа EDSM).
  observed_at  TIMESTAMPTZ,
  source       TEXT NOT NULL DEFAULT 'edsm',
  -- Импорт, который последним видел строку: остальное удаляется в конце импорта.
  sync_run     UUID,
  -- Когда строка последний раз изменилась (держава, состояние, имя или координаты).
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT powerplay_systems_state_check
    CHECK (power_state IN ('Stronghold', 'Fortified', 'Exploited')),
  CONSTRAINT powerplay_systems_name_check
    CHECK (length(name) BETWEEN 1 AND 120 AND length(power) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS idx_powerplay_systems_power
  ON public.powerplay_systems (power, power_state);
CREATE INDEX IF NOT EXISTS idx_powerplay_systems_name_lc
  ON public.powerplay_systems (name_lc);
CREATE INDEX IF NOT EXISTS idx_powerplay_systems_sync_run
  ON public.powerplay_systems (sync_run);

ALTER TABLE public.powerplay_systems ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS powerplay_systems_select ON public.powerplay_systems;
-- Публичные игровые данные (как каталог систем): читать может кто угодно.
CREATE POLICY powerplay_systems_select ON public.powerplay_systems
  FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.powerplay_systems TO anon, authenticated;
-- Пишет только сервер.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.powerplay_systems TO service_role;

COMMENT ON TABLE public.powerplay_systems IS
  'PowerPlay 2.0: системы под контролем держав (ночной дамп EDSM powerPlay.json.gz). Слой «PowerPlay» карты Atlas.';
COMMENT ON COLUMN public.powerplay_systems.power IS
  'Держава, как её пишет журнал игры (ControllingPower): «A. Lavigny-Duval», «Jerome Archer» и т. д.';
COMMENT ON COLUMN public.powerplay_systems.power_state IS
  'Stronghold (зона 30 св. лет), Fortified (20 св. лет) или Exploited.';

-- ── Состояние импорта: одна строка ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.powerplay_sync_state (
  id                 SMALLINT PRIMARY KEY DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'idle',
  source_url         TEXT,
  -- Заголовки последнего удачного ответа: повторный запрос условный (304).
  etag               TEXT,
  last_modified      TEXT,
  dump_generated_at  TIMESTAMPTZ,
  -- Последний завершённый импорт; он же версия (ETag) ответа API слоя.
  run_id             UUID,
  rows_total         INTEGER NOT NULL DEFAULT 0,
  stats              JSONB NOT NULL DEFAULT '{}'::jsonb,
  error              TEXT,
  attempt_at         TIMESTAMPTZ,
  checked_at         TIMESTAMPTZ,
  synced_at          TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT powerplay_sync_state_singleton CHECK (id = 1),
  CONSTRAINT powerplay_sync_state_status_check
    CHECK (status IN ('idle', 'running', 'ok', 'error'))
);

INSERT INTO public.powerplay_sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.powerplay_sync_state ENABLE ROW LEVEL SECURITY;
-- Политик нет: состояние читает и пишет только сервер (service_role).
GRANT SELECT, INSERT, UPDATE ON public.powerplay_sync_state TO service_role;

COMMENT ON TABLE public.powerplay_sync_state IS
  'Состояние импорта PowerPlay: условный запрос к EDSM (ETag/Last-Modified), время, счётчики и последняя ошибка.';

-- ── Импорт пачкой ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.powerplay_apply_batch(p_run UUID, p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_run IS NULL OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'powerplay_apply_batch: нужны идентификатор импорта и массив строк';
  END IF;

  INSERT INTO public.powerplay_systems AS t (
    id64, name, name_lc, x, y, z, power, power_state,
    allegiance, government, observed_at, source, sync_run, updated_at
  )
  SELECT DISTINCT ON (r.id64)
    r.id64, btrim(r.name), lower(btrim(r.name)), r.x, r.y, r.z, btrim(r.power), r.power_state,
    nullif(btrim(r.allegiance), ''), nullif(btrim(r.government), ''), r.observed_at, 'edsm', p_run, now()
  FROM jsonb_to_recordset(p_rows) AS r(
    id64 BIGINT, name TEXT, x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION,
    power TEXT, power_state TEXT, allegiance TEXT, government TEXT, observed_at TIMESTAMPTZ
  )
  WHERE r.id64 IS NOT NULL AND r.id64 > 0
    AND nullif(btrim(r.name), '') IS NOT NULL
    AND nullif(btrim(r.power), '') IS NOT NULL
    AND r.power_state IN ('Stronghold', 'Fortified', 'Exploited')
    AND r.x IS NOT NULL AND r.y IS NOT NULL AND r.z IS NOT NULL
  ORDER BY r.id64, r.observed_at DESC NULLS LAST
  ON CONFLICT (id64) DO UPDATE SET
    name        = EXCLUDED.name,
    name_lc     = EXCLUDED.name_lc,
    x           = EXCLUDED.x,
    y           = EXCLUDED.y,
    z           = EXCLUDED.z,
    power       = EXCLUDED.power,
    power_state = EXCLUDED.power_state,
    allegiance  = EXCLUDED.allegiance,
    government  = EXCLUDED.government,
    observed_at = EXCLUDED.observed_at,
    source      = EXCLUDED.source,
    sync_run    = EXCLUDED.sync_run,
    updated_at  = CASE
      WHEN (t.power, t.power_state, t.name, t.x, t.y, t.z)
           IS DISTINCT FROM (EXCLUDED.power, EXCLUDED.power_state, EXCLUDED.name, EXCLUDED.x, EXCLUDED.y, EXCLUDED.z)
      THEN now()
      ELSE t.updated_at
    END;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ── Завершение импорта: удалить пропавшее и записать состояние ────────────

CREATE OR REPLACE FUNCTION public.powerplay_finish_sync(p_run UUID, p_state JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
  v_total   INTEGER;
  v_state   JSONB := COALESCE(p_state, '{}'::jsonb);
BEGIN
  IF p_run IS NULL THEN
    RAISE EXCEPTION 'powerplay_finish_sync: нужен идентификатор импорта';
  END IF;
  -- Пустой импорт не должен стереть карту: такой дамп отсекается ещё в коде,
  -- здесь — последняя страховка.
  IF NOT EXISTS (SELECT 1 FROM public.powerplay_systems WHERE sync_run = p_run) THEN
    RAISE EXCEPTION 'powerplay_finish_sync: импорт % не записал ни одной системы', p_run;
  END IF;

  DELETE FROM public.powerplay_systems WHERE sync_run IS DISTINCT FROM p_run;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  SELECT count(*) INTO v_total FROM public.powerplay_systems;

  INSERT INTO public.powerplay_sync_state AS s (id, status, run_id, rows_total, synced_at, checked_at, error, updated_at)
  VALUES (1, 'ok', p_run, v_total, now(), now(), NULL, now())
  ON CONFLICT (id) DO UPDATE SET
    status = 'ok', run_id = p_run, rows_total = v_total,
    synced_at = now(), checked_at = now(), error = NULL, updated_at = now();

  UPDATE public.powerplay_sync_state SET
    source_url        = COALESCE(v_state->>'source_url', source_url),
    etag              = v_state->>'etag',
    last_modified     = v_state->>'last_modified',
    dump_generated_at = (v_state->>'dump_generated_at')::timestamptz,
    stats             = COALESCE(v_state->'stats', '{}'::jsonb) || jsonb_build_object('deleted', v_deleted)
  WHERE id = 1;

  RETURN jsonb_build_object('deleted', v_deleted, 'total', v_total);
END;
$$;

-- ── Слой карты одной выборкой ─────────────────────────────────────────────
-- PostgREST режет обычные выборки по max_rows; ~50 тысяч систем одним JSON
-- приходят за один запрос. Порядок — по имени: панель Atlas не сортирует
-- десятки тысяч строк в браузере.

CREATE OR REPLACE FUNCTION public.powerplay_layer_rows()
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    json_agg(
      json_build_array(
        s.id64::text, s.name, s.x, s.y, s.z, s.power, s.power_state,
        floor(extract(epoch FROM s.observed_at))::bigint
      )
      ORDER BY s.name_lc, s.id64
    ),
    '[]'::json
  )
  FROM public.powerplay_systems s;
$$;

-- Импорт и выборка слоя — только сервером (service_role); клиенты идут через API.
REVOKE ALL ON FUNCTION public.powerplay_apply_batch(UUID, JSONB),
  public.powerplay_finish_sync(UUID, JSONB),
  public.powerplay_layer_rows()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerplay_apply_batch(UUID, JSONB),
  public.powerplay_finish_sync(UUID, JSONB),
  public.powerplay_layer_rows()
  TO service_role;

NOTIFY pgrst, 'reload schema';


-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261018180000_powerplay_sync_progress.sql          │
-- └────────────────────────────────────────────────────────────────┘

-- ══════════════════════════════════════════════════════════════════════════
-- PowerPlay: ход импорта и журнал процесса для админки.
--
-- Админка → Игровые данные → PowerPlay показывает загрузку дампа EDSM по
-- этапам (запрос, скачивание, распаковка, разбор, запись в базу, завершение)
-- с прогресс-барами и журналом. Живой прогон виден из памяти веб-процесса,
-- а копия хода и журнала пишется сюда — после перезапуска сайта (обновление,
-- сбой) админ всё равно видит, чем закончилась последняя загрузка: ночная
-- задача планировщика, ленивое обновление из вкладки Atlas или ручной запуск.
--
--   progress — ход последнего прогона: этапы, проценты, итог (JSON из
--              src/lib/powerplayProgress.ts);
--   log      — последние строки журнала (до 200), по прогонам подряд.
--
-- powerplay_admin_summary() — что сейчас лежит в таблице: системы по
-- державам и состояниям, самое старое и свежее наблюдение. Одной выборкой,
-- без перекачки всего слоя в админку.
--
-- Миграция идемпотентна: снимок full_schema.sql и повторный прогон
-- deploy/update-project.sh не ломают уже созданные объекты.
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.powerplay_sync_state
  ADD COLUMN IF NOT EXISTS progress JSONB;
ALTER TABLE public.powerplay_sync_state
  ADD COLUMN IF NOT EXISTS log JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.powerplay_sync_state.progress IS
  'Ход последнего импорта PowerPlay: этапы с процентами и итог (src/lib/powerplayProgress.ts).';
COMMENT ON COLUMN public.powerplay_sync_state.log IS
  'Журнал импорта PowerPlay: последние строки [{at, level, text}] для админки.';

CREATE OR REPLACE FUNCTION public.powerplay_admin_summary()
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT json_build_object(
    'total', (SELECT count(*) FROM public.powerplay_systems),
    'powers', COALESCE((
      SELECT json_agg(
        json_build_object(
          'power', p.power,
          'Stronghold', p.stronghold,
          'Fortified', p.fortified,
          'Exploited', p.exploited,
          'total', p.total
        )
        ORDER BY p.total DESC, p.power
      )
      FROM (
        SELECT
          s.power,
          count(*) FILTER (WHERE s.power_state = 'Stronghold') AS stronghold,
          count(*) FILTER (WHERE s.power_state = 'Fortified') AS fortified,
          count(*) FILTER (WHERE s.power_state = 'Exploited') AS exploited,
          count(*) AS total
        FROM public.powerplay_systems s
        GROUP BY s.power
      ) p
    ), '[]'::json),
    'oldest_observation', (SELECT min(observed_at) FROM public.powerplay_systems),
    'newest_observation', (SELECT max(observed_at) FROM public.powerplay_systems),
    'last_change', (SELECT max(updated_at) FROM public.powerplay_systems)
  );
$$;

-- Сводку читает только сервер (service_role) — админский маршрут.
REVOKE ALL ON FUNCTION public.powerplay_admin_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerplay_admin_summary() TO service_role;

NOTIFY pgrst, 'reload schema';


-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261019120000_minor_factions.sql                   │
-- └────────────────────────────────────────────────────────────────┘

-- ══════════════════════════════════════════════════════════════════════════
-- Минорные фракции (BGS) для карты Atlas: вкладка «Фракции».
--
-- Что хранится:
--   * bgs_systems          — населённые системы (есть хотя бы одна фракция):
--                            координаты, принадлежность, правительство,
--                            экономика, безопасность, население, контролирующая
--                            фракция, когда наблюдали и откуда взято;
--   * bgs_factions         — словарь минорных фракций (имя уникально без учёта
--                            регистра — так их различает и сама игра);
--   * bgs_faction_presence — какая фракция в какой системе: влияние, состояние,
--                            активные / ожидающие / затухающие состояния;
--   * bgs_sync_state       — импорт дампа EDSM: условный запрос, ход и журнал;
--   * bgs_updates          — обновления от пилотов (Colonial Helper и загрузчик
--                            журналов на сайте) для раздела админки.
--
-- Источники:
--   * ночной дамп EDSM `systemsPopulated.json.gz` (≈0,5 ГБ gzip) — полный набор
--     населённых систем с фракциями; импорт — `src/lib/bgsSync.ts`, запускает
--     администратор (Админка → Игровые данные → Фракции) и задача
--     `factions-sync`;
--   * журналы пилотов: FSDJump / Location / CarrierJump со списком `Factions`
--     присылают Colonial Helper и загрузчик журналов на сайте
--     (`POST /api/factions/sync`).
--
-- Правило слияния: побеждает более свежее наблюдение (`observed_at`). Свежие
-- данные пилота не затираются вчерашним дампом, а дамп обновляет системы,
-- где пилоты давно не были. Состав фракций системы заменяется целиком.
--
-- Каждая функция укладывается в короткий statement_timeout PostgREST: запись —
-- пачками по ~250 систем, завершение импорта — несколькими вызовами в цикле.
--
-- Миграция идемпотентна: снимок full_schema.sql и повторный прогон
-- deploy/update-project.sh не ломают уже созданные объекты.
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.bgs_factions (
  id                BIGSERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  -- Ключ уникальности и поиска: имя в нижнем регистре.
  name_lc           TEXT NOT NULL,
  allegiance        TEXT,
  government        TEXT,
  -- Фракция игроков (PMF). Журнал этого не сообщает — флаг приходит из EDSM.
  is_player         BOOLEAN NOT NULL DEFAULT false,
  edsm_id           BIGINT,
  -- Денормализованные счётчики для поиска и сортировки (bgs_recount_factions).
  systems_count     INTEGER NOT NULL DEFAULT 0,
  controlled_count  INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bgs_factions_name_check CHECK (length(name) BETWEEN 1 AND 160)
);

CREATE UNIQUE INDEX IF NOT EXISTS bgs_factions_name_lc_key ON public.bgs_factions (name_lc);
CREATE INDEX IF NOT EXISTS idx_bgs_factions_systems ON public.bgs_factions (systems_count DESC, name_lc);

CREATE TABLE IF NOT EXISTS public.bgs_systems (
  id64                    BIGINT PRIMARY KEY,
  name                    TEXT NOT NULL,
  name_lc                 TEXT NOT NULL,
  x                       DOUBLE PRECISION NOT NULL,
  y                       DOUBLE PRECISION NOT NULL,
  z                       DOUBLE PRECISION NOT NULL,
  allegiance              TEXT,
  government              TEXT,
  economy                 TEXT,
  second_economy          TEXT,
  security                TEXT,
  state                   TEXT,
  population              BIGINT,
  controlling_faction_id  BIGINT REFERENCES public.bgs_factions (id) ON DELETE SET NULL,
  factions_count          INTEGER NOT NULL DEFAULT 0,
  -- Когда состояние фракций системы видели в игре (журнал пилота или EDSM).
  observed_at             TIMESTAMPTZ,
  -- Откуда последнее применённое наблюдение: edsm | helper | web | eddn.
  source                  TEXT NOT NULL DEFAULT 'edsm',
  -- Импорт дампа EDSM, который последним видел систему.
  sync_run                UUID,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bgs_systems_source_check CHECK (source IN ('edsm', 'helper', 'web', 'eddn')),
  CONSTRAINT bgs_systems_name_check CHECK (length(name) BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS idx_bgs_systems_name_lc ON public.bgs_systems (name_lc);
CREATE INDEX IF NOT EXISTS idx_bgs_systems_controlling ON public.bgs_systems (controlling_faction_id);
CREATE INDEX IF NOT EXISTS idx_bgs_systems_sync_run ON public.bgs_systems (sync_run);

CREATE TABLE IF NOT EXISTS public.bgs_faction_presence (
  system_id64        BIGINT NOT NULL REFERENCES public.bgs_systems (id64) ON DELETE CASCADE,
  faction_id         BIGINT NOT NULL REFERENCES public.bgs_factions (id) ON DELETE CASCADE,
  -- Доля 0…1, как в журнале игры (0.452 = 45,2 %).
  influence          REAL,
  state              TEXT,
  active_states      TEXT[] NOT NULL DEFAULT '{}',
  pending_states     TEXT[] NOT NULL DEFAULT '{}',
  recovering_states  TEXT[] NOT NULL DEFAULT '{}',
  happiness          TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (system_id64, faction_id)
);

CREATE INDEX IF NOT EXISTS idx_bgs_presence_faction ON public.bgs_faction_presence (faction_id);

ALTER TABLE public.bgs_factions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bgs_systems ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bgs_faction_presence ENABLE ROW LEVEL SECURITY;
-- Публичные игровые данные (как каталог систем и PowerPlay): читать может кто угодно.
DROP POLICY IF EXISTS bgs_factions_select ON public.bgs_factions;
CREATE POLICY bgs_factions_select ON public.bgs_factions FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS bgs_systems_select ON public.bgs_systems;
CREATE POLICY bgs_systems_select ON public.bgs_systems FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS bgs_faction_presence_select ON public.bgs_faction_presence;
CREATE POLICY bgs_faction_presence_select ON public.bgs_faction_presence FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.bgs_factions, public.bgs_systems, public.bgs_faction_presence TO anon, authenticated;
-- Пишет только сервер.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bgs_factions, public.bgs_systems, public.bgs_faction_presence TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.bgs_factions_id_seq TO service_role;

COMMENT ON TABLE public.bgs_factions IS
  'Минорные фракции (BGS): словарь для вкладки «Фракции» карты Atlas. Источники — дамп EDSM systemsPopulated и журналы пилотов.';
COMMENT ON TABLE public.bgs_systems IS
  'Населённые системы с фракциями: принадлежность, правительство, контролирующая фракция, время наблюдения и источник.';
COMMENT ON TABLE public.bgs_faction_presence IS
  'Присутствие фракции в системе: влияние (0…1), состояние и списки состояний. Состав системы заменяется целиком более свежим наблюдением.';

-- ── Состояние импорта дампа EDSM: одна строка ─────────────────────────────

CREATE TABLE IF NOT EXISTS public.bgs_sync_state (
  id                 SMALLINT PRIMARY KEY DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'idle',
  source_url         TEXT,
  -- Заголовки дампа последнего удачного импорта: тот же дамп второй раз не качается.
  etag               TEXT,
  last_modified      TEXT,
  dump_generated_at  TIMESTAMPTZ,
  dump_bytes         BIGINT,
  run_id             UUID,
  systems_total      INTEGER NOT NULL DEFAULT 0,
  factions_total     INTEGER NOT NULL DEFAULT 0,
  presence_total     INTEGER NOT NULL DEFAULT 0,
  stats              JSONB NOT NULL DEFAULT '{}'::jsonb,
  error              TEXT,
  attempt_at         TIMESTAMPTZ,
  checked_at         TIMESTAMPTZ,
  synced_at          TIMESTAMPTZ,
  -- Ход последнего импорта (этапы, проценты) и журнал процесса для админки.
  progress           JSONB,
  log                JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bgs_sync_state_singleton CHECK (id = 1),
  CONSTRAINT bgs_sync_state_status_check CHECK (status IN ('idle', 'running', 'ok', 'error'))
);

INSERT INTO public.bgs_sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.bgs_sync_state ENABLE ROW LEVEL SECURITY;
-- Политик нет: состояние читает и пишет только сервер (service_role).
GRANT SELECT, INSERT, UPDATE ON public.bgs_sync_state TO service_role;

COMMENT ON TABLE public.bgs_sync_state IS
  'Импорт минорных фракций из дампа EDSM systemsPopulated: заголовки, счётчики, ход этапов и журнал процесса.';

-- ── Обновления от пилотов ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.bgs_updates (
  id           BIGSERIAL PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id      UUID,
  source       TEXT NOT NULL,
  received     INTEGER NOT NULL DEFAULT 0,
  applied      INTEGER NOT NULL DEFAULT 0,
  stale        INTEGER NOT NULL DEFAULT 0,
  created      INTEGER NOT NULL DEFAULT 0,
  invalid      INTEGER NOT NULL DEFAULT 0,
  -- Несколько обновлённых систем — для списка «последние обновления».
  systems      TEXT[] NOT NULL DEFAULT '{}',
  CONSTRAINT bgs_updates_source_check CHECK (source IN ('helper', 'web', 'eddn'))
);

CREATE INDEX IF NOT EXISTS idx_bgs_updates_received ON public.bgs_updates (received_at DESC);

ALTER TABLE public.bgs_updates ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON public.bgs_updates TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.bgs_updates_id_seq TO service_role;

COMMENT ON TABLE public.bgs_updates IS
  'Пачки наблюдений фракций от пилотов (Colonial Helper, загрузчик журналов на сайте): сколько пришло, применено и устарело.';

-- ── Разбор пачки наблюдений ───────────────────────────────────────────────
-- Одна система — одна строка (самое свежее наблюдение из пачки). Значения уже
-- проверены сервером (`src/lib/bgs.ts`), здесь — только приведение типов.

CREATE OR REPLACE FUNCTION public.bgs_parse_rows(p_rows JSONB)
RETURNS TABLE (
  id64            BIGINT,
  name            TEXT,
  x               DOUBLE PRECISION,
  y               DOUBLE PRECISION,
  z               DOUBLE PRECISION,
  allegiance      TEXT,
  government      TEXT,
  economy         TEXT,
  second_economy  TEXT,
  security        TEXT,
  state           TEXT,
  population      BIGINT,
  controlling_lc  TEXT,
  observed_at     TIMESTAMPTZ,
  factions        JSONB
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- Каждое приведение типа под CASE: одна кривая строка не должна ронять
  -- всю пачку (порядок вычисления условий WHERE планировщик не обещает).
  SELECT DISTINCT ON (r.id64)
    r.id64, r.name, r.x, r.y, r.z, r.allegiance, r.government, r.economy, r.second_economy,
    r.security, r.state, r.population, r.controlling_lc, r.observed_at, r.factions
  FROM (
    SELECT
      CASE WHEN (e.item->>'id64') ~ '^[0-9]{1,18}$' THEN (e.item->>'id64')::bigint END AS id64,
      btrim(e.item->>'name') AS name,
      CASE WHEN (e.item->>'x') ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$' THEN (e.item->>'x')::double precision END AS x,
      CASE WHEN (e.item->>'y') ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$' THEN (e.item->>'y')::double precision END AS y,
      CASE WHEN (e.item->>'z') ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$' THEN (e.item->>'z')::double precision END AS z,
      nullif(btrim(e.item->>'allegiance'), '') AS allegiance,
      nullif(btrim(e.item->>'government'), '') AS government,
      nullif(btrim(e.item->>'economy'), '') AS economy,
      nullif(btrim(e.item->>'second_economy'), '') AS second_economy,
      nullif(btrim(e.item->>'security'), '') AS security,
      nullif(btrim(e.item->>'state'), '') AS state,
      CASE WHEN (e.item->>'population') ~ '^[0-9]{1,18}$' THEN (e.item->>'population')::bigint END AS population,
      lower(nullif(btrim(e.item->>'controlling'), '')) AS controlling_lc,
      CASE WHEN (e.item->>'observed_at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$'
        THEN (e.item->>'observed_at')::timestamptz END AS observed_at,
      CASE WHEN jsonb_typeof(e.item->'factions') = 'array' THEN e.item->'factions' ELSE '[]'::jsonb END AS factions,
      e.ord
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) WITH ORDINALITY AS e(item, ord)
    WHERE jsonb_typeof(e.item) = 'object'
  ) r
  WHERE r.id64 IS NOT NULL AND r.id64 > 0
    AND r.name IS NOT NULL AND length(r.name) BETWEEN 1 AND 120
    AND r.x IS NOT NULL AND r.y IS NOT NULL AND r.z IS NOT NULL
  -- Свежее наблюдение побеждает; при равных — то, что в пачке позже.
  ORDER BY r.id64, r.observed_at DESC NULLS LAST, r.ord DESC;
$$;

-- ── Счётчики фракций ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bgs_recount_factions(p_ids BIGINT[] DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH ids AS (
    SELECT f.id FROM public.bgs_factions f WHERE p_ids IS NULL OR f.id = ANY (p_ids)
  ),
  presence AS (
    SELECT p.faction_id, count(*)::integer AS n
    FROM public.bgs_faction_presence p
    WHERE p_ids IS NULL OR p.faction_id = ANY (p_ids)
    GROUP BY p.faction_id
  ),
  controlled AS (
    SELECT s.controlling_faction_id AS faction_id, count(*)::integer AS n
    FROM public.bgs_systems s
    WHERE s.controlling_faction_id IS NOT NULL AND (p_ids IS NULL OR s.controlling_faction_id = ANY (p_ids))
    GROUP BY s.controlling_faction_id
  ),
  totals AS (
    SELECT ids.id, COALESCE(presence.n, 0) AS systems_n, COALESCE(controlled.n, 0) AS controlled_n
    FROM ids
    LEFT JOIN presence ON presence.faction_id = ids.id
    LEFT JOIN controlled ON controlled.faction_id = ids.id
  )
  UPDATE public.bgs_factions f
  SET systems_count = t.systems_n, controlled_count = t.controlled_n
  FROM totals t
  WHERE f.id = t.id AND (f.systems_count <> t.systems_n OR f.controlled_count <> t.controlled_n);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ── Применение пачки наблюдений (дамп EDSM и журналы пилотов) ─────────────
-- p_rows   — массив систем: id64, name, x, y, z, allegiance, government,
--            economy, second_economy, security, state, population,
--            controlling (имя фракции), observed_at, factions[{name,
--            allegiance, government, is_player, edsm_id, influence, state,
--            active_states[], pending_states[], recovering_states[], happiness}];
-- p_source — edsm | helper | web | eddn;
-- p_run    — импорт дампа: система помечается «видели в этом дампе», даже если
--            её данные не применились (у пилота наблюдение свежее);
-- p_recount — пересчитать счётчики затронутых фракций (импорт дампа делает это
--            один раз в конце).

CREATE OR REPLACE FUNCTION public.bgs_apply_snapshots(
  p_rows JSONB,
  p_source TEXT,
  p_run UUID DEFAULT NULL,
  p_recount BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_received   INTEGER := 0;
  v_ids        BIGINT[] := '{}';
  v_new_ids    BIGINT[] := '{}';
  v_old_ctrl   BIGINT[] := '{}';
  v_removed    BIGINT[] := '{}';
  v_touched    BIGINT[] := '{}';
  v_names      TEXT[] := '{}';
  v_factions   INTEGER := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'bgs_apply_snapshots: нужен массив систем';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('edsm', 'helper', 'web', 'eddn') THEN
    RAISE EXCEPTION 'bgs_apply_snapshots: неизвестный источник %', p_source;
  END IF;

  SELECT count(*) INTO v_received FROM public.bgs_parse_rows(p_rows);
  IF v_received = 0 THEN
    RETURN jsonb_build_object('received', 0, 'applied', 0, 'stale', 0, 'created', 0, 'factions_new', 0, 'systems', '[]'::jsonb);
  END IF;

  -- 1. Фракции из пачки: у известных уточняются принадлежность и
  --    правительство, новые добавляются. Флаг «фракция игроков» и id EDSM
  --    приходят только из дампа (у журнала их нет). Обновляется только то, что
  --    изменилось, а вставка не трогает уже известные имена — иначе каждый
  --    импорт сжигал бы значения последовательности id на десятки тысяч.
  WITH incoming AS (
    SELECT DISTINCT ON (lower(btrim(f.item->>'name')))
      btrim(f.item->>'name') AS name,
      lower(btrim(f.item->>'name')) AS name_lc,
      nullif(btrim(f.item->>'allegiance'), '') AS allegiance,
      nullif(btrim(f.item->>'government'), '') AS government,
      CASE WHEN f.item->>'is_player' IN ('true', 'false') THEN (f.item->>'is_player')::boolean END AS is_player,
      CASE WHEN (f.item->>'edsm_id') ~ '^[0-9]{1,18}$' THEN (f.item->>'edsm_id')::bigint END AS edsm_id
    FROM public.bgs_parse_rows(p_rows) s
    CROSS JOIN LATERAL jsonb_array_elements(s.factions) AS f(item)
    WHERE jsonb_typeof(f.item) = 'object'
      AND nullif(btrim(f.item->>'name'), '') IS NOT NULL
      AND length(btrim(f.item->>'name')) <= 160
    ORDER BY lower(btrim(f.item->>'name')), (f.item->>'edsm_id') IS NULL, s.observed_at DESC NULLS LAST
  )
  UPDATE public.bgs_factions t SET
    name       = i.name,
    allegiance = COALESCE(i.allegiance, t.allegiance),
    government = COALESCE(i.government, t.government),
    is_player  = COALESCE(i.is_player, t.is_player),
    edsm_id    = COALESCE(i.edsm_id, t.edsm_id),
    updated_at = now()
  FROM incoming i
  WHERE t.name_lc = i.name_lc
    AND (
      t.name IS DISTINCT FROM i.name
      OR (i.allegiance IS NOT NULL AND t.allegiance IS DISTINCT FROM i.allegiance)
      OR (i.government IS NOT NULL AND t.government IS DISTINCT FROM i.government)
      OR (i.is_player IS NOT NULL AND t.is_player IS DISTINCT FROM i.is_player)
      OR (i.edsm_id IS NOT NULL AND t.edsm_id IS DISTINCT FROM i.edsm_id)
    );

  WITH incoming AS (
    SELECT DISTINCT ON (lower(btrim(f.item->>'name')))
      btrim(f.item->>'name') AS name,
      lower(btrim(f.item->>'name')) AS name_lc,
      nullif(btrim(f.item->>'allegiance'), '') AS allegiance,
      nullif(btrim(f.item->>'government'), '') AS government,
      CASE WHEN f.item->>'is_player' IN ('true', 'false') THEN (f.item->>'is_player')::boolean END AS is_player,
      CASE WHEN (f.item->>'edsm_id') ~ '^[0-9]{1,18}$' THEN (f.item->>'edsm_id')::bigint END AS edsm_id
    FROM public.bgs_parse_rows(p_rows) s
    CROSS JOIN LATERAL jsonb_array_elements(s.factions) AS f(item)
    WHERE jsonb_typeof(f.item) = 'object'
      AND nullif(btrim(f.item->>'name'), '') IS NOT NULL
      AND length(btrim(f.item->>'name')) <= 160
    ORDER BY lower(btrim(f.item->>'name')), (f.item->>'edsm_id') IS NULL, s.observed_at DESC NULLS LAST
  ),
  inserted AS (
    INSERT INTO public.bgs_factions (name, name_lc, allegiance, government, is_player, edsm_id)
    SELECT i.name, i.name_lc, i.allegiance, i.government, COALESCE(i.is_player, false), i.edsm_id
    FROM incoming i
    WHERE NOT EXISTS (SELECT 1 FROM public.bgs_factions t WHERE t.name_lc = i.name_lc)
    ON CONFLICT (name_lc) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_factions FROM inserted;

  -- 2. Какие системы применяются: новых нет в таблице, у известных
  --    наблюдение не старше сохранённого.
  SELECT
    COALESCE(array_agg(s.id64), '{}'),
    COALESCE(array_agg(s.id64) FILTER (WHERE e.id64 IS NULL), '{}'),
    COALESCE(array_agg(s.name ORDER BY s.name), '{}')
  INTO v_ids, v_new_ids, v_names
  FROM public.bgs_parse_rows(p_rows) s
  LEFT JOIN public.bgs_systems e ON e.id64 = s.id64
  WHERE e.id64 IS NULL
     OR e.observed_at IS NULL
     OR (s.observed_at IS NOT NULL AND s.observed_at >= e.observed_at);

  SELECT COALESCE(array_agg(DISTINCT controlling_faction_id), '{}') INTO v_old_ctrl
  FROM public.bgs_systems
  WHERE id64 = ANY (v_ids) AND controlling_faction_id IS NOT NULL;

  -- 3. Сами системы.
  INSERT INTO public.bgs_systems AS t (
    id64, name, name_lc, x, y, z, allegiance, government, economy, second_economy, security, state,
    population, controlling_faction_id, observed_at, source, sync_run, updated_at
  )
  SELECT
    s.id64, s.name, lower(s.name), s.x, s.y, s.z, s.allegiance, s.government, s.economy, s.second_economy,
    s.security, s.state, s.population, f.id, s.observed_at, p_source, p_run, now()
  FROM public.bgs_parse_rows(p_rows) s
  LEFT JOIN public.bgs_factions f ON f.name_lc = s.controlling_lc
  WHERE s.id64 = ANY (v_ids)
  ON CONFLICT (id64) DO UPDATE SET
    name                   = EXCLUDED.name,
    name_lc                = EXCLUDED.name_lc,
    x                      = EXCLUDED.x,
    y                      = EXCLUDED.y,
    z                      = EXCLUDED.z,
    allegiance             = EXCLUDED.allegiance,
    government             = EXCLUDED.government,
    economy                = COALESCE(EXCLUDED.economy, t.economy),
    second_economy         = COALESCE(EXCLUDED.second_economy, t.second_economy),
    security               = COALESCE(EXCLUDED.security, t.security),
    state                  = EXCLUDED.state,
    population             = COALESCE(EXCLUDED.population, t.population),
    controlling_faction_id = EXCLUDED.controlling_faction_id,
    observed_at            = EXCLUDED.observed_at,
    source                 = EXCLUDED.source,
    sync_run               = COALESCE(p_run, t.sync_run),
    updated_at             = now();

  -- Импорт дампа: система была в дампе, даже если у пилота данные свежее —
  -- в конце импорта её нельзя удалять как «пропавшую».
  IF p_run IS NOT NULL THEN
    UPDATE public.bgs_systems t
    SET sync_run = p_run
    FROM public.bgs_parse_rows(p_rows) s
    WHERE t.id64 = s.id64 AND t.sync_run IS DISTINCT FROM p_run;
  END IF;

  -- 4. Состав фракций применённых систем заменяется целиком.
  WITH incoming AS (
    SELECT DISTINCT ON (s.id64, f.id) s.id64 AS system_id64, f.id AS faction_id
    FROM public.bgs_parse_rows(p_rows) s
    CROSS JOIN LATERAL jsonb_array_elements(s.factions) AS fe(item)
    JOIN public.bgs_factions f ON f.name_lc = lower(btrim(fe.item->>'name'))
    WHERE s.id64 = ANY (v_ids) AND jsonb_typeof(fe.item) = 'object'
  ),
  removed AS (
    DELETE FROM public.bgs_faction_presence p
    WHERE p.system_id64 = ANY (v_ids)
      AND NOT EXISTS (
        SELECT 1 FROM incoming i WHERE i.system_id64 = p.system_id64 AND i.faction_id = p.faction_id
      )
    RETURNING p.faction_id
  )
  SELECT COALESCE(array_agg(DISTINCT faction_id), '{}') INTO v_removed FROM removed;

  INSERT INTO public.bgs_faction_presence AS t (
    system_id64, faction_id, influence, state, active_states, pending_states, recovering_states, happiness, updated_at
  )
  SELECT DISTINCT ON (s.id64, f.id)
    s.id64,
    f.id,
    CASE WHEN (fe.item->>'influence') ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$'
      THEN greatest(0, least(1, (fe.item->>'influence')::real)) END,
    nullif(btrim(fe.item->>'state'), ''),
    CASE WHEN jsonb_typeof(fe.item->'active_states') = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(fe.item->'active_states')) ELSE '{}'::text[] END,
    CASE WHEN jsonb_typeof(fe.item->'pending_states') = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(fe.item->'pending_states')) ELSE '{}'::text[] END,
    CASE WHEN jsonb_typeof(fe.item->'recovering_states') = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(fe.item->'recovering_states')) ELSE '{}'::text[] END,
    nullif(btrim(fe.item->>'happiness'), ''),
    now()
  FROM public.bgs_parse_rows(p_rows) s
  CROSS JOIN LATERAL jsonb_array_elements(s.factions) AS fe(item)
  JOIN public.bgs_factions f ON f.name_lc = lower(btrim(fe.item->>'name'))
  WHERE s.id64 = ANY (v_ids) AND jsonb_typeof(fe.item) = 'object'
  ORDER BY s.id64, f.id
  ON CONFLICT (system_id64, faction_id) DO UPDATE SET
    influence         = EXCLUDED.influence,
    state             = EXCLUDED.state,
    active_states     = EXCLUDED.active_states,
    pending_states    = EXCLUDED.pending_states,
    recovering_states = EXCLUDED.recovering_states,
    happiness         = EXCLUDED.happiness,
    updated_at        = now();

  UPDATE public.bgs_systems t
  SET factions_count = c.n
  FROM (
    SELECT ids.id64, COALESCE(counted.n, 0) AS n
    FROM unnest(v_ids) AS ids(id64)
    LEFT JOIN (
      SELECT p.system_id64, count(*)::integer AS n
      FROM public.bgs_faction_presence p
      WHERE p.system_id64 = ANY (v_ids)
      GROUP BY p.system_id64
    ) counted ON counted.system_id64 = ids.id64
  ) c
  WHERE t.id64 = c.id64 AND t.factions_count IS DISTINCT FROM c.n;

  -- 5. Счётчики фракций: пришедших, ушедших из систем и прежних хозяев систем.
  IF p_recount THEN
    SELECT COALESCE(array_agg(DISTINCT f.id), '{}') INTO v_touched
    FROM public.bgs_parse_rows(p_rows) s
    CROSS JOIN LATERAL jsonb_array_elements(s.factions) AS fe(item)
    JOIN public.bgs_factions f ON f.name_lc = lower(btrim(fe.item->>'name'))
    WHERE s.id64 = ANY (v_ids) AND jsonb_typeof(fe.item) = 'object';
    PERFORM public.bgs_recount_factions(v_touched || v_removed || v_old_ctrl);
  END IF;

  RETURN jsonb_build_object(
    'received', v_received,
    'applied', COALESCE(array_length(v_ids, 1), 0),
    'stale', v_received - COALESCE(array_length(v_ids, 1), 0),
    'created', COALESCE(array_length(v_new_ids, 1), 0),
    'factions_new', v_factions,
    'systems', to_jsonb(v_names[1:20])
  );
END;
$$;

-- ── Завершение импорта дампа ─────────────────────────────────────────────
-- PostgREST даёт запросу лишь несколько секунд (statement_timeout), поэтому
-- завершение — несколько коротких вызовов, которые сервер повторяет в цикле:
--   1. bgs_delete_missing      — удалить системы, которых не было в новом дампе,
--                                если пилоты не присылали их p_keep_days дней
--                                (депопуляция, скрытые EDSM системы), пачкой;
--   2. bgs_recount_factions_batch — пересчитать счётчики фракций пачкой по id;
--   3. bgs_prune_factions      — удалить фракции без систем, пачкой;
--   4. bgs_finish_sync         — записать состояние и итоговые числа.

CREATE OR REPLACE FUNCTION public.bgs_delete_missing(
  p_run UUID,
  p_keep_days INTEGER DEFAULT 30,
  p_limit INTEGER DEFAULT 2000
)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_run IS NULL THEN
    RAISE EXCEPTION 'bgs_delete_missing: нужен идентификатор импорта';
  END IF;
  -- Пустой импорт не должен стереть карту: такой дамп отсекается ещё в коде,
  -- здесь — последняя страховка.
  IF NOT EXISTS (SELECT 1 FROM public.bgs_systems WHERE sync_run = p_run) THEN
    RAISE EXCEPTION 'bgs_delete_missing: импорт % не записал ни одной системы', p_run;
  END IF;

  WITH doomed AS (
    SELECT s.id64
    FROM public.bgs_systems s
    WHERE s.sync_run IS DISTINCT FROM p_run
      AND (
        s.source = 'edsm'
        OR s.observed_at IS NULL
        OR s.observed_at < now() - make_interval(days => greatest(1, COALESCE(p_keep_days, 30)))
      )
    LIMIT greatest(1, COALESCE(p_limit, 2000))
  )
  DELETE FROM public.bgs_systems s
  USING doomed d
  WHERE s.id64 = d.id64;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.bgs_recount_factions_batch(p_after BIGINT DEFAULT 0, p_limit INTEGER DEFAULT 5000)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_ids     BIGINT[];
  v_changed INTEGER;
BEGIN
  -- Следующие p_limit фракций по id (keyset): дыры в последовательности id не
  -- превращаются в тысячи пустых вызовов.
  SELECT array_agg(page.id ORDER BY page.id) INTO v_ids
  FROM (
    SELECT f.id FROM public.bgs_factions f
    WHERE f.id > COALESCE(p_after, 0)
    ORDER BY f.id
    LIMIT greatest(1, COALESCE(p_limit, 5000))
  ) page;
  IF v_ids IS NULL THEN
    RETURN jsonb_build_object('rows', 0, 'changed', 0, 'last_id', NULL);
  END IF;
  v_changed := public.bgs_recount_factions(v_ids);
  RETURN jsonb_build_object('rows', array_length(v_ids, 1), 'changed', v_changed, 'last_id', v_ids[array_length(v_ids, 1)]);
END;
$$;

CREATE OR REPLACE FUNCTION public.bgs_prune_factions(p_limit INTEGER DEFAULT 5000)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH doomed AS (
    SELECT f.id
    FROM public.bgs_factions f
    WHERE f.systems_count = 0
      AND f.controlled_count = 0
      AND NOT EXISTS (SELECT 1 FROM public.bgs_faction_presence p WHERE p.faction_id = f.id)
      AND NOT EXISTS (SELECT 1 FROM public.bgs_systems s WHERE s.controlling_faction_id = f.id)
    LIMIT greatest(1, COALESCE(p_limit, 5000))
  )
  DELETE FROM public.bgs_factions f
  USING doomed d
  WHERE f.id = d.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.bgs_finish_sync(p_run UUID, p_state JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_systems  INTEGER;
  v_factions INTEGER;
  v_presence INTEGER;
  v_state    JSONB := COALESCE(p_state, '{}'::jsonb);
BEGIN
  IF p_run IS NULL THEN
    RAISE EXCEPTION 'bgs_finish_sync: нужен идентификатор импорта';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bgs_systems WHERE sync_run = p_run) THEN
    RAISE EXCEPTION 'bgs_finish_sync: импорт % не записал ни одной системы', p_run;
  END IF;

  SELECT count(*) INTO v_systems FROM public.bgs_systems;
  SELECT count(*) INTO v_factions FROM public.bgs_factions;
  SELECT count(*) INTO v_presence FROM public.bgs_faction_presence;

  INSERT INTO public.bgs_sync_state AS st (id, status, run_id, systems_total, factions_total, presence_total,
                                           synced_at, checked_at, error, updated_at)
  VALUES (1, 'ok', p_run, v_systems, v_factions, v_presence, now(), now(), NULL, now())
  ON CONFLICT (id) DO UPDATE SET
    status = 'ok', run_id = p_run, systems_total = v_systems, factions_total = v_factions,
    presence_total = v_presence, synced_at = now(), checked_at = now(), error = NULL, updated_at = now();

  UPDATE public.bgs_sync_state SET
    source_url        = COALESCE(v_state->>'source_url', source_url),
    etag              = v_state->>'etag',
    last_modified     = v_state->>'last_modified',
    dump_generated_at = (v_state->>'dump_generated_at')::timestamptz,
    dump_bytes        = (v_state->>'dump_bytes')::bigint,
    stats             = COALESCE(v_state->'stats', '{}'::jsonb)
  WHERE id = 1;

  RETURN jsonb_build_object('systems', v_systems, 'factions', v_factions, 'presence', v_presence);
END;
$$;

-- ── Слой карты одной выборкой ─────────────────────────────────────────────
-- PostgREST режет обычные выборки по max_rows; десятки тысяч систем приходят
-- одним JSON. Порядок — по имени: панель Atlas не сортирует их в браузере.

CREATE OR REPLACE FUNCTION public.bgs_layer_rows()
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    json_agg(
      json_build_array(
        s.id64::text, s.name, s.x, s.y, s.z, s.allegiance, s.government,
        s.controlling_faction_id, f.name, s.population, s.factions_count,
        floor(extract(epoch FROM s.observed_at))::bigint, s.source
      )
      ORDER BY s.name_lc, s.id64
    ),
    '[]'::json
  )
  FROM public.bgs_systems s
  LEFT JOIN public.bgs_factions f ON f.id = s.controlling_faction_id;
$$;

-- ── Поиск фракций по имени ────────────────────────────────────────────────
-- Сначала точное совпадение, затем начало имени, затем вхождение; внутри —
-- по числу систем. Пустой запрос — самые распространённые фракции.

CREATE OR REPLACE FUNCTION public.bgs_search_factions(
  p_query TEXT,
  p_limit INTEGER DEFAULT 20,
  p_player BOOLEAN DEFAULT false
)
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH q AS (
    SELECT
      lower(btrim(COALESCE(p_query, ''))) AS q,
      replace(replace(replace(lower(btrim(COALESCE(p_query, ''))), '\', '\\'), '%', '\%'), '_', '\_') AS pattern
  )
  SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json)
  FROM (
    SELECT
      f.id, f.name, f.allegiance, f.government, f.is_player,
      f.systems_count AS systems, f.controlled_count AS controlled
    FROM public.bgs_factions f, q
    WHERE (q.q = '' OR f.name_lc LIKE '%' || q.pattern || '%')
      AND (NOT COALESCE(p_player, false) OR f.is_player)
      AND f.systems_count > 0
    ORDER BY
      (q.q <> '' AND f.name_lc = q.q) DESC,
      (q.q <> '' AND f.name_lc LIKE q.pattern || '%') DESC,
      f.systems_count DESC,
      f.name_lc
    LIMIT greatest(1, least(COALESCE(p_limit, 20), 50))
  ) r;
$$;

-- ── Присутствие выбранных фракций ─────────────────────────────────────────
-- Кортеж системы: [id64, имя, x, y, z, влияние, состояние, контролирует,
-- наблюдение (unix-секунды), активные, ожидающие, затухающие, настроение,
-- население, принадлежность системы].

CREATE OR REPLACE FUNCTION public.bgs_faction_presence_rows(p_ids BIGINT[])
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    json_agg(
      json_build_object(
        'id', f.id,
        'name', f.name,
        'allegiance', f.allegiance,
        'government', f.government,
        'is_player', f.is_player,
        'systems_count', f.systems_count,
        'controlled_count', f.controlled_count,
        'systems', COALESCE((
          SELECT json_agg(
            json_build_array(
              s.id64::text, s.name, s.x, s.y, s.z, p.influence, p.state,
              s.controlling_faction_id IS NOT DISTINCT FROM f.id,
              floor(extract(epoch FROM s.observed_at))::bigint,
              p.active_states, p.pending_states, p.recovering_states, p.happiness,
              s.population, s.allegiance
            )
            ORDER BY p.influence DESC NULLS LAST, s.name_lc
          )
          FROM public.bgs_faction_presence p
          JOIN public.bgs_systems s ON s.id64 = p.system_id64
          WHERE p.faction_id = f.id
        ), '[]'::json)
      )
      ORDER BY array_position(p_ids, f.id)
    ),
    '[]'::json
  )
  FROM public.bgs_factions f
  WHERE f.id = ANY (COALESCE(p_ids, '{}'::bigint[]));
$$;

-- ── Карточка системы ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bgs_system_detail(p_id64 BIGINT)
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT json_build_object(
    'system', (
      SELECT row_to_json(sys)
      FROM (
        SELECT
          s.id64::text AS id64, s.name, s.x, s.y, s.z, s.allegiance, s.government, s.economy,
          s.second_economy, s.security, s.state, s.population, s.controlling_faction_id,
          f.name AS controlling_faction, s.factions_count, s.observed_at, s.source, s.updated_at
        FROM public.bgs_systems s
        LEFT JOIN public.bgs_factions f ON f.id = s.controlling_faction_id
        WHERE s.id64 = p_id64
      ) sys
    ),
    'factions', COALESCE((
      SELECT json_agg(
        json_build_object(
          'id', f.id, 'name', f.name, 'allegiance', f.allegiance, 'government', f.government,
          'is_player', f.is_player, 'influence', p.influence, 'state', p.state,
          'active_states', p.active_states, 'pending_states', p.pending_states,
          'recovering_states', p.recovering_states, 'happiness', p.happiness,
          'systems_count', f.systems_count, 'controlled_count', f.controlled_count
        )
        ORDER BY p.influence DESC NULLS LAST, f.name_lc
      )
      FROM public.bgs_faction_presence p
      JOIN public.bgs_factions f ON f.id = p.faction_id
      WHERE p.system_id64 = p_id64
    ), '[]'::json)
  );
$$;

-- ── Сводка для админки ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bgs_admin_summary()
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT json_build_object(
    'systems', (SELECT count(*) FROM public.bgs_systems),
    'factions', (SELECT count(*) FROM public.bgs_factions),
    'player_factions', (SELECT count(*) FROM public.bgs_factions WHERE is_player),
    'presence', (SELECT count(*) FROM public.bgs_faction_presence),
    'allegiances', COALESCE((
      SELECT json_object_agg(a.allegiance, a.n)
      FROM (
        SELECT COALESCE(allegiance, 'None') AS allegiance, count(*) AS n
        FROM public.bgs_systems GROUP BY 1
      ) a
    ), '{}'::json),
    'sources', COALESCE((
      SELECT json_object_agg(src.source, src.n)
      FROM (SELECT source, count(*) AS n FROM public.bgs_systems GROUP BY 1) src
    ), '{}'::json),
    'oldest_observation', (SELECT min(observed_at) FROM public.bgs_systems),
    'newest_observation', (SELECT max(observed_at) FROM public.bgs_systems),
    'fresh_7d', (SELECT count(*) FROM public.bgs_systems WHERE observed_at > now() - interval '7 days'),
    'updates_24h', (SELECT count(*) FROM public.bgs_updates WHERE received_at > now() - interval '24 hours'),
    'applied_24h', (SELECT COALESCE(sum(applied), 0) FROM public.bgs_updates WHERE received_at > now() - interval '24 hours'),
    'updates_7d', (SELECT count(*) FROM public.bgs_updates WHERE received_at > now() - interval '7 days'),
    'applied_7d', (SELECT COALESCE(sum(applied), 0) FROM public.bgs_updates WHERE received_at > now() - interval '7 days'),
    'reporters_7d', (SELECT count(DISTINCT user_id) FROM public.bgs_updates WHERE received_at > now() - interval '7 days'),
    'last_update', (SELECT max(received_at) FROM public.bgs_updates)
  );
$$;

-- Импорт, выборки слоя и сводка — только сервером (service_role); клиенты идут через API.
REVOKE ALL ON FUNCTION
  public.bgs_parse_rows(JSONB),
  public.bgs_recount_factions(BIGINT[]),
  public.bgs_apply_snapshots(JSONB, TEXT, UUID, BOOLEAN),
  public.bgs_delete_missing(UUID, INTEGER, INTEGER),
  public.bgs_recount_factions_batch(BIGINT, INTEGER),
  public.bgs_prune_factions(INTEGER),
  public.bgs_finish_sync(UUID, JSONB),
  public.bgs_layer_rows(),
  public.bgs_search_factions(TEXT, INTEGER, BOOLEAN),
  public.bgs_faction_presence_rows(BIGINT[]),
  public.bgs_system_detail(BIGINT),
  public.bgs_admin_summary()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.bgs_parse_rows(JSONB),
  public.bgs_recount_factions(BIGINT[]),
  public.bgs_apply_snapshots(JSONB, TEXT, UUID, BOOLEAN),
  public.bgs_delete_missing(UUID, INTEGER, INTEGER),
  public.bgs_recount_factions_batch(BIGINT, INTEGER),
  public.bgs_prune_factions(INTEGER),
  public.bgs_finish_sync(UUID, JSONB),
  public.bgs_layer_rows(),
  public.bgs_search_factions(TEXT, INTEGER, BOOLEAN),
  public.bgs_faction_presence_rows(BIGINT[]),
  public.bgs_system_detail(BIGINT),
  public.bgs_admin_summary()
  TO service_role;

NOTIFY pgrst, 'reload schema';


-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261020120000_unified_system_data.sql              │
-- └────────────────────────────────────────────────────────────────┘

-- ══════════════════════════════════════════════════════════════════════════
-- Единый механизм данных о системах (web 2.22.0).
--
-- До этой миграции каждый раздел сайта держал свою картину одной и той же
-- звёздной системы: каталог, кольцо, проекты эскадрилий, «Проекты систем»,
-- Архитектор, станции, фракции, PowerPlay, авианосцы — и почти ничего не
-- знал о соседях. Здесь общие для всех разделов SQL-функции:
--
--   1. Индексы ключа системы `lower(btrim(system_name))` там, где их не было:
--      все разделы ищут систему одним ключом (`src/lib/systemIdentity.ts`).
--
--   2. PowerPlay из журналов пилотов. Одно наблюдение системы (FSDJump /
--      Location / CarrierJump) уже обновляло слой фракций; теперь то же
--      наблюдение обновляет и слой PowerPlay (`powerplay_apply_observations`).
--      Правило то же, что у фракций: побеждает более свежее наблюдение.
--      Ночной дамп EDSM больше не перетирает свежие данные пилотов, а
--      `Unoccupied` из журнала снимает систему со слоя (строка-отметка с
--      power_state = 'Unoccupied' не даёт более старому дампу её вернуть).
--
--   3. Прогресс системы одним правилом. `system_progress_sources(keys)` —
--      те же источники (кэш Raven + журнальные площадки), что у «Проектов
--      систем», но для любого набора систем: их читают карточка системы и
--      проекты эскадрилий, и проценты везде считаются одинаково
--      (`src/lib/architect/projectProgress.ts → buildSystemProgress`).
--
--   4. Журнал → проекты эскадрилий. `sync_project_systems_from_sites(keys)`
--      продвигает статус систем проектов (planned → building → done) по
--      площадкам из журнала, когда журнал прислал Helper или сайт, а не
--      только CAPI, как раньше. Только вперёд: ручной статус не откатывается.
--
--   5. Карточка системы. `system_overview_sources(key, id64, names, viewer)` —
--      всё, что проект знает о системе, одним запросом: каталог, Raven,
--      площадки, планы и архитектор, проекты обоих видов, кольцо, станции,
--      фракции, PowerPlay, цели сообщества, поставки и сканы.
--
-- Миграция идемпотентна (IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS
-- перед ADD CONSTRAINT): снимок full_schema.sql и повторный прогон
-- deploy/update-project.sh ничего не ломают.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1. Индексы ключа системы ──────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_system_progress_system_lc
  ON public.system_progress (lower(btrim(system_name)));
CREATE INDEX IF NOT EXISTS idx_project_systems_system_lc
  ON public.project_systems (lower(btrim(system_name)));
CREATE INDEX IF NOT EXISTS idx_hubs_system_lc
  ON public.hubs (lower(btrim(system_name)));
CREATE INDEX IF NOT EXISTS idx_community_goals_system_lc
  ON public.community_goals (lower(btrim(system_name)));

-- ── 2. PowerPlay из журналов пилотов ──────────────────────────────────────

ALTER TABLE public.powerplay_systems ADD COLUMN IF NOT EXISTS powers TEXT[];
ALTER TABLE public.powerplay_systems ADD COLUMN IF NOT EXISTS control_progress DOUBLE PRECISION;
ALTER TABLE public.powerplay_systems ADD COLUMN IF NOT EXISTS reinforcement BIGINT;
ALTER TABLE public.powerplay_systems ADD COLUMN IF NOT EXISTS undermining BIGINT;

COMMENT ON COLUMN public.powerplay_systems.powers IS
  'Державы в системе по журналу (Powers): контролирующая и те, что ведут захват. Дамп EDSM их не знает — NULL.';
COMMENT ON COLUMN public.powerplay_systems.control_progress IS
  'PowerplayStateControlProgress из журнала: доля шкалы контроля (у оплота может быть больше 1).';
COMMENT ON COLUMN public.powerplay_systems.reinforcement IS
  'PowerplayStateReinforcement из журнала: очки подкрепления за цикл.';
COMMENT ON COLUMN public.powerplay_systems.undermining IS
  'PowerplayStateUndermining из журнала: очки подрыва за цикл.';
COMMENT ON COLUMN public.powerplay_systems.source IS
  'Откуда наблюдение: edsm (ночной дамп), helper (Colonial Helper), web (журнал или CAPI через сайт), eddn.';

-- 'Unoccupied' — отметка «система больше не под контролем» из журнала: слой
-- её не показывает, а дамп с более старым наблюдением не возвращает.
ALTER TABLE public.powerplay_systems DROP CONSTRAINT IF EXISTS powerplay_systems_state_check;
ALTER TABLE public.powerplay_systems ADD CONSTRAINT powerplay_systems_state_check
  CHECK (power_state IN ('Stronghold', 'Fortified', 'Exploited', 'Unoccupied'));
ALTER TABLE public.powerplay_systems DROP CONSTRAINT IF EXISTS powerplay_systems_name_check;
ALTER TABLE public.powerplay_systems ADD CONSTRAINT powerplay_systems_name_check
  CHECK (
    length(name) BETWEEN 1 AND 120
    AND length(power) <= 64
    AND (power_state = 'Unoccupied' OR length(power) >= 1)
  );

CREATE INDEX IF NOT EXISTS idx_powerplay_systems_source
  ON public.powerplay_systems (source) WHERE source <> 'edsm';

-- Импорт дампа пачкой: свежее наблюдение пилота не перетирается.
CREATE OR REPLACE FUNCTION public.powerplay_apply_batch(p_run UUID, p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
  v_kept  INTEGER;
BEGIN
  IF p_run IS NULL OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'powerplay_apply_batch: нужны идентификатор импорта и массив строк';
  END IF;

  -- Журнал пилота новее дампа: строка остаётся как есть, но помечается этим
  -- импортом, чтобы его завершение её не удалило.
  WITH incoming AS (
    SELECT DISTINCT ON (r.id64) r.id64, r.observed_at
    FROM jsonb_to_recordset(p_rows) AS r(id64 BIGINT, observed_at TIMESTAMPTZ)
    WHERE r.id64 IS NOT NULL AND r.id64 > 0
    ORDER BY r.id64, r.observed_at DESC NULLS LAST
  )
  UPDATE public.powerplay_systems AS t
     SET sync_run = p_run
    FROM incoming AS i
   WHERE t.id64 = i.id64
     AND t.source <> 'edsm'
     AND t.observed_at IS NOT NULL
     AND (i.observed_at IS NULL OR t.observed_at > i.observed_at);
  GET DIAGNOSTICS v_kept = ROW_COUNT;

  INSERT INTO public.powerplay_systems AS t (
    id64, name, name_lc, x, y, z, power, power_state,
    allegiance, government, observed_at, source, sync_run, updated_at
  )
  SELECT DISTINCT ON (r.id64)
    r.id64, btrim(r.name), lower(btrim(r.name)), r.x, r.y, r.z, btrim(r.power), r.power_state,
    nullif(btrim(r.allegiance), ''), nullif(btrim(r.government), ''), r.observed_at, 'edsm', p_run, now()
  FROM jsonb_to_recordset(p_rows) AS r(
    id64 BIGINT, name TEXT, x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION,
    power TEXT, power_state TEXT, allegiance TEXT, government TEXT, observed_at TIMESTAMPTZ
  )
  WHERE r.id64 IS NOT NULL AND r.id64 > 0
    AND nullif(btrim(r.name), '') IS NOT NULL
    AND nullif(btrim(r.power), '') IS NOT NULL
    AND r.power_state IN ('Stronghold', 'Fortified', 'Exploited')
    AND r.x IS NOT NULL AND r.y IS NOT NULL AND r.z IS NOT NULL
  ORDER BY r.id64, r.observed_at DESC NULLS LAST
  ON CONFLICT (id64) DO UPDATE SET
    name             = EXCLUDED.name,
    name_lc          = EXCLUDED.name_lc,
    x                = EXCLUDED.x,
    y                = EXCLUDED.y,
    z                = EXCLUDED.z,
    power            = EXCLUDED.power,
    power_state      = EXCLUDED.power_state,
    allegiance       = EXCLUDED.allegiance,
    government       = EXCLUDED.government,
    -- Счётчики журнала дамп не знает: после более свежего дампа они устарели.
    powers           = NULL,
    control_progress = NULL,
    reinforcement    = NULL,
    undermining      = NULL,
    observed_at      = EXCLUDED.observed_at,
    source           = EXCLUDED.source,
    sync_run         = EXCLUDED.sync_run,
    updated_at       = CASE
      WHEN (t.power, t.power_state, t.name, t.x, t.y, t.z)
           IS DISTINCT FROM (EXCLUDED.power, EXCLUDED.power_state, EXCLUDED.name, EXCLUDED.x, EXCLUDED.y, EXCLUDED.z)
      THEN now()
      ELSE t.updated_at
    END
  WHERE NOT (
    t.source <> 'edsm'
    AND t.observed_at IS NOT NULL
    AND (EXCLUDED.observed_at IS NULL OR t.observed_at > EXCLUDED.observed_at)
  );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count + v_kept;
END;
$$;

-- Завершение импорта: пропавшее из дампа удаляется, кроме наблюдений пилотов,
-- которые новее самого дампа (дамп о них ещё не знает).
CREATE OR REPLACE FUNCTION public.powerplay_finish_sync(p_run UUID, p_state JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
  v_total   INTEGER;
  v_state   JSONB := COALESCE(p_state, '{}'::jsonb);
  v_dump_at TIMESTAMPTZ;
BEGIN
  IF p_run IS NULL THEN
    RAISE EXCEPTION 'powerplay_finish_sync: нужен идентификатор импорта';
  END IF;
  -- Пустой импорт не должен стереть карту: такой дамп отсекается ещё в коде,
  -- здесь — последняя страховка.
  IF NOT EXISTS (SELECT 1 FROM public.powerplay_systems WHERE sync_run = p_run) THEN
    RAISE EXCEPTION 'powerplay_finish_sync: импорт % не записал ни одной системы', p_run;
  END IF;

  BEGIN
    v_dump_at := nullif(v_state->>'dump_generated_at', '')::timestamptz;
  EXCEPTION WHEN others THEN
    v_dump_at := NULL;
  END;

  DELETE FROM public.powerplay_systems
   WHERE sync_run IS DISTINCT FROM p_run
     AND NOT (
       source <> 'edsm'
       AND observed_at IS NOT NULL
       AND observed_at > COALESCE(v_dump_at, now() - interval '1 day')
     );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  SELECT count(*) INTO v_total FROM public.powerplay_systems WHERE power_state <> 'Unoccupied';

  INSERT INTO public.powerplay_sync_state AS s (id, status, run_id, rows_total, synced_at, checked_at, error, updated_at)
  VALUES (1, 'ok', p_run, v_total, now(), now(), NULL, now())
  ON CONFLICT (id) DO UPDATE SET
    status = 'ok', run_id = p_run, rows_total = v_total,
    synced_at = now(), checked_at = now(), error = NULL, updated_at = now();

  UPDATE public.powerplay_sync_state SET
    source_url        = COALESCE(v_state->>'source_url', source_url),
    etag              = v_state->>'etag',
    last_modified     = v_state->>'last_modified',
    dump_generated_at = v_dump_at,
    stats             = COALESCE(v_state->'stats', '{}'::jsonb) || jsonb_build_object('deleted', v_deleted)
  WHERE id = 1;

  RETURN jsonb_build_object('deleted', v_deleted, 'total', v_total);
END;
$$;

-- Слой карты: только системы под контролем.
CREATE OR REPLACE FUNCTION public.powerplay_layer_rows()
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    json_agg(
      json_build_array(
        s.id64::text, s.name, s.x, s.y, s.z, s.power, s.power_state,
        floor(extract(epoch FROM s.observed_at))::bigint
      )
      ORDER BY s.name_lc, s.id64
    ),
    '[]'::json
  )
  FROM public.powerplay_systems s
  WHERE s.power_state <> 'Unoccupied';
$$;

-- Сводка для админки: системы под контролем и откуда пришли данные.
CREATE OR REPLACE FUNCTION public.powerplay_admin_summary()
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT json_build_object(
    'total', (SELECT count(*) FROM public.powerplay_systems WHERE power_state <> 'Unoccupied'),
    'powers', COALESCE((
      SELECT json_agg(
        json_build_object(
          'power', p.power,
          'Stronghold', p.stronghold,
          'Fortified', p.fortified,
          'Exploited', p.exploited,
          'total', p.total
        )
        ORDER BY p.total DESC, p.power
      )
      FROM (
        SELECT
          s.power,
          count(*) FILTER (WHERE s.power_state = 'Stronghold') AS stronghold,
          count(*) FILTER (WHERE s.power_state = 'Fortified') AS fortified,
          count(*) FILTER (WHERE s.power_state = 'Exploited') AS exploited,
          count(*) AS total
        FROM public.powerplay_systems s
        WHERE s.power_state <> 'Unoccupied'
        GROUP BY s.power
      ) p
    ), '[]'::json),
    'sources', COALESCE((
      SELECT json_object_agg(src.source, src.n)
      FROM (
        SELECT source, count(*) AS n
        FROM public.powerplay_systems
        WHERE power_state <> 'Unoccupied'
        GROUP BY 1
      ) src
    ), '{}'::json),
    'vacated', (SELECT count(*) FROM public.powerplay_systems WHERE power_state = 'Unoccupied'),
    'oldest_observation', (SELECT min(observed_at) FROM public.powerplay_systems WHERE power_state <> 'Unoccupied'),
    'newest_observation', (SELECT max(observed_at) FROM public.powerplay_systems WHERE power_state <> 'Unoccupied'),
    'last_change', (SELECT max(updated_at) FROM public.powerplay_systems)
  );
$$;

-- Наблюдения пилотов (Helper, сайт, CAPI через сайт) → слой PowerPlay.
-- Возвращает счётчики для ответа маршрута и журнала админки.
CREATE OR REPLACE FUNCTION public.powerplay_apply_observations(p_rows JSONB, p_source TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_dump_at  TIMESTAMPTZ;
  v_row      RECORD;
  v_existing RECORD;
  v_received INTEGER := 0;
  v_applied  INTEGER := 0;
  v_stale    INTEGER := 0;
  v_created  INTEGER := 0;
  v_vacated  INTEGER := 0;
  v_systems  TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('helper', 'web', 'eddn') THEN
    RAISE EXCEPTION 'powerplay_apply_observations: неизвестный источник %', p_source;
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'powerplay_apply_observations: нужен массив наблюдений';
  END IF;

  SELECT dump_generated_at INTO v_dump_at FROM public.powerplay_sync_state WHERE id = 1;

  FOR v_row IN
    SELECT DISTINCT ON (r.id64)
      r.id64,
      btrim(r.name) AS name,
      r.x, r.y, r.z,
      COALESCE(nullif(btrim(r.power), ''), '') AS power,
      r.power_state,
      r.powers,
      r.control_progress,
      r.reinforcement,
      r.undermining,
      nullif(btrim(r.allegiance), '') AS allegiance,
      nullif(btrim(r.government), '') AS government,
      r.observed_at
    FROM jsonb_to_recordset(p_rows) AS r(
      id64 BIGINT, name TEXT, x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION,
      power TEXT, power_state TEXT, powers TEXT[], control_progress DOUBLE PRECISION,
      reinforcement BIGINT, undermining BIGINT, allegiance TEXT, government TEXT, observed_at TIMESTAMPTZ
    )
    WHERE r.id64 IS NOT NULL AND r.id64 > 0
      AND nullif(btrim(r.name), '') IS NOT NULL
      AND length(btrim(r.name)) <= 120
      AND r.x IS NOT NULL AND r.y IS NOT NULL AND r.z IS NOT NULL
      AND r.observed_at IS NOT NULL
      -- PowerPlay 2.0 (29.10.2024): раньше те же поля значили другое.
      AND r.observed_at >= '2024-10-29T00:00:00Z'::timestamptz
      AND r.observed_at <= now() + interval '1 hour'
      AND (
        (r.power_state IN ('Stronghold', 'Fortified', 'Exploited')
          AND nullif(btrim(r.power), '') IS NOT NULL AND length(btrim(r.power)) <= 64)
        OR r.power_state = 'Unoccupied'
      )
    ORDER BY r.id64, r.observed_at DESC
  LOOP
    v_received := v_received + 1;

    SELECT s.observed_at, s.power_state INTO v_existing
      FROM public.powerplay_systems AS s
     WHERE s.id64 = v_row.id64
       FOR UPDATE;

    IF FOUND THEN
      IF v_existing.observed_at IS NOT NULL AND v_existing.observed_at >= v_row.observed_at THEN
        v_stale := v_stale + 1;
        CONTINUE;
      END IF;
      UPDATE public.powerplay_systems AS t SET
        name             = v_row.name,
        name_lc          = lower(v_row.name),
        x                = v_row.x,
        y                = v_row.y,
        z                = v_row.z,
        power            = v_row.power,
        power_state      = v_row.power_state,
        powers           = v_row.powers,
        control_progress = v_row.control_progress,
        reinforcement    = v_row.reinforcement,
        undermining      = v_row.undermining,
        allegiance       = COALESCE(v_row.allegiance, t.allegiance),
        government       = COALESCE(v_row.government, t.government),
        observed_at      = v_row.observed_at,
        source           = p_source,
        updated_at       = CASE
          WHEN (t.power, t.power_state, t.name, t.x, t.y, t.z)
               IS DISTINCT FROM (v_row.power, v_row.power_state, v_row.name, v_row.x, v_row.y, v_row.z)
          THEN now()
          ELSE t.updated_at
        END
      WHERE t.id64 = v_row.id64;
      v_applied := v_applied + 1;
      IF v_row.power_state = 'Unoccupied' AND v_existing.power_state <> 'Unoccupied' THEN
        v_vacated := v_vacated + 1;
      END IF;
    ELSE
      -- Неизвестную систему добавляем только под контролем и только если
      -- наблюдение новее дампа: старый журнал не рисует на карте то, чего уже нет.
      IF v_row.power_state = 'Unoccupied'
         OR (v_dump_at IS NOT NULL AND v_row.observed_at <= v_dump_at) THEN
        v_stale := v_stale + 1;
        CONTINUE;
      END IF;
      INSERT INTO public.powerplay_systems (
        id64, name, name_lc, x, y, z, power, power_state, powers, control_progress,
        reinforcement, undermining, allegiance, government, observed_at, source, sync_run, updated_at
      ) VALUES (
        v_row.id64, v_row.name, lower(v_row.name), v_row.x, v_row.y, v_row.z, v_row.power, v_row.power_state,
        v_row.powers, v_row.control_progress, v_row.reinforcement, v_row.undermining,
        v_row.allegiance, v_row.government, v_row.observed_at, p_source, NULL, now()
      );
      v_applied := v_applied + 1;
      v_created := v_created + 1;
    END IF;

    IF array_length(v_systems, 1) IS NULL OR array_length(v_systems, 1) < 20 THEN
      v_systems := array_append(v_systems, v_row.name);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'received', v_received,
    'applied', v_applied,
    'stale', v_stale,
    'created', v_created,
    'vacated', v_vacated,
    'systems', to_jsonb(v_systems)
  );
END;
$$;

COMMENT ON FUNCTION public.powerplay_apply_observations(JSONB, TEXT) IS
  'PowerPlay из журналов пилотов: применяется только наблюдение новее сохранённого; новая система — только если новее дампа.';

-- ── 3. Прогресс любых систем одним правилом ───────────────────────────────

CREATE OR REPLACE FUNCTION public.system_progress_sources(p_keys TEXT[])
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH keys AS (
    SELECT DISTINCT lower(btrim(k)) AS key
      FROM unnest(COALESCE(p_keys, ARRAY[]::TEXT[])) AS k
     WHERE nullif(btrim(k), '') IS NOT NULL
     LIMIT 1000
  )
  SELECT jsonb_build_object(
    'raven', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'system_key', keys.key,
               'system_name', sp.system_name,
               'progress', sp.progress,
               'updated_at', sp.updated_at,
               'data', sp.data))
        FROM keys
        JOIN public.system_progress AS sp
          ON lower(btrim(sp.system_name)) = keys.key
    ), '[]'::jsonb),
    'depots', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'system_key', keys.key,
               'market_id', cs.market_id::text,
               'system_name', cs.system_name,
               'construction_name', cs.construction_name,
               'construction_progress', cs.construction_progress,
               'resources_total', cs.resources_total,
               'event_timestamp', cs.event_timestamp))
        FROM keys
        JOIN public.colonisation_sites AS cs
          ON lower(btrim(cs.system_name)) = keys.key
    ), '[]'::jsonb)
  );
$$;

COMMENT ON FUNCTION public.system_progress_sources(TEXT[]) IS
  'Источники прогресса систем (кэш Raven + площадки из журнала) — те же, что у «Проектов систем», для любого набора систем.';

-- ── 4. Журнал → статусы систем в проектах эскадрилий ─────────────────────

CREATE OR REPLACE FUNCTION public.sync_project_systems_from_sites(p_keys TEXT[])
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_changed JSONB;
BEGIN
  WITH keys AS (
    SELECT DISTINCT lower(btrim(k)) AS key
      FROM unnest(COALESCE(p_keys, ARRAY[]::TEXT[])) AS k
     WHERE nullif(btrim(k), '') IS NOT NULL
     LIMIT 1000
  ),
  sites AS (
    SELECT keys.key,
           count(*) AS total,
           count(*) FILTER (WHERE cs.construction_progress >= 100) AS complete
      FROM keys
      JOIN public.colonisation_sites AS cs
        ON lower(btrim(cs.system_name)) = keys.key
     GROUP BY keys.key
  ),
  target AS (
    SELECT ps.id,
           CASE WHEN s.complete = s.total THEN 'done' ELSE 'building' END AS status
      FROM public.project_systems AS ps
      JOIN sites AS s ON lower(btrim(ps.system_name)) = s.key
  ),
  changed AS (
    UPDATE public.project_systems AS ps
       SET planned_status = t.status
      FROM target AS t
     WHERE ps.id = t.id
       -- Только вперёд: planned → building → done. Ручной статус не откатывается.
       AND (CASE ps.planned_status WHEN 'done' THEN 2 WHEN 'building' THEN 1 ELSE 0 END)
         < (CASE t.status WHEN 'done' THEN 2 WHEN 'building' THEN 1 ELSE 0 END)
    RETURNING ps.id, ps.project_id, ps.system_name, ps.planned_status
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', c.id,
           'project_id', c.project_id,
           'project_name', p.name,
           'system_name', c.system_name,
           'status', c.planned_status)), '[]'::jsonb)
    INTO v_changed
    FROM changed AS c
    JOIN public.projects AS p ON p.id = c.project_id;

  RETURN jsonb_build_object('changed', v_changed);
END;
$$;

COMMENT ON FUNCTION public.sync_project_systems_from_sites(TEXT[]) IS
  'Статус систем проектов эскадрилий по площадкам из журнала (Helper, сайт, CAPI): только вперёд planned → building → done.';

-- ── 5. Карточка системы одним запросом ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.system_overview_sources(
  p_key    TEXT,
  p_id64   TEXT DEFAULT NULL,
  p_names  TEXT[] DEFAULT NULL,
  p_viewer UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_key      TEXT := lower(btrim(COALESCE(p_key, '')));
  v_id64     TEXT := nullif(btrim(COALESCE(p_id64, '')), '');
  v_catalog  JSONB;
  v_names    TEXT[];
  v_bgs_id64 BIGINT;
  v_out      JSONB;
BEGIN
  -- Адрес системы — только цифры в пределах BIGINT, иначе ищем по имени.
  IF v_id64 IS NOT NULL AND (
       v_id64 !~ '^[0-9]{1,19}$'
       OR (length(v_id64) = 19 AND v_id64 > '9223372036854775807')
     ) THEN
    v_id64 := NULL;
  END IF;
  IF v_key = '' AND v_id64 IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  -- Каталог: по адресу системы, иначе по имени.
  SELECT to_jsonb(c) INTO v_catalog
    FROM (
      SELECT g.id64, g.name, g.x, g.y, g.z, g.main_star, g.star_type, g.star_giant_class,
             g.needs_permit, g.distance_from_sols, g.distance_from_sgra
        FROM public.galaxy_systems AS g
       WHERE (v_id64 IS NOT NULL AND g.id64 = v_id64)
          OR (v_key <> '' AND g.name_lc = v_key)
       ORDER BY (v_id64 IS NOT NULL AND g.id64 = v_id64) DESC
       LIMIT 1
    ) AS c;

  IF v_catalog IS NOT NULL THEN
    IF v_key = '' THEN v_key := lower(btrim(v_catalog->>'name')); END IF;
    IF v_id64 IS NULL THEN v_id64 := v_catalog->>'id64'; END IF;
  END IF;

  -- Точные написания имени: поставки и сканы хранят имя как в журнале.
  SELECT array_agg(DISTINCT n) INTO v_names
    FROM unnest(COALESCE(p_names, ARRAY[]::TEXT[]) || ARRAY[v_catalog->>'name']) AS n
   WHERE nullif(btrim(n), '') IS NOT NULL;
  v_names := COALESCE(v_names, ARRAY[]::TEXT[]);

  SELECT b.id64 INTO v_bgs_id64
    FROM public.bgs_systems AS b
   WHERE (v_id64 IS NOT NULL AND b.id64 = v_id64::BIGINT)
      OR (v_key <> '' AND b.name_lc = v_key)
   ORDER BY (v_id64 IS NOT NULL AND b.id64 = v_id64::BIGINT) DESC
   LIMIT 1;

  v_out := jsonb_build_object(
    'key', v_key,
    'id64', v_id64,
    'catalog', v_catalog,

    'raven', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'system_key', v_key, 'system_name', sp.system_name, 'progress', sp.progress,
               'updated_at', sp.updated_at, 'data', sp.data))
        FROM public.system_progress AS sp
       WHERE lower(btrim(sp.system_name)) = v_key
    ), '[]'::jsonb),

    'depots', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'system_key', v_key, 'market_id', cs.market_id::text, 'system_name', cs.system_name,
               'construction_name', cs.construction_name, 'construction_progress', cs.construction_progress,
               'resources_total', cs.resources_total, 'event_timestamp', cs.event_timestamp)
               ORDER BY cs.event_timestamp DESC)
        FROM public.colonisation_sites AS cs
       WHERE lower(btrim(cs.system_name)) = v_key
    ), '[]'::jsonb),

    -- Планы: опубликованные и свои (черновики «по ссылке» в списках не светятся).
    'plans', COALESCE((
      SELECT jsonb_agg(row_to_json(pl)::jsonb ORDER BY pl.updated_at DESC)
        FROM (
          SELECT p.id, p.system_name, p.title, p.author_id, p.author_name, p.visibility, p.site_count,
                 p.haul_tons, p.catalogue_version, p.updated_at, p.plan
            FROM public.system_plans AS p
           WHERE p.system_name_lc = v_key
             AND (p.visibility = 'public' OR (p_viewer IS NOT NULL AND p.author_id = p_viewer))
           ORDER BY p.updated_at DESC
           LIMIT 5
        ) AS pl
    ), '[]'::jsonb),

    'architect', (
      SELECT jsonb_build_object(
               'system_name', a.system_name, 'user_id', a.user_id, 'name', a.architect_name,
               'assigned_by_name', a.assigned_by_name, 'updated_at', a.updated_at)
        FROM public.system_architects AS a
       WHERE a.system_name_lc = v_key
       LIMIT 1
    ),

    'squadron_projects', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'project_id', p.id, 'name', p.name, 'status', p.status, 'color', p.color,
               'squadron_id', p.squadron_id, 'squadron_name', sq.name, 'squadron_tag', sq.tag,
               'system_status', ps.planned_status, 'priority', ps.priority,
               'target_date', ps.target_date, 'assigned_to', ps.assigned_to)
               ORDER BY p.created_at DESC)
        FROM public.project_systems AS ps
        JOIN public.projects AS p ON p.id = ps.project_id
        LEFT JOIN public.squadrons AS sq ON sq.id = p.squadron_id
       WHERE lower(btrim(ps.system_name)) = v_key
    ), '[]'::jsonb),

    -- «Проекты систем» закрыты для посторонних: имя видят участники, остальным — только число.
    'architect_projects', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'project_id', p.id, 'name', p.name, 'status', p.status, 'color', p.color,
               'stage', s.stage, 'priority', s.priority, 'target_date', s.target_date,
               'progress_summary', p.progress_summary, 'progress_at', p.progress_at,
               'is_member', (p_viewer IS NOT NULL AND EXISTS (
                 SELECT 1 FROM public.architect_project_members AS m
                  WHERE m.project_id = p.id AND m.user_id = p_viewer)))
               ORDER BY p.created_at DESC)
        FROM public.architect_project_systems AS s
        JOIN public.architect_projects AS p ON p.id = s.project_id
       WHERE s.system_name_lc = v_key
    ), '[]'::jsonb),

    'route', (
      SELECT jsonb_build_object(
               'id', rs.id, 'system_name', rs.system_name, 'sort_order', rs.sort_order,
               'status', rs.status, 'progress', rs.progress, 'x', rs.x, 'y', rs.y, 'z', rs.z)
        FROM public.route_systems AS rs
       WHERE lower(rs.system_name) = v_key
       LIMIT 1
    ),

    'hub', (
      SELECT jsonb_build_object(
               'id', h.id, 'name', h.name, 'system_name', h.system_name, 'status', h.status,
               'progress', h.progress, 'segment_order', h.segment_order, 'x', h.x, 'y', h.y, 'z', h.z)
        FROM public.hubs AS h
       WHERE lower(btrim(h.system_name)) = v_key
       LIMIT 1
    ),

    'stations', COALESCE((
      SELECT jsonb_agg(row_to_json(st)::jsonb ORDER BY st.observed_at DESC)
        FROM (
          SELECT sc.station_key, sc.market_id, sc.station_name, sc.station_type, sc.observed_at, sc.source,
                 sc.metadata->'distance_to_arrival' AS distance_to_arrival,
                 sc.metadata->'body_name' AS body_name,
                 sc.metadata->'services' AS services,
                 sc.metadata->'engineers' AS engineers,
                 (SELECT jsonb_object_agg(inv.kind, jsonb_build_object(
                           'observed_at', inv.observed_at,
                           'items', jsonb_array_length(inv.items),
                           'source', inv.source))
                    FROM public.station_inventory_snapshots AS inv
                   WHERE inv.station_key = sc.station_key) AS inventories
            FROM public.station_commerce AS sc
           WHERE sc.system_lc = v_key
           ORDER BY sc.observed_at DESC
           LIMIT 60
        ) AS st
    ), '[]'::jsonb),

    'powerplay', (
      SELECT jsonb_build_object(
               'id64', pp.id64::text, 'name', pp.name, 'power', pp.power, 'state', pp.power_state,
               'powers', pp.powers, 'control_progress', pp.control_progress,
               'reinforcement', pp.reinforcement, 'undermining', pp.undermining,
               'allegiance', pp.allegiance, 'government', pp.government,
               'observed_at', pp.observed_at, 'source', pp.source, 'updated_at', pp.updated_at)
        FROM public.powerplay_systems AS pp
       WHERE (v_id64 IS NOT NULL AND pp.id64 = v_id64::BIGINT)
          OR (v_key <> '' AND pp.name_lc = v_key)
       ORDER BY pp.observed_at DESC NULLS LAST
       LIMIT 1
    ),

    'factions', CASE WHEN v_bgs_id64 IS NULL THEN NULL ELSE public.bgs_system_detail(v_bgs_id64)::jsonb END,

    'goals', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'cg_id', cg.cg_id, 'title', cg.title, 'station_name', cg.station_name,
               'objective', cg.objective, 'tier_current', cg.tier_current, 'tier_max', cg.tier_max,
               'contributors', cg.contributors, 'expiry_date', cg.expiry_date,
               'is_complete', cg.is_complete, 'is_colonisation_related', cg.is_colonisation_related)
               ORDER BY cg.expiry_date DESC NULLS LAST)
        FROM public.community_goals AS cg
       WHERE lower(btrim(cg.system_name)) = v_key
         AND (cg.expiry_date IS NULL OR cg.expiry_date > now() - interval '30 days')
    ), '[]'::jsonb),

    -- Поставки: только суммы, без имён (приватность пилотов решает досье).
    'deliveries', (
      SELECT jsonb_build_object(
               'tons', COALESCE(sum(d.amount) FILTER (WHERE d.is_construction IS DISTINCT FROM false), 0),
               'pilots', count(DISTINCT d.user_id) FILTER (WHERE d.is_construction IS DISTINCT FROM false),
               'last_at', max(d.delivered_at) FILTER (WHERE d.is_construction IS DISTINCT FROM false))
        FROM public.deliveries AS d
       WHERE d.system_name = ANY (v_names)
    ),

    'scans', (
      SELECT jsonb_build_object('bodies', count(DISTINCT s.body_name), 'updated_at', max(s.updated_at))
        FROM public.system_scans AS s
       WHERE s.system_name = ANY (v_names)
    )
  );

  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public.system_overview_sources(TEXT, TEXT, TEXT[], UUID) IS
  'Карточка системы: всё, что проект знает о системе, одним запросом (каталог, колонизация, проекты, кольцо, станции, фракции, PowerPlay, цели, поставки).';

-- Всё это — только сервером (service_role): маршруты сами решают, что показать зрителю.
REVOKE ALL ON FUNCTION public.powerplay_apply_batch(UUID, JSONB),
  public.powerplay_finish_sync(UUID, JSONB),
  public.powerplay_layer_rows(),
  public.powerplay_admin_summary(),
  public.powerplay_apply_observations(JSONB, TEXT),
  public.system_progress_sources(TEXT[]),
  public.sync_project_systems_from_sites(TEXT[]),
  public.system_overview_sources(TEXT, TEXT, TEXT[], UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerplay_apply_batch(UUID, JSONB),
  public.powerplay_finish_sync(UUID, JSONB),
  public.powerplay_layer_rows(),
  public.powerplay_admin_summary(),
  public.powerplay_apply_observations(JSONB, TEXT),
  public.system_progress_sources(TEXT[]),
  public.sync_project_systems_from_sites(TEXT[]),
  public.system_overview_sources(TEXT, TEXT, TEXT[], UUID)
  TO service_role;

NOTIFY pgrst, 'reload schema';


-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261021120000_powerplay_owner.sql                  │
-- └────────────────────────────────────────────────────────────────┘

-- ══════════════════════════════════════════════════════════════════════════
-- PowerPlay: чья система на самом деле (web 2.23.0).
--
-- Ночной дамп EDSM `powerPlay.json.gz` — не «система и её держава», а
-- «система и каждая держава в ней». EDSM (EDSM-NET/EDDN-Events,
-- System/PowerPlay.php) пишет по строке на каждую державу из поля журнала
-- `Powers` — все, чьи зоны влияния накрывают систему, — с одним состоянием и
-- датой события, а `ControllingPower` (владельца) не хранит вовсе. Разбор до
-- web 2.23.0 оставлял у системы последнюю строку, и пограничье доставалось
-- державе с самым большим номером в EDSM: у Nakato Kaine (номер 13) на сайте
-- было 3 144 системы при 1 819 в игре, у Aisling Duval (номер 3) — 1 580 при
-- 3 121.
--
-- Теперь у строки слоя есть основание — откуда известен владелец
-- (`power_basis`):
--   journal — поле ControllingPower из журнала (Helper, сайт, CAPI, EDDN);
--   sole    — дамп перечисляет у системы одну державу: она и владелец;
--   kept    — дамп перечисляет несколько, и среди них прежний точный
--             владелец: смена владельца идёт через «свободную» систему
--             (Unoccupied), и такое наблюдение сняло бы строку со слоя;
--   unknown — дамп перечисляет несколько, владелец не определён (power NULL).
-- Державы, которые перечислил дамп, — в колонке `powers` (у журнала — его
-- собственный список `Powers`).
--
-- power теперь может быть NULL — не пустая строка: CHECK миграции
-- 20261020120000 (при повторном прогоне снимка full_schema.sql или
-- update-project.sh) пропускает NULL, но не ''. Старый код строки без
-- державы просто не показывает.
--
-- Миграция идемпотентна (IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS
-- перед ADD CONSTRAINT).
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.powerplay_systems ALTER COLUMN power DROP NOT NULL;
ALTER TABLE public.powerplay_systems ADD COLUMN IF NOT EXISTS power_basis TEXT;

-- Строки, записанные до этой миграции: журналы пилотов знают владельца
-- точно. Строки дампа остаются без основания (NULL) до следующей загрузки — она
-- начнётся сама: импорт старым разбором считается устаревшим
-- (`powerplay_sync_state.stats.parser`).
UPDATE public.powerplay_systems
   SET power_basis = 'journal'
 WHERE power_basis IS NULL
   AND source <> 'edsm'
   AND power_state <> 'Unoccupied'
   AND nullif(power, '') IS NOT NULL;

ALTER TABLE public.powerplay_systems DROP CONSTRAINT IF EXISTS powerplay_systems_basis_check;
ALTER TABLE public.powerplay_systems ADD CONSTRAINT powerplay_systems_basis_check
  CHECK (
    (power_basis IS NULL OR power_basis IN ('journal', 'sole', 'kept', 'unknown'))
    AND (power_basis IS DISTINCT FROM 'unknown' OR power IS NULL)
    AND (power IS NOT NULL OR power_basis = 'unknown')
  );

COMMENT ON COLUMN public.powerplay_systems.power IS
  'Держава-владелец, как её пишет журнал игры (ControllingPower): «A. Lavigny-Duval», «Jerome Archer» и т. д. NULL — владелец не определён (power_basis = unknown).';
COMMENT ON COLUMN public.powerplay_systems.power_basis IS
  'Откуда известен владелец: journal (ControllingPower из журнала), sole (в дампе EDSM одна держава), kept (прежний точный владелец всё ещё среди держав дампа), unknown (не определён). NULL — строка импорта до web 2.23.0.';
COMMENT ON COLUMN public.powerplay_systems.powers IS
  'Державы в системе (поле журнала Powers): владелец и те, чьи зоны влияния её накрывают. У строк дампа EDSM — державы, которые он перечислил.';

-- ── Импорт дампа пачкой ───────────────────────────────────────────────────
-- Строка пачки — система целиком (`powerplayDump.ts` собирает записи дампа):
-- power — владелец, если держава в дампе одна (иначе пусто), powers — все
-- державы, которые дамп перечислил. Старые вызовы без powers — одна держава.

CREATE OR REPLACE FUNCTION public.powerplay_apply_batch(p_run UUID, p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
  v_kept  INTEGER;
BEGIN
  IF p_run IS NULL OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'powerplay_apply_batch: нужны идентификатор импорта и массив строк';
  END IF;

  -- Журнал пилота новее дампа: строка остаётся как есть, но помечается этим
  -- импортом, чтобы его завершение её не удалило.
  WITH incoming AS (
    SELECT DISTINCT ON (r.id64) r.id64, r.observed_at
    FROM jsonb_to_recordset(p_rows) AS r(id64 BIGINT, observed_at TIMESTAMPTZ)
    WHERE r.id64 IS NOT NULL AND r.id64 > 0
    ORDER BY r.id64, r.observed_at DESC NULLS LAST
  )
  UPDATE public.powerplay_systems AS t
     SET sync_run = p_run
    FROM incoming AS i
   WHERE t.id64 = i.id64
     AND t.source <> 'edsm'
     AND t.observed_at IS NOT NULL
     AND (i.observed_at IS NULL OR t.observed_at > i.observed_at);
  GET DIAGNOSTICS v_kept = ROW_COUNT;

  WITH incoming AS (
    SELECT DISTINCT ON (r.id64)
      r.id64,
      btrim(r.name) AS name,
      r.x, r.y, r.z,
      nullif(btrim(r.power), '') AS power,
      r.power_state,
      COALESCE(
        (SELECT array_agg(DISTINCT btrim(p) ORDER BY btrim(p))
           FROM unnest(r.powers) AS p
          WHERE nullif(btrim(p), '') IS NOT NULL AND length(btrim(p)) <= 64),
        CASE WHEN nullif(btrim(r.power), '') IS NULL THEN NULL ELSE ARRAY[btrim(r.power)] END
      ) AS powers,
      nullif(btrim(r.allegiance), '') AS allegiance,
      nullif(btrim(r.government), '') AS government,
      r.observed_at
    FROM jsonb_to_recordset(p_rows) AS r(
      id64 BIGINT, name TEXT, x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION,
      power TEXT, power_state TEXT, powers TEXT[], allegiance TEXT, government TEXT, observed_at TIMESTAMPTZ
    )
    WHERE r.id64 IS NOT NULL AND r.id64 > 0
      AND nullif(btrim(r.name), '') IS NOT NULL
      AND length(btrim(r.name)) <= 120
      AND r.power_state IN ('Stronghold', 'Fortified', 'Exploited')
      AND r.x IS NOT NULL AND r.y IS NOT NULL AND r.z IS NOT NULL
      AND (nullif(btrim(r.power), '') IS NULL OR length(btrim(r.power)) <= 64)
    ORDER BY r.id64, r.observed_at DESC NULLS LAST
  ),
  resolved AS (
    SELECT
      i.*,
      -- Держава в дампе одна — владелец она. Несколько — прежний точный
      -- владелец, если он среди них; иначе не определён.
      CASE
        WHEN i.power IS NOT NULL THEN i.power
        WHEN t.power_basis IN ('journal', 'sole', 'kept')
             AND nullif(t.power, '') IS NOT NULL
             AND t.power = ANY(i.powers) THEN t.power
        ELSE NULL
      END AS owner,
      CASE
        WHEN i.power IS NOT NULL THEN 'sole'
        WHEN t.power_basis IN ('journal', 'sole', 'kept')
             AND nullif(t.power, '') IS NOT NULL
             AND t.power = ANY(i.powers) THEN 'kept'
        ELSE 'unknown'
      END AS basis
    FROM incoming AS i
    LEFT JOIN public.powerplay_systems AS t ON t.id64 = i.id64
    WHERE i.power IS NOT NULL OR cardinality(i.powers) > 0
  )
  INSERT INTO public.powerplay_systems AS t (
    id64, name, name_lc, x, y, z, power, power_state, power_basis, powers,
    allegiance, government, observed_at, source, sync_run, updated_at
  )
  SELECT
    r.id64, r.name, lower(r.name), r.x, r.y, r.z, r.owner, r.power_state, r.basis, r.powers,
    r.allegiance, r.government, r.observed_at, 'edsm', p_run, now()
  FROM resolved AS r
  ON CONFLICT (id64) DO UPDATE SET
    name             = EXCLUDED.name,
    name_lc          = EXCLUDED.name_lc,
    x                = EXCLUDED.x,
    y                = EXCLUDED.y,
    z                = EXCLUDED.z,
    power            = EXCLUDED.power,
    power_state      = EXCLUDED.power_state,
    power_basis      = EXCLUDED.power_basis,
    powers           = EXCLUDED.powers,
    allegiance       = EXCLUDED.allegiance,
    government       = EXCLUDED.government,
    -- Счётчики журнала дамп не знает: после более свежего дампа они устарели.
    control_progress = NULL,
    reinforcement    = NULL,
    undermining      = NULL,
    observed_at      = EXCLUDED.observed_at,
    source           = EXCLUDED.source,
    sync_run         = EXCLUDED.sync_run,
    updated_at       = CASE
      WHEN (t.power, t.power_state, t.name, t.x, t.y, t.z)
           IS DISTINCT FROM (EXCLUDED.power, EXCLUDED.power_state, EXCLUDED.name, EXCLUDED.x, EXCLUDED.y, EXCLUDED.z)
      THEN now()
      ELSE t.updated_at
    END
  WHERE NOT (
    t.source <> 'edsm'
    AND t.observed_at IS NOT NULL
    AND (EXCLUDED.observed_at IS NULL OR t.observed_at > EXCLUDED.observed_at)
  );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count + v_kept;
END;
$$;

-- ── Завершение импорта ───────────────────────────────────────────────────
-- Как раньше: пропавшее из дампа удаляется, кроме наблюдений пилотов, которые
-- новее самого дампа. Плюс итог по основаниям — для журнала админки.

CREATE OR REPLACE FUNCTION public.powerplay_finish_sync(p_run UUID, p_state JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
  v_total   INTEGER;
  v_unknown INTEGER;
  v_sole    INTEGER;
  v_kept    INTEGER;
  v_journal INTEGER;
  v_state   JSONB := COALESCE(p_state, '{}'::jsonb);
  v_dump_at TIMESTAMPTZ;
  v_bases   JSONB;
BEGIN
  IF p_run IS NULL THEN
    RAISE EXCEPTION 'powerplay_finish_sync: нужен идентификатор импорта';
  END IF;
  -- Пустой импорт не должен стереть карту: такой дамп отсекается ещё в коде,
  -- здесь — последняя страховка.
  IF NOT EXISTS (SELECT 1 FROM public.powerplay_systems WHERE sync_run = p_run) THEN
    RAISE EXCEPTION 'powerplay_finish_sync: импорт % не записал ни одной системы', p_run;
  END IF;

  BEGIN
    v_dump_at := nullif(v_state->>'dump_generated_at', '')::timestamptz;
  EXCEPTION WHEN others THEN
    v_dump_at := NULL;
  END;

  DELETE FROM public.powerplay_systems
   WHERE sync_run IS DISTINCT FROM p_run
     AND NOT (
       source <> 'edsm'
       AND observed_at IS NOT NULL
       AND observed_at > COALESCE(v_dump_at, now() - interval '1 day')
     );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  SELECT
    count(*),
    count(*) FILTER (WHERE power IS NULL),
    count(*) FILTER (WHERE power_basis = 'sole'),
    count(*) FILTER (WHERE power_basis = 'kept'),
    count(*) FILTER (WHERE power_basis = 'journal')
    INTO v_total, v_unknown, v_sole, v_kept, v_journal
    FROM public.powerplay_systems
   WHERE power_state <> 'Unoccupied';
  v_bases := jsonb_build_object('journal', v_journal, 'sole', v_sole, 'kept', v_kept, 'unknown', v_unknown);

  INSERT INTO public.powerplay_sync_state AS s (id, status, run_id, rows_total, synced_at, checked_at, error, updated_at)
  VALUES (1, 'ok', p_run, v_total, now(), now(), NULL, now())
  ON CONFLICT (id) DO UPDATE SET
    status = 'ok', run_id = p_run, rows_total = v_total,
    synced_at = now(), checked_at = now(), error = NULL, updated_at = now();

  UPDATE public.powerplay_sync_state SET
    source_url        = COALESCE(v_state->>'source_url', source_url),
    etag              = v_state->>'etag',
    last_modified     = v_state->>'last_modified',
    dump_generated_at = v_dump_at,
    stats             = COALESCE(v_state->'stats', '{}'::jsonb)
                        || jsonb_build_object('deleted', v_deleted, 'bases', v_bases)
  WHERE id = 1;

  RETURN jsonb_build_object('deleted', v_deleted, 'total', v_total) || v_bases;
END;
$$;

-- ── Слой карты ────────────────────────────────────────────────────────────
-- Кортеж: id64, имя, x, y, z, владелец (NULL — не определён), состояние,
-- наблюдение (unix-секунды), основание, державы в системе.

CREATE OR REPLACE FUNCTION public.powerplay_layer_rows()
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    json_agg(
      json_build_array(
        s.id64::text, s.name, s.x, s.y, s.z, s.power, s.power_state,
        floor(extract(epoch FROM s.observed_at))::bigint, s.power_basis, s.powers
      )
      ORDER BY s.name_lc, s.id64
    ),
    '[]'::json
  )
  FROM public.powerplay_systems s
  WHERE s.power_state <> 'Unoccupied';
$$;

-- ── Сводка для админки ────────────────────────────────────────────────────
-- По державам: состояния, откуда известен владелец и в скольких системах с
-- неопределённым владельцем держава — среди претендентов.

CREATE OR REPLACE FUNCTION public.powerplay_admin_summary()
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH controlled AS (
    SELECT * FROM public.powerplay_systems WHERE power_state <> 'Unoccupied'
  ),
  owned AS (
    SELECT
      s.power,
      count(*) FILTER (WHERE s.power_state = 'Stronghold') AS stronghold,
      count(*) FILTER (WHERE s.power_state = 'Fortified') AS fortified,
      count(*) FILTER (WHERE s.power_state = 'Exploited') AS exploited,
      count(*) AS total,
      count(*) FILTER (WHERE s.power_basis = 'journal') AS journal,
      count(*) FILTER (WHERE s.power_basis = 'sole') AS sole,
      count(*) FILTER (WHERE s.power_basis = 'kept') AS kept,
      count(*) FILTER (WHERE s.power_basis IS NULL) AS legacy
    FROM controlled s
    WHERE nullif(s.power, '') IS NOT NULL
    GROUP BY s.power
  ),
  contested AS (
    SELECT candidate AS power, count(*) AS contested
    FROM controlled s, unnest(s.powers) AS candidate
    WHERE s.power IS NULL
    GROUP BY candidate
  ),
  merged AS (
    SELECT
      COALESCE(o.power, c.power) AS power,
      COALESCE(o.stronghold, 0) AS stronghold,
      COALESCE(o.fortified, 0) AS fortified,
      COALESCE(o.exploited, 0) AS exploited,
      COALESCE(o.total, 0) AS total,
      COALESCE(o.journal, 0) AS journal,
      COALESCE(o.sole, 0) AS sole,
      COALESCE(o.kept, 0) AS kept,
      COALESCE(o.legacy, 0) AS legacy,
      COALESCE(c.contested, 0) AS contested
    FROM owned o
    FULL JOIN contested c ON c.power = o.power
  )
  SELECT json_build_object(
    'total', (SELECT count(*) FROM controlled),
    'powers', COALESCE((
      SELECT json_agg(
        json_build_object(
          'power', m.power,
          'Stronghold', m.stronghold,
          'Fortified', m.fortified,
          'Exploited', m.exploited,
          'total', m.total,
          'journal', m.journal,
          'sole', m.sole,
          'kept', m.kept,
          'legacy', m.legacy,
          'contested', m.contested
        )
        ORDER BY m.total DESC, m.power
      )
      FROM merged m
    ), '[]'::json),
    'unknown', (
      SELECT json_build_object(
        'total', count(*),
        'Stronghold', count(*) FILTER (WHERE power_state = 'Stronghold'),
        'Fortified', count(*) FILTER (WHERE power_state = 'Fortified'),
        'Exploited', count(*) FILTER (WHERE power_state = 'Exploited')
      )
      FROM controlled
      WHERE power IS NULL
    ),
    'bases', COALESCE((
      SELECT json_object_agg(b.basis, b.n)
      FROM (
        SELECT COALESCE(power_basis, 'legacy') AS basis, count(*) AS n
        FROM controlled
        GROUP BY 1
      ) b
    ), '{}'::json),
    'sources', COALESCE((
      SELECT json_object_agg(src.source, src.n)
      FROM (SELECT source, count(*) AS n FROM controlled GROUP BY 1) src
    ), '{}'::json),
    'vacated', (SELECT count(*) FROM public.powerplay_systems WHERE power_state = 'Unoccupied'),
    'oldest_observation', (SELECT min(observed_at) FROM controlled),
    'newest_observation', (SELECT max(observed_at) FROM controlled),
    'last_change', (SELECT max(updated_at) FROM public.powerplay_systems)
  );
$$;

-- ── Наблюдения из журналов (Helper, сайт, CAPI, EDDN) ─────────────────────
-- Как в 20261020120000, плюс:
--   * у строк из журнала основание `journal` — владелец из ControllingPower;
--   * наблюдение старше сохранённого всё же называет владельца, если в
--     строке он не определён, журнал видел систему под контролем одной из
--     перечисленных дампом держав и не раньше чем за 7 дней до дампа: смена
--     владельца в PowerPlay 2.0 идёт через «свободную» систему и занимает не
--     меньше двух циклов (основание `kept`).

CREATE OR REPLACE FUNCTION public.powerplay_apply_observations(p_rows JSONB, p_source TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_dump_at  TIMESTAMPTZ;
  v_row      RECORD;
  v_existing RECORD;
  v_received INTEGER := 0;
  v_applied  INTEGER := 0;
  v_stale    INTEGER := 0;
  v_created  INTEGER := 0;
  v_vacated  INTEGER := 0;
  v_resolved INTEGER := 0;
  v_systems  TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('helper', 'web', 'eddn') THEN
    RAISE EXCEPTION 'powerplay_apply_observations: неизвестный источник %', p_source;
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'powerplay_apply_observations: нужен массив наблюдений';
  END IF;

  SELECT dump_generated_at INTO v_dump_at FROM public.powerplay_sync_state WHERE id = 1;

  FOR v_row IN
    SELECT DISTINCT ON (r.id64)
      r.id64,
      btrim(r.name) AS name,
      r.x, r.y, r.z,
      COALESCE(nullif(btrim(r.power), ''), '') AS power,
      r.power_state,
      r.powers,
      r.control_progress,
      r.reinforcement,
      r.undermining,
      nullif(btrim(r.allegiance), '') AS allegiance,
      nullif(btrim(r.government), '') AS government,
      r.observed_at
    FROM jsonb_to_recordset(p_rows) AS r(
      id64 BIGINT, name TEXT, x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION,
      power TEXT, power_state TEXT, powers TEXT[], control_progress DOUBLE PRECISION,
      reinforcement BIGINT, undermining BIGINT, allegiance TEXT, government TEXT, observed_at TIMESTAMPTZ
    )
    WHERE r.id64 IS NOT NULL AND r.id64 > 0
      AND nullif(btrim(r.name), '') IS NOT NULL
      AND length(btrim(r.name)) <= 120
      AND r.x IS NOT NULL AND r.y IS NOT NULL AND r.z IS NOT NULL
      AND r.observed_at IS NOT NULL
      -- PowerPlay 2.0 (29.10.2024): раньше те же поля значили другое.
      AND r.observed_at >= '2024-10-29T00:00:00Z'::timestamptz
      AND r.observed_at <= now() + interval '1 hour'
      AND (
        (r.power_state IN ('Stronghold', 'Fortified', 'Exploited')
          AND nullif(btrim(r.power), '') IS NOT NULL AND length(btrim(r.power)) <= 64)
        OR r.power_state = 'Unoccupied'
      )
    ORDER BY r.id64, r.observed_at DESC
  LOOP
    v_received := v_received + 1;

    SELECT s.observed_at, s.power_state, s.power, s.powers INTO v_existing
      FROM public.powerplay_systems AS s
     WHERE s.id64 = v_row.id64
       FOR UPDATE;

    IF FOUND THEN
      IF v_existing.observed_at IS NOT NULL AND v_existing.observed_at >= v_row.observed_at THEN
        IF v_existing.power IS NULL
           AND v_existing.power_state <> 'Unoccupied'
           AND v_row.power_state <> 'Unoccupied'
           AND v_row.power <> ''
           AND v_row.power = ANY(COALESCE(v_existing.powers, ARRAY[]::TEXT[]))
           AND v_row.observed_at >= v_existing.observed_at - interval '7 days' THEN
          UPDATE public.powerplay_systems
             SET power = v_row.power, power_basis = 'kept', updated_at = now()
           WHERE id64 = v_row.id64;
          v_resolved := v_resolved + 1;
          v_applied := v_applied + 1;
        ELSE
          v_stale := v_stale + 1;
          CONTINUE;
        END IF;
      ELSE
        UPDATE public.powerplay_systems AS t SET
          name             = v_row.name,
          name_lc          = lower(v_row.name),
          x                = v_row.x,
          y                = v_row.y,
          z                = v_row.z,
          power            = v_row.power,
          power_state      = v_row.power_state,
          power_basis      = CASE WHEN v_row.power_state = 'Unoccupied' THEN NULL ELSE 'journal' END,
          powers           = v_row.powers,
          control_progress = v_row.control_progress,
          reinforcement    = v_row.reinforcement,
          undermining      = v_row.undermining,
          allegiance       = COALESCE(v_row.allegiance, t.allegiance),
          government       = COALESCE(v_row.government, t.government),
          observed_at      = v_row.observed_at,
          source           = p_source,
          updated_at       = CASE
            WHEN (t.power, t.power_state, t.name, t.x, t.y, t.z)
                 IS DISTINCT FROM (v_row.power, v_row.power_state, v_row.name, v_row.x, v_row.y, v_row.z)
            THEN now()
            ELSE t.updated_at
          END
        WHERE t.id64 = v_row.id64;
        v_applied := v_applied + 1;
        IF v_row.power_state = 'Unoccupied' AND v_existing.power_state <> 'Unoccupied' THEN
          v_vacated := v_vacated + 1;
        END IF;
      END IF;
    ELSE
      -- Неизвестную систему добавляем только под контролем и только если
      -- наблюдение новее дампа: старый журнал не рисует на карте то, чего уже нет.
      IF v_row.power_state = 'Unoccupied'
         OR (v_dump_at IS NOT NULL AND v_row.observed_at <= v_dump_at) THEN
        v_stale := v_stale + 1;
        CONTINUE;
      END IF;
      INSERT INTO public.powerplay_systems (
        id64, name, name_lc, x, y, z, power, power_state, power_basis, powers, control_progress,
        reinforcement, undermining, allegiance, government, observed_at, source, sync_run, updated_at
      ) VALUES (
        v_row.id64, v_row.name, lower(v_row.name), v_row.x, v_row.y, v_row.z, v_row.power, v_row.power_state, 'journal',
        v_row.powers, v_row.control_progress, v_row.reinforcement, v_row.undermining,
        v_row.allegiance, v_row.government, v_row.observed_at, p_source, NULL, now()
      );
      v_applied := v_applied + 1;
      v_created := v_created + 1;
    END IF;

    IF array_length(v_systems, 1) IS NULL OR array_length(v_systems, 1) < 20 THEN
      v_systems := array_append(v_systems, v_row.name);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'received', v_received,
    'applied', v_applied,
    'stale', v_stale,
    'created', v_created,
    'vacated', v_vacated,
    'resolved', v_resolved,
    'systems', to_jsonb(v_systems)
  );
END;
$$;

COMMENT ON FUNCTION public.powerplay_apply_observations(JSONB, TEXT) IS
  'PowerPlay из журналов (Helper, сайт, CAPI, EDDN): применяется наблюдение новее сохранённого; новая система — только если новее дампа; старое наблюдение называет неопределённого владельца, если тот среди держав дампа.';
COMMENT ON FUNCTION public.powerplay_apply_batch(UUID, JSONB) IS
  'Импорт дампа EDSM пачкой: система целиком (все её державы). Одна держава — владелец; несколько — прежний точный владелец, если он среди них, иначе «не определён».';

-- Всё это — только сервером (service_role).
REVOKE ALL ON FUNCTION public.powerplay_apply_batch(UUID, JSONB),
  public.powerplay_finish_sync(UUID, JSONB),
  public.powerplay_layer_rows(),
  public.powerplay_admin_summary(),
  public.powerplay_apply_observations(JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerplay_apply_batch(UUID, JSONB),
  public.powerplay_finish_sync(UUID, JSONB),
  public.powerplay_layer_rows(),
  public.powerplay_admin_summary(),
  public.powerplay_apply_observations(JSONB, TEXT)
  TO service_role;

NOTIFY pgrst, 'reload schema';


-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261021130000_eddn_listener.sql                    │
-- └────────────────────────────────────────────────────────────────┘

-- ══════════════════════════════════════════════════════════════════════════
-- Живые данные EDDN (web 2.23.0, по желанию администратора).
--
-- Слушатель (`src/lib/eddn/listener.ts`) подписывается на реле EDDN и отдаёт
-- прыжки и входы в игру тому же разбору, что журналы Colonial Helper и сайта:
-- владелец системы PowerPlay (ControllingPower — его нет в дампе EDSM),
-- состояние и фракции — одним наблюдением, источник `eddn`.
--
-- Здесь одна строка: включён ли слушатель (решает администратор в
-- «Игровые данные → PowerPlay»; флаг переживает перезапуск сайта), его
-- состояние, счётчики и журнал — для админки. Пишет только сервер.
--
-- Миграция идемпотентна.
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.eddn_listener_state (
  id            SMALLINT PRIMARY KEY DEFAULT 1,
  -- Включён администратором: процесс сайта поднимает слушатель сам
  -- (задача eddn-listener раз в 5 минут, открытие слоя PowerPlay, админка).
  enabled       BOOLEAN NOT NULL DEFAULT false,
  enabled_at    TIMESTAMPTZ,
  enabled_by    UUID,
  -- off | connecting | connected | waiting — последнее, что сообщил процесс.
  status        TEXT NOT NULL DEFAULT 'off',
  relay         TEXT,
  -- Счётчики текущего запуска: сообщения, наблюдения, записи в слои, переподключения.
  stats         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Журнал: подключения, «тишина» реле, ошибки записи.
  log           JSONB NOT NULL DEFAULT '[]'::jsonb,
  error         TEXT,
  -- Когда процесс последний раз писал состояние (живой ли слушатель).
  heartbeat_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT eddn_listener_state_singleton CHECK (id = 1),
  CONSTRAINT eddn_listener_state_status_check
    CHECK (status IN ('off', 'connecting', 'connected', 'waiting'))
);

INSERT INTO public.eddn_listener_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.eddn_listener_state ENABLE ROW LEVEL SECURITY;
-- Политик нет: читает и пишет только сервер (service_role).
REVOKE ALL ON public.eddn_listener_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.eddn_listener_state TO service_role;

COMMENT ON TABLE public.eddn_listener_state IS
  'Слушатель живых данных EDDN: включён ли (админка, PowerPlay), состояние, счётчики и журнал. Наблюдения уходят в слои PowerPlay и фракций с источником eddn.';

NOTIFY pgrst, 'reload schema';


-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261022120000_station_search_by_station.sql        │
-- └────────────────────────────────────────────────────────────────┘

-- ══════════════════════════════════════════════════════════════════════════
-- Поиск по станциям списком (web 2.25.0).
--
-- `/station-search` показывает станции строками: одна строка — одна станция,
-- по нажатию раскрывается то, что на ней совпало с запросом (товары с ценой и
-- запасом, модули, корабли, услуги). Поэтому выдача группируется по станциям
-- в базе: страница — это 50 станций, а не 50 пар «станция + товар», и общее
-- число найденных станций известно сразу.
--
-- Подбор совпадений вынесен в одну функцию `station_catalog_matches`: её
-- вызывают и прежний плоский поиск `search_station_catalog` (сигнатура и ответ
-- те же — перегрузка сломала бы PostgREST), и новый
-- `search_station_catalog_stations`.
--
-- Точное совпадение. Товар, модуль или корабль, выбранный из списка быстрого
-- выбора, приходит ключами `exact_keys`: английское название и символ
-- Frontier (EDCD/FDevIDs). Позиция совпадает, если ключ её названия, символа
-- или идентификатора равен одному из них. «Water» больше не находит
-- «Water Purifiers», обычный щит — призматический и Bi-Weave. Ключ — как
-- `commodityKey` в TypeScript: без `$…_name;`, только латиница и цифры, так что
-- `$steel_name;` (Colonial Helper), `steel` (EDDN) и `Steel` (Spansh) — одно.
-- Без ключей поиск, как и раньше, ищет вхождение `needles`.
--
-- Миграция идемпотентна: только CREATE OR REPLACE.
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.station_item_key(value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT regexp_replace(
    regexp_replace(regexp_replace(lower(btrim(coalesce(value, ''))), '^\$', ''), '_name;?$', ''),
    '[^a-z0-9]', '', 'g');
$$;

COMMENT ON FUNCTION public.station_item_key(TEXT) IS
  'Ключ точного совпадения позиции ассортимента: без $…_name;, только a-z0-9 (как commodityKey в TypeScript).';

-- Совпадения: одна строка на пару «станция + позиция». Общая для обоих поисков.
CREATE OR REPLACE FUNCTION public.station_catalog_matches(
  search_kind TEXT, needles TEXT[], exact_keys TEXT[] DEFAULT NULL,
  cx FLOAT8 DEFAULT NULL, cy FLOAT8 DEFAULT NULL, cz FLOAT8 DEFAULT NULL,
  radius_ly FLOAT8 DEFAULT 500, minimum_stock NUMERIC DEFAULT 1, filter_class INTEGER DEFAULT NULL,
  filter_rating TEXT DEFAULT NULL, fresh_only BOOLEAN DEFAULT false
) RETURNS TABLE (
  station_key TEXT, station_name TEXT, station_type TEXT, system_name TEXT, market_id TEXT,
  x FLOAT8, y FLOAT8, z FLOAT8, distance FLOAT8, metadata JSONB, item JSONB,
  observed_at TIMESTAMPTZ, source TEXT, stale BOOLEAN
) LANGUAGE sql STABLE SET search_path = public AS $$
  WITH keys AS (
    SELECT
      coalesce((SELECT array_agg(DISTINCT public.station_item_key(k)) FROM unnest(exact_keys) k
        WHERE public.station_item_key(k) <> ''), '{}'::text[]) AS exact,
      coalesce((SELECT array_agg(DISTINCT public.station_search_key(n)) FROM unnest(needles) n
        WHERE length(public.station_search_key(n)) >= 2), '{}'::text[]) AS contains
  ), stations AS (
    SELECT st.station_key, st.station_name, st.station_type, st.system_name, st.market_id, st.metadata,
      st.observed_at, st.source, sys.x, sys.y, sys.z,
      CASE WHEN cx IS NOT NULL AND cy IS NOT NULL AND cz IS NOT NULL AND sys.x IS NOT NULL AND sys.y IS NOT NULL AND sys.z IS NOT NULL
        THEN sqrt(power(sys.x - cx, 2) + power(sys.y - cy, 2) + power(sys.z - cz, 2)) END AS distance
    FROM public.station_commerce st JOIN public.commerce_systems sys ON st.system_lc = sys.name_lc
    WHERE cx IS NULL OR (sys.x BETWEEN cx - radius_ly AND cx + radius_ly AND sys.y BETWEEN cy - radius_ly AND cy + radius_ly
      AND sys.z BETWEEN cz - radius_ly AND cz + radius_ly
      AND power(sys.x - cx, 2) + power(sys.y - cy, 2) + power(sys.z - cz, 2) <= power(radius_ly, 2))
  ), inventory AS (
    SELECT st.*, entry AS item, snap.observed_at AS inventory_at, snap.source AS inventory_source
    FROM stations st JOIN public.station_inventory_snapshots snap USING (station_key)
    CROSS JOIN LATERAL jsonb_array_elements(snap.items) entry
    WHERE search_kind IN ('market', 'outfitting', 'shipyard') AND snap.kind = search_kind
    UNION ALL
    SELECT st.*, jsonb_build_object('name', service), st.observed_at, st.source
    FROM stations st CROSS JOIN LATERAL jsonb_array_elements_text(
      coalesce(st.metadata->'services', '[]'::jsonb) ||
      (SELECT coalesce(jsonb_agg('Engineer: ' || engineer), '[]'::jsonb)
         FROM jsonb_array_elements_text(coalesce(st.metadata->'engineers', '[]'::jsonb)) engineer)
    ) service WHERE search_kind = 'services'
  )
  SELECT DISTINCT inv.station_key, inv.station_name, inv.station_type, inv.system_name, inv.market_id,
    inv.x, inv.y, inv.z, inv.distance, inv.metadata, inv.item,
    inv.inventory_at, inv.inventory_source, inv.inventory_at < now() - interval '1 hour'
  FROM inventory inv CROSS JOIN keys
  WHERE (CASE WHEN cardinality(keys.exact) > 0 THEN
      public.station_item_key(inv.item->>'name') = ANY (keys.exact)
      OR public.station_item_key(inv.item->>'symbol') = ANY (keys.exact)
      OR public.station_item_key(inv.item->>'id') = ANY (keys.exact)
    ELSE EXISTS (
      SELECT 1 FROM unnest(keys.contains) needle
      WHERE position(needle IN public.station_search_key(inv.item->>'name')) > 0
         OR position(needle IN public.station_search_key(inv.item->>'symbol')) > 0)
    END)
    AND (search_kind <> 'market' OR coalesce((inv.item->>'stock')::numeric, 0) >= minimum_stock)
    AND (NOT fresh_only OR inv.inventory_at >= now() - interval '1 hour')
    AND (search_kind <> 'outfitting' OR filter_class IS NULL OR
      coalesce(inv.item->>'class', substring(coalesce(inv.item->>'symbol', inv.item->>'name') FROM '(?i)_size([0-9]+)_')) = filter_class::text)
    AND (search_kind <> 'outfitting' OR filter_rating IS NULL OR
      coalesce(upper(inv.item->>'rating'), CASE substring(coalesce(inv.item->>'symbol', inv.item->>'name') FROM '(?i)_class([1-5])')
        WHEN '5' THEN 'A' WHEN '4' THEN 'B' WHEN '3' THEN 'C' WHEN '2' THEN 'D' WHEN '1' THEN 'E' END) = filter_rating);
$$;

-- Прежний плоский поиск: та же сигнатура и тот же ответ, совпадения — из общей функции.
CREATE OR REPLACE FUNCTION public.search_station_catalog(
  search_kind TEXT, needles TEXT[], cx FLOAT8 DEFAULT NULL, cy FLOAT8 DEFAULT NULL, cz FLOAT8 DEFAULT NULL,
  radius_ly FLOAT8 DEFAULT 500, minimum_stock NUMERIC DEFAULT 1, filter_class INTEGER DEFAULT NULL,
  filter_rating TEXT DEFAULT NULL, fresh_only BOOLEAN DEFAULT false, sort_by TEXT DEFAULT 'distance',
  page_offset INTEGER DEFAULT 0, row_limit INTEGER DEFAULT 50
) RETURNS JSONB LANGUAGE sql STABLE SET search_path = public AS $$
  WITH page AS (
    SELECT m.* FROM public.station_catalog_matches(search_kind, needles, NULL::text[], cx, cy, cz, radius_ly,
      minimum_stock, filter_class, filter_rating, fresh_only) m
    ORDER BY
      CASE WHEN sort_by = 'price' THEN coalesce((m.item->>'price')::numeric, (m.item->>'buyPrice')::numeric) END NULLS LAST,
      CASE WHEN sort_by = 'updated' THEN m.observed_at END DESC NULLS LAST,
      m.distance NULLS LAST, m.station_key, m.item->>'name'
    LIMIT greatest(1, least(row_limit, 100)) + 1 OFFSET greatest(0, least(page_offset, 5000))
  ) SELECT coalesce(jsonb_agg(page), '[]'::jsonb) FROM page;
$$;

-- Поиск списком: одна строка на станцию, совпадения внутри, общее число станций.
-- Страница — `row_limit` станций и ещё одна (по ней видно, что есть следующая).
CREATE OR REPLACE FUNCTION public.search_station_catalog_stations(
  search_kind TEXT, needles TEXT[], exact_keys TEXT[] DEFAULT NULL,
  cx FLOAT8 DEFAULT NULL, cy FLOAT8 DEFAULT NULL, cz FLOAT8 DEFAULT NULL,
  radius_ly FLOAT8 DEFAULT 500, minimum_stock NUMERIC DEFAULT 1, filter_class INTEGER DEFAULT NULL,
  filter_rating TEXT DEFAULT NULL, fresh_only BOOLEAN DEFAULT false, sort_by TEXT DEFAULT 'distance',
  page_offset INTEGER DEFAULT 0, row_limit INTEGER DEFAULT 50, item_limit INTEGER DEFAULT 100
) RETURNS JSONB LANGUAGE sql STABLE SET search_path = public AS $$
  WITH matches AS (
    SELECT m.*, coalesce((m.item->>'price')::numeric, (m.item->>'buyPrice')::numeric) AS price
    FROM public.station_catalog_matches(search_kind, needles, exact_keys, cx, cy, cz, radius_ly,
      minimum_stock, filter_class, filter_rating, fresh_only) m
  ), grouped AS (
    SELECT station_key, station_name, station_type, system_name, market_id, x, y, z, distance, metadata,
      observed_at, source, stale, count(*)::int AS item_count, min(price) AS best_price,
      -- Модули — от старшего класса и лучшего рейтинга, товары и корабли — по цене.
      array_agg(item ORDER BY item->>'class' DESC NULLS LAST, upper(item->>'rating') NULLS LAST,
        price NULLS LAST, item->>'name') AS items
    FROM matches
    GROUP BY station_key, station_name, station_type, system_name, market_id, x, y, z, distance, metadata,
      observed_at, source, stale
  ), ordered AS (
    SELECT grouped.*, row_number() OVER (ORDER BY
        CASE WHEN sort_by = 'price' THEN best_price END NULLS LAST,
        CASE WHEN sort_by = 'updated' THEN observed_at END DESC NULLS LAST,
        distance NULLS LAST, station_key) AS row_no
    FROM grouped
  ), bounds AS (
    SELECT greatest(0, least(page_offset, 5000)) AS page_skip,
      greatest(1, least(row_limit, 100)) + 1 AS page_take,
      greatest(1, least(item_limit, 200)) AS items_max
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM grouped),
    'stations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
          'station_key', o.station_key, 'station_name', o.station_name, 'station_type', o.station_type,
          'system_name', o.system_name, 'market_id', o.market_id, 'x', o.x, 'y', o.y, 'z', o.z,
          'distance', o.distance, 'metadata', o.metadata, 'observed_at', o.observed_at,
          'source', o.source, 'stale', o.stale, 'item_count', o.item_count, 'best_price', o.best_price,
          'items', to_jsonb(o.items[1:b.items_max])) ORDER BY o.row_no)
      FROM ordered o CROSS JOIN bounds b
      WHERE o.row_no > b.page_skip AND o.row_no <= b.page_skip + b.page_take), '[]'::jsonb));
$$;

REVOKE ALL ON FUNCTION
  public.station_catalog_matches(TEXT, TEXT[], TEXT[], FLOAT8, FLOAT8, FLOAT8, FLOAT8, NUMERIC, INTEGER, TEXT, BOOLEAN),
  public.search_station_catalog_stations(TEXT, TEXT[], TEXT[], FLOAT8, FLOAT8, FLOAT8, FLOAT8, NUMERIC, INTEGER, TEXT, BOOLEAN, TEXT, INTEGER, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.station_catalog_matches(TEXT, TEXT[], TEXT[], FLOAT8, FLOAT8, FLOAT8, FLOAT8, NUMERIC, INTEGER, TEXT, BOOLEAN),
  public.search_station_catalog_stations(TEXT, TEXT[], TEXT[], FLOAT8, FLOAT8, FLOAT8, FLOAT8, NUMERIC, INTEGER, TEXT, BOOLEAN, TEXT, INTEGER, INTEGER, INTEGER)
  TO service_role;

COMMENT ON FUNCTION public.search_station_catalog_stations(TEXT, TEXT[], TEXT[], FLOAT8, FLOAT8, FLOAT8, FLOAT8, NUMERIC, INTEGER, TEXT, BOOLEAN, TEXT, INTEGER, INTEGER, INTEGER) IS
  'Поиск по станциям списком (/station-search): {total, stations:[{…станция, items, item_count, best_price}]}. exact_keys — точный выбор из списка.';

NOTIFY pgrst, 'reload schema';


-- ════════════════════════════════════════════════════════════════════
-- │ MIGRATION: 20261023120000_station_search_access_filters.sql     │
-- ════════════════════════════════════════════════════════════════════

-- Фильтры доступности станции применяются до группировки, total и LIMIT/OFFSET.
-- Отдельные RPC сохраняют старые сигнатуры и совместимость PostgREST.
-- При отсутствии миграции API не возвращает нефильтрованную выдачу.
CREATE OR REPLACE FUNCTION public.station_access_matches(
  station_type TEXT, metadata JSONB, filter_pad TEXT, filter_carriers TEXT
) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  WITH normalized AS (
    SELECT regexp_replace(lower(coalesce(station_type, '')), '[^a-z0-9]', '', 'g') AS kind
  ), access AS (
    SELECT kind = 'fleetcarrier' AS carrier,
      CASE
        WHEN metadata->>'max_landing_pad' IN ('S', 'M', 'L') THEN metadata->>'max_landing_pad'
        WHEN kind = 'outpost' THEN 'M'
        WHEN kind ~ '^(fleetcarrier|coriolis|orbis|ocellus|dodec|bernal|asteroidbase|craterport|planetaryport)' THEN 'L'
        ELSE NULL
      END AS pad
    FROM normalized
  )
  SELECT (filter_carriers = 'include' OR (filter_carriers = 'exclude' AND NOT carrier)
      OR (filter_carriers = 'only' AND carrier))
    AND (filter_pad = 'any' OR coalesce(CASE filter_pad
      WHEN 'S' THEN pad IN ('S', 'M', 'L') WHEN 'M' THEN pad IN ('M', 'L') WHEN 'L' THEN pad = 'L'
      ELSE false END, false))
  FROM access;
$$;

CREATE OR REPLACE FUNCTION public.search_station_catalog_filtered(
  search_kind TEXT, needles TEXT[], cx FLOAT8 DEFAULT NULL, cy FLOAT8 DEFAULT NULL, cz FLOAT8 DEFAULT NULL,
  radius_ly FLOAT8 DEFAULT 500, minimum_stock NUMERIC DEFAULT 1, filter_class INTEGER DEFAULT NULL,
  filter_rating TEXT DEFAULT NULL, fresh_only BOOLEAN DEFAULT false, sort_by TEXT DEFAULT 'distance',
  page_offset INTEGER DEFAULT 0, row_limit INTEGER DEFAULT 50,
  filter_pad TEXT DEFAULT 'any', filter_carriers TEXT DEFAULT 'include'
) RETURNS JSONB LANGUAGE sql STABLE SET search_path = public AS $$
  WITH page AS (
    SELECT m.* FROM public.station_catalog_matches(search_kind, needles, NULL::text[], cx, cy, cz, radius_ly,
      minimum_stock, filter_class, filter_rating, fresh_only) m
    WHERE public.station_access_matches(m.station_type, m.metadata, filter_pad, filter_carriers)
    ORDER BY
      CASE WHEN sort_by = 'price' THEN coalesce((m.item->>'price')::numeric, (m.item->>'buyPrice')::numeric) END NULLS LAST,
      CASE WHEN sort_by = 'updated' THEN m.observed_at END DESC NULLS LAST,
      m.distance NULLS LAST, m.station_key, m.item->>'name'
    LIMIT greatest(1, least(row_limit, 100)) + 1 OFFSET greatest(0, least(page_offset, 5000))
  ) SELECT coalesce(jsonb_agg(page), '[]'::jsonb) FROM page;
$$;

CREATE OR REPLACE FUNCTION public.search_station_catalog_stations_filtered(
  search_kind TEXT, needles TEXT[], exact_keys TEXT[] DEFAULT NULL,
  cx FLOAT8 DEFAULT NULL, cy FLOAT8 DEFAULT NULL, cz FLOAT8 DEFAULT NULL,
  radius_ly FLOAT8 DEFAULT 500, minimum_stock NUMERIC DEFAULT 1, filter_class INTEGER DEFAULT NULL,
  filter_rating TEXT DEFAULT NULL, fresh_only BOOLEAN DEFAULT false, sort_by TEXT DEFAULT 'distance',
  page_offset INTEGER DEFAULT 0, row_limit INTEGER DEFAULT 50, item_limit INTEGER DEFAULT 100,
  filter_pad TEXT DEFAULT 'any', filter_carriers TEXT DEFAULT 'include'
) RETURNS JSONB LANGUAGE sql STABLE SET search_path = public AS $$
  WITH matches AS (
    SELECT m.*, coalesce((m.item->>'price')::numeric, (m.item->>'buyPrice')::numeric) AS price
    FROM public.station_catalog_matches(search_kind, needles, exact_keys, cx, cy, cz, radius_ly,
      minimum_stock, filter_class, filter_rating, fresh_only) m
    WHERE public.station_access_matches(m.station_type, m.metadata, filter_pad, filter_carriers)
  ), grouped AS (
    SELECT station_key, station_name, station_type, system_name, market_id, x, y, z, distance, metadata,
      observed_at, source, stale, count(*)::int AS item_count, min(price) AS best_price,
      -- Модули — от старшего класса и лучшего рейтинга, товары и корабли — по цене.
      array_agg(item ORDER BY item->>'class' DESC NULLS LAST, upper(item->>'rating') NULLS LAST,
        price NULLS LAST, item->>'name') AS items
    FROM matches
    GROUP BY station_key, station_name, station_type, system_name, market_id, x, y, z, distance, metadata,
      observed_at, source, stale
  ), ordered AS (
    SELECT grouped.*, row_number() OVER (ORDER BY
        CASE WHEN sort_by = 'price' THEN best_price END NULLS LAST,
        CASE WHEN sort_by = 'updated' THEN observed_at END DESC NULLS LAST,
        distance NULLS LAST, station_key) AS row_no
    FROM grouped
  ), bounds AS (
    SELECT greatest(0, least(page_offset, 5000)) AS page_skip,
      greatest(1, least(row_limit, 100)) + 1 AS page_take,
      greatest(1, least(item_limit, 200)) AS items_max
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM grouped),
    'stations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
          'station_key', o.station_key, 'station_name', o.station_name, 'station_type', o.station_type,
          'system_name', o.system_name, 'market_id', o.market_id, 'x', o.x, 'y', o.y, 'z', o.z,
          'distance', o.distance, 'metadata', o.metadata, 'observed_at', o.observed_at,
          'source', o.source, 'stale', o.stale, 'item_count', o.item_count, 'best_price', o.best_price,
          'items', to_jsonb(o.items[1:b.items_max])) ORDER BY o.row_no)
      FROM ordered o CROSS JOIN bounds b
      WHERE o.row_no > b.page_skip AND o.row_no <= b.page_skip + b.page_take), '[]'::jsonb));
$$;

REVOKE ALL ON FUNCTION public.station_access_matches(TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.station_access_matches(TEXT, JSONB, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.search_station_catalog_filtered(TEXT, TEXT[], FLOAT8, FLOAT8, FLOAT8, FLOAT8, NUMERIC, INTEGER, TEXT, BOOLEAN, TEXT, INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_station_catalog_filtered(TEXT, TEXT[], FLOAT8, FLOAT8, FLOAT8, FLOAT8, NUMERIC, INTEGER, TEXT, BOOLEAN, TEXT, INTEGER, INTEGER, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.search_station_catalog_stations_filtered(TEXT, TEXT[], TEXT[], FLOAT8, FLOAT8, FLOAT8, FLOAT8, NUMERIC, INTEGER, TEXT, BOOLEAN, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_station_catalog_stations_filtered(TEXT, TEXT[], TEXT[], FLOAT8, FLOAT8, FLOAT8, FLOAT8, NUMERIC, INTEGER, TEXT, BOOLEAN, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';


-- ════════════════════════════════════════════════════════════════════
-- │ MIGRATION: 20261024120000_profile_squadron_images.sql            │
-- ════════════════════════════════════════════════════════════════════

-- Avatar: 5 MiB. Squadron branding: bounded fallback when Storage is down.
-- No existing Storage objects are moved or deleted.
CREATE TABLE IF NOT EXISTS public.squadron_images (
  squadron_id BIGINT NOT NULL REFERENCES public.squadrons(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('logo', 'banner')),
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  bytes BYTEA NOT NULL,
  byte_size INTEGER NOT NULL,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (squadron_id, kind),
  CHECK (byte_size = octet_length(bytes) AND byte_size > 0
    AND byte_size <= CASE kind WHEN 'logo' THEN 2097152 ELSE 6291456 END)
);
ALTER TABLE public.squadron_images ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.squadron_images FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.squadron_images TO service_role;
COMMENT ON TABLE public.squadron_images IS
  'Current squadron logo/banner fallback, one image per kind. Server checks editing permissions; GET serves public branding.';

ALTER TABLE public.profile_avatars DROP CONSTRAINT IF EXISTS profile_avatars_size_limit;
ALTER TABLE public.profile_avatars ADD CONSTRAINT profile_avatars_size_limit
  CHECK (byte_size = octet_length(bytes) AND byte_size BETWEEN 1 AND 5242880);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_avatars TO service_role;

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES
      ('avatars', 'avatars', true, 5242880, ARRAY['image/jpeg','image/png','image/webp','image/gif']),
      ('squadron-media', 'squadron-media', true, 6291456, ARRAY['image/jpeg','image/png','image/webp','image/gif'])
    ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;
  ELSE
    RAISE NOTICE 'Storage is not installed yet; application will create the buckets on first upload.';
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';


-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261025090000_cg_inara_details.sql                 │
-- └────────────────────────────────────────────────────────────────┘

-- Retain the source link and source-side timestamp returned by Inara.
ALTER TABLE public.community_goals
  ADD COLUMN IF NOT EXISTS inara_url TEXT,
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;


-- ┌─────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261026080000_cg_identity_key.sql               │
-- └─────────────────────────────────────────────────────────────┘

ALTER TABLE public.community_goals
  ADD COLUMN IF NOT EXISTS identity_key TEXT;


-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261026090000_community_goal_commander_reports.sql  │
-- └────────────────────────────────────────────────────────────────┘

-- Private, per-account snapshots reported by Colonial Helper/CAPI.
-- Public CG totals remain sourced from Inara; this table is only a community
-- sample used for anonymous aggregate comparisons.
CREATE TABLE IF NOT EXISTS public.community_goal_commander_reports (
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  game_cg_id            INTEGER NOT NULL,
  goal_key              TEXT NOT NULL,
  title                 TEXT NOT NULL,
  system_name           TEXT,
  station_name          TEXT,
  expiry_date           TIMESTAMPTZ,
  player_contribution   BIGINT NOT NULL DEFAULT 0,
  current_total         BIGINT,
  tier_reached          INTEGER,
  tier_max              INTEGER,
  contributors_num      INTEGER,
  percentile_band       INTEGER,
  is_top_rank           BOOLEAN,
  is_complete           BOOLEAN,
  observed_at           TIMESTAMPTZ NOT NULL,
  source                TEXT NOT NULL DEFAULT 'helper'
                        CHECK (source IN ('helper', 'capi', 'web')),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, game_cg_id)
);

CREATE INDEX IF NOT EXISTS idx_community_goal_reports_key
  ON public.community_goal_commander_reports (goal_key, observed_at DESC);

ALTER TABLE public.community_goal_commander_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.community_goal_commander_reports FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.community_goal_commander_reports TO service_role;

CREATE OR REPLACE FUNCTION public.upsert_community_goal_commander_reports(p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected INTEGER;
BEGIN
  INSERT INTO public.community_goal_commander_reports (
    user_id, game_cg_id, goal_key, title, system_name, station_name, expiry_date,
    player_contribution, current_total, tier_reached, tier_max, contributors_num,
    percentile_band, is_top_rank, is_complete, observed_at, source, updated_at
  )
  SELECT
    r.user_id, r.game_cg_id, r.goal_key, r.title, r.system_name, r.station_name,
    r.expiry_date, r.player_contribution, r.current_total, r.tier_reached,
    r.tier_max, r.contributors_num, r.percentile_band, r.is_top_rank,
    r.is_complete, r.observed_at, r.source, NOW()
  FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::JSONB)) AS r(
    user_id UUID,
    game_cg_id INTEGER,
    goal_key TEXT,
    title TEXT,
    system_name TEXT,
    station_name TEXT,
    expiry_date TIMESTAMPTZ,
    player_contribution BIGINT,
    current_total BIGINT,
    tier_reached INTEGER,
    tier_max INTEGER,
    contributors_num INTEGER,
    percentile_band INTEGER,
    is_top_rank BOOLEAN,
    is_complete BOOLEAN,
    observed_at TIMESTAMPTZ,
    source TEXT
  )
  WHERE r.user_id IS NOT NULL
    AND r.game_cg_id > 0
    AND r.goal_key IS NOT NULL
    AND r.title IS NOT NULL
    AND r.observed_at IS NOT NULL
  ON CONFLICT (user_id, game_cg_id) DO UPDATE SET
    goal_key = EXCLUDED.goal_key,
    title = EXCLUDED.title,
    system_name = EXCLUDED.system_name,
    station_name = EXCLUDED.station_name,
    expiry_date = EXCLUDED.expiry_date,
    player_contribution = EXCLUDED.player_contribution,
    current_total = EXCLUDED.current_total,
    tier_reached = EXCLUDED.tier_reached,
    tier_max = EXCLUDED.tier_max,
    contributors_num = EXCLUDED.contributors_num,
    percentile_band = EXCLUDED.percentile_band,
    is_top_rank = EXCLUDED.is_top_rank,
    is_complete = EXCLUDED.is_complete,
    observed_at = EXCLUDED.observed_at,
    source = EXCLUDED.source,
    updated_at = NOW()
  WHERE EXCLUDED.observed_at >= public.community_goal_commander_reports.observed_at;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_community_goal_commander_reports(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_community_goal_commander_reports(JSONB) TO service_role;


-- ┌────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261027090000_community_goal_admin.sql              │
-- └────────────────────────────────────────────────────────────────┘

-- Admin lifecycle controls for the Community Goals catalog.
-- Source data remains intact: moderator edits to Inara records live as JSON
-- overrides, so the scheduled sync cannot erase them.
ALTER TABLE public.community_goals
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'inara'
    CHECK (source IN ('inara', 'manual')),
  ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'approved'
    CHECK (moderation_status IN ('approved', 'hidden', 'rejected')),
  ADD COLUMN IF NOT EXISTS manual_overrides JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(manual_overrides) = 'object'),
  ADD COLUMN IF NOT EXISTS admin_note TEXT,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_community_goals_moderation_expiry
  ON public.community_goals (moderation_status, is_complete, expiry_date);

DROP POLICY IF EXISTS community_goals_public ON public.community_goals;
CREATE POLICY community_goals_public ON public.community_goals
  FOR SELECT USING (moderation_status = 'approved');

-- The catalog is displayed through the filtered server API. Do not expose
-- moderator notes, overrides, or account IDs via direct PostgREST table reads.
REVOKE SELECT ON public.community_goals FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, cg_id, title, description, system_name, station_name, objective, reward,
  tier_current, tier_max, contributors, contributions_total, expiry_date,
  is_complete, is_colonisation_related, inara_url, source_updated_at,
  updated_at, created_at
) ON public.community_goals TO anon, authenticated;
GRANT ALL ON public.community_goals TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.community_goals_id_seq TO service_role;


-- ┌────────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261028090000_community_goal_fallback_sources.sql        │
-- └────────────────────────────────────────────────────────────────────┘

-- Community Goals can be discovered from authenticated Frontier CAPI sessions
-- and Elite journal uploads when the Inara API is unavailable. Journal-only
-- rows wait for moderator approval; the official CAPI/Inara sources are public.
ALTER TABLE public.community_goals
  DROP CONSTRAINT IF EXISTS community_goals_source_check,
  DROP CONSTRAINT IF EXISTS community_goals_moderation_status_check;

ALTER TABLE public.community_goals
  ADD CONSTRAINT community_goals_source_check
    CHECK (source IN ('inara', 'capi', 'journal', 'manual')),
  ADD CONSTRAINT community_goals_moderation_status_check
    CHECK (moderation_status IN ('pending', 'approved', 'hidden', 'rejected'));

CREATE INDEX IF NOT EXISTS idx_community_goals_pending_source
  ON public.community_goals (source, source_updated_at DESC)
  WHERE moderation_status = 'pending';

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261029090000_capi_sync_jobs.sql                           │
-- └────────────────────────────────────────────────────────────────────┘

-- Durable queue for manual Frontier CAPI syncs. The browser only enqueues;
-- the scheduled worker claims and executes one job outside the request lifetime.
CREATE TABLE IF NOT EXISTS public.capi_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  stage text NOT NULL DEFAULT 'queued',
  requested_platform text,
  skip_community_goals boolean NOT NULL DEFAULT true,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  stage_timings jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_duration_ms integer,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS capi_sync_jobs_queue_idx
  ON public.capi_sync_jobs (requested_at, created_at)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS capi_sync_jobs_user_recent_idx
  ON public.capi_sync_jobs (user_id, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS capi_sync_jobs_one_active_per_user_idx
  ON public.capi_sync_jobs (user_id)
  WHERE status IN ('queued', 'running');

ALTER TABLE public.capi_sync_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.capi_sync_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.capi_sync_jobs TO service_role;

-- Atomic cross-process claim. SKIP LOCKED prevents two web replicas from
-- running the same job. A crashed worker's lease is reclaimed after 15 min;
-- after three abandoned attempts it is surfaced as a terminal failure.
CREATE OR REPLACE FUNCTION public.claim_next_capi_sync_job()
RETURNS SETOF public.capi_sync_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.capi_sync_jobs
     SET status = 'failed',
         stage = 'worker_lost',
         error = 'Worker heartbeat expired after maximum attempts',
         finished_at = now(),
         updated_at = now()
   WHERE status = 'running'
     AND heartbeat_at < now() - interval '15 minutes'
     AND attempts >= 3;

  RETURN QUERY
  WITH candidate AS (
    SELECT id
      FROM public.capi_sync_jobs
     WHERE status = 'queued'
        OR (status = 'running'
            AND heartbeat_at < now() - interval '15 minutes'
            AND attempts < 3)
     ORDER BY requested_at, created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  UPDATE public.capi_sync_jobs AS job
     SET status = 'running',
         stage = 'starting',
         started_at = COALESCE(job.started_at, now()),
         heartbeat_at = now(),
         attempts = job.attempts + 1,
         error = NULL,
         updated_at = now()
    FROM candidate
   WHERE job.id = candidate.id
  RETURNING job.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_capi_sync_job() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_capi_sync_job() TO service_role;

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261030090000_community_goal_game_identity.sql          │
-- └────────────────────────────────────────────────────────────────────┘

ALTER TABLE public.community_goals
  ADD COLUMN IF NOT EXISTS game_cg_id INTEGER;

UPDATE public.community_goals
SET game_cg_id = CASE
  WHEN COALESCE(raw_data->>'cg_id', '') ~ '^[1-9][0-9]*$'
    AND (raw_data->>'cg_id')::NUMERIC <= 2147483647
    THEN (raw_data->>'cg_id')::INTEGER
  WHEN COALESCE(raw_data->>'communitygoalGameID', '') ~ '^[1-9][0-9]*$'
    AND (raw_data->>'communitygoalGameID')::NUMERIC <= 2147483647
    THEN (raw_data->>'communitygoalGameID')::INTEGER
  WHEN COALESCE(raw_data->>'cgID', '') ~ '^[1-9][0-9]*$'
    AND (raw_data->>'cgID')::NUMERIC <= 2147483647
    THEN (raw_data->>'cgID')::INTEGER
  ELSE NULL
END
WHERE game_cg_id IS NULL AND raw_data IS NOT NULL;

WITH journal_ids AS (
  SELECT goal_key, MIN(game_cg_id) AS game_cg_id
  FROM public.community_goal_commander_reports
  GROUP BY goal_key
  HAVING COUNT(DISTINCT game_cg_id) = 1
)
UPDATE public.community_goals AS goal
SET game_cg_id = journal_ids.game_cg_id
FROM journal_ids
WHERE goal.source = 'journal'
  AND goal.game_cg_id IS NULL
  AND goal.identity_key = journal_ids.goal_key;

CREATE INDEX IF NOT EXISTS idx_community_goals_game_cg_id
  ON public.community_goals (game_cg_id)
  WHERE game_cg_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261031090000_community_goal_progress_freshness.sql     │
-- └────────────────────────────────────────────────────────────────────┘

ALTER TABLE public.community_goals
  ADD COLUMN IF NOT EXISTS progress_source TEXT,
  ADD COLUMN IF NOT EXISTS progress_updated_at TIMESTAMPTZ;

ALTER TABLE public.community_goals
  DROP CONSTRAINT IF EXISTS community_goals_progress_source_check;

ALTER TABLE public.community_goals
  ADD CONSTRAINT community_goals_progress_source_check
    CHECK (progress_source IS NULL OR progress_source IN ('inara', 'capi', 'journal', 'manual'));

UPDATE public.community_goals
SET progress_source = source,
    progress_updated_at = COALESCE(source_updated_at, updated_at)
WHERE progress_source IS NULL
  AND (tier_current IS NOT NULL OR tier_max IS NOT NULL OR contributors IS NOT NULL OR contributions_total IS NOT NULL);

NOTIFY pgrst, 'reload schema';

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261101090000_community_goal_progress_history.sql       │
-- └────────────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS public.community_goal_progress_history (
  cg_id               INTEGER NOT NULL REFERENCES public.community_goals(cg_id) ON DELETE CASCADE,
  snapshot_hour       TIMESTAMPTZ NOT NULL,
  observed_at         TIMESTAMPTZ NOT NULL,
  source              TEXT NOT NULL CHECK (source IN ('inara', 'capi')),
  tier_current        INTEGER,
  tier_max            INTEGER,
  contributors        INTEGER,
  contributions_total BIGINT NOT NULL CHECK (contributions_total >= 0),
  PRIMARY KEY (cg_id, snapshot_hour)
);

INSERT INTO public.community_goal_progress_history (
  cg_id, snapshot_hour, observed_at, source,
  tier_current, tier_max, contributors, contributions_total
)
SELECT
  cg_id,
  date_trunc('hour', COALESCE(progress_updated_at, source_updated_at, updated_at)),
  COALESCE(progress_updated_at, source_updated_at, updated_at),
  progress_source,
  tier_current,
  tier_max,
  contributors,
  contributions_total
FROM public.community_goals
WHERE progress_source IN ('inara', 'capi')
  AND contributions_total IS NOT NULL
  AND contributions_total >= 0
ON CONFLICT (cg_id, snapshot_hour) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_community_goal_progress_history_time
  ON public.community_goal_progress_history (snapshot_hour, cg_id);

ALTER TABLE public.community_goal_progress_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.community_goal_progress_history FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.community_goal_progress_history TO service_role;

NOTIFY pgrst, 'reload schema';

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261102090000_frontier_public_community_goals.sql      │
-- └────────────────────────────────────────────────────────────────────┘

ALTER TABLE public.community_goals
  DROP CONSTRAINT IF EXISTS community_goals_source_check,
  ADD CONSTRAINT community_goals_source_check
    CHECK (source IN ('inara', 'capi', 'journal', 'frontier', 'manual')),
  ADD COLUMN IF NOT EXISTS contributions_target BIGINT,
  ADD COLUMN IF NOT EXISTS target_source TEXT,
  ADD COLUMN IF NOT EXISTS target_updated_at TIMESTAMPTZ;

ALTER TABLE public.community_goals
  DROP CONSTRAINT IF EXISTS community_goals_progress_source_check,
  ADD CONSTRAINT community_goals_progress_source_check
    CHECK (progress_source IS NULL OR progress_source IN ('inara', 'capi', 'journal', 'frontier', 'manual')),
  DROP CONSTRAINT IF EXISTS community_goals_target_source_check,
  ADD CONSTRAINT community_goals_target_source_check
    CHECK (target_source IS NULL OR target_source = 'frontier'),
  DROP CONSTRAINT IF EXISTS community_goals_contributions_target_check,
  ADD CONSTRAINT community_goals_contributions_target_check
    CHECK (contributions_target IS NULL OR contributions_target >= 0);

ALTER TABLE public.community_goal_progress_history
  DROP CONSTRAINT IF EXISTS community_goal_progress_history_source_check,
  ADD CONSTRAINT community_goal_progress_history_source_check
    CHECK (source IN ('inara', 'capi', 'frontier'));

GRANT SELECT (
  contributions_target
) ON public.community_goals TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- ┌────────────────────────────────────────────────────────────────────┐
-- │ MIGRATION: 20261103090000_ship_route_planner.sql                    │
-- └────────────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS public.pilot_ship_state (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  loadout JSONB,
  current_system TEXT,
  fuel_level DOUBLE PRECISION,
  cargo_count INTEGER,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  loadout_at TIMESTAMPTZ
);
ALTER TABLE public.pilot_ship_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pilot_ship_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pilot_ship_state TO service_role;

CREATE TABLE IF NOT EXISTS public.helper_route_inbox (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  route JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ
);
ALTER TABLE public.helper_route_inbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.helper_route_inbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.helper_route_inbox TO service_role;

NOTIFY pgrst, 'reload schema';
