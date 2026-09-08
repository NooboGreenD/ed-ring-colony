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
