-- ============================================================
-- GALNET_NEWS — новости из Elite Dangerous Galnet
-- Автоматически подтягиваются с официального API
--
-- ⚠ Файл восстановлен 2026-09-25. Прежняя версия лежала одной строкой без
--   переводов строк: первый комментарий съедал весь остаток файла, поэтому
--   миграция не создавала ни одной таблицы. psql считает пустой скрипт
--   успешно выполненным, так что поломка была не видна до первого запроса:
--   на таблице висели переводы Galnet (20260915000000), сверка структуры
--   (20260924010000) и весь синк из scripts/lib/galnet-sync.mjs.
-- ============================================================

-- ─── GALNET_NEWS: лента новостей ────────────────────────────
CREATE TABLE IF NOT EXISTS public.galnet_news (
  id           SERIAL PRIMARY KEY,
  nid          TEXT UNIQUE NOT NULL,  -- внешний ID из Galnet API (по нему идёт upsert)
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  image        TEXT,                  -- URL изображения из Galnet
  published_at TIMESTAMPTZ NOT NULL,
  fetched_at   TIMESTAMPTZ DEFAULT NOW(),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_galnet_published ON public.galnet_news(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_galnet_nid ON public.galnet_news(nid);

ALTER TABLE public.galnet_news ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS galnet_select ON public.galnet_news;
CREATE POLICY galnet_select ON public.galnet_news
  FOR SELECT TO anon, authenticated USING (true);

GRANT SELECT ON public.galnet_news TO anon, authenticated;

-- ─── GALNET_SYNC_LOG: лог синхронизации ─────────────────────
-- Пишут только сервисные задачи (service_role), читает админка.
CREATE TABLE IF NOT EXISTS public.galnet_sync_log (
  id             SERIAL PRIMARY KEY,
  fetched_at     TIMESTAMPTZ DEFAULT NOW(),
  articles_count INTEGER DEFAULT 0,
  new_count      INTEGER DEFAULT 0,
  error_msg      TEXT,
  status         TEXT DEFAULT 'success'
);

GRANT SELECT, INSERT ON public.galnet_sync_log TO anon, authenticated;

ALTER TABLE public.galnet_sync_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS galnet_sync_select ON public.galnet_sync_log;
CREATE POLICY galnet_sync_select ON public.galnet_sync_log
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS galnet_sync_insert ON public.galnet_sync_log;
CREATE POLICY galnet_sync_insert ON public.galnet_sync_log
  FOR INSERT TO anon, authenticated WITH CHECK (true);
