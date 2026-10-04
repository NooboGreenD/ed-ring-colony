create table if not exists public.outfitting_builds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  ship text not null,
  code text not null,
  created_at timestamptz not null default now()
);
create index if not exists outfitting_builds_user_created_idx on public.outfitting_builds(user_id, created_at desc);
alter table public.outfitting_builds enable row level security;
create policy "users manage own outfitting builds" on public.outfitting_builds
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
