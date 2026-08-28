-- ============================================================
-- 022_squadron_chat.sql — Чат эскадрильи + уведомления через user_notifications
-- ============================================================

-- 1. Таблица сообщений чата эскадрильи
CREATE TABLE IF NOT EXISTS public.squadron_chat_messages (
  id BIGSERIAL PRIMARY KEY,
  squadron_id INTEGER NOT NULL REFERENCES public.squadrons(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (char_length(content) <= 2000),
  chat_type TEXT NOT NULL DEFAULT 'general' CHECK (chat_type IN ('general', 'officer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.squadron_chat_messages IS 'Сообщения чата эскадрильи';

-- Индексы
CREATE INDEX IF NOT EXISTS idx_squadron_chat_squadron ON public.squadron_chat_messages(squadron_id);
CREATE INDEX IF NOT EXISTS idx_squadron_chat_type ON public.squadron_chat_messages(chat_type);
CREATE INDEX IF NOT EXISTS idx_squadron_chat_created ON public.squadron_chat_messages(created_at DESC);

-- Триггер updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS squadron_chat_updated_at ON public.squadron_chat_messages;
CREATE TRIGGER squadron_chat_updated_at
  BEFORE UPDATE ON public.squadron_chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.squadron_chat_messages ENABLE ROW LEVEL SECURITY;

-- Читать могут только члены эскадрильи
DROP POLICY IF EXISTS "Squadron members can read chat" ON public.squadron_chat_messages;
CREATE POLICY "Squadron members can read chat" ON public.squadron_chat_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.squadron_members sm
      WHERE sm.squadron_id = squadron_chat_messages.squadron_id
        AND sm.user_id = auth.uid()
    )
  );

-- Писать могут только члены эскадрильи
DROP POLICY IF EXISTS "Squadron members can write chat" ON public.squadron_chat_messages;
CREATE POLICY "Squadron members can write chat" ON public.squadron_chat_messages
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.squadron_members sm
      WHERE sm.squadron_id = squadron_chat_messages.squadron_id
        AND sm.user_id = auth.uid()
    )
  );

-- Удалять могут автор, создатель эскадрильи или can_manage_members
DROP POLICY IF EXISTS "Squadron chat delete" ON public.squadron_chat_messages;
CREATE POLICY "Squadron chat delete" ON public.squadron_chat_messages
  FOR DELETE USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.squadrons s
      WHERE s.id = squadron_chat_messages.squadron_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.squadron_members sm
      JOIN public.squadron_ranks sr ON sr.id = sm.rank_id
      WHERE sm.squadron_id = squadron_chat_messages.squadron_id
        AND sm.user_id = auth.uid()
        AND sr.can_manage_members = true
    )
  );

-- Права на sequence
GRANT SELECT, INSERT, UPDATE, DELETE ON public.squadron_chat_messages TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.squadron_chat_messages_id_seq TO anon, authenticated;

-- Включить realtime для таблицы чата
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.squadron_chat_messages;
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END $$;

-- 2. Добавляем тип squadron_chat_mention в CHECK constraint user_notifications
ALTER TABLE public.user_notifications
DROP CONSTRAINT IF EXISTS user_notifications_type_check;

ALTER TABLE public.user_notifications
ADD CONSTRAINT user_notifications_type_check
CHECK (type IN (
  'project_invite',
  'squadron_invite',
  'project_update',
  'project_system_status',
  'route_status_change',
  'route_progress',
  'forum_reply',
  'forum_mention',
  'message',
  'news',
  'squadron_chat_mention'
));

-- 3. Триггер: @mention в чате эскадрильи → уведомление через create_user_notification
CREATE OR REPLACE FUNCTION public.handle_chat_mention()
RETURNS TRIGGER AS $$
DECLARE
  mention TEXT;
  target_user_id UUID;
  sender_name TEXT;
  squadron_name_val TEXT;
BEGIN
  -- Получаем имя отправителя
  SELECT COALESCE(p.cmdr_name, u.email) INTO sender_name
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
  WHERE u.id = NEW.user_id;

  -- Получаем название эскадрильи
  SELECT s.name INTO squadron_name_val
  FROM public.squadrons s
  WHERE s.id = NEW.squadron_id;

  -- Ищем @mentions в сообщении
  FOR mention IN
    SELECT (regexp_matches(NEW.content, '@([A-Za-z0-9_\-]+)', 'g'))[1]
  LOOP
    -- Находим пользователя по cmdr_name внутри этой эскадрильи
    SELECT p.id INTO target_user_id
    FROM public.profiles p
    JOIN public.squadron_members sm ON sm.user_id = p.id
    WHERE p.cmdr_name ILIKE mention
      AND sm.squadron_id = NEW.squadron_id
    LIMIT 1;

    IF target_user_id IS NOT NULL AND target_user_id != NEW.user_id THEN
      PERFORM public.create_user_notification(
        target_user_id,
        'squadron_chat_mention',
        'Упоминание в чате эскадрильи',
        sender_name || ': ' || LEFT(NEW.content, 120),
        '/squadrons/' || NEW.squadron_id,
        jsonb_build_object(
          'squadron_id', NEW.squadron_id,
          'squadron_name', squadron_name_val,
          'message_id', NEW.id,
          'chat_type', NEW.chat_type,
          'sender_name', sender_name
        )
      );
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS chat_mention_trigger ON public.squadron_chat_messages;
CREATE TRIGGER chat_mention_trigger
  AFTER INSERT ON public.squadron_chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.handle_chat_mention();
