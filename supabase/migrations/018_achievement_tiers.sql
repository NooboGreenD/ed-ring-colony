-- ============================================================
-- 018_achievement_tiers.sql
-- Система достижений с тирами (Inara-style)
-- 7 треков × 5 тиров + геройские бейджи
-- ============================================================

-- 1. Треки достижений
CREATE TABLE IF NOT EXISTS public.achievement_tracks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL,
  color TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  metric_type TEXT NOT NULL CHECK (metric_type IN ('cargo','commodity','hubs','ops','architect')),
  match_commodity TEXT, -- для commodity-type: steel | titanium | cmm
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Ранги (тиры) внутри трека
CREATE TABLE IF NOT EXISTS public.achievement_ranks (
  id SERIAL PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES public.achievement_tracks(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 5),
  threshold INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  UNIQUE(track_id, rank)
);

-- 3. Достижения пользователей (только лучший тир по треку)
CREATE TABLE IF NOT EXISTS public.user_achievements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES public.achievement_tracks(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 5),
  awarded_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, track_id)
);

-- 4. Геройские бейджи (overflow за пределы Tier 5)
CREATE TABLE IF NOT EXISTS public.hero_badges (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES public.achievement_tracks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.user_hero_badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  badge_id TEXT NOT NULL REFERENCES public.hero_badges(id) ON DELETE CASCADE,
  awarded_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, badge_id)
);

-- 5. Таблица архитекторских систем (для трека architect)
CREATE TABLE IF NOT EXISTS public.architect_systems (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  cmdr_name TEXT NOT NULL,
  system_name TEXT NOT NULL,
  awarded_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(cmdr_name, system_name)
);

-- ============================================================
-- Seed data
-- ============================================================

INSERT INTO public.achievement_tracks (id, title, subtitle, color, icon, sort_order, metric_type, match_commodity) VALUES
  ('cargo',      'Экспедиционер',       'Общий тоннаж доставок',       '#ff9d2e', '⚓', 1, 'cargo',      NULL),
  ('steel',      'Металлург',           'Завезено стали',              '#cbd5e1', '⚙️', 2, 'commodity',  'steel'),
  ('titanium',   'Титановый мастер',    'Завезено титана',             '#7dd3fc', '💎', 3, 'commodity',  'titanium'),
  ('cmm',        'Композитчик',         'Завезено CMM-композита',      '#c4b5fd', '🛡️', 4, 'commodity',  'cmm'),
  ('hubs',       'Первооткрыватель',    'Уникальные хабы',             '#34d399', '🌌', 5, 'hubs',       NULL),
  ('ops',        'Оперативник',         'Количество операций',         '#f472b6', '📡', 6, 'ops',        NULL),
  ('architect',  'Архитектор',          'Системы как архитектор',      '#22c55e', '🏗️', 7, 'architect',  NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.achievement_ranks (track_id, rank, threshold, name, description) VALUES
  ('cargo',     1, 1000,    'Космический курьер',      '1 000+ т груза'),
  ('cargo',     2, 10000,   'Грузовой агент',          '10 000+ т груза'),
  ('cargo',     3, 50000,   'Караванщик',              '50 000+ т груза'),
  ('cargo',     4, 100000,  'Флотоводец',              '100 000+ т груза'),
  ('cargo',     5, 500000,  'Легенда кольца',          '500 000+ т груза'),
  ('steel',     1, 1000,    'Стальной след',           '1 000+ т стали'),
  ('steel',     2, 5000,    'Литейщик',                '5 000+ т стали'),
  ('steel',     3, 25000,   'Стальной хребет',         '25 000+ т стали'),
  ('steel',     4, 100000,  'Кузнец кольца',           '100 000+ т стали'),
  ('steel',     5, 250000,  'Владыка стали',           '250 000+ т стали'),
  ('titanium',  1, 1000,    'Титановый след',          '1 000+ т титана'),
  ('titanium',  2, 5000,    'Титановый каркас',        '5 000+ т титана'),
  ('titanium',  3, 25000,   'Титановый щит',           '25 000+ т титана'),
  ('titanium',  4, 100000,  'Титановая крепость',      '100 000+ т титана'),
  ('titanium',  5, 250000,  'Титановый колосс',        '250 000+ т титана'),
  ('cmm',       1, 1000,    'Первый слой',             '1 000+ т CMM-композита'),
  ('cmm',       2, 5000,    'Матрица CMM',             '5 000+ т CMM-композита'),
  ('cmm',       3, 25000,   'Композитный каркас',      '25 000+ т CMM-композита'),
  ('cmm',       4, 100000,  'Броня CMM',               '100 000+ т CMM-композита'),
  ('cmm',       5, 250000,  'Мастер композита',        '250 000+ т CMM-композита'),
  ('hubs',      1, 5,       'Звёздный странник',        '5+ хабов'),
  ('hubs',      2, 15,      'Планетарный скаут',       '15+ хабов'),
  ('hubs',      3, 30,      'Исследователь кольца',    '30+ хабов'),
  ('hubs',      4, 60,      'Картограф хабов',         '60+ хабов'),
  ('hubs',      5, 100,     'Властелин галактики',     '100+ хабов'),
  ('ops',       1, 10,      'Новичок',                 '10+ операций'),
  ('ops',       2, 50,      'Оператор',                '50+ операций'),
  ('ops',       3, 200,     'Ветеран маршрута',        '200+ операций'),
  ('ops',       4, 500,     'Диспетчер кольца',        '500+ операций'),
  ('ops',       5, 2000,    'Командир операций',       '2 000+ операций'),
  ('architect', 1, 5,       'Звёздный пионер',         '5+ систем как архитектор'),
  ('architect', 2, 20,      'Колониальный застройщик', '20+ систем как архитектор'),
  ('architect', 3, 50,      'Архитектор кольца',       '50+ систем как архитектор'),
  ('architect', 4, 100,     'Магистр колонизации',     '100+ систем как архитектор'),
  ('architect', 5, 250,     'Легенда RavenColonial',   '250+ систем как архитектор')
ON CONFLICT DO NOTHING;

INSERT INTO public.hero_badges (id, track_id, name, description, icon, color, threshold, sort_order) VALUES
  ('hero_cargo',     'cargo',     'Герой экспедиции',       '1 000 000+ тонн груза',           '👑', '#fbbf24', 1000000, 1),
  ('hero_steel',     'steel',     'Стальная легенда',       '500 000+ тонн стали',             '⚔️', '#e2e8f0', 500000,  2),
  ('hero_titanium',  'titanium',  'Титановый бог',          '500 000+ тонн титана',            '💠', '#7dd3fc', 500000,  3),
  ('hero_cmm',       'cmm',       'Композитный оверлорд',   '500 000+ тонн CMM',               '🏰', '#c4b5fd', 500000,  4),
  ('hero_architect', 'architect', 'Властелин галактики',    '1 000+ систем как архитектор',    '🌠', '#fbbf24', 1000,    5),
  ('hero_hubs',      'hubs',      'Галактический странник', '200+ уникальных хабов',           '🚀', '#34d399', 200,     6),
  ('hero_ops',       'ops',       'Машина доставок',        '10 000+ операций',                '⚡', '#f472b6', 10000,   7)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Functions
-- ============================================================

-- Нормализация названия commodity для матчинга
CREATE OR REPLACE FUNCTION public.normalize_commodity(c TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN LOWER(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(c, '^\$', ''), '_name;$', ''), '[^a-zа-яё0-9]+', '', 'g'));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Пересчёт достижений одного пользователя
CREATE OR REPLACE FUNCTION public.recalculate_user_achievements(p_user_id UUID)
RETURNS void AS $$
DECLARE
  track_rec RECORD;
  rank_rec RECORD;
  current_val INTEGER;
  best_rank INTEGER;
BEGIN
  FOR track_rec IN SELECT * FROM public.achievement_tracks ORDER BY sort_order
  LOOP
    CASE track_rec.metric_type
      WHEN 'cargo' THEN
        SELECT COALESCE(SUM(amount), 0)::INTEGER INTO current_val
        FROM public.deliveries WHERE user_id = p_user_id;

      WHEN 'commodity' THEN
        SELECT COALESCE(SUM(amount), 0)::INTEGER INTO current_val
        FROM public.deliveries
        WHERE user_id = p_user_id
          AND public.normalize_commodity(commodity) LIKE
            CASE track_rec.match_commodity
              WHEN 'steel'     THEN '%steel%'
              WHEN 'titanium'  THEN '%titanium%'
              WHEN 'cmm'       THEN '%cmm%'
            END;

      WHEN 'hubs' THEN
        SELECT COUNT(DISTINCT system_name)::INTEGER INTO current_val
        FROM public.deliveries
        WHERE user_id = p_user_id AND is_hub = TRUE;

      WHEN 'ops' THEN
        SELECT COUNT(*)::INTEGER INTO current_val
        FROM public.deliveries WHERE user_id = p_user_id;

      WHEN 'architect' THEN
        SELECT COUNT(*)::INTEGER INTO current_val
        FROM public.architect_systems WHERE user_id = p_user_id;
    END CASE;

    best_rank := 0;
    FOR rank_rec IN
      SELECT rank FROM public.achievement_ranks
      WHERE track_id = track_rec.id AND threshold <= current_val
      ORDER BY rank DESC LIMIT 1
    LOOP
      best_rank := rank_rec.rank;
    END LOOP;

    IF best_rank > 0 THEN
      INSERT INTO public.user_achievements (user_id, track_id, rank)
      VALUES (p_user_id, track_rec.id, best_rank)
      ON CONFLICT (user_id, track_id)
      DO UPDATE SET rank = EXCLUDED.rank, awarded_at = NOW();
    ELSE
      DELETE FROM public.user_achievements
      WHERE user_id = p_user_id AND track_id = track_rec.id;
    END IF;
  END LOOP;

  PERFORM public.recalculate_user_hero_badges(p_user_id);
END;
$$ LANGUAGE plpgsql;

-- Пересчёт геройских бейджей
CREATE OR REPLACE FUNCTION public.recalculate_user_hero_badges(p_user_id UUID)
RETURNS void AS $$
DECLARE
  badge_rec RECORD;
  current_val INTEGER;
BEGIN
  FOR badge_rec IN SELECT * FROM public.hero_badges ORDER BY sort_order
  LOOP
    CASE badge_rec.track_id
      WHEN 'cargo' THEN
        SELECT COALESCE(SUM(amount), 0)::INTEGER INTO current_val
        FROM public.deliveries WHERE user_id = p_user_id;
      WHEN 'steel' THEN
        SELECT COALESCE(SUM(amount), 0)::INTEGER INTO current_val
        FROM public.deliveries WHERE user_id = p_user_id AND public.normalize_commodity(commodity) LIKE '%steel%';
      WHEN 'titanium' THEN
        SELECT COALESCE(SUM(amount), 0)::INTEGER INTO current_val
        FROM public.deliveries WHERE user_id = p_user_id AND public.normalize_commodity(commodity) LIKE '%titanium%';
      WHEN 'cmm' THEN
        SELECT COALESCE(SUM(amount), 0)::INTEGER INTO current_val
        FROM public.deliveries WHERE user_id = p_user_id AND public.normalize_commodity(commodity) LIKE '%cmm%';
      WHEN 'hubs' THEN
        SELECT COUNT(DISTINCT system_name)::INTEGER INTO current_val
        FROM public.deliveries WHERE user_id = p_user_id AND is_hub = TRUE;
      WHEN 'ops' THEN
        SELECT COUNT(*)::INTEGER INTO current_val
        FROM public.deliveries WHERE user_id = p_user_id;
      WHEN 'architect' THEN
        SELECT COUNT(*)::INTEGER INTO current_val
        FROM public.architect_systems WHERE user_id = p_user_id;
    END CASE;

    IF current_val >= badge_rec.threshold THEN
      INSERT INTO public.user_hero_badges (user_id, badge_id)
      VALUES (p_user_id, badge_rec.id)
      ON CONFLICT (user_id, badge_id) DO NOTHING;
    ELSE
      DELETE FROM public.user_hero_badges
      WHERE user_id = p_user_id AND badge_id = badge_rec.id;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Триггер: автопересчёт при новой доставке
CREATE OR REPLACE FUNCTION public.on_delivery_insert()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM public.recalculate_user_achievements(NEW.user_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_delivery_achievements ON public.deliveries;
CREATE TRIGGER trg_delivery_achievements
AFTER INSERT ON public.deliveries
FOR EACH ROW
EXECUTE FUNCTION public.on_delivery_insert();

-- ============================================================
-- RPC: достижения пользователя одним запросом
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_user_achievements(p_user_id UUID)
RETURNS TABLE (
  track_id TEXT,
  track_title TEXT,
  track_subtitle TEXT,
  track_color TEXT,
  track_icon TEXT,
  current_rank INTEGER,
  current_rank_name TEXT,
  current_rank_desc TEXT,
  next_rank INTEGER,
  next_rank_threshold INTEGER,
  next_rank_name TEXT,
  progress_val INTEGER,
  total_val INTEGER
) AS $$
BEGIN
  RETURN QUERY
  WITH user_totals AS (
    SELECT
      (SELECT COALESCE(SUM(amount), 0)::INTEGER FROM public.deliveries WHERE user_id = p_user_id) as cargo_total,
      (SELECT COALESCE(SUM(amount), 0)::INTEGER FROM public.deliveries WHERE user_id = p_user_id AND public.normalize_commodity(commodity) LIKE '%steel%') as steel_total,
      (SELECT COALESCE(SUM(amount), 0)::INTEGER FROM public.deliveries WHERE user_id = p_user_id AND public.normalize_commodity(commodity) LIKE '%titanium%') as titanium_total,
      (SELECT COALESCE(SUM(amount), 0)::INTEGER FROM public.deliveries WHERE user_id = p_user_id AND public.normalize_commodity(commodity) LIKE '%cmm%') as cmm_total,
      (SELECT COUNT(DISTINCT system_name)::INTEGER FROM public.deliveries WHERE user_id = p_user_id AND is_hub = TRUE) as hubs_total,
      (SELECT COUNT(*)::INTEGER FROM public.deliveries WHERE user_id = p_user_id) as ops_total,
      (SELECT COUNT(*)::INTEGER FROM public.architect_systems WHERE user_id = p_user_id) as architect_total
  )
  SELECT
    t.id,
    t.title,
    t.subtitle,
    t.color,
    t.icon,
    COALESCE(ua.rank, 0),
    COALESCE(ar.name, ''),
    COALESCE(ar.description, ''),
    COALESCE(nr.rank, 0),
    COALESCE(nr.threshold, 0),
    COALESCE(nr.name, ''),
    CASE t.id
      WHEN 'cargo' THEN ut.cargo_total WHEN 'steel' THEN ut.steel_total
      WHEN 'titanium' THEN ut.titanium_total WHEN 'cmm' THEN ut.cmm_total
      WHEN 'hubs' THEN ut.hubs_total WHEN 'ops' THEN ut.ops_total
      WHEN 'architect' THEN ut.architect_total ELSE 0
    END,
    CASE t.id
      WHEN 'cargo' THEN ut.cargo_total WHEN 'steel' THEN ut.steel_total
      WHEN 'titanium' THEN ut.titanium_total WHEN 'cmm' THEN ut.cmm_total
      WHEN 'hubs' THEN ut.hubs_total WHEN 'ops' THEN ut.ops_total
      WHEN 'architect' THEN ut.architect_total ELSE 0
    END
  FROM public.achievement_tracks t
  CROSS JOIN user_totals ut
  LEFT JOIN public.user_achievements ua ON ua.track_id = t.id AND ua.user_id = p_user_id
  LEFT JOIN public.achievement_ranks ar ON ar.track_id = t.id AND ar.rank = ua.rank
  LEFT JOIN public.achievement_ranks nr ON nr.track_id = t.id AND nr.rank = COALESCE(ua.rank, 0) + 1
  ORDER BY t.sort_order;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION public.get_user_hero_badges(p_user_id UUID)
RETURNS TABLE (
  badge_id TEXT, name TEXT, description TEXT, icon TEXT, color TEXT, threshold INTEGER, awarded_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT hb.id, hb.name, hb.description, hb.icon, hb.color, hb.threshold, uhb.awarded_at
  FROM public.user_hero_badges uhb
  JOIN public.hero_badges hb ON hb.id = uhb.badge_id
  WHERE uhb.user_id = p_user_id
  ORDER BY hb.sort_order;
END;
$$ LANGUAGE plpgsql STABLE;

-- Массовый пересчёт (выполнить один раз после миграции)
CREATE OR REPLACE FUNCTION public.recalculate_all_achievements()
RETURNS void AS $$
DECLARE
  user_rec RECORD;
BEGIN
  FOR user_rec IN SELECT DISTINCT user_id FROM public.deliveries
  LOOP
    PERFORM public.recalculate_user_achievements(user_rec.user_id);
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Indexes & RLS
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON public.user_achievements(user_id);
CREATE INDEX IF NOT EXISTS idx_user_achievements_track ON public.user_achievements(track_id);
CREATE INDEX IF NOT EXISTS idx_user_hero_badges_user ON public.user_hero_badges(user_id);
CREATE INDEX IF NOT EXISTS idx_architect_systems_cmdr ON public.architect_systems(cmdr_name);
CREATE INDEX IF NOT EXISTS idx_architect_systems_user ON public.architect_systems(user_id);

ALTER TABLE public.achievement_tracks   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.achievement_ranks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_achievements    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hero_badges          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_hero_badges     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.architect_systems    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Achievement tracks readable by all" ON public.achievement_tracks;
CREATE POLICY "Achievement tracks readable by all" ON public.achievement_tracks FOR SELECT USING (true);

DROP POLICY IF EXISTS "Achievement ranks readable by all" ON public.achievement_ranks;
CREATE POLICY "Achievement ranks readable by all" ON public.achievement_ranks FOR SELECT USING (true);

DROP POLICY IF EXISTS "User achievements readable by all" ON public.user_achievements;
CREATE POLICY "User achievements readable by all" ON public.user_achievements FOR SELECT USING (true);

DROP POLICY IF EXISTS "Hero badges readable by all" ON public.hero_badges;
CREATE POLICY "Hero badges readable by all" ON public.hero_badges FOR SELECT USING (true);

DROP POLICY IF EXISTS "User hero badges readable by all" ON public.user_hero_badges;
CREATE POLICY "User hero badges readable by all" ON public.user_hero_badges FOR SELECT USING (true);

DROP POLICY IF EXISTS "Architect systems readable by all" ON public.architect_systems;
CREATE POLICY "Architect systems readable by all" ON public.architect_systems FOR SELECT USING (true);
