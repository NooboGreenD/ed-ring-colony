-- ══════════════════════════════════════════════════════════════════════════
-- carrier_directory: реестр авианосцев галактики из живого потока EDDN.
--
-- Зачем эта таблица
-- -----------------
-- До сих пор сайт знал только те носители, которые встретили его пилоты
-- (`fleet_carriers`): свои, эскадрильи и те, у которых довелось стоять. Искать
-- чужой носитель по позывному можно было лишь среди них. Frontier реестр
-- носителей не публикует, но каждый прыжок авианосца его владелец (или пилот,
-- стоящий на борту) отправляет в EDDN — оттуда и берём перепись.
--
-- Что приходит из EDDN и чего не приходит
-- ---------------------------------------
-- Сообщение `journal/1` с событием `CarrierJump` несёт MarketID, позывной
-- (`StationName`), систему с адресом и координатами, тело, службы станции и
-- время. **Имени носителя в нём нет:** игра показывает имя только владельцу
-- (`CarrierStats`), а всем остальным — позывной.
--
-- Поэтому имя в этой таблице заполняется **только людьми**: владельцем или
-- пилотом, который побывал на носителе (см. `carrier_visits`), — через
-- `carrier_directory_set_name`. EDDN-обновление (`carrier_directory_apply`)
-- колонку `name` не трогает вообще: ни записать, ни стереть.
--
-- Доступ
-- ------
-- anon и authenticated не имеют ни одной привилегии: читает и пишет только
-- service_role через маршруты. Условие «побывал на носителе» проверяется в
-- самой SQL-функции, а не только в маршруте.
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.carrier_directory (
  -- MarketID носителя: тот же ключ, что у `fleet_carriers`.
  carrier_id      BIGINT PRIMARY KEY,
  callsign        TEXT,
  -- Имя. Только от пользователей: EDDN его не знает и не пишет.
  name            TEXT,
  name_source     TEXT,           -- owner | visit
  name_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name_at         TIMESTAMPTZ,
  carrier_type    TEXT,           -- FleetCarrier | SquadronCarrier
  system_name     TEXT,
  system_address  BIGINT,
  body_name       TEXT,
  x               DOUBLE PRECISION,
  y               DOUBLE PRECISION,
  z               DOUBLE PRECISION,
  services        JSONB,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Время последнего наблюдения (из события, а не момента записи).
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source          TEXT NOT NULL DEFAULT 'eddn',
  sightings       INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT carrier_directory_name_len CHECK (name IS NULL OR length(name) <= 80)
);

CREATE INDEX IF NOT EXISTS carrier_directory_callsign
  ON public.carrier_directory(upper(callsign));
CREATE INDEX IF NOT EXISTS carrier_directory_name
  ON public.carrier_directory(lower(name)) WHERE name IS NOT NULL;
CREATE INDEX IF NOT EXISTS carrier_directory_system
  ON public.carrier_directory(lower(system_name));
CREATE INDEX IF NOT EXISTS carrier_directory_seen
  ON public.carrier_directory(updated_at DESC);

-- Кто где побывал. Нужна не для отчётности, а как право: уточнить имя
-- носителя может лишь тот, кто его видел в игре (или владелец).
CREATE TABLE IF NOT EXISTS public.carrier_visits (
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  carrier_id    BIGINT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  observations  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, carrier_id)
);

CREATE INDEX IF NOT EXISTS carrier_visits_carrier
  ON public.carrier_visits(carrier_id);

ALTER TABLE public.carrier_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carrier_visits ENABLE ROW LEVEL SECURITY;

-- Никаких политик: доступ только сервисной ролью (она обходит RLS).
REVOKE ALL ON public.carrier_directory FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.carrier_directory TO service_role;
REVOKE ALL ON public.carrier_visits FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.carrier_visits TO service_role;

/**
 * Наблюдения из EDDN: добавить или обновить строки реестра.
 *
 * `name` не упоминается ни в INSERT, ни в UPDATE — так внешние данные не
 * могут ни подставить имя, ни затереть уточнённое пользователем.
 * Локация и службы обновляются только более свежим наблюдением: EDDN иногда
 * переотправляет старые сообщения из очереди.
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
  'Реестр авианосцев из EDDN: только локация и службы, имя не трогает.';

/**
 * Записать визиты: пилот стоял на носителе (журнал `Docked`/`CarrierJump`).
 * Повторные визиты увеличивают счётчик и двигают `last_seen_at`.
 */
CREATE OR REPLACE FUNCTION public.carrier_visits_record(p_user UUID, p_rows JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_touched INTEGER := 0;
BEGIN
  IF p_user IS NULL OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN jsonb_build_object('applied', 0);
  END IF;

  WITH input AS (
    SELECT *
    FROM jsonb_to_recordset(p_rows) AS row(carrier_id BIGINT, observed_at TIMESTAMPTZ)
    WHERE row.carrier_id IS NOT NULL AND row.carrier_id > 0
  ), upserted AS (
    INSERT INTO public.carrier_visits AS cv (user_id, carrier_id, first_seen_at, last_seen_at, observations)
    SELECT p_user, carrier_id,
      LEAST(COALESCE(observed_at, now()), now()),
      LEAST(COALESCE(observed_at, now()), now()),
      1
    FROM input
    ON CONFLICT (user_id, carrier_id) DO UPDATE SET
      first_seen_at = LEAST(cv.first_seen_at, EXCLUDED.first_seen_at),
      last_seen_at = GREATEST(cv.last_seen_at, EXCLUDED.last_seen_at),
      observations = cv.observations + 1
    RETURNING cv.carrier_id
  )
  SELECT count(*) INTO v_touched FROM upserted;

  RETURN jsonb_build_object('applied', v_touched);
END;
$$;

REVOKE ALL ON FUNCTION public.carrier_visits_record(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.carrier_visits_record(UUID, JSONB) TO service_role;

COMMENT ON FUNCTION public.carrier_visits_record(UUID, JSONB) IS
  'Визиты пилота на авианосцы: право уточнять имя (см. carrier_directory_set_name).';

/**
 * Уточнить имя носителя — только владельцу или тому, кто на нём побывал.
 *
 * Право проверяется здесь, а не в маршруте: даже случайный вызов сервисной
 * ролью не даст переписать имя чужого носителя. Строка реестра создаётся из
 * `fleet_carriers`, если EDDN этот носитель ещё не приносил.
 */
CREATE OR REPLACE FUNCTION public.carrier_directory_set_name(
  p_carrier_id BIGINT,
  p_name TEXT,
  p_user UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := btrim(COALESCE(p_name, ''));
  v_owner UUID;
  v_visited BOOLEAN := false;
  v_source TEXT;
BEGIN
  IF p_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;
  IF p_carrier_id IS NULL OR p_carrier_id <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'carrier_id');
  END IF;
  IF v_name = '' OR length(v_name) > 80 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'name');
  END IF;

  SELECT owner_id INTO v_owner FROM public.fleet_carriers WHERE carrier_id = p_carrier_id;
  SELECT EXISTS (SELECT 1 FROM public.carrier_visits WHERE user_id = p_user AND carrier_id = p_carrier_id)
    INTO v_visited;

  IF v_owner IS DISTINCT FROM p_user AND NOT v_visited THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  v_source := CASE WHEN v_owner = p_user THEN 'owner' ELSE 'visit' END;

  -- Одна вставка на все случаи: строка может уже быть из EDDN, может быть
  -- только в учёте сайта, а может не быть нигде. `fleet_carriers` даёт
  -- недостающие поля, но строка создаётся в любом случае — иначе имя,
  -- уточнённое посетителем, потерялось бы.
  INSERT INTO public.carrier_directory AS cd (
    carrier_id, callsign, carrier_type, system_name, system_address, body_name, x, y, z,
    name, name_source, name_by, name_at, first_seen_at, last_seen_at, updated_at, source
  )
  SELECT
    p_carrier_id, fc.callsign, fc.carrier_type, fc.system_name, fc.system_address, fc.body_name,
    fc.x, fc.y, fc.z, v_name, v_source, p_user, now(),
    now(), now(), COALESCE(fc.location_at, now()), 'site'
  FROM (SELECT 1) AS one
  LEFT JOIN public.fleet_carriers fc ON fc.carrier_id = p_carrier_id
  ON CONFLICT (carrier_id) DO UPDATE SET
    name = EXCLUDED.name,
    name_source = EXCLUDED.name_source,
    name_by = EXCLUDED.name_by,
    name_at = EXCLUDED.name_at,
    -- Локацию и позывной реестр мог знать раньше: пустые поля сайта её не стирают.
    callsign = COALESCE(cd.callsign, EXCLUDED.callsign),
    carrier_type = COALESCE(cd.carrier_type, EXCLUDED.carrier_type),
    system_name = COALESCE(cd.system_name, EXCLUDED.system_name),
    system_address = COALESCE(cd.system_address, EXCLUDED.system_address),
    body_name = COALESCE(cd.body_name, EXCLUDED.body_name),
    x = COALESCE(cd.x, EXCLUDED.x),
    y = COALESCE(cd.y, EXCLUDED.y),
    z = COALESCE(cd.z, EXCLUDED.z),
    first_seen_at = LEAST(cd.first_seen_at, EXCLUDED.first_seen_at),
    last_seen_at = GREATEST(cd.last_seen_at, EXCLUDED.last_seen_at);

  RETURN jsonb_build_object('ok', true, 'name', v_name, 'source', v_source);
END;
$$;

REVOKE ALL ON FUNCTION public.carrier_directory_set_name(BIGINT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.carrier_directory_set_name(BIGINT, TEXT, UUID) TO service_role;

COMMENT ON FUNCTION public.carrier_directory_set_name(BIGINT, TEXT, UUID) IS
  'Уточнение имени авианосца: только владелец или побывавший на нём пилот.';
