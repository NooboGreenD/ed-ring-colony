-- RavenColonial returns a weighted completion percentage with two decimal
-- places. Preserve it in the cache and marker source tables so /map displays
-- the same progress as the live system detail page, rather than a rounded
-- integer (or a failed integer cast).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'system_progress' AND column_name = 'progress'
  ) THEN
    ALTER TABLE public.system_progress
      ALTER COLUMN progress TYPE NUMERIC(7,2)
      USING progress::NUMERIC(7,2);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'route_systems' AND column_name = 'progress'
  ) THEN
    ALTER TABLE public.route_systems
      ALTER COLUMN progress TYPE NUMERIC(7,2)
      USING progress::NUMERIC(7,2);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'hubs' AND column_name = 'progress'
  ) THEN
    ALTER TABLE public.hubs
      ALTER COLUMN progress TYPE NUMERIC(7,2)
      USING progress::NUMERIC(7,2);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'raven_sync_log' AND column_name = 'progress'
  ) THEN
    ALTER TABLE public.raven_sync_log
      ALTER COLUMN progress TYPE NUMERIC(7,2)
      USING progress::NUMERIC(7,2);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'raven_sync_log' AND column_name = 'system_progress'
  ) THEN
    ALTER TABLE public.raven_sync_log
      ALTER COLUMN system_progress TYPE NUMERIC(7,2)
      USING system_progress::NUMERIC(7,2);
  END IF;
END $$;
