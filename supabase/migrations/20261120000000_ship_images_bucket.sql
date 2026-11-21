-- ============================================================================
-- 20261120000000_ship_images_bucket.sql
-- Bucket Supabase Storage для картинок кораблей на странице /cmdr/[name]/ships.
--
-- Публичный bucket `ship-images` хранит PNG картинки кораблей по имени
-- из outfitting.json (например, `cobra_mk_iii.png`, `sidewinder.png`).
-- Картинки заливаются админом вручную (или скриптом) через Supabase CLI/API.
-- ============================================================================

-- Создать публичный bucket для картинок кораблей
DO $$ BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'ship-images',
      'ship-images',
      true,
      10485760, -- 10 МБ
      ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    )
    ON CONFLICT (id) DO NOTHING;

    -- Политики доступа: если пользователь не владелец storage.objects,
    -- миграция не падает — просто выводит NOTICE (как в 000_base_schema.sql).
    BEGIN
      DROP POLICY IF EXISTS "Ship images are publicly readable" ON storage.objects;
      CREATE POLICY "Ship images are publicly readable" ON storage.objects
        FOR SELECT TO anon, authenticated
        USING (bucket_id = 'ship-images');

      DROP POLICY IF EXISTS "Ship images are writable by service role" ON storage.objects;
      CREATE POLICY "Ship images are writable by service role" ON storage.objects
        FOR INSERT TO service_role
        WITH CHECK (bucket_id = 'ship-images');

      DROP POLICY IF EXISTS "Ship images are updatable by service role" ON storage.objects;
      CREATE POLICY "Ship images are updatable by service role" ON storage.objects
        FOR UPDATE TO service_role
        USING (bucket_id = 'ship-images');

      DROP POLICY IF EXISTS "Ship images are deletable by service role" ON storage.objects;
      CREATE POLICY "Ship images are deletable by service role" ON storage.objects
        FOR DELETE TO service_role
        USING (bucket_id = 'ship-images');
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'storage.objects принадлежит supabase_admin — создайте политики бакета ship-images через Supabase Dashboard';
    END;
  END IF;
END $$;
