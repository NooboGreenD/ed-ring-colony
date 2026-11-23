import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

export async function createSquadronJournalFixture(additionalMigrations = []) {
const db = new PGlite();
const PILOT = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
// «Посторонний» создатель: эскадрильи в тестах заводит не тот пилот, которого
// мы проверяем, — иначе триггер сразу сделал бы его командиром.
const LEAD = '00000000-0000-4000-8000-000000000004';
// Свободные пилоты: тесты создания эскадрильи нельзя вести на тех, кого
// предыдущие тесты уже записали в состав — автовступление тогда не сработает.
const FRESH = '00000000-0000-4000-8000-000000000005';
const FRESH2 = '00000000-0000-4000-8000-000000000006';
const FRESH3 = '00000000-0000-4000-8000-000000000007';

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
INSERT INTO auth.users VALUES ('${PILOT}'), ('${OTHER}'), ('${LEAD}'), ('${FRESH}'), ('${FRESH2}'), ('${FRESH3}');

CREATE TABLE public.profiles(
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  cmdr_name text,
  avatar_url text,
  squadron text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  forum_posts_count integer NOT NULL DEFAULT 0,
  game_squadron_id bigint
);

CREATE TABLE public.squadrons(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  tag text,
  member_limit integer,
  status text NOT NULL DEFAULT 'active',
  is_open_recruitment boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.squadron_ranks(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  squadron_id bigint NOT NULL REFERENCES public.squadrons(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 99,
  is_default boolean NOT NULL DEFAULT false,
  can_manage_projects boolean NOT NULL DEFAULT false,
  can_manage_members boolean NOT NULL DEFAULT false,
  can_manage_ranks boolean NOT NULL DEFAULT false,
  can_edit_squadron boolean NOT NULL DEFAULT false
);

-- Как в настоящей базе: триггер создания эскадрильи создаёт и голосовые
-- комнаты, поэтому без таблицы вставка эскадрильи падала бы.
CREATE TABLE public.squadron_voice_rooms(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  squadron_id bigint NOT NULL REFERENCES public.squadrons(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  is_officer_only boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 1
);

CREATE TABLE public.squadron_members(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  squadron_id bigint NOT NULL REFERENCES public.squadrons(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  rank_id bigint REFERENCES public.squadron_ranks(id) ON DELETE SET NULL,
  callsign text,
  joined_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  UNIQUE(squadron_id, user_id)
);

-- Представление до миграции: она обязана его расширить, а не сломать.
CREATE VIEW public.public_profiles AS
  SELECT p.id, p.cmdr_name, p.avatar_url, p.squadron, p.created_at, p.updated_at,
         p.forum_posts_count
    FROM public.profiles p;
`);

// Триггер создания эскадрильи и звания по умолчанию — те же, что ставит
// 20260911030000. Без них созданная по журналу эскадрилья осталась бы без
// владельца в составе и без званий, а ранг назначать было бы не из чего.
await db.exec(`
CREATE FUNCTION public.create_default_squadron_ranks(p_squadron_id bigint)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.squadron_ranks (squadron_id, name, sort_order, is_default,
    can_manage_projects, can_manage_members, can_manage_ranks, can_edit_squadron)
  VALUES
    (p_squadron_id, 'Командир эскадрильи', 1, true, true, true, true, true),
    (p_squadron_id, 'Заместитель командира', 2, true, true, true, false, false),
    (p_squadron_id, 'Офицер', 3, true, true, true, false, false),
    (p_squadron_id, 'Ветеран', 4, true, true, false, false, false),
    (p_squadron_id, 'Пилот', 5, true, false, false, false, false);
END $$;

CREATE FUNCTION public.on_squadron_created()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE commander_rank_id bigint;
BEGIN
  PERFORM public.create_default_squadron_ranks(NEW.id);
  INSERT INTO public.squadron_voice_rooms (squadron_id, name) VALUES (NEW.id, 'Общий канал');
  SELECT id INTO commander_rank_id FROM public.squadron_ranks
   WHERE squadron_id = NEW.id AND name = 'Командир эскадрильи' ORDER BY id LIMIT 1;
  IF commander_rank_id IS NOT NULL THEN
    INSERT INTO public.squadron_members (squadron_id, user_id, rank_id)
    VALUES (NEW.id, NEW.created_by, commander_rank_id)
    ON CONFLICT (squadron_id, user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_on_squadron_created
  AFTER INSERT ON public.squadrons
  FOR EACH ROW EXECUTE FUNCTION public.on_squadron_created();
`);

await db.exec(readFileSync(
  new URL('../../../supabase/migrations/20261117090000_squadron_journal_sync.sql', import.meta.url), 'utf8',
));

/** Эскадрилья сайта с собственными званиями: как её создаёт триггер. */
async function createSquadron(name, options = {}) {
  const { rows } = await db.query(
    'INSERT INTO public.squadrons (name, tag, member_limit, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
    [name, options.tag ?? null, options.memberLimit ?? null, LEAD],
  );
  const id = rows[0].id;
  // Триггер записал создателя командиром; в этих тестах состав задаём сами,
  // иначе «свободных мест» и «уже участник» считались бы не с нуля.
  await db.query('DELETE FROM public.squadron_members WHERE squadron_id = $1', [id]);
  await db.query(
    `INSERT INTO public.squadron_ranks (squadron_id, name, sort_order, can_edit_squadron, can_manage_members, can_manage_ranks, can_manage_projects)
     VALUES ($1, 'Командир эскадрильи', 1, true, true, true, true),
            ($1, 'Офицер', 3, false, true, false, false),
            ($1, 'Пилот', 5, false, false, false, false)`,
    [id],
  );
  return id;
}

async function apply(userId, payload) {
  const { rows } = await db.query(
    `SELECT public.apply_pilot_squadron($1::uuid, $2::bigint, $3, $4, $5::int, $6, $7::timestamptz, $8, $9) AS result`,
    [
      userId,
      payload.id ?? null,
      payload.name ?? '',
      payload.tag ?? null,
      payload.rank ?? null,
      payload.rankName ?? null,
      payload.at ?? new Date().toISOString(),
      payload.source ?? 'helper',
      payload.join ?? true,
    ],
  );
  return rows[0].result;
}

async function profileOf(userId) {
  const { rows } = await db.query('SELECT * FROM public.profiles WHERE id = $1', [userId]);
  return rows[0];
}

async function membersOf(squadronId) {
  const { rows } = await db.query(
    `SELECT sm.*, r.name AS rank_name, r.can_manage_members
       FROM public.squadron_members sm
       LEFT JOIN public.squadron_ranks r ON r.id = sm.rank_id
      WHERE sm.squadron_id = $1 ORDER BY sm.user_id`,
    [squadronId],
  );
  return rows;
}

await db.exec(`INSERT INTO public.profiles (id, cmdr_name) VALUES
  ('${PILOT}', 'Nova'), ('${OTHER}', 'Vega'), ('${LEAD}', 'Lead'),
  ('${FRESH}', 'Rook'), ('${FRESH2}', 'Sable'), ('${FRESH3}', 'Wren')`);

for (const file of additionalMigrations) {
  await db.exec(readFileSync(new URL('../../../supabase/migrations/' + file, import.meta.url), 'utf8'));
}
return { db, PILOT, OTHER, LEAD, FRESH, FRESH2, FRESH3, createSquadron, apply, profileOf, membersOf };
}
