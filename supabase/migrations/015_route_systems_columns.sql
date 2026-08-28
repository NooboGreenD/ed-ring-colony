-- ============================================================
-- 015_route_systems_columns.sql — Добавление недостающих столбцов
-- к таблице route_systems
-- ============================================================

-- Добавляем недостающие столбцы (IF NOT EXISTS — безопасно)
ALTER TABLE public.route_systems
  ADD COLUMN IF NOT EXISTS x DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS y DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS z DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'planned',
  ADD COLUMN IF NOT EXISTS progress INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_hub BOOLEAN NOT NULL DEFAULT false;

-- Проверка/добавление CHECK-ограничений
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'route_systems_status_check'
  ) THEN
    ALTER TABLE public.route_systems
      ADD CONSTRAINT route_systems_status_check
      CHECK (status IN ('planned','preparing','building','done','on_hold'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'route_systems_progress_check'
  ) THEN
    ALTER TABLE public.route_systems
      ADD CONSTRAINT route_systems_progress_check
      CHECK (progress BETWEEN 0 AND 100);
  END IF;
END $$;

-- Убеждаемся, что RLS позволяет чтение всем
DROP POLICY IF EXISTS route_systems_select ON public.route_systems;
CREATE POLICY route_systems_select
  ON public.route_systems FOR SELECT TO anon, authenticated USING (true);

GRANT SELECT ON public.route_systems TO anon, authenticated;
