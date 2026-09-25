-- Яндекс ID (oauth.yandex.ru) вход и привязка. Self-hosted GoTrue не имеет
-- провайдера Яндекса, поэтому соответствие «Yandex user_id ↔ auth.users.id»
-- хранится здесь. Пишет только service_role (сервер сайта); пользователь
-- видит лишь свою строку.
CREATE TABLE IF NOT EXISTS public.yandex_identities (
  user_id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  yandex_user_id  TEXT NOT NULL UNIQUE,
  email           TEXT,
  display_name    TEXT,
  avatar_url      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.yandex_identities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS yandex_identities_select_own ON public.yandex_identities;
CREATE POLICY yandex_identities_select_own ON public.yandex_identities
  FOR SELECT USING (auth.uid() = user_id);
-- INSERT/UPDATE/DELETE: политик нет → только service_role.

CREATE INDEX IF NOT EXISTS idx_yandex_identities_yandex_user_id ON public.yandex_identities(yandex_user_id);
