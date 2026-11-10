-- ══════════════════════════════════════════════════════════════════════════
-- atlas_carrier_watch: личный список авианосцев в Атласе («Трафик авианосцев»).
--
-- Зачем эта таблица
-- -----------------
-- Реестр носителей (`fleet_carriers`) собирается всем сайтом: Colonial Helper
-- и загрузка журналов присылают `CarrierJump`, `CarrierLocation`, `Docked` и
-- рыночные события. Но «следить» за чужим носителем в игре нельзя — можно
-- только запомнить позывной и найти его позже. До сих пор такое «избранное»
-- жило лишь в браузере пилота (localStorage) и пропадало при смене устройства.
--
-- Здесь хранится личное: какие носители пилот добавил в избранное и какие
-- комментарии к ним написал («стоит у нашей стройки», «возит сталь»).
-- Это не данные игры и не общий справочник — только заметки одного пилота.
--
-- Что в строке
-- ------------
--   * `carrier_id` — MarketID носителя, тот же ключ, что у `fleet_carriers`
--     и у слоя «Авианосцы» карты. Позывной и имя — снимок на момент
--     добавления: носитель может быть переименован или пропасть из реестра,
--     а запись в избранном обязана остаться;
--   * `favorite` — «в избранном»; снятие флага оставляет строку с заметкой;
--   * `note` — комментарий пилота (до 500 символов, как у избранного Atlas).
--
-- Доступ
-- ------
-- Только владелец: RLS по `auth.uid()`. Чужих записей не видит никто, и
-- service_role пишет сюда только через маршрут, который уже проверил сессию.
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.atlas_carrier_watch (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- MarketID носителя. В `fleet_carriers` это BIGINT, но позывной иногда
  -- приходит строкой — храним текстом и сравниваем как текст.
  carrier_id  TEXT NOT NULL,
  callsign    TEXT,
  name        TEXT,
  system_name TEXT,
  favorite    BOOLEAN NOT NULL DEFAULT TRUE,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT atlas_carrier_watch_key UNIQUE (user_id, carrier_id),
  CONSTRAINT atlas_carrier_watch_note_len CHECK (note IS NULL OR length(note) <= 500)
);

CREATE INDEX IF NOT EXISTS atlas_carrier_watch_user
  ON public.atlas_carrier_watch(user_id, updated_at DESC);

ALTER TABLE public.atlas_carrier_watch ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS atlas_carrier_watch_select ON public.atlas_carrier_watch;
CREATE POLICY atlas_carrier_watch_select ON public.atlas_carrier_watch
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS atlas_carrier_watch_insert ON public.atlas_carrier_watch;
CREATE POLICY atlas_carrier_watch_insert ON public.atlas_carrier_watch
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS atlas_carrier_watch_update ON public.atlas_carrier_watch;
CREATE POLICY atlas_carrier_watch_update ON public.atlas_carrier_watch
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS atlas_carrier_watch_delete ON public.atlas_carrier_watch;
CREATE POLICY atlas_carrier_watch_delete ON public.atlas_carrier_watch
  FOR DELETE USING (auth.uid() = user_id);

REVOKE ALL ON public.atlas_carrier_watch FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.atlas_carrier_watch TO authenticated;
GRANT ALL ON public.atlas_carrier_watch TO service_role;

-- Поиск в «Трафике авианосцев» идёт по позывному, имени и системе. Индексы по
-- позывному и системе в `fleet_carriers` уже есть (миграция 20261017000000);
-- имени не было, а по нему ищут чаще всего.
CREATE INDEX IF NOT EXISTS fleet_carriers_name_lower
  ON public.fleet_carriers(lower(name)) WHERE name IS NOT NULL;

COMMENT ON TABLE public.atlas_carrier_watch IS
  'Личное избранное авианосцев в Атласе: позывной, имя, комментарий. RLS по auth.uid().';
