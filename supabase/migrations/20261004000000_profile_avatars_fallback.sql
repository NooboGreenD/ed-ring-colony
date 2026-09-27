-- ─────────────────────────────────────────────────────────────
-- Аватары профиля: запасное хранилище и гарантированный бакет.
--
-- Зачем
-- -----
-- Жалоба: «картинки профиля не загружаются, при смене аватарки ошибка 503».
-- 503 отдаёт не сайт: браузер грузил файл НАПРЯМУЮ в Supabase Storage
-- (`supabase.<домен>/storage/v1/...`), и когда контейнер storage не поднят
-- или Kong не видит живой upstream, шлюз отвечает 503 Service Unavailable.
-- Пилот при этом видел только текст ошибки из SDK и терял аватар.
--
-- Теперь загрузка идёт через сайт (`POST /api/account/avatar`), а если
-- Storage недоступен, картинка сохраняется прямо в базе и отдаётся
-- маршрутом `/api/avatars/<user_id>`. Аватары продолжают работать даже при
-- мёртвом storage-контейнере, а починка инфраструктуры перестаёт быть
-- условием для смены картинки.
--
-- Размер намеренно ограничен приложением (≤ 1 МБ после проверки MIME):
-- база — не файловое хранилище, это именно запасной путь.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.profile_avatars (
  user_id    UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  mime       TEXT        NOT NULL,
  bytes      BYTEA       NOT NULL,
  byte_size  INTEGER     NOT NULL,
  checksum   TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.profile_avatars IS
  'Запасное хранилище аватаров: используется, когда Supabase Storage недоступен (см. /api/account/avatar)';
COMMENT ON COLUMN public.profile_avatars.checksum IS
  'SHA-256 содержимого: служит версией в адресе /api/avatars/<id>?v=… и ETag при отдаче';

ALTER TABLE public.profile_avatars ENABLE ROW LEVEL SECURITY;

-- Пишет и читает эти строки сервер под service_role (он RLS не подчиняется).
-- Пилоту оставляем чтение собственной строки: полезно для отладки и не даёт
-- выгрузить чужие картинки одним запросом PostgREST.
DROP POLICY IF EXISTS profile_avatars_select_own ON public.profile_avatars;
CREATE POLICY profile_avatars_select_own ON public.profile_avatars
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON public.profile_avatars FROM anon;
GRANT SELECT ON public.profile_avatars TO authenticated;

-- ── Бакет avatars ────────────────────────────────────────────
-- В 000_base_schema.sql он создаётся внутри DO-блока, который молча
-- пропускается, если схема storage ещё не развёрнута (частый порядок при
-- self-hosted установке: сначала SQL, потом контейнеры). Повторяем создание
-- идемпотентно — иначе Storage отвечает «Bucket not found» и после починки
-- 503 загрузка всё равно не работает.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public)
    VALUES ('avatars', 'avatars', true)
    ON CONFLICT (id) DO UPDATE SET public = true;

    BEGIN
      DROP POLICY IF EXISTS avatars_read ON storage.objects;
      CREATE POLICY avatars_read ON storage.objects
        FOR SELECT TO anon, authenticated USING (bucket_id = 'avatars');

      DROP POLICY IF EXISTS avatars_insert ON storage.objects;
      CREATE POLICY avatars_insert ON storage.objects
        FOR INSERT TO authenticated WITH CHECK (bucket_id = 'avatars');

      DROP POLICY IF EXISTS avatars_update ON storage.objects;
      CREATE POLICY avatars_update ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'avatars' AND owner = auth.uid());

      DROP POLICY IF EXISTS avatars_delete ON storage.objects;
      CREATE POLICY avatars_delete ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'avatars' AND owner = auth.uid());
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'storage.objects принадлежит supabase_admin — политики бакета avatars настройте через Dashboard';
    END;
  ELSE
    RAISE NOTICE 'Схема storage не найдена: бакет avatars будет создан приложением при первой загрузке';
  END IF;
END $$;
