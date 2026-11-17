import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

/* Эскадрилья пилота из журнала в БД:
   supabase/migrations/20261117090000_squadron_journal_sync.sql.

   Миграция исполняется настоящим PostgreSQL (PGlite), как и остальные
   SQL-тесты проекта. Проверяется то, что нельзя проверить по коду маршрута:

   * связь эскадрильи сайта с игровой ставится по названию и потом находится
     по SquadronID;
   * автовступление в состав даёт ранг БЕЗ прав, даже если игровой ранг высокий;
   * ручной ранг офицера журнал не перетирает, игровые поля обновляются;
   * старый журнал (пере-импорт истории) не откатывает свежее состояние;
   * пилот из другой эскадрильи не переезжает автоматически;
   * полная эскадрилья не переполняется. */

const db = new PGlite();
const PILOT = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
INSERT INTO auth.users VALUES ('${PILOT}'), ('${OTHER}');

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
  created_by uuid
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

await db.exec(readFileSync(
  new URL('../../supabase/migrations/20261117090000_squadron_journal_sync.sql', import.meta.url), 'utf8',
));

/** Эскадрилья сайта с собственными званиями: как её создаёт триггер. */
async function createSquadron(name, options = {}) {
  const { rows } = await db.query(
    'INSERT INTO public.squadrons (name, tag, member_limit, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
    [name, options.tag ?? null, options.memberLimit ?? null, PILOT],
  );
  const id = rows[0].id;
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

await db.exec(`INSERT INTO public.profiles (id, cmdr_name) VALUES ('${PILOT}', 'Nova'), ('${OTHER}', 'Vega')`);

test('эскадрилья находится по названию, связывается с игровым ID и пилот вступает', async () => {
  const squadronId = await createSquadron('ENDURANCE EXPLORATION');
  const result = await apply(PILOT, {
    id: 75645, name: '  endurance exploration ', rank: 0, at: '2026-11-10T18:00:00Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.squadronId, Number(squadronId));
  assert.equal(result.foundBy, 'name', 'первый раз — по названию, без учёта регистра и пробелов');
  assert.equal(result.joined, true);
  assert.equal(result.member, false, 'member описывает состояние ДО приёма');

  const members = await membersOf(squadronId);
  assert.equal(members.length, 1);
  assert.equal(members[0].user_id, PILOT);
  assert.equal(members[0].game_rank, 0);
  assert.equal(members[0].joined_via, 'game');

  const profile = await profileOf(PILOT);
  assert.equal(Number(profile.game_squadron_id), 75645);
  assert.equal(profile.game_squadron_name, 'endurance exploration');
  assert.equal(profile.game_squadron_rank, 0);
  assert.equal(Number(profile.game_squadron_site_id), Number(squadronId));
  assert.equal(profile.game_squadron_source, 'helper');
  // Витрина состава сайта не перетирается журналом: её пересобирают триггеры.
  assert.equal(profile.squadron, null);

  const { rows: linked } = await db.query('SELECT game_squadron_id FROM public.squadrons WHERE id = $1', [squadronId]);
  assert.equal(Number(linked[0].game_squadron_id), 75645);
});

test('второй раз эскадрилья находится уже по SquadronID', async () => {
  const result = await apply(PILOT, { id: 75645, name: 'ENDURANCE EXPLORATION', rank: 1, at: '2026-11-12T18:00:00Z' });
  assert.equal(result.foundBy, 'game_id');
  assert.equal(result.joined, false, 'пилот уже в составе');
  assert.equal(result.member, true);
  const { rows } = await db.query('SELECT game_rank FROM public.squadron_members WHERE user_id = $1', [PILOT]);
  assert.equal(rows[0].game_rank, 1);
});

test('автовступление даёт ранг без прав, даже при высоком игровом ранге', async () => {
  const squadronId = await createSquadron('DEEP SPACE HAULERS');
  // Vega: игровой ранг 8 — «командир», но права в игре и на сайте не связаны.
  const result = await apply(OTHER, { id: 90001, name: 'DEEP SPACE HAULERS', rank: 8, at: '2026-11-13T10:00:00Z' });
  assert.equal(result.joined, true);

  const members = await membersOf(squadronId);
  assert.equal(members.length, 1);
  assert.equal(members[0].can_manage_members, false, 'никаких прав из журнала');
  assert.equal(members[0].game_rank, 8);
  // Единственный ранг без прав — «Пилот» (sort_order 5).
  assert.equal(members[0].rank_name, 'Пилот');
});

test('ручное звание офицера журнал не перетирает, игровые поля — обновляет', async () => {
  const { rows: squad } = await db.query("SELECT id FROM public.squadrons WHERE name = 'ENDURANCE EXPLORATION'");
  const squadronId = squad[0].id;
  const { rows: officerRank } = await db.query(
    "SELECT id FROM public.squadron_ranks WHERE squadron_id = $1 AND name = 'Офицер'", [squadronId],
  );
  await db.query(
    'UPDATE public.squadron_members SET rank_id = $1 WHERE squadron_id = $2 AND user_id = $3',
    [officerRank[0].id, squadronId, PILOT],
  );

  const result = await apply(PILOT, {
    id: 75645, name: 'ENDURANCE EXPLORATION', rank: 2, rankName: 'Лейтенант', at: '2026-11-14T10:00:00Z',
  });
  assert.equal(result.joined, false);

  const members = await membersOf(squadronId);
  assert.equal(members[0].rank_name, 'Офицер', 'назначение офицера главнее журнала');
  assert.equal(members[0].game_rank, 2);
  assert.equal(members[0].game_rank_name, 'Лейтенант');
  assert.ok(members[0].game_synced_at);
});

test('старый журнал не откатывает свежее состояние (пере-импорт истории)', async () => {
  const before = await profileOf(PILOT);
  const result = await apply(PILOT, {
    id: 75645, name: 'ENDURANCE EXPLORATION', rank: 0, at: '2026-01-01T00:00:00Z',
  });
  assert.equal(result.skipped, 'stale');
  assert.equal(result.ok, true, 'это не ошибка приёма');
  const after = await profileOf(PILOT);
  assert.equal(after.game_squadron_rank, before.game_squadron_rank);
  assert.equal(after.game_squadron_at.toISOString(), before.game_squadron_at.toISOString());
});

test('пилот из другой эскадрильи автоматически не переезжает', async () => {
  const otherSquadron = await createSquadron('RING RUNNERS');
  const result = await apply(PILOT, { id: 424242, name: 'RING RUNNERS', at: '2026-11-15T10:00:00Z' });
  assert.equal(result.squadronId, Number(otherSquadron));
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'other_squadron');
  // Сведения профиля всё же обновились: игра теперь говорит про другую
  // эскадрилью, и пилот должен видеть именно её.
  const profile = await profileOf(PILOT);
  assert.equal(Number(profile.game_squadron_id), 424242);
  const members = await membersOf(otherSquadron);
  assert.equal(members.length, 0, 'состав другой эскадрильи не тронут');
});

test('полная эскадрилья не переполняется автовступлением', async () => {
  const fullSquadron = await createSquadron('FULL HOUSE', { memberLimit: 1 });
  await db.query(
    'INSERT INTO public.squadron_members (squadron_id, user_id) VALUES ($1, $2)',
    [fullSquadron, OTHER],
  );
  // Другой пилот: освобождаем его из предыдущих эскадрилий, чтобы причина
  // отказа была именно «полная», а не «уже в другой».
  await db.exec(`INSERT INTO auth.users VALUES ('00000000-0000-4000-8000-000000000003') ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles (id, cmdr_name) VALUES ('00000000-0000-4000-8000-000000000003', 'Rook');`);
  const result = await apply('00000000-0000-4000-8000-000000000003', {
    id: 777, name: 'FULL HOUSE', at: '2026-11-16T10:00:00Z',
  });
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'full');
  assert.equal((await membersOf(fullSquadron)).length, 1);
});

test('join=false сохраняет сведения, но состав не меняет', async () => {
  await createSquadron('QUIET WING');
  const result = await apply(OTHER, { id: 555, name: 'QUIET WING', at: '2026-11-16T12:00:00Z', join: false });
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'join_disabled');
  assert.equal(result.member, false);
  const profile = await profileOf(OTHER);
  assert.equal(profile.game_squadron_name, 'QUIET WING');
});

test('эскадрилья без совпадения на сайте: сведения сохранены, причина названа', async () => {
  const result = await apply(OTHER, { id: 31337, name: 'UNKNOWN WING', at: '2026-11-16T15:00:00Z' });
  assert.equal(result.squadronId, null);
  assert.equal(result.reason, 'squadron_not_found');
  const profile = await profileOf(OTHER);
  assert.equal(Number(profile.game_squadron_id), 31337);
  assert.equal(profile.game_squadron_name, 'UNKNOWN WING');
});

test('витрина public_profiles получила колонки эскадрильи из журнала', async () => {
  const { rows } = await db.query('SELECT * FROM public.public_profiles WHERE id = $1', [PILOT]);
  assert.equal(Number(rows[0].game_squadron_id), 424242);
  assert.equal(typeof rows[0].game_squadron_name, 'string');
  assert.ok('game_squadron_rank' in rows[0]);
  assert.ok('game_squadron_site_id' in rows[0]);
  // Прежние колонки никуда не делись.
  assert.equal(rows[0].cmdr_name, 'Nova');
});

test('функция недоступна anon и authenticated', async () => {
  const { rows } = await db.query(
    `SELECT has_function_privilege('anon', 'public.apply_pilot_squadron(uuid,bigint,text,text,integer,text,timestamptz,text,boolean)', 'EXECUTE') AS anon,
            has_function_privilege('authenticated', 'public.apply_pilot_squadron(uuid,bigint,text,text,integer,text,timestamptz,text,boolean)', 'EXECUTE') AS authenticated,
            has_function_privilege('service_role', 'public.apply_pilot_squadron(uuid,bigint,text,text,integer,text,timestamptz,text,boolean)', 'EXECUTE') AS service`,
  );
  assert.equal(rows[0].anon, false);
  assert.equal(rows[0].authenticated, false);
  assert.equal(rows[0].service, true);
});
