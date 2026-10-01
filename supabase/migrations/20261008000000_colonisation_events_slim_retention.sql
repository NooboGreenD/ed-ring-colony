-- ─────────────────────────────────────────────────────────────────────────
-- colonisation_events: худеем и перестаём расти бесконечно
--
-- Контекст: таблица рассчитывалась на ~3 ГБ, а выросла до 12+. Две причины:
--
--   1. `raw_event` хранил ПОЛНУЮ копию события журнала — вместе с
--      `ResourcesRequired` (тот же список ресурсов, что и в
--      `resources_total`) и `Name_Localised` каждого ресурса. Строка
--      выходила вдвое-втрое тяжелее полезного содержимого, при этом колонку
--      никто не читает, кроме диагностики `raw_event->>'event'`.
--      Новый код пишет только `{"event": "..."}`; здесь худеют старые строки.
--
--   2. У таблицы не было политики хранения: история «наблюдений» строек
--      копилась вечно, хотя читателю (enrichRavenSystemWithJournalSnapshots)
--      нужен только ПОСЛЕДНИЙ снимок каждой площадки, а повторы с 28.09.2026
--      отсекаются `source_hash`. Функция `colonisation_events_prune()` ниже
--      вызывается расписанием (`/api/cron/colonisation-cleanup`) и удаляет:
--        • все вклады `ColonisationContribution` (их никто не читает,
--          тоннаж командира живёт в `deliveries`);
--        • состояния старше окна (по умолчанию 60 дней), КРОМЕ последнего
--          снимка каждой площадки — он нужен карте Raven;
--        • снимки `construction_depot_snapshots` старше окна (графики
--          прогресса не смотрят в бесконечную историю).
--
-- Миграция безопасна на живой базе: UPDATE идёт построчно без блокировки
-- схемы, функция создаётся заново (OR REPLACE). Место на диске возвращается
-- не сразу: после миграции выполните `VACUUM (ANALYZE) colonisation_events`,
-- а в тихое окно — `VACUUM FULL` или `pg_repack` (см. maintenance-скрипт).
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Старые строки: от сырого события остаётся только маркер типа.
--    Условие по длине отсекает уже слитые строки — повторный запуск ничего
--    не переписывает (миграция идемпотентна и по числу затронутых строк).
UPDATE public.colonisation_events
   SET raw_event = jsonb_build_object('event', coalesce(raw_event->>'event', ''))
 WHERE raw_event IS NOT NULL
   AND octet_length(raw_event::text) > 256;

COMMENT ON COLUMN public.colonisation_events.raw_event IS
  'Маркер типа события ({"event":"ColonisationConstructionDepot"}). Полное событие журнала больше не хранится: всё нужное лежит в колонках и resources_total.';

-- 2. «Монеты наёмников»: сброс мусора, написанного до фикса источника.
--    Поле заполнялось из Statistics.Combat.Combat_Bond_Profits — это
--    накопленные за всю игру КРЕДИТЫ за боевые облигации (сотни миллионов),
--    а не жетоны Operations (кап игры 9999, журнал хранит их в
--    Bank_Account.MercCoins_Current). Следующая загрузка журнала запишет
--    настоящее значение.
UPDATE public.pilot_stats
   SET mercenary_coins = 0
 WHERE mercenary_coins IS NOT NULL
   AND mercenary_coins > 100000;

-- 3. Функция хранения: вызывается расписанием, но доступна и для ручного
--    запуска: SELECT * FROM public.colonisation_events_prune(60);
CREATE OR REPLACE FUNCTION public.colonisation_events_prune(
  p_retain_days integer DEFAULT 60
)
RETURNS TABLE(deleted_events bigint, deleted_snapshots bigint, deleted_contributions bigint)
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff timestamptz;
  events_deleted bigint;
  snapshots_deleted bigint;
  contributions_deleted bigint;
BEGIN
  IF p_retain_days IS NULL OR p_retain_days < 7 THEN
    cutoff := now() - interval '60 days';
  ELSE
    cutoff := now() - make_interval(days => p_retain_days);
  END IF;

  -- 3a. Вклады: не читает никто — убираем целиком, независимо от возраста.
  DELETE FROM public.colonisation_events
   WHERE coalesce(raw_event->>'event', '') = 'ColonisationContribution';
  GET DIAGNOSTICS contributions_deleted = ROW_COUNT;

  -- 3b. История состояний старше окна. Последний снимок площадки (по
  --     user_id + market_id) переживает чистку: его читает обогащение
  --     Raven Colonial, когда журнал свежее ответа Raven.
  DELETE FROM public.colonisation_events
   WHERE event_timestamp < cutoff
     AND id NOT IN (
       SELECT latest.id
         FROM (
           SELECT DISTINCT ON (user_id, market_id) id
             FROM public.colonisation_events
            WHERE market_id IS NOT NULL
            ORDER BY user_id, market_id, event_timestamp DESC
         ) AS latest
     );
  GET DIAGNOSTICS events_deleted = ROW_COUNT;

  -- 3c. Снимки прогресса: графики читают окно, а не всю историю.
  DELETE FROM public.construction_depot_snapshots
   WHERE snapshot_at < cutoff;
  GET DIAGNOSTICS snapshots_deleted = ROW_COUNT;

  RETURN QUERY SELECT events_deleted, snapshots_deleted, contributions_deleted;
END;
$$;

COMMENT ON FUNCTION public.colonisation_events_prune(integer) IS
  'Политика хранения colonisation_events: удалить вклады, состояния старше N дней (кроме последнего снимка площадки) и старые снимки прогресса. Вызывается /api/cron/colonisation-cleanup.';

-- 4. Индекс под чистку: поиск «последнего снимка площадки» в большой таблице.
CREATE INDEX IF NOT EXISTS idx_colonisation_events_user_market_time
  ON public.colonisation_events (user_id, market_id, event_timestamp DESC);
