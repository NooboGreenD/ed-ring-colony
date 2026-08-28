-- 006_forum_enhancements.sql
-- (Колонки уже добавлены в 000 через ADD COLUMN IF NOT EXISTS, тут на всякий случай)
ALTER TABLE IF EXISTS forum_posts
  ADD COLUMN IF NOT EXISTS parent_post_id INTEGER REFERENCES forum_posts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_edited BOOLEAN DEFAULT false;

ALTER TABLE IF EXISTS profiles
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS squadron TEXT,
  ADD COLUMN IF NOT EXISTS total_delivered INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hubs_visited INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS forum_posts_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION increment_forum_posts(uid UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE profiles SET forum_posts_count = forum_posts_count + 1 WHERE id = uid;
END;
$$ LANGUAGE plpgsql;
