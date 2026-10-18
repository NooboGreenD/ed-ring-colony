-- ══════════════════════════════════════════════════════════════════════════
-- Авианосцы: эскадренный носитель привязывается только к своей эскадрилье.
--
-- Жалоба: «все авианосцы эскадрилий на карте отображаются как авианосцы
-- эскадрильи [DNHG] DRUNK HEDGEHOG».
--
-- Причина. Сервер считал доказательством членства и стыковку к Javelin
-- (Docked/Location/CarrierJump со службой squadronBank): «к эскадренному
-- носителю пускают только членов эскадры». Это неверно: доступ к стыковке у
-- Javelin настраивается так же, как у Drake, и может быть открыт всем пилотам.
-- Пилот эскадрильи, пристыковавшийся к чужому Javelin, приписывал его своей
-- эскадрилье, а правило «первая привязка навсегда» не давало это исправить ни
-- журналам настоящих хозяев, ни их офицерам (ручная привязка отвечала 409).
-- Вместе с подписью на карте носитель получал права «эскадрильи»: её участники
-- видели его груз, офицеры — финансы.
--
-- Что меняется (функция apply_fleet_carrier_batch, операция squadron_claim):
--   1. Привязку дают только события, которые игра пишет членам эскадрильи
--      носителя (поле proof): CarrierLocation — при каждом запуске игры, сразу
--      после SquadronStartup; CarrierStats — управление носителем;
--      CarrierBuy. Операции без proof шлёт сервер прежней версии (в том числе
--      пока после этой миграции пересобирается образ) — они игнорируются.
--   2. Тег. Позывной Javelin — тег его эскадрильи в игре (четыре символа,
--      «ENEX» у ENDURANCE EXPLORATION). Если и он, и тег эскадрильи на сайте
--      известны и не совпадают, носитель к ней не привязывается, а уже
--      сделанная журналом привязка снимается (fleet_carrier_tag_conflict).
--   3. Свежесть: события старше 30 дней привязку не дают — старый журнал
--      помнит прежнюю эскадрилью пилота.
--   4. Отвязку офицерами журналы больше не отменяют: эскадрилья попадает в
--      squadron_rejected, и журналы её участников носитель к ней не вернут
--      (вернуть можно ручной привязкой).
--   5. Источник 'member' — привязка по этим правилам. 'journal' остаётся
--      только у старых непроверенных привязок: подтверждённая заявка другой
--      эскадрильи её перехватывает.
--   6. Ремонт данных: имя стоянки Javelin из четырёх символов — это тег, он
--      переезжает в callsign; старые привязки 'journal' снимаются, кроме тех,
--      где тег носителя совпадает с тегом эскадрильи (они становятся
--      'member'). Настоящие привязки вернутся сами: CarrierLocation пишется
--      участникам при каждом запуске игры. Повторный прогон миграции
--      безопасен — привязки по новым правилам имеют источник 'member'.
-- ══════════════════════════════════════════════════════════════════════════

-- 1. Источник привязки 'member' ─────────────────────────────────────────────
-- Ограничение создавалось в определении колонки, поэтому его имя ищем по
-- тексту: снимаем любое прежнее и ставим новое (повторный прогон безопасен).
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.fleet_carriers'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%squadron_source%'
  LOOP
    EXECUTE format('ALTER TABLE public.fleet_carriers DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE public.fleet_carriers ADD CONSTRAINT fleet_carriers_squadron_source_check
  CHECK (squadron_source IN ('journal', 'member', 'manual', 'legacy'));

-- 2. Эскадрильи, отказавшиеся от носителя ────────────────────────────────────
ALTER TABLE public.fleet_carriers
  ADD COLUMN IF NOT EXISTS squadron_rejected BIGINT[] NOT NULL DEFAULT '{}'::BIGINT[];

-- 3. Тег носителя против тега эскадрильи ─────────────────────────────────────
-- Позывной Javelin — тег эскадрильи в игре (ровно четыре символа). Тег
-- эскадрильи на сайте сравнивается без скобок и пробелов; тег другой длины
-- ничего не доказывает (его могли собрать из названия). То же правило — в
-- src/lib/carrierTags.ts.
CREATE OR REPLACE FUNCTION public.fleet_carrier_tag_conflict(p_callsign TEXT, p_squadron_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce((
    SELECT t.carrier_tag <> t.squadron_tag
      FROM (SELECT upper(btrim(coalesce(p_callsign, ''))) AS carrier_tag,
                   upper(regexp_replace(coalesce(s.tag, ''), '[^A-Za-z0-9]', '', 'g')) AS squadron_tag
              FROM squadrons s
             WHERE s.id = p_squadron_id) AS t
     WHERE t.carrier_tag ~ '^[A-Z0-9]{4}$' AND t.squadron_tag ~ '^[A-Z0-9]{4}$'), false);
$$;

-- 4. Применение пакета наблюдений ────────────────────────────────────────────
-- Тело — из 20261017000000_fleet_carriers.sql; изменены ветки identity (тег
-- снимает ошибочную привязку журнала) и squadron_claim (правила выше).
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
      -- Позывной Javelin — тег его эскадрильи в игре. Стал известен и не
      -- совпадает с тегом эскадрильи, к которой носитель привязал журнал, —
      -- привязка ошибочная (пилот на сайте не в той эскадрилье, что в игре).
      -- Ручную привязку решали офицеры — её не трогаем.
      IF car.squadron_id IS NOT NULL AND car.squadron_source IN ('journal', 'member') THEN
        UPDATE fleet_carriers SET squadron_id = NULL, squadron_source = NULL, squadron_at = NULL
          WHERE carrier_id = cid AND public.fleet_carrier_tag_conflict(callsign, squadron_id);
      END IF;
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
      -- Эскадренный носитель привязывается к эскадрилье пилота на сайте только
      -- по событию, которое игра пишет членам эскадрильи носителя (proof):
      -- CarrierLocation при запуске игры, CarrierStats, CarrierBuy. Стыковка
      -- не доказывает ничего — Javelin пускает и чужих; операции без proof
      -- (сервер прежней версии) игнорируются. Кроме того, привязку не дают:
      --   * события старше 30 дней — старый журнал помнит прежнюю эскадрилью;
      --   * эскадрилья, чьи офицеры отвязали носитель (squadron_rejected);
      --   * тег носителя, не совпадающий с тегом эскадрильи;
      --   * чужая подтверждённая или ручная привязка — её перехватывает только
      --     заявка против старой непроверенной ('journal').
      IF coalesce(op->>'proof', '') NOT IN ('CarrierStats', 'CarrierBuy', 'CarrierLocation')
         OR at < now() - interval '30 days'
         OR user_squadron IS NULL OR car.carrier_type <> 'SquadronCarrier'
         OR user_squadron = ANY(car.squadron_rejected)
         OR public.fleet_carrier_tag_conflict(car.callsign, user_squadron)
         OR (car.squadron_id IS NOT NULL AND car.squadron_id <> user_squadron
             AND car.squadron_source IS DISTINCT FROM 'journal') THEN
        ignored := ignored + 1;
        CONTINUE;
      END IF;
      UPDATE fleet_carriers SET
        squadron_id = user_squadron,
        squadron_source = CASE WHEN squadron_id = user_squadron AND squadron_source IN ('manual', 'legacy')
                               THEN squadron_source ELSE 'member' END,
        squadron_at = CASE WHEN squadron_id = user_squadron THEN greatest(coalesce(squadron_at, at), at)
                           ELSE at END,
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
  public.fleet_carrier_tag_conflict(TEXT, BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_fleet_carrier_batch(UUID, TEXT, JSONB),
  public.fleet_carrier_tag_conflict(TEXT, BIGINT)
  TO service_role;

-- 5. Ремонт данных ───────────────────────────────────────────────────────────
-- Имя стоянки Javelin из четырёх символов (слабое имя из Docked.StationName,
-- name_at пуст) — это его позывной, тег эскадрильи.
UPDATE public.fleet_carriers
   SET callsign = coalesce(callsign, upper(btrim(name))), name = NULL, updated_at = now()
 WHERE carrier_type = 'SquadronCarrier' AND name_at IS NULL
   AND btrim(name) ~ '^[A-Za-z0-9]{4}$';

-- Старые привязки журнала: подтверждённые тегом остаются (уже по новым
-- правилам), остальные — в основном «по стыковке» — снимаются.
UPDATE public.fleet_carriers c
   SET squadron_source = 'member', updated_at = now()
 WHERE c.squadron_source = 'journal' AND c.squadron_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM public.squadrons s
      WHERE s.id = c.squadron_id
        AND upper(regexp_replace(coalesce(s.tag, ''), '[^A-Za-z0-9]', '', 'g')) ~ '^[A-Z0-9]{4}$'
        AND upper(regexp_replace(coalesce(s.tag, ''), '[^A-Za-z0-9]', '', 'g')) = upper(btrim(c.callsign)));
UPDATE public.fleet_carriers
   SET squadron_id = NULL, squadron_source = NULL, squadron_at = NULL, updated_at = now()
 WHERE squadron_source = 'journal';

COMMENT ON COLUMN public.fleet_carriers.squadron_source IS
  'Откуда привязка к эскадрилье: member — журнал участника (CarrierLocation/CarrierStats/CarrierBuy), manual — офицер, legacy — старая таблица squadron_carriers, journal — старая непроверенная.';
COMMENT ON COLUMN public.fleet_carriers.squadron_rejected IS
  'Эскадрильи, чьи офицеры отвязали носитель: журналы их участников его больше не привязывают.';

NOTIFY pgrst, 'reload schema';
