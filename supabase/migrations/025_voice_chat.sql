-- ============================================================
-- 019_voice_chat.sql — Голосовой чат эскадрильи (WebRTC signaling)
-- ============================================================

-- 0. Убедимся, что функция is_squadron_officer существует (создана в 011)
-- Если нет — создаём её здесь заранее
CREATE OR REPLACE FUNCTION public.is_squadron_officer(check_squadron_id INTEGER, check_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.squadron_members sm
    JOIN public.squadron_ranks sr ON sr.id = sm.rank_id
    WHERE sm.squadron_id = check_squadron_id
      AND sm.user_id = check_user_id
      AND (sr.can_manage_members = true OR sr.can_manage_projects = true OR sr.can_manage_ranks = true OR sr.can_edit_squadron = true)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 1. Таблица голосовых комнат эскадрильи
CREATE TABLE IF NOT EXISTS public.squadron_voice_rooms (
  id SERIAL PRIMARY KEY,
  squadron_id INTEGER NOT NULL REFERENCES public.squadrons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_officer_only BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(squadron_id, name)
);

CREATE INDEX IF NOT EXISTS idx_squadron_voice_rooms_squadron ON public.squadron_voice_rooms(squadron_id);

ALTER TABLE public.squadron_voice_rooms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Voice rooms readable by squadron members" ON public.squadron_voice_rooms;
CREATE POLICY "Voice rooms readable by squadron members" ON public.squadron_voice_rooms FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_voice_rooms.squadron_id AND sm.user_id = auth.uid())
);

DROP POLICY IF EXISTS "Officers can manage voice rooms" ON public.squadron_voice_rooms;
CREATE POLICY "Officers can manage voice rooms" ON public.squadron_voice_rooms FOR ALL USING (
  public.is_squadron_officer(squadron_voice_rooms.squadron_id, auth.uid())
);

-- 2. Таблица WebRTC signaling (SDP offers/answers, ICE candidates)
CREATE TABLE IF NOT EXISTS public.squadron_voice_signals (
  id BIGSERIAL PRIMARY KEY,
  squadron_id INTEGER NOT NULL REFERENCES public.squadrons(id) ON DELETE CASCADE,
  room_id INTEGER NOT NULL REFERENCES public.squadron_voice_rooms(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL CHECK (signal_type IN ('offer','answer','ice-candidate','join','leave')),
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_squadron_voice_signals_room ON public.squadron_voice_signals(room_id);
CREATE INDEX IF NOT EXISTS idx_squadron_voice_signals_target ON public.squadron_voice_signals(target_id);
CREATE INDEX IF NOT EXISTS idx_squadron_voice_signals_created ON public.squadron_voice_signals(created_at);

ALTER TABLE public.squadron_voice_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Voice signals readable by squadron members" ON public.squadron_voice_signals;
CREATE POLICY "Voice signals readable by squadron members" ON public.squadron_voice_signals FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.squadron_members sm WHERE sm.squadron_id = squadron_voice_signals.squadron_id AND sm.user_id = auth.uid())
);

DROP POLICY IF EXISTS "Users can insert own signals" ON public.squadron_voice_signals;
CREATE POLICY "Users can insert own signals" ON public.squadron_voice_signals FOR INSERT WITH CHECK (auth.uid() = sender_id);

-- 3. Таблица участников голосовых комнат (кто сейчас подключён)
CREATE TABLE IF NOT EXISTS public.squadron_voice_participants (
  id SERIAL PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES public.squadron_voice_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  is_muted BOOLEAN NOT NULL DEFAULT false,
  is_deafened BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_squadron_voice_participants_room ON public.squadron_voice_participants(room_id);

ALTER TABLE public.squadron_voice_participants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Participants readable by squadron members" ON public.squadron_voice_participants;
CREATE POLICY "Participants readable by squadron members" ON public.squadron_voice_participants FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.squadron_members sm
    JOIN public.squadron_voice_rooms r ON r.squadron_id = sm.squadron_id
    WHERE r.id = squadron_voice_participants.room_id AND sm.user_id = auth.uid())
);

DROP POLICY IF EXISTS "Users manage own participation" ON public.squadron_voice_participants;
CREATE POLICY "Users manage own participation" ON public.squadron_voice_participants FOR ALL USING (auth.uid() = user_id);

-- 4. Функция: авто-очистка старых сигналов (старше 5 минут)
CREATE OR REPLACE FUNCTION public.cleanup_old_voice_signals()
RETURNS void AS $$
BEGIN
  DELETE FROM public.squadron_voice_signals WHERE created_at < NOW() - INTERVAL '5 minutes';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Представление: активные участники голосовых комнат с именами
CREATE OR REPLACE VIEW public.squadron_voice_participant_detail AS
SELECT
  vp.id,
  vp.room_id,
  vp.user_id,
  vp.joined_at,
  vp.is_muted,
  vp.is_deafened,
  p.cmdr_name,
  p.avatar_url,
  r.squadron_id,
  r.name as room_name
FROM public.squadron_voice_participants vp
LEFT JOIN public.profiles p ON p.id = vp.user_id
LEFT JOIN public.squadron_voice_rooms r ON r.id = vp.room_id;

-- 6. Представление: список голосовых комнат с количеством участников
CREATE OR REPLACE VIEW public.squadron_voice_room_summary AS
SELECT
  r.*,
  COUNT(vp.user_id) as participant_count
FROM public.squadron_voice_rooms r
LEFT JOIN public.squadron_voice_participants vp ON vp.room_id = r.id
GROUP BY r.id;

-- 7. Дефолтные голосовые комнаты (создаются при создании эскадрильи)
CREATE OR REPLACE FUNCTION public.create_default_voice_rooms(squadron_id INTEGER)
RETURNS void AS $$
BEGIN
  INSERT INTO public.squadron_voice_rooms (squadron_id, name, description, is_officer_only, sort_order)
  VALUES
    (squadron_id, 'Общий канал', 'Общий голосовой канал для всех пилотов', false, 1),
    (squadron_id, 'Офицерский канал', 'Голосовой канал для офицеров', true, 2),
    (squadron_id, 'Оперативный канал', 'Канал для оперативных задач', false, 3);
END;
$$ LANGUAGE plpgsql;

-- 8. Обновление триггера создания эскадрильи: добавляем голосовые комнаты
CREATE OR REPLACE FUNCTION public.on_squadron_created()
RETURNS TRIGGER AS $$
DECLARE
  cmdr_rank_id INTEGER;
BEGIN
  PERFORM public.create_default_squadron_ranks(NEW.id);
  PERFORM public.create_default_voice_rooms(NEW.id);

  SELECT id INTO cmdr_rank_id FROM public.squadron_ranks
    WHERE squadron_id = NEW.id AND name = 'Командир эскадрильи';

  IF cmdr_rank_id IS NOT NULL THEN
    INSERT INTO public.squadron_members (squadron_id, user_id, rank_id)
    VALUES (NEW.id, NEW.created_by, cmdr_rank_id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS squadron_created_trigger ON public.squadrons;
CREATE TRIGGER squadron_created_trigger
  AFTER INSERT ON public.squadrons
  FOR EACH ROW
  EXECUTE FUNCTION public.on_squadron_created();

-- 9. Триггер обновления updated_at для voice_rooms
DROP TRIGGER IF EXISTS squadron_voice_rooms_updated_at ON public.squadron_voice_rooms;
CREATE TRIGGER squadron_voice_rooms_updated_at
  BEFORE UPDATE ON public.squadron_voice_rooms
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- 10. Дополнительная политика для voice_participants
DROP POLICY IF EXISTS "Voice participants readable by room squadron members" ON public.squadron_voice_participants;
CREATE POLICY "Voice participants readable by room squadron members" ON public.squadron_voice_participants FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.squadron_voice_rooms r
    JOIN public.squadron_members sm ON sm.squadron_id = r.squadron_id
    WHERE r.id = squadron_voice_participants.room_id AND sm.user_id = auth.uid())
);
