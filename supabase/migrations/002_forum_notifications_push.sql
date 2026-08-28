-- ============================================================
-- Forum Notifications + Web Push Migration
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. Таблица уведомлений форума
CREATE TABLE IF NOT EXISTS forum_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  thread_id INT NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
  post_id INT REFERENCES forum_posts(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'forum_reply' CHECK (type IN ('forum_reply','forum_mention')),
  title TEXT NOT NULL,
  body TEXT,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_forum_notif_user ON forum_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_forum_notif_unread ON forum_notifications(user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_forum_notif_thread ON forum_notifications(thread_id);

-- 2. Таблица push-подписок (Web Push API)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);

-- 3. RLS
ALTER TABLE forum_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS forum_notif_select ON forum_notifications;
CREATE POLICY forum_notif_select ON forum_notifications FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS forum_notif_update ON forum_notifications;
CREATE POLICY forum_notif_update ON forum_notifications FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS forum_notif_delete ON forum_notifications;
CREATE POLICY forum_notif_delete ON forum_notifications FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS push_subs_select ON push_subscriptions;
CREATE POLICY push_subs_select ON push_subscriptions FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS push_subs_insert ON push_subscriptions;
CREATE POLICY push_subs_insert ON push_subscriptions FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS push_subs_delete ON push_subscriptions;
CREATE POLICY push_subs_delete ON push_subscriptions FOR DELETE USING (auth.uid() = user_id);

-- 4. Функция-триггер: при создании поста → уведомления подписчикам
CREATE OR REPLACE FUNCTION notify_forum_subscribers()
RETURNS TRIGGER AS $$
DECLARE
  sub RECORD;
  thread_title TEXT;
  post_preview TEXT;
BEGIN
  SELECT title INTO thread_title FROM forum_threads WHERE id = NEW.thread_id;

  post_preview := LEFT(NEW.content, 120);
  IF LENGTH(NEW.content) > 120 THEN
    post_preview := post_preview || '…';
  END IF;

  FOR sub IN
    SELECT user_id FROM forum_subscriptions
    WHERE thread_id = NEW.thread_id AND user_id != NEW.author_id
  LOOP
    INSERT INTO forum_notifications (user_id, thread_id, post_id, type, title, body)
    VALUES (sub.user_id, NEW.thread_id, NEW.id, 'forum_reply',
            COALESCE(thread_title, 'Новый ответ в теме'),
            NEW.author_name || ': ' || post_preview);
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Триггер на INSERT в forum_posts
DROP TRIGGER IF EXISTS trg_notify_forum_subscribers ON forum_posts;
CREATE TRIGGER trg_notify_forum_subscribers
  AFTER INSERT ON forum_posts
  FOR EACH ROW
  EXECUTE FUNCTION notify_forum_subscribers();
