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
