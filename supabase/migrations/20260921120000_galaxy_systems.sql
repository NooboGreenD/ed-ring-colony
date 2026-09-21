-- ════════════════════════════════════════════════════════════════
-- Migration: Spansh Galaxy Systems
-- Источник данных: полный ночной дамп https://spansh.co.uk/dumps
--   (systems.json.gz — «Just system details (no bodies or stations)»,
--    формат BriefDumpSystem: id64, name, mainStar, coords{x,y,z},
--    needsPermit, updateTime — одна система на строку).
-- Загрузка: `npm run spansh:import` (scripts/import-spansh-systems.mjs).
-- ════════════════════════════════════════════════════════════════

-- ─── Все известные системы галактики (координаты — в той же системе,
--     что и на сайте: Sol = (0,0,0), SgrA = (25.21875, -20.90625, 25899.96875) ───
CREATE TABLE IF NOT EXISTS galaxy_systems (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id64 TEXT NOT NULL,                          -- Spansh ID64 (до 2^64 → строка)
  name TEXT NOT NULL,                          -- каноническое имя из Spansh
  name_lc TEXT NOT NULL,                       -- нормализованный ключ поиска (lower, сжатие пробелов)
  x DOUBLE PRECISION NOT NULL,
  y DOUBLE PRECISION NOT NULL,
  z DOUBLE PRECISION NOT NULL,
  main_star TEXT,                              -- сырой класс главной звезды, напр. 'G (White-Yellow) Star'
  star_type TEXT,                              -- нормализованный класс: o|b|a|f|g|k|m|brown_dwarf|neutron|black_hole|white_dwarf|wolf_rayet|herbig_ae_be|t_tauri|carbon|unknown
  star_giant_class TEXT,                       -- dwarf|giant|supergiant (для обычных классов), NULL для экзотических
  needs_permit BOOLEAN,
  distance_from_sols DOUBLE PRECISION,         -- ly, Sol = (0,0,0)
  distance_from_sgra DOUBLE PRECISION,         -- ly до Sagittarius A*
  updated_at TIMESTAMPTZ,                      -- updateTime из дампа (последнее обновление системы)
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Uniqueness: дамп не содержит дублей, но повторный импорт идёт как upsert
CREATE UNIQUE INDEX IF NOT EXISTS uq_galaxy_systems_id64 ON galaxy_systems(id64);
CREATE UNIQUE INDEX IF NOT EXISTS uq_galaxy_systems_name_lc ON galaxy_systems(name_lc);

-- Cube-запросы атласа (x/y/z BETWEEN …): три b-tree + bitmap AND
CREATE INDEX IF NOT EXISTS idx_galaxy_systems_x ON galaxy_systems(x);
CREATE INDEX IF NOT EXISTS idx_galaxy_systems_y ON galaxy_systems(y);
CREATE INDEX IF NOT EXISTS idx_galaxy_systems_z ON galaxy_systems(z);

-- Поиск по типу звезды (атлас: нейтроны/чёрные дыры/карлики и т.п.)
CREATE INDEX IF NOT EXISTS idx_galaxy_systems_star_type ON galaxy_systems(star_type);
CREATE INDEX IF NOT EXISTS idx_galaxy_systems_star_giant_class ON galaxy_systems(star_giant_class);

-- ─── Метаданные последней загрузки (для «DB ready»-гated логики и UI) ───
CREATE TABLE IF NOT EXISTS galaxy_systems_meta (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── RLS: открытое чтение (справочные данные), запись только через service role ───
ALTER TABLE galaxy_systems ENABLE ROW LEVEL SECURITY;
ALTER TABLE galaxy_systems_meta ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'galaxy_systems' AND policyname = 'galaxy_systems_public'
  ) THEN
    CREATE POLICY galaxy_systems_public ON galaxy_systems FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'galaxy_systems_meta' AND policyname = 'galaxy_systems_meta_public'
  ) THEN
    CREATE POLICY galaxy_systems_meta_public ON galaxy_systems_meta FOR SELECT USING (true);
  END IF;
END $$;

COMMENT ON TABLE galaxy_systems IS 'Все известные системы Elite Dangerous (ночной дамп Spansh, scripts/import-spansh-systems.mjs)';
COMMENT ON TABLE galaxy_systems_meta IS 'Метаданные последней загрузки дампа Spansh (key=''stats'')';
