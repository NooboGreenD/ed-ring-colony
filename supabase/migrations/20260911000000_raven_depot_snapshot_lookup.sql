-- Fast lookup of the newest complete Construction Depot journal snapshot for
-- the RavenColonial MarketID. Contribution rows have no full resource list and
-- are deliberately excluded from this index.
CREATE INDEX IF NOT EXISTS idx_colonisation_events_market_depot_timestamp
  ON public.colonisation_events (market_id, event_timestamp DESC)
  WHERE construction_id IS NOT NULL;
