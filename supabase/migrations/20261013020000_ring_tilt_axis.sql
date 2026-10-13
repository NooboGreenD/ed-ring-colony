-- Двусторонний наклон и азимут оси. NULL/0 сохраняет геометрию старых сессий.
ALTER TABLE public.atlas_ring_sessions
  ADD COLUMN IF NOT EXISTS tilt_axis_degrees DOUBLE PRECISION;

ALTER TABLE public.atlas_ring_sessions
  DROP CONSTRAINT IF EXISTS ring_tilt_degrees_range;
ALTER TABLE public.atlas_ring_sessions
  ADD CONSTRAINT ring_tilt_degrees_range
    CHECK (tilt_degrees IS NULL OR tilt_degrees BETWEEN -180 AND 180);

ALTER TABLE public.atlas_ring_sessions
  DROP CONSTRAINT IF EXISTS ring_tilt_axis_degrees_range;
ALTER TABLE public.atlas_ring_sessions
  ADD CONSTRAINT ring_tilt_axis_degrees_range
    CHECK (tilt_axis_degrees IS NULL OR (tilt_axis_degrees >= 0 AND tilt_axis_degrees < 360));
