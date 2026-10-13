-- Дополнительные колонки для сессий галактического кольца:
--   • deviation_limit — пользовательский допуск отклонения от окружности (св.л.)
--   • key_systems     — JSONB-массив обязательных (ключевых) систем с координатами
-- Обе колонки опциональны (NULL = значение по умолчанию), чтобы не ломать
-- существующие сессии.

ALTER TABLE public.atlas_ring_sessions
  ADD COLUMN IF NOT EXISTS deviation_limit DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS key_systems    JSONB;

COMMENT ON COLUMN public.atlas_ring_sessions.deviation_limit
  IS 'Пользовательский допуск отклонения от окружности кольца, св.л. NULL = 100 (по умолчанию).';
COMMENT ON COLUMN public.atlas_ring_sessions.key_systems
  IS 'Массив ключевых (обязательных) систем: [{name, x, y, z}], через которые должен пройти маршрут.';
