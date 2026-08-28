-- ============================================================
-- 011_squadron_system.sql — Система эскадрилий с званиями
-- Ограничение: 1 пилот = 1 эскадрилья одновременно
-- ============================================================

-- 1. Эскадрильи
CREATE TABLE IF NOT EXISTS public.squadrons (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  tag TEXT UNIQUE,
  description TEXT,
  color TEXT NOT NULL DEFAULT '#3b82f6' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  icon TEXT DEFAULT 'squadron',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','recruiting','closed','disbanded')),
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_squadrons_status ON public.squadrons(status);
CREATE INDEX IF NOT EXISTS idx_squadrons_created_by ON public.squadrons(created_by);

ALTER TABLE public.squadrons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Squadrons readable by all" ON public.squadrons;
CREATE POLICY "Squadrons readable by all" ON public.squadrons FOR SELECT USING (true);
DROP POLICY IF EXISTS "Squadron creators can manage" ON public.squadrons;
CREATE POLICY "Squadron creators can manage" ON public.squadrons FOR ALL USING (auth.uid() = created_by);

-- 2. Звания эскадрильи (5 дефолтных + до 15 кастомных = max 20)
CREATE TABLE IF NOT EXISTS public.squadron_ranks (
  id SERIAL PRIMARY KEY,
  squadron_id INTEGER NOT NULL REFERENCES public.squadrons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT false,
  can_manage_projects BOOLEAN NOT NULL DEFAULT false,
  can_manage_members BOOLEAN NOT NULL DEFAULT false,
  can_manage_ranks BOOLEAN NOT NULL DEFAULT false,
  can_edit_squadron BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(squadron_id, name)
);

CREATE INDEX IF NOT EXISTS idx_squadron_ranks_squadron ON public.squadron_ranks(squadron_id);

ALTER TABLE public.squadron_ranks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Squadron ranks readable by all" ON public.squadron_ranks;
CREATE POLICY "Squadron ranks readable by all" ON public.squadron_ranks FOR SELECT USING (true);
DROP POLICY IF EXISTS "Squadron leaders manage ranks" ON public.squadron_ranks;
CREATE POLICY "Squadron leaders manage ranks" ON public.squadron_ranks FOR ALL USING (
  public.is_squadron_rank_manager(squadron_ranks.squadron_id, auth.uid())
);

-- 3. Участники эскадрильи — ОГРАНИЧЕНИЕ: 1 пилот = 1 эскадрилья
CREATE TABLE IF NOT EXISTS public.squadron_members (
  id SERIAL PRIMARY KEY,
  squadron_id INTEGER NOT NULL REFERENCES public.squadrons(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rank_id INTEGER REFERENCES public.squadron_ranks(id) ON DELETE SET NULL,
  callsign TEXT,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(squadron_id, user_id)
);

-- Уникальный индекс: один пилот — одна эскадрилья
CREATE UNIQUE INDEX IF NOT EXISTS idx_squadron_members_user_unique ON public.squadron_members(user_id);

CREATE INDEX IF NOT EXISTS idx_squadron_members_squadron ON public.squadron_members(squadron_id);

ALTER TABLE public.squadron_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Squadron members readable by all" ON public.squadron_members;
CREATE POLICY "Squadron members readable by all" ON public.squadron_members FOR SELECT USING (true);
DROP POLICY IF EXISTS "Users manage own squadron membership" ON public.squadron_members;
CREATE POLICY "Users manage own squadron membership" ON public.squadron_members FOR ALL USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Squadron leaders can manage members" ON public.squadron_members;
CREATE POLICY "Squadron leaders can manage members" ON public.squadron_members FOR ALL USING (
  public.is_squadron_leader(squadron_members.squadron_id, auth.uid())
);

-- 4. Связь проектов с эскадрильями
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS squadron_id INTEGER REFERENCES public.squadrons(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_projects_squadron ON public.projects(squadron_id);

-- 5. Представление сводки по эскадрилье
CREATE OR REPLACE VIEW public.squadron_summary AS
SELECT
  s.id,
  s.name,
  s.tag,
  s.description,
  s.color,
  s.icon,
  s.status,
  s.created_by,
  s.created_at,
  COUNT(DISTINCT sm.user_id) as member_count,
  COUNT(DISTINCT p.id) as project_count
FROM public.squadrons s
LEFT JOIN public.squadron_members sm ON sm.squadron_id = s.id
LEFT JOIN public.projects p ON p.squadron_id = s.id
GROUP BY s.id, s.name, s.tag, s.description, s.color, s.icon, s.status, s.created_by, s.created_at;

-- 6. Функция: вставка дефолтных 5 званий при создании эскадрильи
CREATE OR REPLACE FUNCTION public.create_default_squadron_ranks(squadron_id INTEGER)
RETURNS void AS $$
BEGIN
  INSERT INTO public.squadron_ranks (squadron_id, name, sort_order, is_default, can_manage_projects, can_manage_members, can_manage_ranks, can_edit_squadron)
  VALUES
    (squadron_id, 'Командир эскадрильи', 1, true, true, true, true, true),
    (squadron_id, 'Заместитель командира', 2, true, true, true, false, false),
    (squadron_id, 'Офицер', 3, true, true, true, false, false),
    (squadron_id, 'Ветеран', 4, true, true, false, false, false),
    (squadron_id, 'Пилот', 5, true, false, false, false, false);
END;
$$ LANGUAGE plpgsql;

-- 7. Триггер: авто-создание званий и назначение командира
CREATE OR REPLACE FUNCTION public.on_squadron_created()
RETURNS TRIGGER AS $$
DECLARE
  cmdr_rank_id INTEGER;
BEGIN
  PERFORM public.create_default_squadron_ranks(NEW.id);

  SELECT id INTO cmdr_rank_id FROM public.squadron_ranks
    WHERE squadron_id = NEW.id AND name = 'Командир эскадрильи';

  IF cmdr_rank_id IS NOT NULL THEN
    INSERT INTO public.squadron_members (squadron_id, user_id, rank_id)
    VALUES (NEW.id, NEW.created_by, cmdr_rank_id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS squadron_created_trigger ON public.squadrons;
CREATE TRIGGER squadron_created_trigger
  AFTER INSERT ON public.squadrons
  FOR EACH ROW
  EXECUTE FUNCTION public.on_squadron_created();

-- 8. Функция: проверка лимита званий (max 20)
CREATE OR REPLACE FUNCTION public.check_squadron_rank_limit()
RETURNS TRIGGER AS $$
DECLARE
  rank_count INTEGER;
  max_ranks CONSTANT INTEGER := 20;
BEGIN
  SELECT COUNT(*) INTO rank_count FROM public.squadron_ranks
  WHERE squadron_id = NEW.squadron_id;

  IF rank_count >= max_ranks THEN
    RAISE EXCEPTION 'Достигнут лимит званий (max %)', max_ranks;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS squadron_rank_limit_trigger ON public.squadron_ranks;
CREATE TRIGGER squadron_rank_limit_trigger
  BEFORE INSERT ON public.squadron_ranks
  FOR EACH ROW
  EXECUTE FUNCTION public.check_squadron_rank_limit();

-- 9. Триггер обновления updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS squadrons_updated_at ON public.squadrons;
CREATE TRIGGER squadrons_updated_at
  BEFORE UPDATE ON public.squadrons
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- 10. Функция: проверка, что приглашаемый пилот не в другой эскадрилье
CREATE OR REPLACE FUNCTION public.can_join_squadron(target_user_id UUID, target_squadron_id INTEGER)
RETURNS BOOLEAN AS $$
DECLARE
  existing_squadron INTEGER;
BEGIN
  SELECT squadron_id INTO existing_squadron
  FROM public.squadron_members
  WHERE user_id = target_user_id;

  IF existing_squadron = target_squadron_id THEN
    RETURN true;
  END IF;

  IF existing_squadron IS NOT NULL THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$ LANGUAGE plpgsql STABLE;

-- 10a. Функция: проверка прав лидера (обходит RLS через SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.is_squadron_leader(check_squadron_id INTEGER, check_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.squadron_members sm
    JOIN public.squadron_ranks sr ON sr.id = sm.rank_id
    WHERE sm.squadron_id = check_squadron_id
      AND sm.user_id = check_user_id
      AND sr.can_manage_members = true
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 10b. Функция: проверка прав управления званиями (обходит RLS через SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.is_squadron_rank_manager(check_squadron_id INTEGER, check_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.squadron_members sm
    JOIN public.squadron_ranks sr ON sr.id = sm.rank_id
    WHERE sm.squadron_id = check_squadron_id
      AND sm.user_id = check_user_id
      AND sr.can_manage_ranks = true
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 11. Представление: полные данные члена эскадрильи с званием
CREATE OR REPLACE VIEW public.squadron_member_detail AS
SELECT
  sm.id,
  sm.squadron_id,
  sm.user_id,
  sm.rank_id,
  sm.callsign,
  sm.joined_at,
  sr.name as rank_name,
  sr.sort_order as rank_order,
  sr.is_default,
  sr.can_manage_projects,
  sr.can_manage_members,
  sr.can_manage_ranks,
  sr.can_edit_squadron,
  p.cmdr_name,
  p.avatar_url
FROM public.squadron_members sm
LEFT JOIN public.squadron_ranks sr ON sr.id = sm.rank_id
LEFT JOIN public.profiles p ON p.id = sm.user_id;

-- 13. Обновление project_summary: добавляем squadron_id и squadron_name
CREATE OR REPLACE VIEW public.project_summary AS
SELECT
  p.id,
  p.name,
  p.description,
  p.color,
  p.icon,
  p.status,
  p.squadron_id,
  sq.name as squadron_name,
  p.created_by,
  p.created_at,
  COUNT(DISTINCT pm.user_id) as member_count,
  COUNT(DISTINCT ps.id) as system_count,
  COUNT(DISTINCT ps.id) FILTER (WHERE ps.planned_status = 'done') as systems_done,
  COUNT(DISTINCT ps.id) FILTER (WHERE ps.planned_status = 'building') as systems_building,
  MAX(ps.target_date) as latest_target_date
FROM public.projects p
LEFT JOIN public.squadrons sq ON sq.id = p.squadron_id
LEFT JOIN public.project_members pm ON pm.project_id = p.id
LEFT JOIN public.project_systems ps ON ps.project_id = p.id
GROUP BY p.id, p.name, p.description, p.color, p.icon, p.status, p.squadron_id, sq.name, p.created_by, p.created_at;
