-- Fix: replace NEW.author_name with lookup from profiles table in forum triggers
-- Applied via Supabase Management API on 2026-09-02

CREATE OR REPLACE FUNCTION public.update_thread_last_post()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  author_name TEXT;
BEGIN
  SELECT cmdr_name INTO author_name FROM profiles WHERE id = NEW.author_id;
  
  UPDATE forum_threads 
  SET last_post_at = NEW.created_at,
      last_post_author = COALESCE(author_name, 'Unknown'),
      updated_at = NOW()
  WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_forum_subscribers()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  sub RECORD;
  thread_title TEXT;
  post_preview TEXT;
  author_name TEXT;
BEGIN
  SELECT title INTO thread_title FROM forum_threads WHERE id = NEW.thread_id;
  SELECT cmdr_name INTO author_name FROM profiles WHERE id = NEW.author_id;

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
            COALESCE(author_name, 'Unknown') || ': ' || post_preview);
  END LOOP;

  RETURN NEW;
END;
$function$;
