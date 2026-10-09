-- ─────────────────────────────────────────────────────────────────────────
-- colonisation_sites: одна строка на площадку вместо истории colonisation_events
--
-- Что на самом деле читает сайт: обогащение Raven Colonial берёт ПОСЛЕДНИЙ
-- известный список ресурсов каждой площадки (по MarketID) — и больше ничего
-- из истории не нужно. А писали все клиенты (браузер, Colonial Helper, CAPI,
-- страница журнала) строку на КАЖДОЕ событие ColonisationConstructionDepot и
-- на каждого командира отдельно, с полным ResourcesRequired (включая Payment
-- и Name_Localised) плюс raw_event, source_hash и journal_import_id. Отсюда
-- 12+ ГБ при ~3 ГБ логов: история, размноженная по пилотам, и копии одного
-- состояния.
--
-- Эта миграция ничего не удаляет и не переписывает. Она нужна, чтобы код
-- нового релиза уже мог писать в новую таблицу, а старая продолжала работать
-- до переключения (обновление применяет миграции ДО перезапуска сайта):
--   • public.colonisation_sites — текущее состояние площадки, PK = MarketID;
--   • colonisation_sites_write(jsonb) — запись «новее побеждает» в одной
--     транзакции; возвращает, какие площадки реально изменились (по ним
--     строятся снимки прогресса, повтор состояния снимка не даёт);
--   • colonisation_retention_prune(days) — чистка снимков прогресса вместо
--     colonisation_events_prune, которая ходила в историю состояний.
-- Перенос последнего состояния и удаление старой таблицы (освобождает место)
-- — вручную: supabase/maintenance/colonisation_sites_cutover.sql.
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Текущее состояние площадки ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.colonisation_sites (
  market_id             BIGINT PRIMARY KEY,
  system_name           TEXT NOT NULL,
  construction_id       BIGINT,
  construction_name     TEXT,
  construction_progress NUMERIC(5,2),
  resources_total       JSONB NOT NULL DEFAULT '[]'::jsonb,
  event_timestamp       TIMESTAMPTZ NOT NULL,
  -- Кто последним прислал состояние. ON DELETE SET NULL: удаление аккаунта
  -- не должно стирать состояние площадки, которое нужно всем (Raven-карте).
  user_id               UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.colonisation_sites IS
  'Текущее состояние каждой стройплощадки (ключ — MarketID из журнала). Одна строка на площадку; история прогресса — в construction_depot_snapshots.';
COMMENT ON COLUMN public.colonisation_sites.resources_total IS
  'Компактный список ресурсов: Name, Name_Localised (если есть), RequiredAmount, ProvidedAmount. Payment и прочие поля журнала не хранятся.';
COMMENT ON COLUMN public.colonisation_sites.event_timestamp IS
  'Момент журнала, которому соответствует состояние. Более старое состояние не перезаписывает более новое.';

-- Клиенты (anon/authenticated) таблицу не читают и не пишут: ни прав, ни
-- политик для них нет. Сервер работает под service_role — ей выдаём права
-- явно (не полагаясь на DEFAULT PRIVILEGES) и единственную политику.
ALTER TABLE public.colonisation_sites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.colonisation_sites FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.colonisation_sites TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'colonisation_sites'
       AND policyname = 'colonisation_sites_service_role'
  ) THEN
    CREATE POLICY colonisation_sites_service_role ON public.colonisation_sites
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 2. Компактный список ресурсов ───────────────────────────────────────────
-- Хранятся только поля, которые читает обогащение Raven и отпечаток «ничего
-- не изменилось». Элементы без имени или с нечисловыми суммами отбрасываются.
-- Список сортируется по имени, чтобы один и тот же набор в другом порядке не
-- выглядел как изменение. Функция серверная: старые Helper'ы пришлют полный
-- ResourcesRequired, и таблица останется лёгкой и при них.
CREATE OR REPLACE FUNCTION public.colonisation_compact_resources(p_resources jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  WITH src AS (
    SELECT e.r,
           coalesce(e.r->>'Name', e.r->>'name', '') AS name,
           nullif(coalesce(e.r->>'Name_Localised', e.r->>'nameLocalised', ''), '') AS localised,
           btrim(coalesce(e.r->>'RequiredAmount', e.r->>'requiredAmount')) AS required_text,
           btrim(coalesce(e.r->>'ProvidedAmount', e.r->>'providedAmount')) AS provided_text
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(p_resources) = 'array' THEN p_resources ELSE '[]'::jsonb END
           ) AS e(r)
     WHERE jsonb_typeof(e.r) = 'object'
  )
  SELECT coalesce(
           jsonb_agg(
             jsonb_strip_nulls(jsonb_build_object(
               'Name', src.name,
               'Name_Localised', src.localised,
               'RequiredAmount', greatest(src.required_text::numeric, 0),
               'ProvidedAmount', greatest(src.provided_text::numeric, 0)
             ))
             ORDER BY src.name
           ),
           '[]'::jsonb
         )
    FROM src
   WHERE src.name <> ''
     AND src.required_text ~ '^-?[0-9]+(\.[0-9]+)?$'
     AND src.provided_text ~ '^-?[0-9]+(\.[0-9]+)?$';
$$;

-- Отпечаток состояния для проверки «ничего не изменилось»: то же, что
-- хранится, но без Name_Localised. Смена языка журнала у клиента — не новое
-- состояние стройки, и снимок прогресса из-за неё не пишется.
CREATE OR REPLACE FUNCTION public.colonisation_resources_state(p_resources jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT coalesce(
           jsonb_agg((e.elem - 'Name_Localised') ORDER BY e.elem->>'Name'),
           '[]'::jsonb
         )
    FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(p_resources) = 'array' THEN p_resources ELSE '[]'::jsonb END
         ) AS e(elem);
$$;

-- 3. Запись состояний: «новее побеждает» ───────────────────────────────────
-- Вход — массив строк (см. src/lib/colonisationEvents.ts). Внутри одной пачки
-- на площадку остаётся самое позднее состояние; при равной метке времени
-- побеждает строка, пришедшая позже в пачке. Строка в базе обновляется, только
-- если метка времени новее — повтор старого состояния ничего не меняет.
-- Возвращает market_id текстом: MarketID — 64-битное число, и JSON-числа
-- клиента могут потерять точность.
-- `changed` = площадка новая или изменился прогресс/список ресурсов (имена
-- и суммы; локализация и Payment не в счёт): только такие состояния дают снимок.
CREATE OR REPLACE FUNCTION public.colonisation_sites_write(p_rows jsonb)
RETURNS TABLE (market_id text, changed boolean)
LANGUAGE sql
SET search_path = public
AS $$
  WITH parsed AS (
    SELECT r.market_id, r.system_name, r.construction_id, r.construction_name,
           r.construction_progress, r.resources_total, r.event_timestamp, r.user_id,
           e.ord
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(p_rows) = 'array' THEN p_rows ELSE '[]'::jsonb END
           ) WITH ORDINALITY AS e(elem, ord)
     CROSS JOIN LATERAL jsonb_to_record(e.elem) AS r(
             market_id bigint,
             system_name text,
             construction_id bigint,
             construction_name text,
             construction_progress numeric,
             resources_total jsonb,
             event_timestamp timestamptz,
             user_id uuid)
     WHERE jsonb_typeof(e.elem) = 'object'
  ),
  incoming AS (
    SELECT DISTINCT ON (p.market_id)
           p.market_id,
           btrim(p.system_name)                                 AS system_name,
           p.construction_id,
           nullif(btrim(coalesce(p.construction_name, '')), '') AS construction_name,
           round(p.construction_progress, 2)                    AS construction_progress,
           public.colonisation_compact_resources(p.resources_total) AS resources_total,
           p.event_timestamp,
           p.user_id
      FROM parsed AS p
     WHERE p.market_id IS NOT NULL
       AND p.market_id <> 0
       AND p.event_timestamp IS NOT NULL
       AND btrim(coalesce(p.system_name, '')) <> ''
     ORDER BY p.market_id, p.event_timestamp DESC, p.ord DESC
  ),
  before AS (
    SELECT s.market_id, s.construction_progress, s.resources_total
      FROM public.colonisation_sites AS s
      JOIN incoming AS i ON i.market_id = s.market_id
  ),
  upserted AS (
    INSERT INTO public.colonisation_sites AS s (
      market_id, system_name, construction_id, construction_name,
      construction_progress, resources_total, event_timestamp, user_id
    )
    SELECT i.market_id, i.system_name, i.construction_id, i.construction_name,
           i.construction_progress, i.resources_total, i.event_timestamp, i.user_id
      FROM incoming AS i
    ON CONFLICT (market_id) DO UPDATE SET
      system_name           = EXCLUDED.system_name,
      construction_id       = EXCLUDED.construction_id,
      construction_name     = EXCLUDED.construction_name,
      construction_progress = EXCLUDED.construction_progress,
      resources_total       = EXCLUDED.resources_total,
      event_timestamp       = EXCLUDED.event_timestamp,
      user_id               = EXCLUDED.user_id
    WHERE EXCLUDED.event_timestamp > s.event_timestamp
    RETURNING s.market_id
  )
  SELECT u.market_id::text,
         (
           NOT EXISTS (SELECT 1 FROM before b WHERE b.market_id = u.market_id)
           OR EXISTS (
             SELECT 1
               FROM before b
               JOIN incoming i ON i.market_id = b.market_id
              WHERE b.market_id = u.market_id
                AND (
                  b.construction_progress IS DISTINCT FROM i.construction_progress
                  OR public.colonisation_resources_state(b.resources_total)
                     IS DISTINCT FROM public.colonisation_resources_state(i.resources_total)
                )
           )
         ) AS changed
    FROM upserted AS u;
$$;

-- 4. Чистка снимков прогресса ──────────────────────────────────────────────
-- Вызывается /api/cron/colonisation-cleanup. Состояния площадок чистить не
-- нужно: в таблице одна строка на площадку. Старая таблица colonisation_events
-- (если ещё не удалена maintenance-скриптом) функцией не трогается.
DROP FUNCTION IF EXISTS public.colonisation_events_prune(integer);

CREATE OR REPLACE FUNCTION public.colonisation_retention_prune(
  p_retain_days integer DEFAULT 60
)
RETURNS TABLE (deleted_snapshots bigint, legacy_events_present boolean)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  cutoff timestamptz;
  snapshots_deleted bigint;
BEGIN
  IF p_retain_days IS NULL OR p_retain_days < 7 THEN
    cutoff := now() - interval '60 days';
  ELSE
    cutoff := now() - make_interval(days => p_retain_days);
  END IF;

  DELETE FROM public.construction_depot_snapshots
   WHERE snapshot_at < cutoff;
  GET DIAGNOSTICS snapshots_deleted = ROW_COUNT;

  RETURN QUERY SELECT snapshots_deleted, to_regclass('public.colonisation_events') IS NOT NULL;
END;
$$;

COMMENT ON FUNCTION public.colonisation_retention_prune(integer) IS
  'Удаляет снимки прогресса старше окна (по умолчанию 60 дней). Возвращает число удалённых снимков и признак, что старая таблица colonisation_events ещё существует.';

-- 5. Доступ: функции записи и чистки — только для сервера ─────────────────
-- У функций по умолчанию EXECUTE есть у PUBLIC, а PostgREST отдаёт их anon и
-- authenticated. Без этих REVOKE любой клиент с публичным ключом мог бы писать
-- в таблицу или чистить снимки.
REVOKE ALL ON FUNCTION public.colonisation_compact_resources(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.colonisation_resources_state(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.colonisation_sites_write(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.colonisation_retention_prune(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.colonisation_compact_resources(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.colonisation_resources_state(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.colonisation_sites_write(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.colonisation_retention_prune(integer) TO service_role;

-- 6. Старая таблица ───────────────────────────────────────────────────────
-- Пустую colonisation_events (новая установка, где журнал ещё не грузили)
-- удаляем сразу. Непустую не трогаем: её переносит maintenance-скрипт.
-- Блокировка берётся с NOWAIT: если в таблицу сейчас пишут, миграция её не
-- ждёт и не рискует удалить строку, которая появилась в этот момент.
DO $$
BEGIN
  IF to_regclass('public.colonisation_events') IS NOT NULL THEN
    BEGIN
      LOCK TABLE public.colonisation_events IN ACCESS EXCLUSIVE MODE NOWAIT;
      IF NOT EXISTS (SELECT 1 FROM public.colonisation_events) THEN
        DROP TABLE public.colonisation_events;
      ELSE
        COMMENT ON TABLE public.colonisation_events IS
          'УСТАРЕЛО: история состояний стройки заменена таблицей colonisation_sites. Перенос и удаление — supabase/maintenance/colonisation_sites_cutover.sql.';
      END IF;
    EXCEPTION WHEN lock_not_available THEN
      RAISE NOTICE 'colonisation_events занята записью — проверка на пустоту пропущена';
    END;
  END IF;
END $$;
