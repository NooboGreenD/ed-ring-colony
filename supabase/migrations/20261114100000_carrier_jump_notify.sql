-- ══════════════════════════════════════════════════════════════════════════
-- Уведомления о прыжках авианосцев, на которые подписан пилот.
--
-- Зачем
-- -----
-- Страница «Авианосцы перед прыжком» (`/carriers/jumps`) умеет подписываться
-- на носитель: в `atlas_carrier_watch` лежит снимок плана (`jump_system_name`,
-- `jump_departure_at`, `jump_seen_at`, миграция
-- `20261110190000_carrier_watch_jump.sql`). Пока страница открыта, подписчик
-- видит, что план изменился; но прыжок случается и тогда, когда сайт закрыт.
--
-- Поэтому уведомление пишется в `user_notifications` — тот же канал, из
-- которого живёт колокольчик (`NotificationBell`): он читает таблицу, слушает
-- Realtime и опрашивает её раз в 15 секунд, а при скрытой вкладке показывает
-- браузерное уведомление. Web-push здесь не участвует: он требует серверного
-- вызова, а событие рождается в базе. Отдельного механизма не заводим.
--
-- Что является событием
-- ---------------------
-- Строка `carrier_jump_history` — состоявшийся прыжок (её пишут триггеры
-- учёта сайта и реестра EDDN, миграция `20261113120000_carrier_jump_history.sql`).
-- Значит, здесь не нужно ничего вычислять: вставка истории и есть «носитель
-- прыгнул». Отменённый заказ, перенос плана и стоянка без прыжка события не
-- создают — подписчику приходит только то, что действительно случилось.
--
-- Кому
-- ----
-- Только тем, кто подписан именно на прыжок: `jump_seen_at IS NOT NULL`.
-- Обычное избранное Атласа (`favorite`) уведомлений не получает — пилот
-- добавил носитель в список, а не просил следить за вылетом.
--
-- Текст намеренно без языка: заголовок — позывной (или имя, или MarketID),
-- тело — `откуда → куда`. Вид уведомления (`type = 'carrier_jump'`) колокольчик
-- подписывает на языке пилота (`nbell.typeCarrierJump`), а системы и позывные
-- не переводятся. Так одно уведомление читается на всех семи локалях сайта.
--
-- Доступ
-- ------
-- Пишет уведомления только триггер под `SECURITY DEFINER` (service_role),
-- прямых прав у клиентов на `carrier_jump_history` нет. Читает каждый свои
-- строки `user_notifications` — правило RLS там уже есть, его не трогаем.
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.carrier_jump_notify_watchers()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_title TEXT;
  v_body  TEXT;
BEGIN
  -- Подпись носителя на момент прыжка: позывной, иначе имя, иначе MarketID.
  v_title := coalesce(
    nullif(btrim(coalesce(NEW.callsign, '')), ''),
    nullif(btrim(coalesce(NEW.name, '')), ''),
    '#' || NEW.carrier_id::text
  );
  v_body := btrim(NEW.from_system) || ' → ' || btrim(NEW.to_system);

  INSERT INTO public.user_notifications(user_id, type, title, body, href, metadata)
  SELECT
    w.user_id,
    'carrier_jump',
    left(v_title, 200),
    left(v_body, 1000),
    -- Ссылка ведёт в Атлас на вкладку «Авианосцы» и фокусирует носитель
    -- (страница читает `carrier` и выбирает систему слоя).
    '/atlas?tab=carriers&carrier=' || NEW.carrier_id::text,
    jsonb_build_object(
      'carrier_id', NEW.carrier_id,
      'from_system', NEW.from_system,
      'to_system', NEW.to_system,
      'jumped_at', NEW.jumped_at,
      'source', NEW.source
    )
  FROM public.atlas_carrier_watch w
  -- Профиль обязателен: `user_notifications.user_id` ссылается на
  -- `profiles(id)`, а подписка — на `auth.users(id)`. Пилот без профиля
  -- (не завершил регистрацию) уведомление не получит, и это не должно
  -- ронять запись истории прыжка.
  JOIN public.profiles p ON p.id = w.user_id
  WHERE w.carrier_id = NEW.carrier_id::text
    AND w.jump_seen_at IS NOT NULL;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.carrier_jump_notify_watchers() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS carrier_jump_notify_watchers ON public.carrier_jump_history;
CREATE TRIGGER carrier_jump_notify_watchers
  AFTER INSERT ON public.carrier_jump_history
  FOR EACH ROW
  EXECUTE FUNCTION public.carrier_jump_notify_watchers();

COMMENT ON FUNCTION public.carrier_jump_notify_watchers() IS
  'Прыжок носителя из истории → уведомление в колокольчик каждому подписчику (atlas_carrier_watch.jump_seen_at).';
