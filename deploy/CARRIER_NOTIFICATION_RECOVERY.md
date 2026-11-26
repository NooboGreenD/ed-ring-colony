# Восстановление carrier-sync после ошибки типа уведомления

Подтверждённая ошибка: `user_notifications_type_check` отклоняет уведомление
`carrier_jump`. Триггер уведомления откатывает ту же SQL-транзакцию, в которой
записываются местоположение и груз авика. Helper сохраняет отвергнутую пачку
и повторяет её; LOADING читает прежнее серверное состояние.

## Точечное исправление существующего Docker-развёртывания

Это изменение схемы БД, не ручная коррекция остатков. Оно сохраняет прежнее
условие CHECK и добавляет допустимый тип; таблицы с данными не очищаются,
RLS/права не ослабляются. DO-блок атомарен. При невозможности получить блокировку
за 5 секунд он завершится ошибкой без удаления прежнего ограничения — повторите
позже. Само добавление CHECK проверяет существующие строки таблицы.

Выполнить на сервере, где контейнер БД называется `supabase-db` (из любого каталога):

```bash
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
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
SQL
```

Этот же SQL — новая миграция
`supabase/migrations/20261130090000_carrier_jump_notification_type.sql`.
Повторный штатный прогон миграции после ручного исправления безопасен.
Если production использует другую БД, применять SQL нужно именно в той БД,
к которой подключён сайт, а не в пустой/служебной базе.

## Проверка восстановления

- Не удалять `.carrier_events_outbox.json` и не сбрасывать журнал.
- Оставить Helper с подключением к сайту: после паузы повтора он должен
  подтвердить отправку накопленных событий без 503 и опустошить очередь.
- Сверить свежие серверные остатки и LOADING/паттерн. Повторы тех же исходных
  событий идемпотентны; не добавлять тоннаж вручную по счётчику deliveries.
- Смотреть только новые серверные ошибки после ремонта: старые строки
  `docker logs` остаются в журнале и не означают повторный сбой.
- Если ошибка сохраняется, проверить определение ограничения:

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.user_notifications'::regclass
  AND conname = 'user_notifications_type_check';
```

Агент проверил исправление локально, но не применял его на production.
Для устранения именно этой ошибки обновление Helper не требуется.
