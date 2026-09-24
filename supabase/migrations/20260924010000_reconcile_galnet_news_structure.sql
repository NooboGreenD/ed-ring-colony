-- Reconcile public.galnet_news with the exported table structure.
--
-- The CSV export contains the following columns:
--   id, nid, title, body, image, published_at, fetched_at, created_at,
--   title_<language>, body_<language>, translated_at, translation_status,
--   guid, slug, source_lang
--
-- This migration is intentionally idempotent so it can be applied to an
-- existing Supabase project regardless of which earlier Galnet migrations
-- have already been run.

BEGIN;

-- Core article fields. Existing installations normally already have these
-- from 20260830152500_galnet_news.sql.
ALTER TABLE public.galnet_news
  ADD COLUMN IF NOT EXISTS nid TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS body TEXT,
  ADD COLUMN IF NOT EXISTS image TEXT,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- Translation metadata.
ALTER TABLE public.galnet_news
  ADD COLUMN IF NOT EXISTS translated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS translation_status TEXT,
  ADD COLUMN IF NOT EXISTS guid TEXT,
  ADD COLUMN IF NOT EXISTS slug TEXT,
  ADD COLUMN IF NOT EXISTS source_lang TEXT;

-- Localized title and body fields represented by the export.
ALTER TABLE public.galnet_news
  ADD COLUMN IF NOT EXISTS title_ru TEXT,
  ADD COLUMN IF NOT EXISTS title_en TEXT,
  ADD COLUMN IF NOT EXISTS title_de TEXT,
  ADD COLUMN IF NOT EXISTS title_it TEXT,
  ADD COLUMN IF NOT EXISTS title_ko TEXT,
  ADD COLUMN IF NOT EXISTS title_zh TEXT,
  ADD COLUMN IF NOT EXISTS title_ja TEXT,
  ADD COLUMN IF NOT EXISTS body_ru TEXT,
  ADD COLUMN IF NOT EXISTS body_en TEXT,
  ADD COLUMN IF NOT EXISTS body_de TEXT,
  ADD COLUMN IF NOT EXISTS body_it TEXT,
  ADD COLUMN IF NOT EXISTS body_ko TEXT,
  ADD COLUMN IF NOT EXISTS body_zh TEXT,
  ADD COLUMN IF NOT EXISTS body_ja TEXT;

-- Preserve the existing English source content and make the defaults apply
-- to newly inserted rows. NULL checks keep this safe for existing data.
UPDATE public.galnet_news
SET title_en = title
WHERE title_en IS NULL AND title IS NOT NULL;

UPDATE public.galnet_news
SET body_en = body
WHERE body_en IS NULL AND body IS NOT NULL;

UPDATE public.galnet_news
SET source_lang = 'en'
WHERE source_lang IS NULL;

UPDATE public.galnet_news
SET translation_status = 'pending'
WHERE translation_status IS NULL;

ALTER TABLE public.galnet_news
  ALTER COLUMN source_lang SET DEFAULT 'en',
  ALTER COLUMN translation_status SET DEFAULT 'pending';

-- Keep the identifiers used by the sync and translation jobs efficient and
-- unique when they are available. Partial indexes allow legacy NULL values.
CREATE UNIQUE INDEX IF NOT EXISTS idx_galnet_news_nid
  ON public.galnet_news (nid)
  WHERE nid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_galnet_news_guid
  ON public.galnet_news (guid)
  WHERE guid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_galnet_news_slug
  ON public.galnet_news (slug)
  WHERE slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_galnet_news_published_at
  ON public.galnet_news (published_at DESC);

CREATE INDEX IF NOT EXISTS idx_galnet_news_translation_status
  ON public.galnet_news (translation_status);

COMMIT;

-- Expected final columns:
-- id, nid, title, body, image, published_at, fetched_at, created_at,
-- title_ru, title_en, title_de, title_it, title_ko, title_zh, title_ja,
-- body_ru, body_en, body_de, body_it, body_ko, body_zh, body_ja,
-- translated_at, translation_status, guid, slug, source_lang
