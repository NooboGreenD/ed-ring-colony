-- ============================================================
-- Atlas + EDDN Integration — SQL Migration for ed-ring-colony
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. Таблица поисковых сессий Atlas
CREATE TABLE IF NOT EXISTS atlas_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_system TEXT NOT NULL,
  reference_x DOUBLE PRECISION,
  reference_y DOUBLE PRECISION,
  reference_z DOUBLE PRECISION,
  cube_size_ly INT NOT NULL DEFAULT 500,
  world_types TEXT[] NOT NULL DEFAULT '{}',
  extra_filters JSONB DEFAULT '{}',
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed'))
);

-- 2. Таблица найденных систем-кандидатов
CREATE TABLE IF NOT EXISTS atlas_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id UUID REFERENCES atlas_searches(id) ON DELETE CASCADE,
  system_name TEXT NOT NULL,
  x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION,
  edsm_id BIGINT, id64 BIGINT,
  world_type TEXT NOT NULL,
  body_name TEXT,
  distance_from_ref DOUBLE PRECISION,
  distance_to_arrival DOUBLE PRECISION,
  estimated_value BIGINT,
  is_main_star BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(search_id, system_name, body_name, world_type)
);

-- 3. Таблица маршрутов Atlas (v1 — с created_by)
CREATE TABLE IF NOT EXISTS atlas_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  from_system TEXT NOT NULL,
  to_system TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'greedy' CHECK (engine IN ('greedy','weighted_astar','neutron')),
  jump_range DOUBLE PRECISION DEFAULT 30.0,
  waypoints JSONB NOT NULL DEFAULT '[]',
  total_distance_ly DOUBLE PRECISION,
  estimated_jumps INT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Таблица EDDN сообщений
CREATE TABLE IF NOT EXISTS eddn_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_ref TEXT NOT NULL,
  uploader_id TEXT,
  software_name TEXT,
  system_name TEXT,
  system_address BIGINT,
  star_pos JSONB,
  station_name TEXT,
  event_type TEXT NOT NULL,
  message JSONB NOT NULL,
  received_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Индексы
CREATE INDEX IF NOT EXISTS idx_atlas_candidates_search ON atlas_candidates(search_id);
CREATE INDEX IF NOT EXISTS idx_atlas_candidates_type ON atlas_candidates(world_type);
CREATE INDEX IF NOT EXISTS idx_atlas_candidates_system ON atlas_candidates(system_name);
CREATE INDEX IF NOT EXISTS idx_eddn_system ON eddn_messages(system_name);
CREATE INDEX IF NOT EXISTS idx_eddn_event ON eddn_messages(event_type);
CREATE INDEX IF NOT EXISTS idx_eddn_received ON eddn_messages(received_at);

-- 6. RLS
ALTER TABLE atlas_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE atlas_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE atlas_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE eddn_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS atlas_searches_select ON atlas_searches;
CREATE POLICY atlas_searches_select ON atlas_searches FOR SELECT USING (true);
DROP POLICY IF EXISTS atlas_searches_insert ON atlas_searches;
CREATE POLICY atlas_searches_insert ON atlas_searches FOR INSERT WITH CHECK (auth.uid() = created_by OR created_by IS NULL);

DROP POLICY IF EXISTS atlas_candidates_select ON atlas_candidates;
CREATE POLICY atlas_candidates_select ON atlas_candidates FOR SELECT USING (true);

DROP POLICY IF EXISTS atlas_routes_select ON atlas_routes;
CREATE POLICY atlas_routes_select ON atlas_routes FOR SELECT USING (true);
DROP POLICY IF EXISTS atlas_routes_insert ON atlas_routes;
CREATE POLICY atlas_routes_insert ON atlas_routes FOR INSERT WITH CHECK (auth.uid() = created_by OR created_by IS NULL);

DROP POLICY IF EXISTS eddn_select ON eddn_messages;
CREATE POLICY eddn_select ON eddn_messages FOR SELECT USING (true);

-- 7. Функция поиска в кубе
CREATE OR REPLACE FUNCTION atlas_candidates_in_cube(
  cx DOUBLE PRECISION, cy DOUBLE PRECISION, cz DOUBLE PRECISION,
  size_ly DOUBLE PRECISION, filter_types TEXT[] DEFAULT NULL
)
RETURNS SETOF atlas_candidates AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM atlas_candidates
  WHERE x BETWEEN cx - size_ly/2 AND cx + size_ly/2
    AND y BETWEEN cy - size_ly/2 AND cy + size_ly/2
    AND z BETWEEN cz - size_ly/2 AND cz + size_ly/2
    AND (filter_types IS NULL OR world_type = ANY(filter_types));
END;
$$ LANGUAGE plpgsql STABLE;

-- 8. Функция KNN
CREATE OR REPLACE FUNCTION atlas_nearest_candidates(
  cx DOUBLE PRECISION, cy DOUBLE PRECISION, cz DOUBLE PRECISION,
  max_results INT DEFAULT 50, filter_types TEXT[] DEFAULT NULL
)
RETURNS TABLE (id UUID, system_name TEXT, x DOUBLE PRECISION, y DOUBLE PRECISION,
               z DOUBLE PRECISION, world_type TEXT, distance DOUBLE PRECISION) AS $$
BEGIN
  RETURN QUERY
  SELECT c.id, c.system_name, c.x, c.y, c.z, c.world_type,
    SQRT(POWER(c.x - cx, 2) + POWER(c.y - cy, 2) + POWER(c.z - cz, 2)) AS distance
  FROM atlas_candidates c
  WHERE (filter_types IS NULL OR c.world_type = ANY(filter_types))
  ORDER BY distance LIMIT max_results;
END;
$$ LANGUAGE plpgsql STABLE;
