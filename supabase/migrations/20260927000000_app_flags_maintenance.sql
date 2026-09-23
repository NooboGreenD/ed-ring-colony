-- ══════════════════════════════════════════════════════════════════════
-- Флаги приложения: технические работы и отметка о последней копии БД.
--
-- Зачем отдельная таблица, а не память веб-процесса:
--   1. заглушку «Ведутся технические работы» отдаёт прокси (src/proxy.ts),
--      который работает в отдельном рантайме и не видит переменные Node;
--   2. контейнер web может перезапуститься посреди резервного копирования —
--      признак с `expires_at` переживёт перезапуск и сам «отлипнет»;
--   3. веб-контейнер не имеет доступа к файловой системе хоста, поэтому
--      дата последней копии (для «прошла неделя — пора») хранится здесь.
--
-- Запись идёт только сервисным ключом (service_role обходит RLS); чтение
-- разрешено всем — прокси должен узнать признак без секретов.
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.app_flags (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.app_flags IS
    'Служебные флаги приложения: maintenance (заглушка техработ) и db_backup (отметка о последней копии).';
COMMENT ON COLUMN public.app_flags.key IS
    'maintenance — сайт под заглушкой; db_backup — когда и какая копия БД сделана последней.';

ALTER TABLE public.app_flags ENABLE ROW LEVEL SECURITY;

-- Чтение: прокси и заглушка читают признак анонимным ключом.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'app_flags' AND policyname = 'app_flags_public_read'
    ) THEN
        CREATE POLICY app_flags_public_read ON public.app_flags FOR SELECT USING (true);
    END IF;
END
$$;

GRANT SELECT ON TABLE public.app_flags TO anon, authenticated;
-- INSERT/UPDATE/DELETE намеренно не выдаём никому: с включённым RLS и без
-- политик записать флаг может только роль, обходящая RLS (service_role).

-- updated_at пишется самим приложением (upsert в src/lib/maintenance.ts);
-- триггер не заводим: в $fn$-телах этого репозитория по соглашению только SQL,
-- а польза от автообновления метки при ручной правке из psql невелика.
