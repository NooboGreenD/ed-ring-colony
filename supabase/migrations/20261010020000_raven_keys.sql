-- RCC-ключ Raven Colonial пользователя для создания проектов с сайта (Архитектор).
-- Значение зашифровано приложением (AES-256-GCM, ключ RAVEN_KEY_SECRET) —
-- в базе лежит только шифротекст. Доступ только через серверные маршруты.
CREATE TABLE IF NOT EXISTS public.raven_keys (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  key_cipher   TEXT NOT NULL,
  key_mask     TEXT NOT NULL,
  cmdr_name    TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.raven_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.raven_keys FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.raven_keys TO service_role;

COMMENT ON TABLE public.raven_keys IS
  'RCC-ключи Raven Colonial (шифротекст). Читается и пишется только сервером под service_role.';

NOTIFY pgrst, 'reload schema';
