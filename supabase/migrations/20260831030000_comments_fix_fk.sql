-- Fix comments table: add explicit FK to profiles so PostgREST can embed profiles
-- This allows queries like: .select('*,author:profiles(cmdr_name)')

-- Drop existing FK if it points to auth.users
ALTER TABLE public.comments
  DROP CONSTRAINT IF EXISTS comments_author_id_fkey;

-- Add FK pointing to profiles(id) — profiles.id already references auth.users(id)
ALTER TABLE public.comments
  ADD CONSTRAINT comments_author_id_fkey
  FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
