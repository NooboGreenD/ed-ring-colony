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
