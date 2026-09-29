-- ─────────────────────────────────────────────────────────────────────────
-- system_architects — назначенный архитектор системы и права на планы
-- ─────────────────────────────────────────────────────────────────────────
--
-- Зачем. До этой миграции планы застройки (`system_plans`) были полностью
-- демократичными: сохранить план системы мог любой авторизованный командир,
-- и договориться «кто в системе главный» было негде. Для совместной
-- колонизации этого мало — нужен именованный архитектор системы, как в игре.
--
-- Правило редактирования плана:
--
--   * пока у системы НЕТ назначенного архитектора — ничего не меняется:
--     планы сохраняет любой, свои планы правят их авторы;
--   * как только архитектор НАЗНАЧЕН — создавать и изменять планы этой
--     системы может только он (и администратор сайта). Чужие сохранённые
--     планы не исчезают, просто править их больше нельзя, пока их автор
--     не станет архитектором системы.
--
-- Кто меняет архитектора:
--
--   * назначить или сменить архитектора — только `admin` (панель
--     «Администрирование системы» в разделе /architect);
--   * сам архитектор может отказаться от системы (DELETE своей строки).
--
-- Почему права здесь, а не только в API: маршруты /api/architect/plans
-- ходят в базу через cookie-клиент, то есть RLS — последняя линия обороны.
-- Проверки в маршрутах остаются (дают человеческие сообщения об ошибке),
-- политики ниже делают невозможным обход через прямые запросы. Проверка
-- вынесена в SECURITY DEFINER-функции, чтобы политика не зависела от
-- RLS-порядка чтения profiles/system_architects и не уходила в рекурсию.

CREATE TABLE IF NOT EXISTS public.system_architects (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  system_name      TEXT NOT NULL CHECK (LENGTH(BTRIM(system_name)) BETWEEN 1 AND 128),
  -- Ключ системы в нижнем регистре пишет API (`systemKey`): имена систем
  -- сравниваются без учёта регистра, как и в system_plans/system_progress.
  system_name_lc   TEXT NOT NULL UNIQUE CHECK (
    system_name_lc = BTRIM(system_name_lc)
    AND system_name_lc = lower(system_name_lc)
  ),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  architect_name   TEXT NOT NULL DEFAULT '',
  assigned_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_by_name TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.system_architects IS
  'Назначенные архитекторы систем: одна строка = система закреплена за архитектором, после этого править её планы может только он и admin.';

CREATE INDEX IF NOT EXISTS idx_system_architects_user
  ON public.system_architects (user_id);

ALTER TABLE public.system_architects ENABLE ROW LEVEL SECURITY;

-- Кто архитектор системы — не секрет: читают все, включая гостей.
DROP POLICY IF EXISTS system_architects_select ON public.system_architects;
CREATE POLICY system_architects_select ON public.system_architects
  FOR SELECT TO anon, authenticated USING (true);

GRANT SELECT ON public.system_architects TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.system_architects TO authenticated;

-- Признак «текущий пользователь — администратор»: собрано одной функцией,
-- чтобы все политики ниже читались одинаково.
CREATE OR REPLACE FUNCTION public.request_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;

-- Назначать и менять архитектора системы может только админ.
DROP POLICY IF EXISTS system_architects_insert ON public.system_architects;
CREATE POLICY system_architects_insert ON public.system_architects
  FOR INSERT TO authenticated WITH CHECK (public.request_is_admin());

DROP POLICY IF EXISTS system_architects_update ON public.system_architects;
CREATE POLICY system_architects_update ON public.system_architects
  FOR UPDATE TO authenticated
  USING (public.request_is_admin())
  WITH CHECK (public.request_is_admin());

-- Снять архитектора: админ или он сам («отказаться от системы»).
DROP POLICY IF EXISTS system_architects_delete ON public.system_architects;
CREATE POLICY system_architects_delete ON public.system_architects
  FOR DELETE TO authenticated USING (
    user_id = auth.uid() OR public.request_is_admin()
  );

-- Право создать план системы: без назначенного архитектора — как раньше,
-- с назначенным — только архитектор системы или админ.
CREATE OR REPLACE FUNCTION public.system_plan_can_create(p_system_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.request_is_admin()
    OR NOT EXISTS (
      SELECT 1 FROM public.system_architects sa
      WHERE sa.system_name_lc = lower(BTRIM(p_system_name))
    )
    OR EXISTS (
      SELECT 1 FROM public.system_architects sa
      WHERE sa.system_name_lc = lower(BTRIM(p_system_name))
        AND sa.user_id = auth.uid()
    );
$$;

-- Право изменить существующий план: автор — пока у системы нет архитектора;
-- иначе только назначенный архитектор или админ (независимо от автора:
-- архитектор получает власть над планами «своей» системы целиком).
CREATE OR REPLACE FUNCTION public.system_plan_can_edit(p_system_name text, p_author_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.request_is_admin()
    OR EXISTS (
      SELECT 1 FROM public.system_architects sa
      WHERE sa.system_name_lc = lower(BTRIM(p_system_name))
        AND sa.user_id = auth.uid()
    )
    OR (
      p_author_id = auth.uid()
      AND NOT EXISTS (
        SELECT 1 FROM public.system_architects sa
        WHERE sa.system_name_lc = lower(BTRIM(p_system_name))
      )
    );
$$;

-- Право удалить план: автор (уборка собственных черновиков не отменяется
-- назначением архитектора), модератор/админ — как раньше, плюс архитектор
-- системы может чистить планы своей системы.
CREATE OR REPLACE FUNCTION public.system_plan_can_delete(p_system_name text, p_author_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p_author_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'moderator')
    )
    OR EXISTS (
      SELECT 1 FROM public.system_architects sa
      WHERE sa.system_name_lc = lower(BTRIM(p_system_name))
        AND sa.user_id = auth.uid()
    );
$$;

DROP POLICY IF EXISTS system_plans_insert ON public.system_plans;
CREATE POLICY system_plans_insert ON public.system_plans
  FOR INSERT TO authenticated WITH CHECK (
    author_id = auth.uid()
    AND public.system_plan_can_create(system_name)
  );

DROP POLICY IF EXISTS system_plans_update ON public.system_plans;
CREATE POLICY system_plans_update ON public.system_plans
  FOR UPDATE TO authenticated
  USING (public.system_plan_can_edit(system_name, author_id))
  WITH CHECK (public.system_plan_can_edit(system_name, author_id));

DROP POLICY IF EXISTS system_plans_delete ON public.system_plans;
CREATE POLICY system_plans_delete ON public.system_plans
  FOR DELETE TO authenticated USING (
    public.system_plan_can_delete(system_name, author_id)
  );

-- Триггер updated_at: функция уже создана прошлыми миграциями; повторяем
-- определение, чтобы файл применялся и сам по себе.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS system_architects_updated_at ON public.system_architects;
CREATE TRIGGER system_architects_updated_at
  BEFORE UPDATE ON public.system_architects
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
