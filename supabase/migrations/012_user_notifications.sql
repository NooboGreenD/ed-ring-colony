-- ============================================================
-- 012_user_notifications.sql — Универсальная система уведомлений
-- + Push-уведомления для мобильных
-- ============================================================

-- 1. Таблица универсальных уведомлений пользователя
CREATE TABLE IF NOT EXISTS public.user_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'project_invite',        -- Приглашение в проект
    'squadron_invite',       -- Приглашение в эскадрилью
    'project_update',        -- Изменение в проекте (название, описание, статус)
    'project_system_status', -- Изменение статуса системы в проекте
    'route_status_change',   -- Изменение статуса точки общего маршрута
    'route_progress',        -- Прогресс строительства точки маршрута
    'forum_reply',           -- Ответ в теме форума (уже есть)
    'forum_mention',         -- Упоминание на форуме (уже есть)
    'message',               -- Личное сообщение (уже есть)
    'news'                   -- Новая статья (уже есть)
  )),
  title TEXT NOT NULL,
  body TEXT,
  -- Ссылка для перехода по клику
  href TEXT NOT NULL DEFAULT '/',
  -- JSON с доп. данными (id проекта, системы и т.д.)
  metadata JSONB DEFAULT '{}',
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_notif_user ON public.user_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_user_notif_unread ON public.user_notifications(user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_notif_type ON public.user_notifications(user_id, type, created_at DESC);

ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_notif_select ON public.user_notifications;
CREATE POLICY user_notif_select ON public.user_notifications FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS user_notif_insert ON public.user_notifications;
CREATE POLICY user_notif_insert ON public.user_notifications FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_notif_update ON public.user_notifications;
CREATE POLICY user_notif_update ON public.user_notifications FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS user_notif_delete ON public.user_notifications;
CREATE POLICY user_notif_delete ON public.user_notifications FOR DELETE USING (auth.uid() = user_id);

-- 2. Функция: создать уведомление для пользователя (SECURITY DEFINER — вызывается из триггеров)
CREATE OR REPLACE FUNCTION public.create_user_notification(
  p_user_id UUID,
  p_type TEXT,
  p_title TEXT,
  p_body TEXT DEFAULT NULL,
  p_href TEXT DEFAULT '/',
  p_metadata JSONB DEFAULT '{}'
)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO public.user_notifications (user_id, type, title, body, href, metadata)
  VALUES (p_user_id, p_type, p_title, p_body, p_href, p_metadata)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Триггер: при добавлении пилота в проект → уведомление пилоту
CREATE OR REPLACE FUNCTION public.notify_project_member_added()
RETURNS TRIGGER AS $$
DECLARE
  project_name TEXT;
  inviter_name TEXT;
BEGIN
  SELECT p.name INTO project_name
  FROM public.projects p WHERE p.id = NEW.project_id;

  SELECT pr.cmdr_name INTO inviter_name
  FROM public.profiles pr
  JOIN public.project_members pm ON pm.user_id = pr.id
  WHERE pm.project_id = NEW.project_id AND pm.role IN ('leader', 'officer')
  LIMIT 1;

  PERFORM public.create_user_notification(
    NEW.user_id,
    'project_invite',
    COALESCE(project_name, 'Новый проект'),
    (COALESCE(inviter_name, 'Офицер') || ' добавил вас в проект «' || COALESCE(project_name, '—') || '»'),
    '/projects/' || NEW.project_id,
    jsonb_build_object('project_id', NEW.project_id, 'role', NEW.role)
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_project_member_added ON public.project_members;
CREATE TRIGGER trg_notify_project_member_added
  AFTER INSERT ON public.project_members
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_project_member_added();

-- 4. Триггер: при добавлении пилота в эскадрилью → уведомление пилоту
CREATE OR REPLACE FUNCTION public.notify_squadron_member_added()
RETURNS TRIGGER AS $$
DECLARE
  squadron_name TEXT;
  inviter_name TEXT;
BEGIN
  SELECT s.name INTO squadron_name
  FROM public.squadrons s WHERE s.id = NEW.squadron_id;

  SELECT pr.cmdr_name INTO inviter_name
  FROM public.profiles pr
  JOIN public.squadron_members sm ON sm.user_id = pr.id
  JOIN public.squadron_ranks sr ON sr.id = sm.rank_id
  WHERE sm.squadron_id = NEW.squadron_id AND sr.can_manage_members = true
  LIMIT 1;

  PERFORM public.create_user_notification(
    NEW.user_id,
    'squadron_invite',
    COALESCE(squadron_name, 'Новая эскадрилья'),
    (COALESCE(inviter_name, 'Командир') || ' пригласил вас в эскадрилью «' || COALESCE(squadron_name, '—') || '»'),
    '/squadrons/' || NEW.squadron_id,
    jsonb_build_object('squadron_id', NEW.squadron_id, 'rank_id', NEW.rank_id)
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_squadron_member_added ON public.squadron_members;
CREATE TRIGGER trg_notify_squadron_member_added
  AFTER INSERT ON public.squadron_members
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_squadron_member_added();

-- 5. Триггер: изменение статуса системы в проекте → уведомление всем участникам проекта
CREATE OR REPLACE FUNCTION public.notify_project_system_status_change()
RETURNS TRIGGER AS $$
DECLARE
  project_name TEXT;
  member RECORD;
  status_label TEXT;
  old_status_label TEXT;
BEGIN
  -- Если статус не изменился — ничего не делаем
  IF OLD.planned_status = NEW.planned_status THEN
    RETURN NEW;
  END IF;

  SELECT p.name INTO project_name
  FROM public.projects p WHERE p.id = NEW.project_id;

  status_label := CASE NEW.planned_status
    WHEN 'planned' THEN 'Запланировано'
    WHEN 'preparing' THEN 'Подготовка'
    WHEN 'building' THEN 'Строительство'
    WHEN 'done' THEN 'Завершено'
    WHEN 'on_hold' THEN 'Приостановлено'
    ELSE NEW.planned_status
  END;

  old_status_label := CASE OLD.planned_status
    WHEN 'planned' THEN 'Запланировано'
    WHEN 'preparing' THEN 'Подготовка'
    WHEN 'building' THEN 'Строительство'
    WHEN 'done' THEN 'Завершено'
    WHEN 'on_hold' THEN 'Приостановлено'
    ELSE OLD.planned_status
  END;

  FOR member IN
    SELECT user_id FROM public.project_members WHERE project_id = NEW.project_id
  LOOP
    PERFORM public.create_user_notification(
      member.user_id,
      'project_system_status',
      COALESCE(project_name, 'Проект'),
      ('Система «' || NEW.system_name || '»: ' || old_status_label || ' → ' || status_label),
      '/projects/' || NEW.project_id,
      jsonb_build_object(
        'project_id', NEW.project_id,
        'system_name', NEW.system_name,
        'old_status', OLD.planned_status,
        'new_status', NEW.planned_status
      )
    );
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_project_system_status ON public.project_systems;
CREATE TRIGGER trg_notify_project_system_status
  AFTER UPDATE OF planned_status ON public.project_systems
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_project_system_status_change();

-- 6. Триггер: изменение статуса/прогресса точки общего маршрута → уведомление всем
--    (кто состоит в проектах, где эта система есть, или все подписанные)
CREATE OR REPLACE FUNCTION public.notify_route_system_change()
RETURNS TRIGGER AS $$
DECLARE
  status_label TEXT;
  old_status_label TEXT;
  affected_user RECORD;
BEGIN
  -- Если ничего не изменилось — выходим
  IF OLD.status = NEW.status AND OLD.progress = NEW.progress THEN
    RETURN NEW;
  END IF;

  status_label := CASE NEW.status
    WHEN 'planned' THEN 'Запланирована'
    WHEN 'building' THEN 'Строительство'
    WHEN 'done' THEN 'Завершена'
    ELSE NEW.status
  END;

  old_status_label := CASE OLD.status
    WHEN 'planned' THEN 'Запланирована'
    WHEN 'building' THEN 'Строительство'
    WHEN 'done' THEN 'Завершена'
    ELSE OLD.status
  END;

  -- Уведомляем участников проектов, где эта система фигурирует
  FOR affected_user IN
    SELECT DISTINCT pm.user_id
    FROM public.project_systems ps
    JOIN public.project_members pm ON pm.project_id = ps.project_id
    WHERE ps.system_name = NEW.system_name
  LOOP
    -- Статус изменился
    IF OLD.status IS DISTINCT FROM NEW.status THEN
      PERFORM public.create_user_notification(
        affected_user.user_id,
        'route_status_change',
        'Маршрут: ' || NEW.system_name,
        ('Статус: ' || old_status_label || ' → ' || status_label),
        '/map',
        jsonb_build_object(
          'system_name', NEW.system_name,
          'old_status', OLD.status,
          'new_status', NEW.status,
          'progress', NEW.progress
        )
      );
    END IF;

    -- Прогресс изменился (и статус building)
    IF OLD.progress IS DISTINCT FROM NEW.progress AND NEW.status = 'building' THEN
      PERFORM public.create_user_notification(
        affected_user.user_id,
        'route_progress',
        'Маршрут: ' || NEW.system_name,
        ('Прогресс: ' || COALESCE(OLD.progress::text, '0') || '% → ' || COALESCE(NEW.progress::text, '0') || '%'),
        '/map',
        jsonb_build_object(
          'system_name', NEW.system_name,
          'old_progress', OLD.progress,
          'new_progress', NEW.progress,
          'status', NEW.status
        )
      );
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_route_system_change ON public.route_systems;
CREATE TRIGGER trg_notify_route_system_change
  AFTER UPDATE OF status, progress ON public.route_systems
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_route_system_change();

-- 7. Триггер: изменение проекта (название, описание, статус) → уведомление участникам
CREATE OR REPLACE FUNCTION public.notify_project_update()
RETURNS TRIGGER AS $$
DECLARE
  changed_fields TEXT := '';
  member RECORD;
BEGIN
  IF OLD.name IS DISTINCT FROM NEW.name THEN
    changed_fields := changed_fields || 'название, ';
  END IF;
  IF OLD.description IS DISTINCT FROM NEW.description THEN
    changed_fields := changed_fields || 'описание, ';
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    changed_fields := changed_fields || 'статус, ';
  END IF;
  IF OLD.color IS DISTINCT FROM NEW.color THEN
    changed_fields := changed_fields || 'оформление, ';
  END IF;

  -- Убираем trailing comma
  IF length(changed_fields) > 2 THEN
    changed_fields := left(changed_fields, length(changed_fields) - 2);
  ELSE
    RETURN NEW; -- ничего не изменилось из значимых полей
  END IF;

  FOR member IN
    SELECT user_id FROM public.project_members WHERE project_id = NEW.id
  LOOP
    PERFORM public.create_user_notification(
      member.user_id,
      'project_update',
      'Проект обновлён: ' || NEW.name,
      ('Изменены: ' || changed_fields),
      '/projects/' || NEW.id,
      jsonb_build_object('project_id', NEW.id, 'changed', changed_fields)
    );
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_project_update ON public.projects;
CREATE TRIGGER trg_notify_project_update
  AFTER UPDATE OF name, description, status, color ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_project_update();
