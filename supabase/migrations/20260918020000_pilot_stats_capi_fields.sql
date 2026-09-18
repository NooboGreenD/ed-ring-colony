-- ─────────────────────────────────────────────────────────────
-- Досье пилота: боевые/торговые/исследовательские ранги и текущее
-- положение в pilot_stats.
--
-- Зачем: ранги Combat/Trade/Explore/фракций и текущая система/станция живут
-- только в capi_profiles, а эта таблица заполняется исключительно при
-- авторизации сайта через Frontier CAPI. Colonial Helper теперь умеет
-- получать профиль из CAPI сам (авторизация PKCE, без Shared Key от FDEV) и
-- отправляет его через POST /api/cmdr/stats — без этих колонок данные молча
-- терялись, а досье показывало «—».
--
-- Колонки добавляются NULL'ами: у существующих записей их не было, и
-- отличать «нет данных» от нуля важно (см. /api/cmdr/stats — поле
-- присутствует в upsert только если пришло в payload).
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.pilot_stats
  ADD COLUMN IF NOT EXISTS combat_rank     INTEGER,
  ADD COLUMN IF NOT EXISTS trade_rank      INTEGER,
  ADD COLUMN IF NOT EXISTS explore_rank    INTEGER,
  ADD COLUMN IF NOT EXISTS empire_rank     INTEGER,
  ADD COLUMN IF NOT EXISTS federation_rank INTEGER,
  ADD COLUMN IF NOT EXISTS current_ship    TEXT,
  ADD COLUMN IF NOT EXISTS current_system  TEXT,
  ADD COLUMN IF NOT EXISTS current_station TEXT;

-- Индекс для поиска досье по системе (эскадрилья: кто где сейчас).
CREATE INDEX IF NOT EXISTS idx_pilot_stats_system
  ON public.pilot_stats (current_system)
  WHERE current_system IS NOT NULL;
