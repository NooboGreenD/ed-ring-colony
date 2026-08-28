-- 003_atlas_async_and_favorites.sql
ALTER TABLE IF EXISTS atlas_searches
  ADD COLUMN IF NOT EXISTS total_found INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE TABLE IF NOT EXISTS atlas_favorites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  candidate_id UUID,
  search_id UUID REFERENCES atlas_searches(id) ON DELETE CASCADE,
  system_name TEXT NOT NULL,
  x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION,
  world_type TEXT NOT NULL,
  body_name TEXT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, system_name, world_type)
);

ALTER TABLE atlas_favorites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own favorites" ON atlas_favorites;
CREATE POLICY "Users can manage own favorites"
  ON atlas_favorites FOR ALL USING (auth.uid() = user_id);

-- atlas_routes уже создана в 001 с полем created_by.
-- Добавляем недостающие колонки для совместимости с 003.
ALTER TABLE IF EXISTS atlas_routes
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE IF EXISTS atlas_routes
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT false;

-- Пересоздаём политики, используя обе колонки для совместимости
ALTER TABLE atlas_routes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own routes" ON atlas_routes;
CREATE POLICY "Users can manage own routes"
  ON atlas_routes FOR ALL
  USING (auth.uid() = user_id OR auth.uid() = created_by OR user_id IS NULL);

DROP POLICY IF EXISTS "Public routes are readable" ON atlas_routes;
CREATE POLICY "Public routes are readable"
  ON atlas_routes FOR SELECT USING (is_public = true);

CREATE INDEX IF NOT EXISTS idx_atlas_favorites_user ON atlas_favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_atlas_routes_user ON atlas_routes(user_id);
