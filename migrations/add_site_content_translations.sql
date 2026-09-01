-- Add translation columns to site_content table
-- Run this in Supabase SQL Editor: https://supabase.com/dashboard/project/sgukfplhxdhmkqponwft/sql

ALTER TABLE site_content
  ADD COLUMN IF NOT EXISTS kicker_ru text,
  ADD COLUMN IF NOT EXISTS kicker_en text,
  ADD COLUMN IF NOT EXISTS kicker_de text,
  ADD COLUMN IF NOT EXISTS kicker_it text,
  ADD COLUMN IF NOT EXISTS kicker_ko text,
  ADD COLUMN IF NOT EXISTS kicker_zh text,
  ADD COLUMN IF NOT EXISTS kicker_ja text,
  ADD COLUMN IF NOT EXISTS title1_ru text,
  ADD COLUMN IF NOT EXISTS title1_en text,
  ADD COLUMN IF NOT EXISTS title1_de text,
  ADD COLUMN IF NOT EXISTS title1_it text,
  ADD COLUMN IF NOT EXISTS title1_ko text,
  ADD COLUMN IF NOT EXISTS title1_zh text,
  ADD COLUMN IF NOT EXISTS title1_ja text,
  ADD COLUMN IF NOT EXISTS title2_ru text,
  ADD COLUMN IF NOT EXISTS title2_en text,
  ADD COLUMN IF NOT EXISTS title2_de text,
  ADD COLUMN IF NOT EXISTS title2_it text,
  ADD COLUMN IF NOT EXISTS title2_ko text,
  ADD COLUMN IF NOT EXISTS title2_zh text,
  ADD COLUMN IF NOT EXISTS title2_ja text,
  ADD COLUMN IF NOT EXISTS manifest_ru text,
  ADD COLUMN IF NOT EXISTS manifest_en text,
  ADD COLUMN IF NOT EXISTS manifest_de text,
  ADD COLUMN IF NOT EXISTS manifest_it text,
  ADD COLUMN IF NOT EXISTS manifest_ko text,
  ADD COLUMN IF NOT EXISTS manifest_zh text,
  ADD COLUMN IF NOT EXISTS manifest_ja text;

-- Copy existing values as Russian defaults
UPDATE site_content SET
  kicker_ru = kicker,
  title1_ru = title1,
  title2_ru = title2,
  manifest_ru = manifest
WHERE id = 1;
