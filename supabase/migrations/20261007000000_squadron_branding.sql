-- Оформление публичной страницы эскадрильи.
ALTER TABLE public.squadrons
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS banner_url TEXT,
  ADD COLUMN IF NOT EXISTS banner_position TEXT NOT NULL DEFAULT 'center',
  ADD COLUMN IF NOT EXISTS motto TEXT;

ALTER TABLE public.squadrons DROP CONSTRAINT IF EXISTS squadrons_banner_position_check;
ALTER TABLE public.squadrons
  ADD CONSTRAINT squadrons_banner_position_check
  CHECK (banner_position IN ('top', 'center', 'bottom'));

COMMENT ON COLUMN public.squadrons.logo_url IS 'Публичный логотип эскадрильи';
COMMENT ON COLUMN public.squadrons.banner_url IS 'Фоновое изображение шапки эскадрильи';
COMMENT ON COLUMN public.squadrons.motto IS 'Короткий девиз на публичной странице';
