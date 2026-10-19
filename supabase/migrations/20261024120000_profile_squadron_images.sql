-- Avatar: 5 MiB. Squadron branding: bounded fallback when Storage is down.
-- No existing Storage objects are moved or deleted.
CREATE TABLE IF NOT EXISTS public.squadron_images (
  squadron_id BIGINT NOT NULL REFERENCES public.squadrons(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('logo', 'banner')),
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  bytes BYTEA NOT NULL,
  byte_size INTEGER NOT NULL,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (squadron_id, kind),
  CHECK (byte_size = octet_length(bytes) AND byte_size > 0
    AND byte_size <= CASE kind WHEN 'logo' THEN 2097152 ELSE 6291456 END)
);
ALTER TABLE public.squadron_images ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.squadron_images FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.squadron_images TO service_role;
COMMENT ON TABLE public.squadron_images IS
  'Current squadron logo/banner fallback, one image per kind. Server checks editing permissions; GET serves public branding.';

ALTER TABLE public.profile_avatars DROP CONSTRAINT IF EXISTS profile_avatars_size_limit;
ALTER TABLE public.profile_avatars ADD CONSTRAINT profile_avatars_size_limit
  CHECK (byte_size = octet_length(bytes) AND byte_size BETWEEN 1 AND 5242880);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_avatars TO service_role;

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES
      ('avatars', 'avatars', true, 5242880, ARRAY['image/jpeg','image/png','image/webp','image/gif']),
      ('squadron-media', 'squadron-media', true, 6291456, ARRAY['image/jpeg','image/png','image/webp','image/gif'])
    ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;
  ELSE
    RAISE NOTICE 'Storage is not installed yet; application will create the buckets on first upload.';
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
