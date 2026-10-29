-- Привязка лаунчера к учётной записи и перенос настроек между устройствами.
--
-- Лаунчер на компьютере не хранит пароль: пилот открывает профиль на сайте,
-- нажимает «Подключить лаунчер», получает короткий код на десять минут и
-- вводит его в лаунчере. Сервер меняет код на токен устройства, и дальше
-- лаунчер ходит им как Bearer. Токен лежит в базе только хешем: утечка дампа
-- не даёт войти в чужую учётную запись.
--
-- Настройки (профили раскладки оверлея и позиции блоков) хранятся одним
-- снимком JSON на пилота: их немного, и они меняются целиком.
--
-- Все три таблицы закрыты наружу: к ним обращаются только серверные
-- обработчики сервисным ключом, публичных политик RLS нет.

create table if not exists public.helper_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default '',
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists helper_devices_user_idx
  on public.helper_devices (user_id, created_at desc);
alter table public.helper_devices enable row level security;
revoke all on public.helper_devices from public, anon, authenticated;
grant all on public.helper_devices to service_role;

create table if not exists public.helper_link_codes (
  code_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  device_id uuid references public.helper_devices(id) on delete set null
);
create index if not exists helper_link_codes_user_idx
  on public.helper_link_codes (user_id, created_at desc);
alter table public.helper_link_codes enable row level security;
revoke all on public.helper_link_codes from public, anon, authenticated;
grant all on public.helper_link_codes to service_role;

create table if not exists public.helper_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  device_name text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.helper_settings enable row level security;
revoke all on public.helper_settings from public, anon, authenticated;
grant all on public.helper_settings to service_role;

comment on table public.helper_devices is
  'Устройства, привязанные к учётной записи кодом из профиля. Токен хранится хешем.';
comment on table public.helper_link_codes is
  'Одноразовые коды привязки лаунчера: живут 10 минут, хранятся хешем.';
comment on table public.helper_settings is
  'Снимок настроек Helper (профили раскладки оверлея), чтобы перенести их на другое устройство.';
