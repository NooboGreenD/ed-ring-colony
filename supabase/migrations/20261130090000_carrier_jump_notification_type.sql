-- The legacy support migration installs a notification type allowlist but
-- carrier_jump_notify_watchers inserts 'carrier_jump'. A watched carrier's
-- location update then aborts the entire carrier batch, including cargo.
-- Widen the existing check, preserving every previously allowed/custom type.
-- No notifications, cargo, events, baselines, subscriptions or RLS are changed.
DO $$
DECLARE
  predicate text;
BEGIN
  -- Fail quickly rather than queue a long table lock on a busy deployment.
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE public.user_notifications IN ACCESS EXCLUSIVE MODE;

  SELECT pg_get_expr(c.conbin, c.conrelid) INTO predicate
  FROM pg_constraint c
  WHERE c.conrelid = 'public.user_notifications'::regclass
    AND c.conname = 'user_notifications_type_check' AND c.contype = 'c';

  -- Newer base schemas have no allowlist: do not introduce a restriction.
  IF predicate IS NULL THEN
    RETURN;
  END IF;
  -- pg_get_expr preserves this explicit OR arm. Reapplication is a no-op.
  IF strpos(predicate, '(type = ''carrier_jump''::text)') > 0 THEN
    RETURN;
  END IF;

  ALTER TABLE public.user_notifications
    DROP CONSTRAINT user_notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.user_notifications ADD CONSTRAINT user_notifications_type_check CHECK ((%s) OR (type = ''carrier_jump''::text))',
    predicate
  );
END;
$$;
