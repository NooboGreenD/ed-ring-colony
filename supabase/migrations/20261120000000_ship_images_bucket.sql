-- ============================================================================
-- 20261120000000_ship_images_bucket.sql
-- Bucket Supabase Storage для картинок кораблей на странице /cmdr/[name]/ships.
--
-- Публичный bucket `ship-images` хранит PNG картинки кораблей по имени
-- из outfitting.json (например, `cobra_mk_iii.png`, `sidewinder.png`).
-- Картинки заливаются админом вручную (или скриптом) через Supabase CLI/API.
-- ============================================================================

-- Создать публичный bucket для картинок кораблей
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'ship-images',
  'ship-images',
  true,
  10485760, -- 10 МБ
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- Политика: чтение разрешено всем (публичный bucket)
CREATE POLICY "Ship images are publicly readable" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'ship-images');

-- Политика: запись разрешена только service_role (админ через API)
CREATE POLICY "Ship images are writable by service role" ON storage.objects
  FOR INSERT
  WITH CHECK (bucket_id = 'ship-images' AND auth.role() = 'service_role');

CREATE POLICY "Ship images are updatable by service role" ON storage.objects
  FOR UPDATE
  USING (bucket_id = 'ship-images' AND auth.role() = 'service_role');

CREATE POLICY "Ship images are deletable by service role" ON storage.objects
  FOR DELETE
  USING (bucket_id = 'ship-images' AND auth.role() = 'service_role');

-- Включить RLS на objetos (по умолчанию уже включено для storage.objects, но на всякий случай)
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
