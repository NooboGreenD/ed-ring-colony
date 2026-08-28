-- ============================================================
-- 010_project_squadrons.sql — Система проектов (эскадрилий)
-- ============================================================

-- 1. Проекты / Эскадрильи
CREATE TABLE IF NOT EXISTS public.projects (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT NOT NULL DEFAULT '#3b82f6' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  icon TEXT DEFAULT 'squadron',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','archived')),
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON public.projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_created_by ON public.projects(created_by);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Projects readable by all" ON public.projects;
CREATE POLICY "Projects readable by all" ON public.projects FOR SELECT USING (true);
DROP POLICY IF EXISTS "Project creators can manage" ON public.projects;
CREATE POLICY "Project creators can manage" ON public.projects FOR ALL USING (auth.uid() = created_by);

-- 2. Участники проекта
CREATE TABLE IF NOT EXISTS public.project_members (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('leader','officer','member')),
  callsign TEXT,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_members_project ON public.project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON public.project_members(user_id);

-- 2a. Триггер: авто-добавление создателя проекта как leader
CREATE OR REPLACE FUNCTION public.on_project_created()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.project_members (project_id, user_id, role)
  VALUES (NEW.id, NEW.created_by, 'leader')
  ON CONFLICT (project_id, user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS project_created_trigger ON public.projects;
CREATE TRIGGER project_created_trigger
  AFTER INSERT ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.on_project_created();

-- 2b. Функция: проверка прав управления проектом (обходит RLS)
CREATE OR REPLACE FUNCTION public.is_project_manager(check_project_id INTEGER, check_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.project_members pm
    WHERE pm.project_id = check_project_id
      AND pm.user_id = check_user_id
      AND pm.role IN ('leader', 'officer')
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Project members readable by all" ON public.project_members;
CREATE POLICY "Project members readable by all" ON public.project_members FOR SELECT USING (true);
DROP POLICY IF EXISTS "Users manage own membership" ON public.project_members;
CREATE POLICY "Users manage own membership" ON public.project_members FOR ALL USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Project leaders can manage members" ON public.project_members;
CREATE POLICY "Project leaders can manage members" ON public.project_members FOR ALL USING (
  public.is_project_manager(project_members.project_id, auth.uid())
);

-- 3. Системы в проекте
CREATE TABLE IF NOT EXISTS public.project_systems (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  system_name TEXT NOT NULL,
  route_system_id INTEGER REFERENCES public.route_systems(id) ON DELETE SET NULL,
  hub_id INTEGER REFERENCES public.hubs(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  planned_status TEXT NOT NULL DEFAULT 'planned' CHECK (planned_status IN ('planned','preparing','building','done','on_hold')),
  priority INTEGER NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 5),
  notes TEXT,
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  target_date DATE,
  added_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_systems_project ON public.project_systems(project_id);
CREATE INDEX IF NOT EXISTS idx_project_systems_sort ON public.project_systems(project_id, sort_order);

ALTER TABLE public.project_systems ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Project systems readable by all" ON public.project_systems;
CREATE POLICY "Project systems readable by all" ON public.project_systems FOR SELECT USING (true);
DROP POLICY IF EXISTS "Project leaders can manage systems" ON public.project_systems;
CREATE POLICY "Project leaders can manage systems" ON public.project_systems FOR ALL USING (
  public.is_project_manager(project_systems.project_id, auth.uid())
);

-- 4. Планы строительства в рамках проекта
CREATE TABLE IF NOT EXISTS public.project_build_plans (
  id SERIAL PRIMARY KEY,
  project_system_id INTEGER NOT NULL REFERENCES public.project_systems(id) ON DELETE CASCADE,
  build_type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 5),
  planned_start DATE,
  planned_end DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_build_plans_system ON public.project_build_plans(project_system_id);

ALTER TABLE public.project_build_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Build plans readable by all" ON public.project_build_plans;
CREATE POLICY "Build plans readable by all" ON public.project_build_plans FOR SELECT USING (true);
DROP POLICY IF EXISTS "Project leaders can manage plans" ON public.project_build_plans;
CREATE POLICY "Project leaders can manage plans" ON public.project_build_plans FOR ALL USING (
  EXISTS (
    SELECT 1 FROM public.project_systems ps
    WHERE ps.id = project_build_plans.project_system_id
      AND public.is_project_manager(ps.project_id, auth.uid())
  )
);

-- 5. Представление: сводка по проекту
CREATE OR REPLACE VIEW public.project_summary AS
SELECT 
  p.id,
  p.name,
  p.description,
  p.color,
  p.icon,
  p.status,
  p.created_by,
  p.created_at,
  COUNT(DISTINCT pm.user_id) as member_count,
  COUNT(DISTINCT ps.id) as system_count,
  COUNT(DISTINCT ps.id) FILTER (WHERE ps.planned_status = 'done') as systems_done,
  COUNT(DISTINCT ps.id) FILTER (WHERE ps.planned_status = 'building') as systems_building,
  MAX(ps.target_date) as latest_target_date
FROM public.projects p
LEFT JOIN public.project_members pm ON pm.project_id = p.id
LEFT JOIN public.project_systems ps ON ps.project_id = p.id
GROUP BY p.id, p.name, p.description, p.color, p.icon, p.status, p.created_by, p.created_at;

-- 6. Функция: оптимальный маршрут проекта (жадный по координатам)
CREATE OR REPLACE FUNCTION public.get_project_route(project_id INTEGER)
RETURNS TABLE (
  system_name TEXT,
  x DOUBLE PRECISION,
  y DOUBLE PRECISION,
  z DOUBLE PRECISION,
  sort_order INTEGER,
  distance_from_prev DOUBLE PRECISION,
  cumulative_distance DOUBLE PRECISION
) AS $$
DECLARE
  prev_x DOUBLE PRECISION;
  prev_y DOUBLE PRECISION;
  prev_z DOUBLE PRECISION;
  cum DOUBLE PRECISION := 0;
  d DOUBLE PRECISION;
BEGIN
  FOR system_name, x, y, z, sort_order IN
    SELECT 
      ps.system_name,
      COALESCE(h.x, rs.x, 0::DOUBLE PRECISION) as x,
      COALESCE(h.y, rs.y, 0::DOUBLE PRECISION) as y,
      COALESCE(h.z, rs.z, 0::DOUBLE PRECISION) as z,
      ps.sort_order
    FROM public.project_systems ps
    LEFT JOIN public.hubs h ON h.id = ps.hub_id
    LEFT JOIN public.route_systems rs ON rs.id = ps.route_system_id
    WHERE ps.project_id = $1
    ORDER BY ps.sort_order
  LOOP
    IF prev_x IS NOT NULL THEN
      d := sqrt((x - prev_x)^2 + (y - prev_y)^2 + (z - prev_z)^2);
      cum := cum + d;
    ELSE
      d := 0;
    END IF;

    distance_from_prev := d;
    cumulative_distance := cum;

    RETURN NEXT;

    prev_x := x;
    prev_y := y;
    prev_z := z;
  END LOOP;
END;
$$ LANGUAGE plpgsql STABLE;

-- 7. Триггер обновления updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_updated_at ON public.projects;
CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
