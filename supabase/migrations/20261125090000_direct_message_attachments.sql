-- Private DM attachments are published with the message in one INSERT.
-- Old rows remain valid and text-only sending also works on older schemas.
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.messages'::regclass AND conname = 'messages_attachments_array') THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_attachments_array
      CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 5);
  END IF;
END $$;

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('direct-message-files', 'direct-message-files', false, 10485760)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit;
-- Block browser access even if another installation has broad permissive
-- Storage policies. Files are served only by the authenticated participant API.
DROP POLICY IF EXISTS direct_message_files_private ON storage.objects;
CREATE POLICY direct_message_files_private ON storage.objects AS RESTRICTIVE
  FOR ALL TO anon, authenticated
  USING (bucket_id <> 'direct-message-files')
  WITH CHECK (bucket_id <> 'direct-message-files');
-- service_role bypasses RLS. Never issue public URLs for this bucket.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
    AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'messages') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  END IF;
END $$;
