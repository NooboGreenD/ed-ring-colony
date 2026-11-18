-- ============================================================
-- SITE_CONTENT — поля пожертвований (DonationAlerts)
--
-- Админка («Контент» → виджет пожертвований) пишет
-- donation_widget_url / donation_button_url (+ переводы *_<lang>),
-- а страница подписок читает их для плашки и кнопки DonationAlerts.
-- Миграция идемпотентна: ADD COLUMN IF NOT EXISTS можно повторять.
-- ============================================================

ALTER TABLE public.site_content
  ADD COLUMN IF NOT EXISTS donation_widget_url text,
  ADD COLUMN IF NOT EXISTS donation_button_url text;

ALTER TABLE public.site_content
  ADD COLUMN IF NOT EXISTS donation_widget_url_ru text,
  ADD COLUMN IF NOT EXISTS donation_widget_url_en text,
  ADD COLUMN IF NOT EXISTS donation_widget_url_de text,
  ADD COLUMN IF NOT EXISTS donation_widget_url_it text,
  ADD COLUMN IF NOT EXISTS donation_widget_url_ko text,
  ADD COLUMN IF NOT EXISTS donation_widget_url_zh text,
  ADD COLUMN IF NOT EXISTS donation_widget_url_ja text,
  ADD COLUMN IF NOT EXISTS donation_button_url_ru text,
  ADD COLUMN IF NOT EXISTS donation_button_url_en text,
  ADD COLUMN IF NOT EXISTS donation_button_url_de text,
  ADD COLUMN IF NOT EXISTS donation_button_url_it text,
  ADD COLUMN IF NOT EXISTS donation_button_url_ko text,
  ADD COLUMN IF NOT EXISTS donation_button_url_zh text,
  ADD COLUMN IF NOT EXISTS donation_button_url_ja text;

-- Русская колонка = базовая колонка (кромеNULL оставляем как есть).
UPDATE public.site_content SET
  donation_widget_url_ru = COALESCE(donation_widget_url_ru, donation_widget_url),
  donation_button_url_ru = COALESCE(donation_button_url_ru, donation_button_url)
WHERE id = 1;

-- Остальные языки намеренно остаются NULL: фронт подставляет базовую
-- колонку, когда перевода отсутствует.
