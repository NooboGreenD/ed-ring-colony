-- ══════════════════════════════════════════════════════════════════════════
-- История прыжков авианосцев (`/carriers/jumps`, вкладка «История»).
--
-- Зачем
-- -----
-- Живая таблица показывает только заказы: носитель ушёл — строки нет. Ни
-- `fleet_carriers`, ни `carrier_directory` не хранят прошлых прыжков: в первой
-- лежит текущая стоянка и заказ, во второй — стоянка и один след последнего
-- прыжка (`previous_system_name`). Для графика интенсивности и списка «кто
-- куда прыгал» нужен журнал событий, который никуда не денется.
--
-- Что внутри
-- ----------
-- Одна строка — один состоявшийся прыжок: носитель, откуда, куда, время
-- прыжка и источник наблюдения (`site` — журнал/Helper, `eddn` — живой поток).
--
-- Пишут историю триггеры, а не маршруты:
--   * `fleet_carriers.system_name` изменился на более свежее наблюдение —
--     значит, `CarrierJump` из журнала подтвердил прибытие; время берём из
--     `location_at` (это время события, а не записи);
--   * `carrier_directory.system_name` изменился по наблюдению EDDN — время
--     `updated_at` этого наблюдения (EDDN присылает `CarrierJump` сразу после
--     прыжка, так что это близко к фактическому).
-- Триггеров два, потому что источники разные и пишут в разные таблицы; правило
-- «не писать дубль» одно на обоих.
--
-- Дубли
-- -----
-- Один и тот же прыжок может прийти из журнала и из EDDN с разницей в минуты.
-- Поэтому запись с тем же носителем и той же целью в пределах двух часов
-- считается повтором и не добавляется. Два настоящих прыжка в одну систему
-- подряд бывают редко, а «двойной счёт» на графике — хуже.
--
-- Доступ
-- ------
-- Прыжки носителей видны в игре любому пилоту, поэтому история публичная на
-- чтение (RLS: SELECT для anon и authenticated). Пишут её только триггеры под
-- service_role; прямых INSERT/UPDATE/DELETE у клиентов нет.
--
-- Ограничений по срокам нет: год — это около 3–4 тысяч строк на активный
-- реестр, их спокойно тянет индекс по `jumped_at`.
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.carrier_jump_history (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- MarketID. Не внешний ключ: носитель может исчезнуть из реестра, а история
  -- прыжков остаётся.
  carrier_id  BIGINT NOT NULL,
  -- Снимок подписи на момент прыжка: носитель переименуют — история не «поедет».
  callsign    TEXT,
  name        TEXT,
  from_system TEXT NOT NULL,
  to_system   TEXT NOT NULL,
  -- Время прыжка (прибытия), а не записи строки.
  jumped_at   TIMESTAMPTZ NOT NULL,
  source      TEXT NOT NULL DEFAULT 'site' CHECK (source IN ('site', 'eddn')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- График и список читают окно «за период» и сортируют по времени.
CREATE INDEX IF NOT EXISTS carrier_jump_history_time
  ON public.carrier_jump_history(jumped_at DESC);
CREATE INDEX IF NOT EXISTS carrier_jump_history_carrier
  ON public.carrier_jump_history(carrier_id, jumped_at DESC);

ALTER TABLE public.carrier_jump_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS carrier_jump_history_select ON public.carrier_jump_history;
CREATE POLICY carrier_jump_history_select ON public.carrier_jump_history
  FOR SELECT USING (true);

REVOKE ALL ON public.carrier_jump_history FROM PUBLIC;
GRANT SELECT ON public.carrier_jump_history TO anon, authenticated;
GRANT ALL ON public.carrier_jump_history TO service_role;

COMMENT ON TABLE public.carrier_jump_history IS
  'История прыжков авианосцев: носитель, откуда/куда, время; пишется триггерами учёта сайта и EDDN.';
COMMENT ON COLUMN public.carrier_jump_history.jumped_at IS
  'Время прыжка (прибытия) по наблюдению, а не время записи строки.';
COMMENT ON COLUMN public.carrier_jump_history.source IS
  'site — журнал/Helper, eddn — живой поток EDDN.';

-- ── Правило записи: одно на оба триггера ───────────────────────────────────
-- Отдельная функция, а не копия кода в каждом триггере: правило «не писать
-- дубль» должно быть ровно одно, иначе сайт и EDDN разойдутся в поведении.
CREATE OR REPLACE FUNCTION public.carrier_jump_history_record(
  p_carrier_id BIGINT,
  p_callsign   TEXT,
  p_name       TEXT,
  p_from       TEXT,
  p_to         TEXT,
  p_at         TIMESTAMPTZ,
  p_source     TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_from TEXT := btrim(coalesce(p_from, ''));
  v_to   TEXT := btrim(coalesce(p_to, ''));
  v_at   TIMESTAMPTZ := coalesce(p_at, now());
BEGIN
  -- Нечего записывать: нет носителя, системы или это не смена системы.
  IF p_carrier_id IS NULL OR v_from = '' OR v_to = '' THEN
    RETURN;
  END IF;
  IF lower(v_from) = lower(v_to) THEN
    RETURN;
  END IF;
  -- Тот же прыжок уже записан другим источником (или повторно этим же).
  IF EXISTS (
    SELECT 1
    FROM public.carrier_jump_history h
    WHERE h.carrier_id = p_carrier_id
      AND lower(h.to_system) = lower(v_to)
      AND h.jumped_at BETWEEN v_at - interval '2 hours' AND v_at + interval '2 hours'
  ) THEN
    RETURN;
  END IF;
  INSERT INTO public.carrier_jump_history(carrier_id, callsign, name, from_system, to_system, jumped_at, source)
  VALUES (
    p_carrier_id,
    NULLIF(btrim(coalesce(p_callsign, '')), ''),
    NULLIF(btrim(coalesce(p_name, '')), ''),
    v_from, v_to, v_at,
    CASE WHEN p_source = 'eddn' THEN 'eddn' ELSE 'site' END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.carrier_jump_history_record(BIGINT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.carrier_jump_history_record(BIGINT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) TO service_role;

-- ── Учёт сайта: журнал и Helper ────────────────────────────────────────────
-- `apply_fleet_carrier_batch` меняет `system_name` только более свежим
-- наблюдением, поэтому смена системы здесь = подтверждённый прыжок.
-- SECURITY DEFINER: строку истории пишет владелец функции. Иначе при
-- обновлении из-под anon/authenticated INSERT упёрся бы в права таблицы, а
-- журнал должен работать при любом способе записи стоянки.
CREATE OR REPLACE FUNCTION public.carrier_jump_history_fleet_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.carrier_jump_history_record(
    NEW.carrier_id, NEW.callsign, NEW.name,
    OLD.system_name, NEW.system_name,
    coalesce(NEW.location_at, now()), 'site');
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.carrier_jump_history_fleet_trigger() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS carrier_jump_history_fleet ON public.fleet_carriers;
CREATE TRIGGER carrier_jump_history_fleet
  AFTER UPDATE OF system_name ON public.fleet_carriers
  FOR EACH ROW
  WHEN (
    OLD.system_name IS DISTINCT FROM NEW.system_name
    AND OLD.system_name IS NOT NULL AND btrim(OLD.system_name) <> ''
    AND NEW.system_name IS NOT NULL AND btrim(NEW.system_name) <> ''
  )
  EXECUTE FUNCTION public.carrier_jump_history_fleet_trigger();

-- ── Реестр EDDN ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.carrier_jump_history_directory_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.carrier_jump_history_record(
    NEW.carrier_id, NEW.callsign, NEW.name,
    OLD.system_name, NEW.system_name,
    coalesce(NEW.updated_at, now()), 'eddn');
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.carrier_jump_history_directory_trigger() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS carrier_jump_history_directory ON public.carrier_directory;
CREATE TRIGGER carrier_jump_history_directory
  AFTER UPDATE OF system_name ON public.carrier_directory
  FOR EACH ROW
  WHEN (
    OLD.system_name IS DISTINCT FROM NEW.system_name
    AND OLD.system_name IS NOT NULL AND btrim(OLD.system_name) <> ''
    AND NEW.system_name IS NOT NULL AND btrim(NEW.system_name) <> ''
  )
  EXECUTE FUNCTION public.carrier_jump_history_directory_trigger();

-- ── Начальное наполнение ───────────────────────────────────────────────────
-- До этой миграции прыжки нигде не копились, но реестр EDDN помнит след
-- последнего прыжка каждого носителя (`previous_system_name`, `previous_at`).
-- Переносим его: график за год не должен начинаться с пустоты. Время —
-- последнее наблюдение прежней стоянки, то есть «не позже прыжка»; это честнее,
-- чем придумывать точное время.
INSERT INTO public.carrier_jump_history(carrier_id, callsign, name, from_system, to_system, jumped_at, source)
SELECT cd.carrier_id, cd.callsign, cd.name,
       btrim(cd.previous_system_name), btrim(cd.system_name),
       coalesce(cd.previous_at, cd.updated_at, now()), 'eddn'
FROM public.carrier_directory cd
WHERE cd.previous_system_name IS NOT NULL AND cd.system_name IS NOT NULL
  AND btrim(cd.previous_system_name) <> '' AND btrim(cd.system_name) <> ''
  AND lower(btrim(cd.previous_system_name)) <> lower(btrim(cd.system_name))
  AND NOT EXISTS (
    SELECT 1 FROM public.carrier_jump_history h
    WHERE h.carrier_id = cd.carrier_id
      AND lower(h.to_system) = lower(btrim(cd.system_name))
      AND h.jumped_at BETWEEN coalesce(cd.previous_at, cd.updated_at, now()) - interval '2 hours'
                           AND coalesce(cd.previous_at, cd.updated_at, now()) + interval '2 hours'
  );

-- ── Сводка и корзины для графика ───────────────────────────────────────────
-- Считает база: за год это тысячи строк, и тянуть их в браузер ради счётчиков
-- незачем. Гранулярность выбирает страница: 5 минут / час / день / месяц.
CREATE OR REPLACE FUNCTION public.carrier_jump_history_buckets(
  p_since       TIMESTAMPTZ,
  p_granularity TEXT
) RETURNS TABLE (bucket TIMESTAMPTZ, jumps BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT
    CASE p_granularity
      WHEN 'month' THEN (date_trunc('month', h.jumped_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
      WHEN 'day'   THEN (date_trunc('day',   h.jumped_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
      WHEN 'hour'  THEN (date_trunc('hour',  h.jumped_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
      -- 5 минут: ячейки от эпохи, чтобы границы не зависели от часового пояса.
      ELSE to_timestamp(floor(extract(epoch FROM h.jumped_at) / 300) * 300)
    END AS bucket,
    count(*)::bigint AS jumps
  FROM public.carrier_jump_history h
  WHERE h.jumped_at >= p_since
  GROUP BY 1
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.carrier_jump_history_buckets(TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.carrier_jump_history_buckets(TIMESTAMPTZ, TEXT) TO service_role;

COMMENT ON FUNCTION public.carrier_jump_history_buckets(TIMESTAMPTZ, TEXT) IS
  'Корзины графика интенсивности прыжков: 5 минут, час, день или месяц (UTC).';

CREATE OR REPLACE FUNCTION public.carrier_jump_history_summary(
  p_since TIMESTAMPTZ,
  p_top   INTEGER DEFAULT 5
) RETURNS JSONB
LANGUAGE sql STABLE AS $$
  WITH rows AS (
    SELECT * FROM public.carrier_jump_history WHERE jumped_at >= p_since
  ), top AS (
    SELECT h.carrier_id,
           max(h.callsign) AS callsign,
           max(h.name) AS name,
           count(*)::int AS jumps
    FROM rows h
    GROUP BY h.carrier_id
    ORDER BY jumps DESC, h.carrier_id
    LIMIT greatest(1, coalesce(p_top, 5))
  )
  SELECT jsonb_build_object(
    'total',        (SELECT count(*) FROM rows),
    'carriers',     (SELECT count(DISTINCT carrier_id) FROM rows),
    'routes',       (SELECT count(DISTINCT lower(from_system) || '→' || lower(to_system)) FROM rows),
    'source_site',  (SELECT count(*) FROM rows WHERE source = 'site'),
    'source_eddn',  (SELECT count(*) FROM rows WHERE source = 'eddn'),
    'top',          coalesce((SELECT jsonb_agg(to_jsonb(top)) FROM top), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.carrier_jump_history_summary(TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.carrier_jump_history_summary(TIMESTAMPTZ, INTEGER) TO service_role;

COMMENT ON FUNCTION public.carrier_jump_history_summary(TIMESTAMPTZ, INTEGER) IS
  'Сводка истории прыжков за период: всего, носителей, маршрутов, по источникам и топ носителей.';
