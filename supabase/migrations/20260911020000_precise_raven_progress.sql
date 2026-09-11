-- RavenColonial returns a weighted completion percentage with two decimal
-- places. Preserve it in the cache and marker source tables so /map displays
-- the same progress as the live system detail page, rather than a rounded
-- integer (or a failed integer cast).
--
-- PostgreSQL records `UPDATE OF progress` and `WHEN (OLD.progress ...)`
-- references in trigger definitions.  Such a trigger prevents ALTER COLUMN
-- directly (for example trg_notify_route_system_change).  Snapshot every
-- user-defined trigger on each affected table, recreate it verbatim after the
-- type conversion, and leave internal FK triggers untouched.  The DO block is
-- atomic: if a conversion or recreation fails, PostgreSQL restores both the
-- original column type and the trigger definitions.
DO $$
DECLARE
  target RECORD;
  saved_trigger RECORD;
  restore_commands TEXT[];
  restore_command TEXT;
BEGIN
  FOR target IN
    SELECT *
    FROM (
      VALUES
        ('system_progress', 'progress'),
        ('route_systems', 'progress'),
        ('hubs', 'progress'),
        ('raven_sync_log', 'progress'),
        ('raven_sync_log', 'system_progress')
    ) AS affected(table_name, column_name)
  LOOP
    -- It is safe to rerun after a partially attempted deployment.  Do not
    -- take table locks/recreate triggers when this exact target type exists.
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = target.table_name
        AND column_name = target.column_name
        AND data_type = 'numeric'
        AND numeric_precision = 7
        AND numeric_scale = 2
    )
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = target.table_name
        AND column_name = target.column_name
    ) THEN
      restore_commands := ARRAY[]::TEXT[];

      FOR saved_trigger IN
        SELECT tg.tgname, tg.tgenabled, pg_get_triggerdef(tg.oid, false) AS definition
        FROM pg_trigger AS tg
        INNER JOIN pg_class AS relation ON relation.oid = tg.tgrelid
        INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = target.table_name
          AND NOT tg.tgisinternal
      LOOP
        restore_commands := array_append(restore_commands, saved_trigger.definition);
        -- pg_get_triggerdef does not include a trigger's enabled mode.
        -- Preserve non-default disabled/replica/always settings as well.
        IF saved_trigger.tgenabled = 'D' THEN
          restore_commands := array_append(
            restore_commands,
            format('ALTER TABLE public.%I DISABLE TRIGGER %I', target.table_name, saved_trigger.tgname)
          );
        ELSIF saved_trigger.tgenabled = 'R' THEN
          restore_commands := array_append(
            restore_commands,
            format('ALTER TABLE public.%I ENABLE REPLICA TRIGGER %I', target.table_name, saved_trigger.tgname)
          );
        ELSIF saved_trigger.tgenabled = 'A' THEN
          restore_commands := array_append(
            restore_commands,
            format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', target.table_name, saved_trigger.tgname)
          );
        END IF;
        EXECUTE format('DROP TRIGGER %I ON public.%I', saved_trigger.tgname, target.table_name);
      END LOOP;

      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN %I TYPE NUMERIC(7,2) USING %I::NUMERIC(7,2)',
        target.table_name,
        target.column_name,
        target.column_name
      );

      FOREACH restore_command IN ARRAY restore_commands LOOP
        EXECUTE restore_command;
      END LOOP;
    END IF;
  END LOOP;
END $$;
