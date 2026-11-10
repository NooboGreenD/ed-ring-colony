-- ══════════════════════════════════════════════════════════════════════════
-- carrier_directory: след последнего прыжка (линия маршрута на карте).
--
-- Зачем
-- -----
-- Реестр знает, ГДЕ носитель стоит сейчас, но не откуда он пришёл. На карте
-- галактики у носителей сайта маршрут виден по заказанному прыжку (пунктир к
-- цели), а у реестра EDDN такого поля нет вовсе — `CarrierJump` приходит уже
-- после прыжка. Чтобы «Трафик авианосцев» на карте выглядел так же, как
-- остальные слои, храним предыдущее наблюдение: при смене системы оно
-- сдвигается в `previous_*`, и карта рисует отрезок «откуда → куда».
--
-- Что важно
-- ---------
-- Предыдущая система записывается только более свежим наблюдением и только
-- при реальной смене системы: повторная переотправка того же `CarrierJump`
-- (EDDN переотправляет очередь) не должна затирать маршрут «сам собой».
-- Имя носителя (`name`) по-прежнему не трогается — его пишут только люди.
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.carrier_directory
  ADD COLUMN IF NOT EXISTS previous_system_name    TEXT,
  ADD COLUMN IF NOT EXISTS previous_system_address BIGINT,
  ADD COLUMN IF NOT EXISTS previous_x              DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS previous_y              DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS previous_z              DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS previous_at             TIMESTAMPTZ;

COMMENT ON COLUMN public.carrier_directory.previous_system_name IS
  'Система, из которой носитель пришёл последним известным прыжком (для линии маршрута на карте).';

-- Карта читает реестр «самые свежие сверху» и обрезает выборку.
CREATE INDEX IF NOT EXISTS carrier_directory_last_seen
  ON public.carrier_directory(last_seen_at DESC);

/**
 * Наблюдения из EDDN: добавить или обновить строки реестра.
 *
 * Отличие от версии `20261108120000_carrier_directory.sql` — блок `previous_*`:
 * при смене системы старое место стоянки переезжает в «откуда пришёл», чтобы
 * карта могла нарисовать маршрут. `name` не упоминается ни в INSERT, ни в
 * UPDATE: внешние данные не могут ни подставить имя, ни стереть уточнённое.
 */
CREATE OR REPLACE FUNCTION public.carrier_directory_apply(p_rows JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_touched INTEGER := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN jsonb_build_object('applied', 0);
  END IF;

  WITH input AS (
    SELECT *
    FROM jsonb_to_recordset(p_rows) AS row(
      carrier_id      BIGINT,
      callsign        TEXT,
      carrier_type    TEXT,
      system_name     TEXT,
      system_address  BIGINT,
      body_name       TEXT,
      x               DOUBLE PRECISION,
      y               DOUBLE PRECISION,
      z               DOUBLE PRECISION,
      services        JSONB,
      observed_at     TIMESTAMPTZ
    )
    WHERE row.carrier_id IS NOT NULL AND row.carrier_id > 0
  ), upserted AS (
    INSERT INTO public.carrier_directory AS cd (
      carrier_id, callsign, carrier_type, system_name, system_address, body_name,
      x, y, z, services, first_seen_at, last_seen_at, updated_at, source, sightings
    )
    SELECT
      carrier_id, callsign, carrier_type, system_name, system_address, body_name,
      x, y, z, services,
      LEAST(COALESCE(observed_at, now()), now()),
      LEAST(COALESCE(observed_at, now()), now()),
      LEAST(COALESCE(observed_at, now()), now()),
      'eddn', 1
    FROM input
    ON CONFLICT (carrier_id) DO UPDATE SET
      callsign = COALESCE(EXCLUDED.callsign, cd.callsign),
      carrier_type = COALESCE(EXCLUDED.carrier_type, cd.carrier_type),
      -- Носитель действительно сменил систему более свежим наблюдением:
      -- прежнее место уходит в «откуда пришёл» (до обновления колонок ниже).
      previous_system_name = CASE WHEN EXCLUDED.updated_at > cd.updated_at
          AND cd.system_name IS NOT NULL AND EXCLUDED.system_name IS NOT NULL
          AND lower(btrim(EXCLUDED.system_name)) <> lower(btrim(cd.system_name))
        THEN cd.system_name ELSE cd.previous_system_name END,
      previous_system_address = CASE WHEN EXCLUDED.updated_at > cd.updated_at
          AND cd.system_name IS NOT NULL AND EXCLUDED.system_name IS NOT NULL
          AND lower(btrim(EXCLUDED.system_name)) <> lower(btrim(cd.system_name))
        THEN cd.system_address ELSE cd.previous_system_address END,
      previous_x = CASE WHEN EXCLUDED.updated_at > cd.updated_at
          AND cd.system_name IS NOT NULL AND EXCLUDED.system_name IS NOT NULL
          AND lower(btrim(EXCLUDED.system_name)) <> lower(btrim(cd.system_name))
        THEN cd.x ELSE cd.previous_x END,
      previous_y = CASE WHEN EXCLUDED.updated_at > cd.updated_at
          AND cd.system_name IS NOT NULL AND EXCLUDED.system_name IS NOT NULL
          AND lower(btrim(EXCLUDED.system_name)) <> lower(btrim(cd.system_name))
        THEN cd.y ELSE cd.previous_y END,
      previous_z = CASE WHEN EXCLUDED.updated_at > cd.updated_at
          AND cd.system_name IS NOT NULL AND EXCLUDED.system_name IS NOT NULL
          AND lower(btrim(EXCLUDED.system_name)) <> lower(btrim(cd.system_name))
        THEN cd.z ELSE cd.previous_z END,
      previous_at = CASE WHEN EXCLUDED.updated_at > cd.updated_at
          AND cd.system_name IS NOT NULL AND EXCLUDED.system_name IS NOT NULL
          AND lower(btrim(EXCLUDED.system_name)) <> lower(btrim(cd.system_name))
        THEN cd.updated_at ELSE cd.previous_at END,
      system_name = CASE WHEN EXCLUDED.updated_at >= cd.updated_at
        THEN COALESCE(EXCLUDED.system_name, cd.system_name) ELSE cd.system_name END,
      system_address = CASE WHEN EXCLUDED.updated_at >= cd.updated_at
        THEN COALESCE(EXCLUDED.system_address, cd.system_address) ELSE cd.system_address END,
      body_name = CASE WHEN EXCLUDED.updated_at >= cd.updated_at
        THEN COALESCE(EXCLUDED.body_name, cd.body_name) ELSE cd.body_name END,
      x = CASE WHEN EXCLUDED.updated_at >= cd.updated_at THEN COALESCE(EXCLUDED.x, cd.x) ELSE cd.x END,
      y = CASE WHEN EXCLUDED.updated_at >= cd.updated_at THEN COALESCE(EXCLUDED.y, cd.y) ELSE cd.y END,
      z = CASE WHEN EXCLUDED.updated_at >= cd.updated_at THEN COALESCE(EXCLUDED.z, cd.z) ELSE cd.z END,
      services = CASE WHEN EXCLUDED.updated_at >= cd.updated_at
        THEN COALESCE(EXCLUDED.services, cd.services) ELSE cd.services END,
      first_seen_at = LEAST(cd.first_seen_at, EXCLUDED.first_seen_at),
      last_seen_at = GREATEST(cd.last_seen_at, EXCLUDED.last_seen_at),
      updated_at = GREATEST(cd.updated_at, EXCLUDED.updated_at),
      sightings = cd.sightings + 1
    RETURNING cd.carrier_id
  )
  SELECT count(*) INTO v_touched FROM upserted;

  RETURN jsonb_build_object('applied', v_touched);
END;
$$;

REVOKE ALL ON FUNCTION public.carrier_directory_apply(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.carrier_directory_apply(JSONB) TO service_role;

COMMENT ON FUNCTION public.carrier_directory_apply(JSONB) IS
  'Реестр авианосцев из EDDN: локация, службы и след последнего прыжка; имя не трогает.';
