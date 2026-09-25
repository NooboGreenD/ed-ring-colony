-- Колонка public.raven_sync_log.synced_at: её пишет API
-- (src/app/api/ravencolonial/sync/log/route.ts, src/app/api/projects/[id]/progress/route.ts),
-- по ней сортирует лог админка (src/components/Admin/RavenSyncTab.tsx), но в
-- схеме она нигде не была описана.
--
-- Из-за этого на базе, поднятой из 000_base_schema.sql, падал индекс
-- idx_raven_sync_log_synced_at в 20260830110258_rls_policies_v2.sql
-- («column "synced_at" does not exist»), а сам лог не заполнялся.
ALTER TABLE public.raven_sync_log
  ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ DEFAULT NOW();

-- Свежие строки без явного synced_at не должны «проваливаться» в конец сортировки.
UPDATE public.raven_sync_log SET synced_at = created_at WHERE synced_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_raven_sync_log_synced_at ON public.raven_sync_log(synced_at);
