-- Системы маршрута (не хабы). Выполнить в SQL Editor Supabase один раз.
-- Список может быть длинным: уникальность по имени без учёта регистра.

CREATE TABLE IF NOT EXISTS public.route_systems (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  system_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS route_systems_system_name_lower
  ON public.route_systems (LOWER(system_name));

CREATE INDEX IF NOT EXISTS route_systems_sort_order_idx
  ON public.route_systems (sort_order, id);

ALTER TABLE public.route_systems ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS route_systems_select ON public.route_systems;
CREATE POLICY route_systems_select
  ON public.route_systems
  FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS route_systems_insert ON public.route_systems;
CREATE POLICY route_systems_insert
  ON public.route_systems
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')
    )
  );

DROP POLICY IF EXISTS route_systems_update ON public.route_systems;
CREATE POLICY route_systems_update
  ON public.route_systems
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')
    )
  );

DROP POLICY IF EXISTS route_systems_delete ON public.route_systems;
CREATE POLICY route_systems_delete
  ON public.route_systems
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'moderator')
    )
  );

GRANT SELECT ON public.route_systems TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.route_systems TO authenticated;
