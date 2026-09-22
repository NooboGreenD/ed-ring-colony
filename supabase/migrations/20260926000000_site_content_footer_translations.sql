-- ============================================================
-- SITE_CONTENT — колонки переводов для подвала
--
-- Админка («Контент» → «Подвал сайта») пишет footer_copyright_ru /
-- footer_discord_en / … , а миграция 20260920000000 добавила такие колонки
-- только для kicker/title1/title2/manifest. Из-за этого:
--   • upsert из админки падал с «column … does not exist», либо
--   • GET /api/home-data не мог выбрать список колонок и молча откатывался
--     на базовые footer_copyright/… — правки админки на сайте не появлялись.
--
-- Миграция идемпотентна: можно запускать повторно.
-- ============================================================

ALTER TABLE public.site_content
  ADD COLUMN IF NOT EXISTS footer_copyright_ru text,
  ADD COLUMN IF NOT EXISTS footer_copyright_en text,
  ADD COLUMN IF NOT EXISTS footer_copyright_de text,
  ADD COLUMN IF NOT EXISTS footer_copyright_it text,
  ADD COLUMN IF NOT EXISTS footer_copyright_ko text,
  ADD COLUMN IF NOT EXISTS footer_copyright_zh text,
  ADD COLUMN IF NOT EXISTS footer_copyright_ja text,
  ADD COLUMN IF NOT EXISTS footer_discord_ru text,
  ADD COLUMN IF NOT EXISTS footer_discord_en text,
  ADD COLUMN IF NOT EXISTS footer_discord_de text,
  ADD COLUMN IF NOT EXISTS footer_discord_it text,
  ADD COLUMN IF NOT EXISTS footer_discord_ko text,
  ADD COLUMN IF NOT EXISTS footer_discord_zh text,
  ADD COLUMN IF NOT EXISTS footer_discord_ja text,
  ADD COLUMN IF NOT EXISTS footer_edsm_ru text,
  ADD COLUMN IF NOT EXISTS footer_edsm_en text,
  ADD COLUMN IF NOT EXISTS footer_edsm_de text,
  ADD COLUMN IF NOT EXISTS footer_edsm_it text,
  ADD COLUMN IF NOT EXISTS footer_edsm_ko text,
  ADD COLUMN IF NOT EXISTS footer_edsm_zh text,
  ADD COLUMN IF NOT EXISTS footer_edsm_ja text,
  ADD COLUMN IF NOT EXISTS footer_inara_ru text,
  ADD COLUMN IF NOT EXISTS footer_inara_en text,
  ADD COLUMN IF NOT EXISTS footer_inara_de text,
  ADD COLUMN IF NOT EXISTS footer_inara_it text,
  ADD COLUMN IF NOT EXISTS footer_inara_ko text,
  ADD COLUMN IF NOT EXISTS footer_inara_zh text,
  ADD COLUMN IF NOT EXISTS footer_inara_ja text;

-- На базах, где применялся только «свободный» файл
-- supabase/add_site_content_translations.sql (он не внесён в migrations),
-- kicker/title1/title2/manifest могли остаться без *_ru. Докидываем, если
-- чего-то нет: ADD COLUMN IF NOT EXISTS повторяет то, что уже есть безопасно.
ALTER TABLE public.site_content
  ADD COLUMN IF NOT EXISTS kicker_ru text,
  ADD COLUMN IF NOT EXISTS title1_ru text,
  ADD COLUMN IF NOT EXISTS title2_ru text,
  ADD COLUMN IF NOT EXISTS manifest_ru text,
  ADD COLUMN IF NOT EXISTS kicker_en text,
  ADD COLUMN IF NOT EXISTS kicker_de text,
  ADD COLUMN IF NOT EXISTS kicker_it text,
  ADD COLUMN IF NOT EXISTS kicker_ko text,
  ADD COLUMN IF NOT EXISTS kicker_zh text,
  ADD COLUMN IF NOT EXISTS kicker_ja text,
  ADD COLUMN IF NOT EXISTS title1_en text,
  ADD COLUMN IF NOT EXISTS title1_de text,
  ADD COLUMN IF NOT EXISTS title1_it text,
  ADD COLUMN IF NOT EXISTS title1_ko text,
  ADD COLUMN IF NOT EXISTS title1_zh text,
  ADD COLUMN IF NOT EXISTS title1_ja text,
  ADD COLUMN IF NOT EXISTS title2_en text,
  ADD COLUMN IF NOT EXISTS title2_de text,
  ADD COLUMN IF NOT EXISTS title2_it text,
  ADD COLUMN IF NOT EXISTS title2_ko text,
  ADD COLUMN IF NOT EXISTS title2_zh text,
  ADD COLUMN IF NOT EXISTS title2_ja text,
  ADD COLUMN IF NOT EXISTS manifest_en text,
  ADD COLUMN IF NOT EXISTS manifest_de text,
  ADD COLUMN IF NOT EXISTS manifest_it text,
  ADD COLUMN IF NOT EXISTS manifest_ko text,
  ADD COLUMN IF NOT EXISTS manifest_zh text,
  ADD COLUMN IF NOT EXISTS manifest_ja text;

-- Русская колонка = базовая колонка (админка считает каноническим именно ru).
UPDATE public.site_content SET
  footer_copyright_ru = COALESCE(footer_copyright_ru, footer_copyright),
  footer_discord_ru   = COALESCE(footer_discord_ru,   footer_discord),
  footer_edsm_ru      = COALESCE(footer_edsm_ru,      footer_edsm),
  footer_inara_ru     = COALESCE(footer_inara_ru,     footer_inara),
  kicker_ru           = COALESCE(kicker_ru,          kicker),
  title1_ru           = COALESCE(title1_ru,          title1),
  title2_ru           = COALESCE(title2_ru,          title2),
  manifest_ru         = COALESCE(manifest_ru,        manifest)
WHERE id = 1;

-- ВАЖНО: остальные языки (en, de, it, ko, zh, ja) намеренно остаются NULL.
-- Фронт уже подставляет базовую колонку, когда перевода нет (localizedValue),
-- а «предзаполнение» русским текстом только усыпило бы админку: кнопка
-- «перевести недостающее» считает заполненную колонку переведённой и никогда
-- не принесла бы настоящий перевод.
