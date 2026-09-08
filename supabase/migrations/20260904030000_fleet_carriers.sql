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
