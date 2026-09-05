-- Add translation columns to site_content table
-- Run this in Supabase Studio → SQL Editor

-- kicker translations
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS kicker_en TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS kicker_de TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS kicker_it TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS kicker_ko TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS kicker_zh TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS kicker_ja TEXT DEFAULT '';

-- title1 translations
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS title1_en TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS title1_de TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS title1_it TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS title1_ko TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS title1_zh TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS title1_ja TEXT DEFAULT '';

-- title2 translations
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS title2_en TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS title2_de TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS title2_it TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS title2_ko TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS title2_zh TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS title2_ja TEXT DEFAULT '';

-- manifest translations
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS manifest_en TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS manifest_de TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS manifest_it TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS manifest_ko TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS manifest_zh TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS manifest_ja TEXT DEFAULT '';

-- footer_copyright translations
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_copyright_en TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_copyright_de TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_copyright_it TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_copyright_ko TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_copyright_zh TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_copyright_ja TEXT DEFAULT '';

-- footer_discord translations
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_discord_en TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_discord_de TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_discord_it TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_discord_ko TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_discord_zh TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_discord_ja TEXT DEFAULT '';

-- footer_edsm translations
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_edsm_en TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_edsm_de TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_edsm_it TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_edsm_ko TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_edsm_zh TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_edsm_ja TEXT DEFAULT '';

-- footer_inara translations
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_inara_en TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_inara_de TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_inara_it TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_inara_ko TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_inara_zh TEXT DEFAULT '';
ALTER TABLE site_content ADD COLUMN IF NOT EXISTS footer_inara_ja TEXT DEFAULT '';

-- Copy existing Russian content into new columns as fallback
UPDATE site_content SET
  kicker_en = kicker, kicker_de = kicker, kicker_it = kicker, kicker_ko = kicker, kicker_zh = kicker, kicker_ja = kicker,
  title1_en = title1, title1_de = title1, title1_it = title1, title1_ko = title1, title1_zh = title1, title1_ja = title1,
  title2_en = title2, title2_de = title2, title2_it = title2, title2_ko = title2, title2_zh = title2, title2_ja = title2,
  manifest_en = manifest, manifest_de = manifest, manifest_it = manifest, manifest_ko = manifest, manifest_zh = manifest, manifest_ja = manifest,
  footer_copyright_en = footer_copyright, footer_copyright_de = footer_copyright, footer_copyright_it = footer_copyright, footer_copyright_ko = footer_copyright, footer_copyright_zh = footer_copyright, footer_copyright_ja = footer_copyright,
  footer_discord_en = footer_discord, footer_discord_de = footer_discord, footer_discord_it = footer_discord, footer_discord_ko = footer_discord, footer_discord_zh = footer_discord, footer_discord_ja = footer_discord,
  footer_edsm_en = footer_edsm, footer_edsm_de = footer_edsm, footer_edsm_it = footer_edsm, footer_edsm_ko = footer_edsm, footer_edsm_zh = footer_edsm, footer_edsm_ja = footer_edsm,
  footer_inara_en = footer_inara, footer_inara_de = footer_inara, footer_inara_it = footer_inara, footer_inara_ko = footer_inara, footer_inara_zh = footer_inara, footer_inara_ja = footer_inara
WHERE id = 1;
