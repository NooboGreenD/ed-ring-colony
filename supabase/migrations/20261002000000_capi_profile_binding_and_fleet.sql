-- Frontier CAPI: дополнительные поля для полной карточки пилота.
--
-- Привязка выполняется по user_id (UUID), а cmdr_name используется только
-- для ссылки /cmdr/<name>. Поэтому смена имени Frontier не должна создавать
-- второй профиль или затирать пользовательский ник сайта.

ALTER TABLE public.capi_profiles
  ADD COLUMN IF NOT EXISTS cqc_rank INTEGER,
  ADD COLUMN IF NOT EXISTS loan BIGINT,
  ADD COLUMN IF NOT EXISTS frontier_id TEXT;

CREATE INDEX IF NOT EXISTS idx_capi_profiles_cmdr_name
  ON public.capi_profiles (cmdr_name);

COMMENT ON COLUMN public.capi_profiles.frontier_id IS 'Идентификатор командира Frontier, если его отдаёт CAPI';
COMMENT ON COLUMN public.capi_profiles.loan IS 'Текущий кредитный займ командира из Frontier CAPI';
