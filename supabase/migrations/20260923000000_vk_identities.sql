-- VK ID (id.vk.com) вход и привязка. Self-hosted GoTrue не имеет провайдера VK,
-- поэтому соответствие «VK user_id ↔ auth.users.id» хранится здесь.
-- Пишет только service_role (сервер сайта); пользователь видит лишь свою строку.
CREATE TABLE IF NOT EXISTS public.vk_identities (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  vk_user_id   TEXT NOT NULL UNIQUE,
  email        TEXT,
  display_name TEXT,
  avatar_url   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.vk_identities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vk_identities_select_own ON public.vk_identities;
CREATE POLICY vk_identities_select_own ON public.vk_identities
  FOR SELECT USING (auth.uid() = user_id);
-- INSERT/UPDATE/DELETE: политик нет → только service_role.

CREATE INDEX IF NOT EXISTS idx_vk_identities_vk_user_id ON public.vk_identities(vk_user_id);
