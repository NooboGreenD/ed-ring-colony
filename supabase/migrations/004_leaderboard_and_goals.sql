-- 004_leaderboard_and_goals.sql
CREATE TABLE IF NOT EXISTS hub_goals (
  id SERIAL PRIMARY KEY,
  hub_id INTEGER NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
  commodity TEXT NOT NULL,
  target_amount INTEGER NOT NULL DEFAULT 0,
  current_amount INTEGER NOT NULL DEFAULT 0,
  unit TEXT DEFAULT 'tonnes',
  deadline TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(hub_id, commodity)
);

CREATE TABLE IF NOT EXISTS badges (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  icon_url TEXT,
  condition_type TEXT NOT NULL,
  condition_value INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  badge_id INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  awarded_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, badge_id)
);

INSERT INTO badges (slug, name, description, condition_type, condition_value) VALUES
  ('first_delivery', 'Первый груз', 'Внесли первую доставку', 'deliveries_count', 1),
  ('heavy_lifter', 'Тяжеловес', 'Внесли 1000 тонн груза', 'deliveries_amount', 1000),
  ('explorer', 'Исследователь', 'Посетили 10 хабов', 'hubs_visited', 10),
  ('communicator', 'Коммуникатор', 'Написали 50 сообщений на форуме', 'forum_posts', 50)
ON CONFLICT (slug) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_hub_goals_hub ON hub_goals(hub_id);
CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id);
