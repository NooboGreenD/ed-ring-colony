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
