-- ============================================================================
-- 20261120010000_user_ship_photos.sql
-- Пользовательские фото кораблей (премиум перк "Фото Галерея кораблей").
--
-- Позволяет владельцам премиум-подписки с перком загружать до 5 фото
-- своих кораблей. Официальные картинки кораблей хранятся в bucket `ship-images`
-- и управляются через админ-панель.
-- ============================================================================

-- Создать публичный bucket для картинок кораблей (если ещё не создан)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'ship-images') THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('ship-images', 'ship-images', true, 10485760, ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  END IF;
END $$;

-- Политики доступа к бакету ship-images (public read, service_role write)
DROP POLICY IF EXISTS ship_images_public_read ON storage.objects;
CREATE POLICY ship_images_public_read ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'ship-images');

DROP POLICY IF EXISTS ship_images_service_write ON storage.objects;
CREATE POLICY ship_images_service_write ON storage.objects
  FOR ALL
  TO service_role
  USING (bucket_id = 'ship-images')
  WITH CHECK (bucket_id = 'ship-images');

CREATE TABLE IF NOT EXISTS public.user_ship_photos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ship_id         TEXT NOT NULL,                 -- ID корабля из outfitting.json (cobra_mk_iii, sidewinder, …)
  image_url       TEXT NOT NULL,                 -- Публичный URL картинки в Supabase Storage
  is_primary      BOOLEAN NOT NULL DEFAULT false,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_ship_photos_user_id ON public.user_ship_photos(user_id);
CREATE INDEX idx_user_ship_photos_ship_id ON public.user_ship_photos(ship_id);
CREATE INDEX idx_user_ship_photos_user_ship ON public.user_ship_photos(user_id, ship_id);

ALTER TABLE public.user_ship_photos ENABLE ROW LEVEL SECURITY;

-- Чтение: могут видеть все (включая неавторизованных)
CREATE POLICY "User ship photos are publicly readable" ON public.user_ship_photos
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Вставка: только авторизованный пользователь, свои фото.
-- Лимит 5 фото на корабль контролируется на уровне API (route.ts).
CREATE POLICY "Users can insert their own ship photos" ON public.user_ship_photos
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Обновление: только владелец фото
CREATE POLICY "Users can update their own ship photos" ON public.user_ship_photos
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Удаление: только владелец фото
CREATE POLICY "Users can delete their own ship photos" ON public.user_ship_photos
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Service role может всё
CREATE POLICY "Service role can manage all user ship photos" ON public.user_ship_photos
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
