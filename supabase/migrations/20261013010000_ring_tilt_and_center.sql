-- Поддержка некомпланарных галактических колец:
--   * возможность сменить центр расчёта (не только Sagittarius A*);
--   * высотное смещение центра кольца относительно галактической плоскости (-5000..+5000 св.л);
--   * наклон (tilt) плоскости кольца в градусах 0..180.
-- При tilt=0 кольцо лежит в галактической плоскости (поведение не меняется);
-- при больших наклонах серверная логика зажимает высотное смещение так, чтобы
-- кольцо не выходило за ±6000 св.л от галактической плоскости (толщина диска).

ALTER TABLE atlas_ring_sessions
  ADD COLUMN IF NOT EXISTS center_system TEXT,
  ADD COLUMN IF NOT EXISTS height_offset DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS tilt_degrees DOUBLE PRECISION;

-- Ограничения на диапазоны (NULL == значение по умолчанию).
ALTER TABLE atlas_ring_sessions
  ADD CONSTRAINT ring_height_offset_range
    CHECK (height_offset IS NULL OR (height_offset >= -5000 AND height_offset <= 5000)),
  ADD CONSTRAINT ring_tilt_degrees_range
    CHECK (tilt_degrees IS NULL OR (tilt_degrees >= 0 AND tilt_degrees <= 180));
