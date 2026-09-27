-- ─────────────────────────────────────────────────────────────
-- Frontier CAPI: состояние привязки должно быть видно, а не угадываться.
--
-- Зачем
-- -----
-- Жалоба «все этапы проходят, но привязка не делается» была неотличима от
-- «Companion API временно недоступен» и от «база отстала на миграцию»:
-- в capi_tokens хранился только сам токен, а причина сбоя нигде не
-- фиксировалась. Ниже — минимум полей, по которым сайт и cron понимают,
-- жива ли связь и что с ней случилось в последний раз.
--
--   platform      — на каком аккаунте авторизовался пилот (audience OAuth:
--                   frontier/steam/epic/xbox/psn). Нужен, чтобы предложить
--                   тот же способ входа при переподключении.
--   linked_at     — когда привязка создана. Refresh-токен Frontier живёт не
--                   дольше 25 дней от авторизации, и по этой дате видно,
--                   что пора просить пилота авторизоваться заново.
--   last_error    — текст последнего сбоя синхронизации.
--   last_error_at — когда он случился.
--
-- Колонки добавляются NULL'ами: у существующих привязок истории нет, а
-- «нет данных» и «ошибок не было» — разные состояния.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.capi_tokens
  ADD COLUMN IF NOT EXISTS platform      TEXT,
  ADD COLUMN IF NOT EXISTS linked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error    TEXT,
  ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;

-- Один аккаунт Frontier — одна учётная запись сайта. Индекс нужен колбэку:
-- он проверяет, не привязан ли этот customer_id к кому-то ещё, прежде чем
-- перезаписывать токены.
CREATE INDEX IF NOT EXISTS idx_capi_tokens_frontier_id
  ON public.capi_tokens (frontier_id)
  WHERE frontier_id IS NOT NULL;

-- Cron берёт привязки по времени последнего синка, начиная с тех, которых
-- не синхронизировали ни разу.
CREATE INDEX IF NOT EXISTS idx_capi_tokens_sync_queue
  ON public.capi_tokens (last_synced_at NULLS FIRST)
  WHERE is_active;

COMMENT ON COLUMN public.capi_tokens.platform IS 'Платформа аккаунта Frontier (audience OAuth): frontier, steam, epic, xbox, psn';
COMMENT ON COLUMN public.capi_tokens.linked_at IS 'Когда пилот прошёл авторизацию Frontier; refresh-токен живёт не дольше 25 дней от этой даты';
COMMENT ON COLUMN public.capi_tokens.last_error IS 'Последняя ошибка синхронизации CAPI — показывается в /account/capi';

-- Ранги Odyssey из CAPI (commander.rank.soldier / .exobiologist): колонки
-- уже есть в capi_profiles с миграции 20260916000000, но у баз, залитых
-- ранним снимком схемы, их может не быть — повторяем идемпотентно, иначе
-- синк молча теряет эти два ранга.
ALTER TABLE public.capi_profiles
  ADD COLUMN IF NOT EXISTS mercenary_rank    INTEGER,
  ADD COLUMN IF NOT EXISTS exobiologist_rank INTEGER,
  ADD COLUMN IF NOT EXISTS cqc_rank          INTEGER,
  ADD COLUMN IF NOT EXISTS loan              BIGINT,
  ADD COLUMN IF NOT EXISTS frontier_id       TEXT;
