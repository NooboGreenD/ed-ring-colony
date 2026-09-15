-- ============================================================
-- GALNET_NEWS / NEWS — колонки переводов и поля для инкрементальной синхронизации
--
-- Эти колонки уже использовались кодом (src/lib/translate.ts,
-- src/app/api/galnet/route.ts), но не были описаны ни в одной миграции:
-- из-за этого на свежей базе вставка статьи падала с
-- "Could not find the 'translation_status' column of 'galnet_news'".
--
-- Миграция идемпотентна: её можно запускать повторно.
-- ============================================================

-- ── galnet_news ────────────────────────────────────────────
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS guid TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS source_lang TEXT DEFAULT 'en';
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS translation_status TEXT DEFAULT 'pending';
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS translated_at TIMESTAMPTZ;

ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS title_ru TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS title_en TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS title_de TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS title_it TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS title_ko TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS title_zh TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS title_ja TEXT;

ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS body_ru TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS body_en TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS body_de TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS body_it TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS body_ko TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS body_zh TEXT;
ALTER TABLE public.galnet_news ADD COLUMN IF NOT EXISTS body_ja TEXT;

-- Оригинал всегда доступен в колонках исходного языка.
UPDATE public.galnet_news SET title_en = title WHERE title_en IS NULL AND title IS NOT NULL;
UPDATE public.galnet_news SET body_en = body   WHERE body_en IS NULL AND body IS NOT NULL;

-- Существующие переводы помечаем как завершённые.
UPDATE public.galnet_news
   SET translation_status = 'completed',
       translated_at = COALESCE(translated_at, NOW())
 WHERE translated_at IS NOT NULL
   AND COALESCE(translation_status, 'pending') <> 'completed';

UPDATE public.galnet_news
   SET translation_status = 'pending'
 WHERE translation_status IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_galnet_guid ON public.galnet_news(guid) WHERE guid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_galnet_slug ON public.galnet_news(slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_galnet_translation_status ON public.galnet_news(translation_status);

-- ── news ───────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.news') IS NOT NULL THEN
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS translation_status TEXT DEFAULT 'pending';
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS translated_at TIMESTAMPTZ;

    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS title_ru TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS title_en TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS title_de TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS title_it TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS title_ko TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS title_zh TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS title_ja TEXT;

    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS body_ru TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS body_en TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS body_de TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS body_it TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS body_ko TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS body_zh TEXT;
    ALTER TABLE public.news ADD COLUMN IF NOT EXISTS body_ja TEXT;

    UPDATE public.news
       SET translation_status = 'completed',
           translated_at = COALESCE(translated_at, NOW())
     WHERE translated_at IS NOT NULL
       AND COALESCE(translation_status, 'pending') <> 'completed';

    UPDATE public.news SET translation_status = 'pending' WHERE translation_status IS NULL;

    CREATE INDEX IF NOT EXISTS idx_news_translation_status ON public.news(translation_status);
  END IF;
END $$;

-- ── galnet_sync_log — расширяем под новые отчёты ───────────
ALTER TABLE public.galnet_sync_log ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE public.galnet_sync_log ADD COLUMN IF NOT EXISTS translated_count INTEGER DEFAULT 0;
ALTER TABLE public.galnet_sync_log ADD COLUMN IF NOT EXISTS updated_count INTEGER DEFAULT 0;

-- Права на чтение лога (пишет сервисный ключ, он обходит RLS).
GRANT SELECT ON public.galnet_news TO anon, authenticated;
GRANT SELECT ON public.galnet_sync_log TO anon, authenticated;
