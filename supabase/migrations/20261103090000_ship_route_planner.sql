-- Private live ship state shared by the website and Colonial Helper, plus an
-- explicit one-shot route inbox. Both tables are accessed only by server-side
-- handlers using the service role; raw Loadout data is never exposed publicly.
create table if not exists public.pilot_ship_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  loadout jsonb,
  current_system text,
  fuel_level double precision,
  cargo_count integer,
  received_at timestamptz not null default now(),
  loadout_at timestamptz
);
alter table public.pilot_ship_state enable row level security;
revoke all on public.pilot_ship_state from public, anon, authenticated;
grant all on public.pilot_ship_state to service_role;

create table if not exists public.helper_route_inbox (
  user_id uuid primary key references auth.users(id) on delete cascade,
  route jsonb not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);
alter table public.helper_route_inbox enable row level security;
revoke all on public.helper_route_inbox from public, anon, authenticated;
grant all on public.helper_route_inbox to service_role;
