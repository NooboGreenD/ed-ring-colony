-- 007_eddn_dashboard.sql
CREATE INDEX IF NOT EXISTS idx_eddn_system_name ON eddn_messages(system_name);
CREATE INDEX IF NOT EXISTS idx_eddn_event_type ON eddn_messages(event_type);
CREATE INDEX IF NOT EXISTS idx_eddn_received_at ON eddn_messages(received_at DESC);

CREATE OR REPLACE VIEW eddn_system_activity AS
SELECT
  system_name,
  COUNT(*) as event_count,
  MAX(received_at) as last_event_at,
  COUNT(DISTINCT uploader_id) as unique_uploaders
FROM eddn_messages
WHERE system_name IS NOT NULL
GROUP BY system_name;

CREATE OR REPLACE VIEW eddn_hourly_stats AS
SELECT
  date_trunc('hour', received_at) as hour,
  event_type,
  COUNT(*) as count
FROM eddn_messages
GROUP BY date_trunc('hour', received_at), event_type
ORDER BY hour DESC;
