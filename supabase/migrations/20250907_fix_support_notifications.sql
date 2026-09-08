-- ============================================
-- Fix: Add support_ticket and support_reply types to user_notifications
-- Fixes 500 error when creating support tickets
-- ============================================

-- First, check current constraint definition
DO $$
DECLARE
  constraint_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO constraint_def
  FROM pg_constraint
  WHERE conrelid = 'user_notifications'::regclass
    AND conname = 'user_notifications_type_check';
  
  IF constraint_def IS NOT NULL THEN
    RAISE NOTICE 'Current constraint: %', constraint_def;
  ELSE
    RAISE NOTICE 'No user_notifications_type_check constraint found';
  END IF;
END $$;

-- Drop the old constraint if it exists
ALTER TABLE public.user_notifications
DROP CONSTRAINT IF EXISTS user_notifications_type_check;

-- Add the new constraint with support types included
ALTER TABLE public.user_notifications
ADD CONSTRAINT user_notifications_type_check
CHECK (type IN (
  'forum_reply',
  'forum_mention',
  'squadron_invite',
  'friend_request',
  'project_update',
  'news_comment',
  'support_ticket',
  'support_reply'
));

-- Also ensure the table exists with correct schema if it was created elsewhere
-- Add missing columns if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_notifications' AND column_name = 'metadata'
  ) THEN
    ALTER TABLE public.user_notifications ADD COLUMN metadata jsonb;
  END IF;
END $$;

-- Verify the fix
SELECT conname, pg_get_constraintdef(oid) as constraint_definition
FROM pg_constraint
WHERE conrelid = 'user_notifications'::regclass
  AND conname = 'user_notifications_type_check';
