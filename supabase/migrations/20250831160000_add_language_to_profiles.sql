-- Migration: Add language column to profiles table
-- Created: 2025-08-31
-- Purpose: Store user's preferred UI language

-- Add language column with default 'ru'
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS language VARCHAR(10) DEFAULT 'ru' NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN public.profiles.language IS 'User preferred UI language (ru, en, de, it, ko, zh, ja)';

-- Create index for fast lookups (useful if filtering by language)
CREATE INDEX IF NOT EXISTS idx_profiles_language ON public.profiles(language);

-- Update existing rows that have NULL language (should not happen with DEFAULT, but safety measure)
UPDATE public.profiles SET language = 'ru' WHERE language IS NULL;

-- Add check constraint to ensure only valid language codes
ALTER TABLE public.profiles
DROP CONSTRAINT IF EXISTS chk_profiles_language;

ALTER TABLE public.profiles
ADD CONSTRAINT chk_profiles_language
CHECK (language IN ('ru', 'en', 'de', 'it', 'ko', 'zh', 'ja'));

-- Grant select on profiles to anon and authenticated roles (if not already granted)
GRANT SELECT ON public.profiles TO anon;
GRANT SELECT, UPDATE ON public.profiles TO authenticated;
