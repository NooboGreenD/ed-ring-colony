-- ══════════════════════════════════════════════════════════════════════════
-- Расписания прыжков авианосцев (`/carriers/jumps`, вкладка «Расписание»).
--
-- Зачем
-- -----
-- Таблица «перед прыжком» показывает только текущие заказы: они живут минуты
-- и исчезают, как только носитель ушёл. Пилоту же нужен план на дни вперёд —
-- «когда и куда пойдёт наш носитель», «кто и когда привезёт груз в систему».
-- Поэтому рядом с живыми заказами появилось расписание: свои строки с датой
-- вылета, которые ведёт человек, а не игра.
--
-- Расписание — это именованный набор прыжков одного пилота:
--   * `carrier_jump_schedules`       — шапка: название, заметка, видимость;
--   * `carrier_jump_schedule_entries` — сами прыжки: носитель, откуда, куда,
--     время вылета и примечание.
--
-- Приватное и публичное
-- ---------------------
-- `visibility = 'private'` — расписание видит только владелец (по умолчанию).
-- `visibility = 'public'`  — видит любой, у кого есть ссылка, даже без входа:
-- это нужно, чтобы командир эскадрильи отдал план логистам, не добавляя их в
-- проект. Публичное расписание читается, но правится только владельцем.
--
-- Доступ
-- ------
-- RLS повторяет правило маршрутов: владелец — полный доступ, остальные —
-- только чтение публичного. `anon` получает права лишь на чтение (политика
-- пускает его к строкам, где `visibility = 'public'`), записи идут через
-- service_role из маршрута, который уже проверил сессию.
--
-- Груза и финансов здесь нет и быть не может: это календарь, а не учёт.
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.carrier_jump_schedules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  note        TEXT,
  -- 'private' — только владелец, 'public' — по ссылке для всех.
  visibility  TEXT NOT NULL DEFAULT 'private'
              CHECK (visibility IN ('private', 'public')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT carrier_jump_schedule_title_len CHECK (length(btrim(title)) BETWEEN 1 AND 80),
  CONSTRAINT carrier_jump_schedule_note_len CHECK (note IS NULL OR length(note) <= 500)
);

CREATE INDEX IF NOT EXISTS carrier_jump_schedule_owner
  ON public.carrier_jump_schedules(owner_id, updated_at DESC);
-- Публичные расписания ищутся списком «что ещё есть у людей».
CREATE INDEX IF NOT EXISTS carrier_jump_schedule_public
  ON public.carrier_jump_schedules(updated_at DESC)
  WHERE visibility = 'public';

CREATE TABLE IF NOT EXISTS public.carrier_jump_schedule_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id   UUID NOT NULL REFERENCES public.carrier_jump_schedules(id) ON DELETE CASCADE,
  -- MarketID носителя, если прыжок взят из живого заказа. Ручной план может
  -- быть без носителя: пилот знает только позывной и системы.
  carrier_id    TEXT,
  callsign      TEXT,
  name          TEXT,
  from_system   TEXT NOT NULL,
  to_system     TEXT NOT NULL,
  departure_at  TIMESTAMPTZ NOT NULL,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT carrier_jump_entry_callsign_len CHECK (callsign IS NULL OR length(callsign) <= 16),
  CONSTRAINT carrier_jump_entry_name_len CHECK (name IS NULL OR length(name) <= 80),
  CONSTRAINT carrier_jump_entry_system_len CHECK (length(btrim(from_system)) BETWEEN 1 AND 80 AND length(btrim(to_system)) BETWEEN 1 AND 80),
  CONSTRAINT carrier_jump_entry_carrier_len CHECK (carrier_id IS NULL OR length(carrier_id) <= 32),
  CONSTRAINT carrier_jump_entry_note_len CHECK (note IS NULL OR length(note) <= 500)
);

-- Календарь читает месяц целиком и сортирует по вылету.
CREATE INDEX IF NOT EXISTS carrier_jump_entry_schedule_time
  ON public.carrier_jump_schedule_entries(schedule_id, departure_at ASC);
CREATE INDEX IF NOT EXISTS carrier_jump_entry_time
  ON public.carrier_jump_schedule_entries(departure_at ASC);
-- Один и тот же прыжок не должен попасть в расписание дважды.
CREATE UNIQUE INDEX IF NOT EXISTS carrier_jump_entry_unique
  ON public.carrier_jump_schedule_entries(schedule_id, carrier_id, departure_at)
  WHERE carrier_id IS NOT NULL;

ALTER TABLE public.carrier_jump_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carrier_jump_schedule_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS carrier_jump_schedule_select ON public.carrier_jump_schedules;
CREATE POLICY carrier_jump_schedule_select ON public.carrier_jump_schedules
  FOR SELECT USING (visibility = 'public' OR auth.uid() = owner_id);

DROP POLICY IF EXISTS carrier_jump_schedule_insert ON public.carrier_jump_schedules;
CREATE POLICY carrier_jump_schedule_insert ON public.carrier_jump_schedules
  FOR INSERT WITH CHECK (auth.uid() = owner_id);

DROP POLICY IF EXISTS carrier_jump_schedule_update ON public.carrier_jump_schedules;
CREATE POLICY carrier_jump_schedule_update ON public.carrier_jump_schedules
  FOR UPDATE USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);

DROP POLICY IF EXISTS carrier_jump_schedule_delete ON public.carrier_jump_schedules;
CREATE POLICY carrier_jump_schedule_delete ON public.carrier_jump_schedules
  FOR DELETE USING (auth.uid() = owner_id);

-- Строки видны там, где видно само расписание: публичное — всем, приватное —
-- владельцу.
DROP POLICY IF EXISTS carrier_jump_entry_select ON public.carrier_jump_schedule_entries;
CREATE POLICY carrier_jump_entry_select ON public.carrier_jump_schedule_entries
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.carrier_jump_schedules s
      WHERE s.id = schedule_id AND (s.visibility = 'public' OR s.owner_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS carrier_jump_entry_write ON public.carrier_jump_schedule_entries;
CREATE POLICY carrier_jump_entry_write ON public.carrier_jump_schedule_entries
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.carrier_jump_schedules s
      WHERE s.id = schedule_id AND s.owner_id = auth.uid()
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.carrier_jump_schedules s
      WHERE s.id = schedule_id AND s.owner_id = auth.uid()
    )
  );

-- Сводка по расписаниям для списка: сколько прыжков и когда ближайший.
-- Отдельная функция, потому что список показывает до полусотни расписаний, а
-- тянуть все строки каждого ради двух чисел — это тысячи записей на один
-- экран. Считает база, маршрут получает готовые числа.
CREATE OR REPLACE FUNCTION public.carrier_jump_schedule_stats(p_ids UUID[])
RETURNS TABLE (
  schedule_id   UUID,
  entry_count   BIGINT,
  next_entry_at TIMESTAMPTZ,
  last_entry_at TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
  SELECT e.schedule_id,
         count(*)::bigint,
         min(e.departure_at) FILTER (WHERE e.departure_at >= now()),
         max(e.departure_at)
  FROM public.carrier_jump_schedule_entries e
  WHERE e.schedule_id = ANY(p_ids)
  GROUP BY e.schedule_id;
$$;

REVOKE ALL ON FUNCTION public.carrier_jump_schedule_stats(UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.carrier_jump_schedule_stats(UUID[]) TO service_role;

COMMENT ON FUNCTION public.carrier_jump_schedule_stats(UUID[]) IS
  'Список расписаний: число прыжков и ближайший вылет по каждому.';

REVOKE ALL ON public.carrier_jump_schedules FROM PUBLIC;
REVOKE ALL ON public.carrier_jump_schedule_entries FROM PUBLIC;
GRANT SELECT ON public.carrier_jump_schedules TO anon;
GRANT SELECT ON public.carrier_jump_schedule_entries TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.carrier_jump_schedules TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.carrier_jump_schedule_entries TO authenticated;
GRANT ALL ON public.carrier_jump_schedules TO service_role;
GRANT ALL ON public.carrier_jump_schedule_entries TO service_role;

COMMENT ON TABLE public.carrier_jump_schedules IS
  'Расписание прыжков авианосцев: личная или публичная подборка планов (страница /carriers/jumps).';
COMMENT ON TABLE public.carrier_jump_schedule_entries IS
  'Прыжок в расписании: носитель, откуда/куда и время вылета. Пишется пилотом, не игрой.';
COMMENT ON COLUMN public.carrier_jump_schedules.visibility IS
  'private — только владелец, public — по ссылке для всех (чтение без входа).';
