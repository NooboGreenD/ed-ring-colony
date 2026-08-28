-- 005_user_pois_and_reports.sql
CREATE TABLE IF NOT EXISTS user_pois (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  system_name TEXT NOT NULL,
  x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION,
  poi_type TEXT DEFAULT 'general',
  is_public BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE user_pois ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own POIs" ON user_pois;
CREATE POLICY "Users can manage own POIs"
  ON user_pois FOR ALL USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Public POIs are readable" ON user_pois;
CREATE POLICY "Public POIs are readable"
  ON user_pois FOR SELECT USING (is_public = true);

CREATE TABLE IF NOT EXISTS forum_reports (
  id SERIAL PRIMARY KEY,
  reporter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_id INTEGER REFERENCES forum_posts(id) ON DELETE CASCADE,
  thread_id INTEGER REFERENCES forum_threads(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  moderator_note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS forum_tags (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  color TEXT DEFAULT '#ff9d2e',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS thread_tags (
  thread_id INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES forum_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (thread_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_user_pois_user ON user_pois(user_id);
CREATE INDEX IF NOT EXISTS idx_forum_reports_status ON forum_reports(status);
