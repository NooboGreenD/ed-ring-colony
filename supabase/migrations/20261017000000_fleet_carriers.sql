-- ══════════════════════════════════════════════════════════════════════════
-- Авианосцы (Fleet Carrier / Squadron Carrier): собственный учёт проекта.
--
-- Зачем: оверлей Colonial Helper брал груз авианосца только из Raven Colonial,
-- а туда уходили одни аддитивные дельты (PATCH) — без корректировок по рынку,
-- без банка эскадры и с риском повторной отправки истории. Цифры «протухали»,
-- а при недоступности Raven блок CARRIER оставался пустым. Теперь сервер
-- проекта сам ведёт состояние каждого носителя:
--
--   * fleet_carriers       — реестр: тип, позывной, имя, привязка к пилоту и
--                            эскадрилье, система/прыжок, службы, статус;
--   * fleet_carrier_cargo  — груз поимённо: базовый снимок + дельты после него;
--   * fleet_carrier_events — журнал грузовых дельт (идемпотентность по хешу).
--
-- Груз считается так (для каждой пары носитель+товар):
--
--     quantity = max(0, baseline_qty + Σ delta(event_at > baseline_at))
--
-- Базовый снимок бывает полным (трюм пуст по CarrierStats, CarrierBuy,
-- Frontier CAPI) и частичным (рынок авианосца: товары на продажу). Дельты,
-- пришедшие раньше снимка, в нём уже учтены и в сумму не входят — поэтому
-- повторная загрузка старых журналов (сайт + Helper, сброс кэша) ничего не
-- удваивает и не откатывает.
--
-- Все записи идут через service_role (маршруты Next.js проверяют права);
-- anon/authenticated к таблицам и функциям доступа не имеют.
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.fleet_carriers (
  carrier_id            BIGINT PRIMARY KEY CHECK (carrier_id > 0),
  carrier_type          TEXT NOT NULL DEFAULT 'FleetCarrier'
                          CHECK (carrier_type IN ('FleetCarrier', 'SquadronCarrier')),
  callsign              TEXT,
  name                  TEXT,
  name_at               TIMESTAMPTZ,
  -- Привязка к профилю пилота (личный Drake-Class).
  owner_id              UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  owner_source          TEXT CHECK (owner_source IN ('journal', 'capi', 'manual')),
  owner_at              TIMESTAMPTZ,
  -- Привязка к эскадрилье (Javelin-Class или носитель, отданный эскадре).
  squadron_id           BIGINT REFERENCES public.squadrons(id) ON DELETE SET NULL,
  squadron_source       TEXT CHECK (squadron_source IN ('journal', 'manual', 'legacy')),
  squadron_at           TIMESTAMPTZ,
  -- Где стоит.
  system_name           TEXT,
  system_address        BIGINT,
  body_name             TEXT,
  body_id               INTEGER,
  x                     DOUBLE PRECISION,
  y                     DOUBLE PRECISION,
  z                     DOUBLE PRECISION,
  location_at           TIMESTAMPTZ,
  location_source       TEXT,
  -- Запланированный прыжок (CarrierJumpRequest).
  jump_system_name      TEXT,
  jump_system_address   BIGINT,
  jump_body_name        TEXT,
  jump_body_id          INTEGER,
  jump_departure_at     TIMESTAMPTZ,
  jump_requested_at     TIMESTAMPTZ,
  -- Статус.
  docking_access        TEXT,
  allow_notorious       BOOLEAN,
  docking_at            TIMESTAMPTZ,
  pending_decommission  BOOLEAN NOT NULL DEFAULT false,
  decommission_at       TIMESTAMPTZ,
  fuel_level            INTEGER,
  jump_range_curr       DOUBLE PRECISION,
  jump_range_max        DOUBLE PRECISION,
  space_usage           JSONB CHECK (space_usage IS NULL OR jsonb_typeof(space_usage) = 'object'),
  finance               JSONB CHECK (finance IS NULL OR jsonb_typeof(finance) = 'object'),
  stats_at              TIMESTAMPTZ,
  -- Службы экипажа (CarrierStats.Crew + CarrierCrewServices).
  services              JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(services) = 'array'),
  services_at           TIMESTAMPTZ,
  -- Службы станции из Docked.StationServices (видны любому пилоту).
  station_services      JSONB CHECK (station_services IS NULL OR jsonb_typeof(station_services) = 'array'),
  station_services_at   TIMESTAMPTZ,
  -- Ордера рынка владельца (CarrierTradeOrder): товар → {purchase, sale, price, ...}.
  trade_orders          JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(trade_orders) = 'object'),
  -- Последний ПОЛНЫЙ снимок трюма.
  cargo_baseline_at     TIMESTAMPTZ,
  cargo_baseline_source TEXT,
  cargo_updated_at      TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Один личный авианосец на профиль: у командира в игре он тоже один.
CREATE UNIQUE INDEX IF NOT EXISTS fleet_carriers_one_personal
  ON public.fleet_carriers(owner_id)
  WHERE owner_id IS NOT NULL AND carrier_type = 'FleetCarrier';
CREATE INDEX IF NOT EXISTS fleet_carriers_squadron
  ON public.fleet_carriers(squadron_id) WHERE squadron_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fleet_carriers_callsign
  ON public.fleet_carriers(upper(callsign)) WHERE callsign IS NOT NULL;
CREATE INDEX IF NOT EXISTS fleet_carriers_system
  ON public.fleet_carriers(lower(system_name)) WHERE system_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.fleet_carrier_cargo (
  carrier_id      BIGINT NOT NULL REFERENCES public.fleet_carriers(carrier_id) ON DELETE CASCADE,
  commodity       TEXT NOT NULL CHECK (commodity ~ '^[a-z0-9]{1,80}$'),
  name_localised  TEXT,
  baseline_qty    INTEGER NOT NULL DEFAULT 0 CHECK (baseline_qty >= 0),
  baseline_at     TIMESTAMPTZ,
  baseline_source TEXT,
  quantity        INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (carrier_id, commodity)
);

CREATE TABLE IF NOT EXISTS public.fleet_carrier_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carrier_id  BIGINT NOT NULL REFERENCES public.fleet_carriers(carrier_id) ON DELETE CASCADE,
  -- Хеш считает сервер из полей самого журнального события: один и тот же
  -- MarketSell из Helper'а и из загрузки на сайте даёт один хеш.
  event_hash  TEXT NOT NULL UNIQUE CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  source      TEXT NOT NULL,
  event       TEXT NOT NULL,
  commodity   TEXT NOT NULL CHECK (commodity ~ '^[a-z0-9]{1,80}$'),
  delta       INTEGER NOT NULL CHECK (delta <> 0),
  event_at    TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fleet_carrier_events_ledger
  ON public.fleet_carrier_events(carrier_id, commodity, event_at);

ALTER TABLE public.fleet_carriers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_carrier_cargo ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_carrier_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fleet_carriers, public.fleet_carrier_cargo, public.fleet_carrier_events
  FROM anon, authenticated;
GRANT ALL ON public.fleet_carriers, public.fleet_carrier_cargo, public.fleet_carrier_events
  TO service_role;

-- ── Перенос старой ручной таблицы squadron_carriers ─────────────────────────
-- Она создавалась, но так и не использовалась интерфейсом. Данные, если они
-- есть, становятся привязками эскадрилий в новой модели.
DO $$
BEGIN
  IF to_regclass('public.squadron_carriers') IS NOT NULL THEN
    INSERT INTO public.fleet_carriers(
      carrier_id, callsign, name, name_at, squadron_id, squadron_source, squadron_at,
      system_name, x, y, z, location_at, location_source)
    SELECT DISTINCT ON (sc.carrier_id::bigint)
      sc.carrier_id::bigint, NULLIF(trim(sc.callsign), ''), NULLIF(trim(sc.carrier_name), ''),
      sc.created_at, sc.squadron_id, 'legacy', sc.created_at,
      NULLIF(trim(sc.current_system), ''), sc.x, sc.y, sc.z,
      CASE WHEN NULLIF(trim(sc.current_system), '') IS NULL THEN NULL ELSE sc.updated_at END,
      'legacy'
    FROM public.squadron_carriers sc
    JOIN public.squadrons s ON s.id = sc.squadron_id
    WHERE sc.carrier_id ~ '^[0-9]{1,18}$' AND sc.carrier_id::bigint > 0
    ORDER BY sc.carrier_id::bigint, sc.updated_at DESC NULLS LAST
    ON CONFLICT (carrier_id) DO NOTHING;
  END IF;
END $$;

-- ── Перенос рынка авианосца вслед за самим авианосцем ──────────────────────
-- Каталог станций (station_commerce) хранит рынок FC по MarketID, но систему
-- обновлял только при следующей стыковке. После прыжка рынок оставался
-- «торговать» в старой системе. Здесь строка каталога переезжает вместе с
-- носителем, снимки рынка остаются привязанными к MarketID.
CREATE OR REPLACE FUNCTION public.move_fleet_carrier_station(
  p_carrier_id BIGINT, p_system TEXT, p_x DOUBLE PRECISION, p_y DOUBLE PRECISION,
  p_z DOUBLE PRECISION, p_at TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  previous RECORD;
  sys_key TEXT := lower(trim(coalesce(p_system, '')));
BEGIN
  IF sys_key = '' OR p_at IS NULL OR to_regclass('public.station_commerce') IS NULL THEN
    RETURN false;
  END IF;
  SELECT system_name, station_name, observed_at INTO previous
    FROM station_commerce WHERE station_key = 'market:' || p_carrier_id FOR UPDATE;
  IF NOT FOUND OR lower(previous.system_name) = sys_key OR previous.observed_at >= p_at THEN
    RETURN false;
  END IF;
  INSERT INTO commerce_systems(system_name, name_lc, x, y, z, has_stations, observed_at, source)
    VALUES (trim(p_system), sys_key, p_x, p_y, p_z, true, p_at, 'colonial-helper')
  ON CONFLICT (name_lc) DO UPDATE SET
    has_stations = true,
    x = coalesce(commerce_systems.x, EXCLUDED.x),
    y = coalesce(commerce_systems.y, EXCLUDED.y),
    z = coalesce(commerce_systems.z, EXCLUDED.z);
  IF to_regclass('public.market_prices') IS NOT NULL THEN
    DELETE FROM market_prices
      WHERE lower(system_name) = lower(previous.system_name)
        AND lower(station_name) = lower(previous.station_name);
  END IF;
  IF to_regclass('public.market_search_cache') IS NOT NULL THEN
    DELETE FROM market_search_cache WHERE market_id::text = p_carrier_id::text;
  END IF;
  UPDATE station_commerce SET
    system_name = trim(p_system), system_lc = sys_key,
    -- Орбита/тело старой системы после прыжка недействительны.
    metadata = coalesce(metadata, '{}'::jsonb) - 'body_name' - 'body_id' - 'distance_to_arrival'
               - 'latitude' - 'longitude' - 'local_position',
    observed_at = p_at, source = 'colonial-helper'
  WHERE station_key = 'market:' || p_carrier_id;
  RETURN true;
END;
$$;

-- ── Применение пакета наблюдений ────────────────────────────────────────────
-- p_ops — массив операций, уже нормализованных сервером из журнальных событий
-- (см. src/lib/fleetCarriers.ts). Порядок не важен: каждое поле обновляется
-- только более свежим наблюдением, груз пересчитывается из журнала дельт.
CREATE OR REPLACE FUNCTION public.apply_fleet_carrier_batch(
  p_user_id UUID, p_source TEXT, p_ops JSONB)
RETURNS JSONB
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  op JSONB;
  item JSONB;
  kind TEXT;
  cid BIGINT;
  at TIMESTAMPTZ;
  car public.fleet_carriers%ROWTYPE;
  touched BIGINT[] := ARRAY[]::BIGINT[];
  user_squadron BIGINT;
  other_personal RECORD;
  inserted_id BIGINT;
  applied INTEGER := 0;
  duplicates INTEGER := 0;
  ignored INTEGER := 0;
  moved INTEGER := 0;
  patch JSONB;
  role_key TEXT;
  found_role BOOLEAN;
  services_new JSONB;
  same_system BOOLEAN;
  cargo_touched BIGINT[] := ARRAY[]::BIGINT[];
BEGIN
  IF p_source NOT IN ('helper', 'web', 'capi', 'manual') THEN
    RAISE EXCEPTION 'Invalid carrier source %', p_source;
  END IF;
  IF p_ops IS NULL OR jsonb_typeof(p_ops) <> 'array' THEN
    RAISE EXCEPTION 'Carrier ops must be an array';
  END IF;
  IF jsonb_array_length(p_ops) > 5000 THEN
    RAISE EXCEPTION 'Too many carrier ops';
  END IF;

  -- Носители пакета: создаём и блокируем в стабильном порядке. Блокировка
  -- нужна, чтобы два Helper'а эскадрильи, пишущие в один носитель, не
  -- пересчитали груз по неполному журналу дельт.
  SELECT coalesce(array_agg(DISTINCT (o->>'carrier_id')::bigint), ARRAY[]::BIGINT[]) INTO touched
    FROM jsonb_array_elements(p_ops) o
   WHERE (o->>'carrier_id') ~ '^[0-9]{1,18}$' AND (o->>'carrier_id')::bigint > 0;
  INSERT INTO fleet_carriers(carrier_id)
    SELECT unnest(touched) ON CONFLICT (carrier_id) DO NOTHING;
  PERFORM 1 FROM fleet_carriers WHERE carrier_id = ANY(touched) ORDER BY carrier_id FOR UPDATE;

  IF p_user_id IS NOT NULL THEN
    SELECT squadron_id INTO user_squadron
      FROM squadron_members WHERE user_id = p_user_id ORDER BY squadron_id LIMIT 1;
  END IF;

  -- Порядок: по времени события, при равном времени — как прислал сервер
  -- (identity → stats → owner одного CarrierStats идут друг за другом).
  FOR op IN
    SELECT e.value FROM jsonb_array_elements(p_ops) WITH ORDINALITY AS e(value, n)
    ORDER BY (e.value->>'at')::timestamptz NULLS FIRST, e.n
  LOOP
    kind := op->>'op';
    IF (op->>'carrier_id') !~ '^[0-9]{1,18}$' THEN
      ignored := ignored + 1;
      CONTINUE;
    END IF;
    cid := (op->>'carrier_id')::bigint;
    at := (op->>'at')::timestamptz;
    IF at IS NULL OR at > now() + interval '10 minutes' THEN
      ignored := ignored + 1;
      CONTINUE;
    END IF;
    SELECT * INTO car FROM fleet_carriers WHERE carrier_id = cid;

    IF kind = 'identity' THEN
      -- weak_name: имя из Docked.StationName — только если настоящего ещё нет
      -- (у непереименованного носителя там позывной, а не имя).
      UPDATE fleet_carriers SET
        carrier_type = CASE WHEN op->>'carrier_type' = 'SquadronCarrier' THEN 'SquadronCarrier' ELSE carrier_type END,
        -- Эскадренный носитель принадлежит эскадрилье, а не пилоту.
        owner_id = CASE WHEN op->>'carrier_type' = 'SquadronCarrier' THEN NULL ELSE owner_id END,
        owner_source = CASE WHEN op->>'carrier_type' = 'SquadronCarrier' THEN NULL ELSE owner_source END,
        owner_at = CASE WHEN op->>'carrier_type' = 'SquadronCarrier' THEN NULL ELSE owner_at END,
        callsign = coalesce(NULLIF(op->>'callsign', ''), callsign),
        name = CASE
          WHEN NULLIF(op->>'name', '') IS NULL THEN name
          WHEN coalesce((op->>'weak_name')::boolean, false) THEN coalesce(name, op->>'name')
          WHEN name_at IS NULL OR at >= name_at THEN op->>'name'
          ELSE name END,
        name_at = CASE
          WHEN NULLIF(op->>'name', '') IS NULL OR coalesce((op->>'weak_name')::boolean, false) THEN name_at
          WHEN name_at IS NULL OR at >= name_at THEN at
          ELSE name_at END,
        station_services = CASE WHEN jsonb_typeof(op->'station_services') = 'array'
                                  AND (station_services_at IS NULL OR at >= station_services_at)
                                THEN op->'station_services' ELSE station_services END,
        station_services_at = CASE WHEN jsonb_typeof(op->'station_services') = 'array'
                                     AND (station_services_at IS NULL OR at >= station_services_at)
                                   THEN at ELSE station_services_at END,
        updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'stats' THEN
      IF car.stats_at IS NOT NULL AND at < car.stats_at THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        carrier_type = CASE WHEN op->>'carrier_type' = 'SquadronCarrier' THEN 'SquadronCarrier' ELSE carrier_type END,
        callsign = coalesce(NULLIF(op->>'callsign', ''), callsign),
        name = CASE WHEN NULLIF(op->>'name', '') IS NOT NULL AND (name_at IS NULL OR at >= name_at)
                    THEN op->>'name' ELSE name END,
        name_at = CASE WHEN NULLIF(op->>'name', '') IS NOT NULL AND (name_at IS NULL OR at >= name_at)
                       THEN at ELSE name_at END,
        docking_access = CASE WHEN op ? 'docking_access' AND (docking_at IS NULL OR at >= docking_at)
                              THEN op->>'docking_access' ELSE docking_access END,
        allow_notorious = CASE WHEN op ? 'allow_notorious' AND (docking_at IS NULL OR at >= docking_at)
                               THEN (op->>'allow_notorious')::boolean ELSE allow_notorious END,
        docking_at = CASE WHEN op ? 'docking_access' AND (docking_at IS NULL OR at >= docking_at)
                          THEN at ELSE docking_at END,
        pending_decommission = CASE WHEN op ? 'pending_decommission' AND (decommission_at IS NULL OR at >= decommission_at)
                                    THEN (op->>'pending_decommission')::boolean ELSE pending_decommission END,
        decommission_at = CASE WHEN op ? 'pending_decommission' AND (decommission_at IS NULL OR at >= decommission_at)
                               THEN at ELSE decommission_at END,
        fuel_level = coalesce((op->>'fuel_level')::integer, fuel_level),
        jump_range_curr = coalesce((op->>'jump_range_curr')::double precision, jump_range_curr),
        jump_range_max = coalesce((op->>'jump_range_max')::double precision, jump_range_max),
        space_usage = CASE WHEN jsonb_typeof(op->'space_usage') = 'object' THEN op->'space_usage' ELSE space_usage END,
        finance = CASE WHEN jsonb_typeof(op->'finance') = 'object' THEN op->'finance' ELSE finance END,
        services = CASE WHEN jsonb_typeof(op->'services') = 'array' AND (services_at IS NULL OR at >= services_at)
                        THEN op->'services' ELSE services END,
        services_at = CASE WHEN jsonb_typeof(op->'services') = 'array' AND (services_at IS NULL OR at >= services_at)
                           THEN at ELSE services_at END,
        stats_at = at,
        updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'owner' THEN
      -- Личная привязка. Доказательства: CarrierStats/CarrierBuy (приходят
      -- только владельцу) и Frontier CAPI; «мягкое» — CarrierLocation.
      IF p_user_id IS NULL OR car.carrier_type = 'SquadronCarrier' THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      IF car.owner_id = p_user_id THEN
        UPDATE fleet_carriers SET
          owner_at = greatest(coalesce(owner_at, at), at),
          owner_source = CASE WHEN owner_source = 'manual' AND op->>'proof' IN ('journal', 'capi')
                              THEN op->>'proof' ELSE owner_source END
        WHERE carrier_id = cid;
        applied := applied + 1;
        CONTINUE;
      END IF;
      IF op->>'proof' = 'soft' AND car.owner_id IS NOT NULL AND car.owner_source <> 'manual' THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      IF car.owner_id IS NOT NULL AND car.owner_source <> 'manual' AND car.owner_at IS NOT NULL
         AND at < car.owner_at THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      SELECT carrier_id, owner_at, owner_source INTO other_personal FROM fleet_carriers
        WHERE owner_id = p_user_id AND carrier_type = 'FleetCarrier' AND carrier_id <> cid
        LIMIT 1;
      IF FOUND THEN
        -- Старый журнал с прежним (списанным) носителем не отбирает привязку
        -- у текущего; «мягкое» доказательство не отбирает её никогда.
        IF op->>'proof' = 'soft' OR (other_personal.owner_source <> 'manual'
             AND other_personal.owner_at IS NOT NULL AND other_personal.owner_at > at) THEN
          ignored := ignored + 1;
          CONTINUE;
        END IF;
        UPDATE fleet_carriers SET owner_id = NULL, owner_source = NULL, owner_at = NULL
          WHERE carrier_id = other_personal.carrier_id;
      END IF;
      UPDATE fleet_carriers SET
        owner_id = p_user_id,
        owner_source = CASE WHEN op->>'proof' = 'capi' THEN 'capi' ELSE 'journal' END,
        owner_at = at,
        updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'squadron_claim' THEN
      -- Эскадренный носитель: пилот, видящий его CarrierStats/CarrierLocation
      -- или стыкующийся к нему (только для членов эскадрильи), привязывает
      -- его к своей эскадрилье на сайте — если носитель ещё ничей.
      IF user_squadron IS NULL OR car.carrier_type <> 'SquadronCarrier'
         OR (car.squadron_id IS NOT NULL AND car.squadron_id <> user_squadron) THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        squadron_id = user_squadron,
        squadron_source = coalesce(squadron_source, 'journal'),
        squadron_at = greatest(coalesce(squadron_at, at), at),
        updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'location' THEN
      IF NULLIF(op->>'system_name', '') IS NULL
         OR (car.location_at IS NOT NULL AND at < car.location_at) THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      same_system := lower(op->>'system_name') = lower(coalesce(car.system_name, ''));
      UPDATE fleet_carriers SET
        system_name = op->>'system_name',
        -- Тело, координаты и адрес прежней системы после прыжка недействительны.
        system_address = CASE WHEN op ? 'system_address' THEN (op->>'system_address')::bigint
                              WHEN same_system THEN system_address ELSE NULL END,
        body_name = CASE WHEN op ? 'body_name' THEN NULLIF(op->>'body_name', '')
                         WHEN same_system THEN body_name ELSE NULL END,
        body_id = CASE WHEN op ? 'body_id' THEN (op->>'body_id')::integer
                       WHEN same_system THEN body_id ELSE NULL END,
        x = CASE WHEN op ? 'x' THEN (op->>'x')::double precision WHEN same_system THEN x ELSE NULL END,
        y = CASE WHEN op ? 'y' THEN (op->>'y')::double precision WHEN same_system THEN y ELSE NULL END,
        z = CASE WHEN op ? 'z' THEN (op->>'z')::double precision WHEN same_system THEN z ELSE NULL END,
        location_at = at,
        location_source = coalesce(op->>'source_event', location_source),
        updated_at = now()
      WHERE carrier_id = cid;
      -- Прыжок завершён (или сорвался без события): носитель уже не там,
      -- где был в момент запроса.
      IF car.jump_departure_at IS NOT NULL AND at >= car.jump_departure_at THEN
        UPDATE fleet_carriers SET
          jump_system_name = NULL, jump_system_address = NULL, jump_body_name = NULL,
          jump_body_id = NULL, jump_departure_at = NULL, jump_requested_at = NULL
        WHERE carrier_id = cid;
      END IF;
      applied := applied + 1;
      IF public.move_fleet_carrier_station(cid, op->>'system_name', (op->>'x')::double precision,
           (op->>'y')::double precision, (op->>'z')::double precision, at) THEN
        moved := moved + 1;
      END IF;

    ELSIF kind = 'jump' THEN
      IF (car.jump_requested_at IS NOT NULL AND at < car.jump_requested_at)
         OR (car.location_at IS NOT NULL AND (op->>'departure_at') IS NOT NULL
             AND (op->>'departure_at')::timestamptz <= car.location_at)
         OR (car.location_at IS NOT NULL AND at < car.location_at AND (op->>'departure_at') IS NULL) THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        jump_system_name = NULLIF(op->>'system_name', ''),
        jump_system_address = (op->>'system_address')::bigint,
        jump_body_name = NULLIF(op->>'body_name', ''),
        jump_body_id = (op->>'body_id')::integer,
        jump_departure_at = (op->>'departure_at')::timestamptz,
        jump_requested_at = at,
        updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'jump_cancel' THEN
      IF car.jump_requested_at IS NULL OR at < car.jump_requested_at THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        jump_system_name = NULL, jump_system_address = NULL, jump_body_name = NULL,
        jump_body_id = NULL, jump_departure_at = NULL, jump_requested_at = NULL,
        updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'decommission' THEN
      IF car.decommission_at IS NOT NULL AND at < car.decommission_at THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        pending_decommission = coalesce((op->>'pending')::boolean, false),
        decommission_at = at, updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'docking' THEN
      IF car.docking_at IS NOT NULL AND at < car.docking_at THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        docking_access = coalesce(op->>'docking_access', docking_access),
        allow_notorious = coalesce((op->>'allow_notorious')::boolean, allow_notorious),
        docking_at = at, updated_at = now()
      WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'service' THEN
      role_key := lower(coalesce(op->>'role', ''));
      IF role_key = '' OR (car.services_at IS NOT NULL AND at < car.services_at) THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      patch := CASE op->>'operation'
        WHEN 'activate' THEN jsonb_build_object('activated', true, 'enabled', true)
        WHEN 'deactivate' THEN jsonb_build_object('activated', false, 'enabled', false)
        WHEN 'pause' THEN jsonb_build_object('enabled', false)
        WHEN 'resume' THEN jsonb_build_object('enabled', true)
        ELSE '{}'::jsonb END;
      IF NULLIF(op->>'crew_name', '') IS NOT NULL THEN
        patch := patch || jsonb_build_object('crew_name', op->>'crew_name');
      END IF;
      SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(car.services) s WHERE lower(s->>'role') = role_key)
        INTO found_role;
      IF found_role THEN
        SELECT coalesce(jsonb_agg(CASE WHEN lower(s->>'role') = role_key THEN s || patch ELSE s END), '[]'::jsonb)
          INTO services_new FROM jsonb_array_elements(car.services) s;
      ELSE
        services_new := car.services || jsonb_build_array(
          jsonb_build_object('role', op->>'role', 'activated', false, 'enabled', false) || patch);
      END IF;
      UPDATE fleet_carriers SET services = services_new, services_at = at, updated_at = now()
        WHERE carrier_id = cid;
      applied := applied + 1;

    ELSIF kind = 'order' THEN
      item := car.trade_orders -> (op->>'commodity');
      IF NULLIF(op->>'commodity', '') IS NULL
         OR (item IS NOT NULL AND (item->>'at')::timestamptz > at) THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      IF coalesce((op->>'cancel')::boolean, false) THEN
        UPDATE fleet_carriers SET trade_orders = trade_orders - (op->>'commodity'), updated_at = now()
          WHERE carrier_id = cid;
      ELSE
        UPDATE fleet_carriers SET trade_orders = trade_orders || jsonb_build_object(op->>'commodity',
            jsonb_strip_nulls(jsonb_build_object(
              'name', NULLIF(op->>'name_localised', ''),
              'purchase', (op->>'purchase')::integer,
              'sale', (op->>'sale')::integer,
              'price', (op->>'price')::integer,
              'black_market', coalesce((op->>'black_market')::boolean, false),
              'at', at))),
          updated_at = now()
        WHERE carrier_id = cid;
      END IF;
      applied := applied + 1;

    ELSIF kind = 'delta' THEN
      IF (op->>'commodity') !~ '^[a-z0-9]{1,80}$' OR coalesce((op->>'delta')::integer, 0) = 0
         OR (op->>'hash') !~ '^[0-9a-f]{64}$' THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      inserted_id := NULL;
      INSERT INTO fleet_carrier_events(carrier_id, event_hash, user_id, source, event, commodity, delta, event_at)
        VALUES (cid, op->>'hash', p_user_id, p_source, coalesce(op->>'event', 'unknown'),
                op->>'commodity', (op->>'delta')::integer, at)
      ON CONFLICT (event_hash) DO NOTHING
      RETURNING id INTO inserted_id;
      IF inserted_id IS NULL THEN
        duplicates := duplicates + 1;
        CONTINUE;
      END IF;
      INSERT INTO fleet_carrier_cargo(carrier_id, commodity, name_localised, baseline_qty, baseline_at, baseline_source)
        VALUES (cid, op->>'commodity', NULLIF(op->>'name_localised', ''), 0,
                car.cargo_baseline_at, car.cargo_baseline_source)
      ON CONFLICT (carrier_id, commodity) DO UPDATE SET
        name_localised = coalesce(fleet_carrier_cargo.name_localised, EXCLUDED.name_localised);
      cargo_touched := array_append(cargo_touched, cid);
      applied := applied + 1;

    ELSIF kind = 'baseline' THEN
      IF jsonb_typeof(op->'items') <> 'array' THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      IF coalesce((op->>'full')::boolean, false) THEN
        IF car.cargo_baseline_at IS NOT NULL AND at <= car.cargo_baseline_at THEN
          ignored := ignored + 1;
          CONTINUE;
        END IF;
        UPDATE fleet_carriers SET cargo_baseline_at = at, cargo_baseline_source = op->>'source_event'
          WHERE carrier_id = cid;
        UPDATE fleet_carrier_cargo SET baseline_qty = 0, baseline_at = at, baseline_source = op->>'source_event'
          WHERE carrier_id = cid AND (baseline_at IS NULL OR baseline_at < at);
        -- Дельты до полного снимка в нём уже учтены и больше не нужны.
        DELETE FROM fleet_carrier_events WHERE carrier_id = cid AND event_at <= at;
      ELSIF car.cargo_baseline_at IS NOT NULL AND at <= car.cargo_baseline_at THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(op->'items') LOOP
        IF (item->>'commodity') !~ '^[a-z0-9]{1,80}$' OR coalesce((item->>'qty')::integer, -1) < 0 THEN
          CONTINUE;
        END IF;
        INSERT INTO fleet_carrier_cargo(carrier_id, commodity, name_localised, baseline_qty, baseline_at, baseline_source)
          VALUES (cid, item->>'commodity', NULLIF(item->>'name_localised', ''), (item->>'qty')::integer,
                  at, op->>'source_event')
        ON CONFLICT (carrier_id, commodity) DO UPDATE SET
          baseline_qty = EXCLUDED.baseline_qty,
          baseline_at = EXCLUDED.baseline_at,
          baseline_source = EXCLUDED.baseline_source,
          name_localised = coalesce(EXCLUDED.name_localised, fleet_carrier_cargo.name_localised)
        WHERE fleet_carrier_cargo.baseline_at IS NULL OR fleet_carrier_cargo.baseline_at <= EXCLUDED.baseline_at;
      END LOOP;
      cargo_touched := array_append(cargo_touched, cid);
      applied := applied + 1;

    ELSE
      ignored := ignored + 1;
    END IF;
  END LOOP;

  -- Пересчёт груза затронутых носителей одним проходом.
  IF cardinality(cargo_touched) > 0 THEN
    UPDATE fleet_carrier_cargo c SET
      quantity = greatest(0, c.baseline_qty + coalesce((
        SELECT sum(e.delta) FROM fleet_carrier_events e
         WHERE e.carrier_id = c.carrier_id AND e.commodity = c.commodity
           AND (c.baseline_at IS NULL OR e.event_at > c.baseline_at)), 0)),
      updated_at = now()
    WHERE c.carrier_id = ANY(cargo_touched);
    UPDATE fleet_carriers SET cargo_updated_at = now() WHERE carrier_id = ANY(cargo_touched);
  END IF;

  RETURN jsonb_build_object(
    'applied', applied, 'duplicates', duplicates, 'ignored', ignored,
    'stations_moved', moved, 'carriers', to_jsonb(touched));
END;
$$;

REVOKE ALL ON FUNCTION public.apply_fleet_carrier_batch(UUID, TEXT, JSONB),
  public.move_fleet_carrier_station(BIGINT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_fleet_carrier_batch(UUID, TEXT, JSONB),
  public.move_fleet_carrier_station(BIGINT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ)
  TO service_role;

COMMENT ON TABLE public.fleet_carriers IS
  'Авианосцы: личные (owner_id) и эскадренные (squadron_id). Пишется только сервером (service_role).';
COMMENT ON TABLE public.fleet_carrier_cargo IS
  'Груз авианосца: quantity = baseline_qty + сумма дельт после baseline_at.';
COMMENT ON TABLE public.fleet_carrier_events IS
  'Грузовые дельты из журналов (MarketSell/MarketBuy/CargoTransfer/банк эскадры); event_hash — идемпотентность.';

NOTIFY pgrst, 'reload schema';
