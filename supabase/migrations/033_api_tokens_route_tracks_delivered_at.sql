-- ============================================================
-- 033_api_tokens_route_tracks_delivered_at.sql
-- API токены для Colonial Helper, таблица маршрутов, delivered_at
-- ============================================================

-- 1. API токены пользователей
CREATE TABLE IF NOT EXISTS public.api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  is_revoked BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON public.api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON public.api_tokens(token_hash);

ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own api_tokens" ON public.api_tokens;
CREATE POLICY "Users can manage own api_tokens" ON public.api_tokens FOR ALL USING (auth.uid() = user_id);

-- 2. Добавляем delivered_at в deliveries (если ещё нет)
ALTER TABLE public.deliveries ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

-- Обновляем существующие записи: delivered_at = created_at где NULL
UPDATE public.deliveries SET delivered_at = created_at WHERE delivered_at IS NULL;

-- 3. Таблица для отслеживания маршрутов (живые маршруты)
CREATE TABLE IF NOT EXISTS public.route_tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT,
  systems JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_route_tracks_user ON public.route_tracks(user_id);

ALTER TABLE public.route_tracks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own route_tracks" ON public.route_tracks;
CREATE POLICY "Users can manage own route_tracks" ON public.route_tracks FOR ALL USING (auth.uid() = user_id);
