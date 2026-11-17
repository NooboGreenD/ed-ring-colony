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
   * полная эскадрилья не переполняется;
   * эскадрильи, которой на сайте нет, создаётся (владелец — сам пилот), но
     только вместе с вступлением и только при наличии названия. */

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
  new URL('../../supabase/migrations/20261117090000_squadron_journal_sync.sql', import.meta.url), 'utf8',
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

test('эскадрильи, которой на сайте нет, создаётся — владельцем становится пилот', async () => {
  const result = await apply(FRESH, {
    id: 31337, name: 'UNKNOWN WING', rank: 2, at: '2026-11-16T15:00:00Z',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.created, true);
  assert.equal(result.foundBy, 'created');
  assert.equal(result.joined, true, 'пилот сразу в составе своей же эскадрильи');

  const { rows } = await db.query('SELECT * FROM public.squadrons WHERE id = $1', [result.squadronId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'UNKNOWN WING');
  assert.equal(rows[0].tag, 'UNKNOWNWIN', 'тег собран из названия (10 символов)');
  assert.equal(rows[0].created_by, FRESH, 'создатель — сам пилот: эскадрилья остаётся его');
  assert.equal(Number(rows[0].game_squadron_id), 31337);
  assert.equal(rows[0].game_squadron_source, 'journal');
  assert.equal(rows[0].member_limit, 600);

  const members = await membersOf(result.squadronId);
  assert.equal(members.length, 1);
  assert.equal(members[0].user_id, FRESH);
  // Строку завёл триггер создания: пилот — владелец сайта, значит командир.
  // Права пришли не из журнала, а из того, что эскадрилья его собственная.
  assert.equal(members[0].rank_name, 'Командир эскадрильи');
  assert.equal(members[0].game_rank, 2, 'игровой ранг записан рядом');
  assert.equal(members[0].joined_via, null, 'это не вступление по журналу, а владение');

  // Звания и голосовые комнаты появились триггером создания эскадрильи.
  const { rows: ranks } = await db.query(
    'SELECT name FROM public.squadron_ranks WHERE squadron_id = $1 ORDER BY sort_order', [result.squadronId],
  );
  assert.equal(ranks.length, 5);
  const { rows: rooms } = await db.query(
    'SELECT count(*)::int AS n FROM public.squadron_voice_rooms WHERE squadron_id = $1', [result.squadronId],
  );
  assert.equal(rooms[0].n, 1);

  // Витрина профиля показывает созданную эскадрилью.
  const profile = await profileOf(FRESH);
  assert.equal(Number(profile.game_squadron_site_id), result.squadronId);
});

test('создание не откатывается старым журналом', async () => {
  // Сначала свежее состояние, потом событие из старой истории (пере-импорт):
  // сайт обязан его пропустить, а не завести по нему эскадрилью.
  const fresh = await apply(FRESH3, { id: 777777, name: 'GHOST WING', at: '2026-11-16T22:00:00Z' });
  assert.equal(fresh.created, true, JSON.stringify(fresh));
  const before = await db.query('SELECT count(*)::int AS n FROM public.squadrons');
  const result = await apply(FRESH3, { id: 999999, name: 'OLDER WING', at: '2026-01-01T00:00:00Z' });
  assert.equal(result.skipped, 'stale', JSON.stringify(result));
  const after = await db.query('SELECT count(*)::int AS n FROM public.squadrons');
  assert.equal(after.rows[0].n, before.rows[0].n, 'история не заводит эскадрилий');
});

test('join=false сведений не создаёт: сайт остаётся прежним', async () => {
  const before = await db.query('SELECT count(*)::int AS n FROM public.squadrons');
  const result = await apply(FRESH2, {
    id: 888888, name: 'HUSHED WING', at: '2026-11-17T01:00:00Z', join: false,
  });
  assert.equal(result.created, false, JSON.stringify(result));
  assert.equal(result.squadronId, null, JSON.stringify(result));
  assert.equal(result.reason, 'squadron_not_found', 'вступления нет — и создавать нечего');
  const after = await db.query('SELECT count(*)::int AS n FROM public.squadrons');
  assert.equal(after.rows[0].n, before.rows[0].n);
  const profile = await profileOf(FRESH2);
  assert.equal(profile.game_squadron_name, 'HUSHED WING', 'сведения о пилоте записаны');
});

test('без названия эскадрилья не создаётся: показывать нечего', async () => {
  const before = await db.query('SELECT count(*)::int AS n FROM public.squadrons');
  const result = await apply(FRESH3, { id: 606060, name: '', at: '2026-11-17T00:00:00Z' });
  assert.equal(result.created, false, JSON.stringify(result));
  assert.equal(result.squadronId, null, JSON.stringify(result));
  const after = await db.query('SELECT count(*)::int AS n FROM public.squadrons');
  assert.equal(after.rows[0].n, before.rows[0].n);
});

test('тег из журнала ищет эскадрилью с другим написанием имени', async () => {
  // На сайте имя могло быть записано по-другому (перевод, приписка), тег — тот.
  const squadronId = await createSquadron('Deep Space Haulers', { tag: 'DSHA' });
  const result = await apply(OTHER, {
    id: 555001, name: 'DEEP SPACE HAULERS [OLD]', tag: 'dsha', at: '2026-11-16T19:00:00Z',
  });
  assert.equal(result.squadronId, Number(squadronId));
  assert.equal(result.foundBy, 'tag', 'дубль не создан');
  const members = await membersOf(squadronId);
  assert.equal(members.length, 0, 'пилот уже в другой эскадрилье сайта — не переезжает автоматически');
});

test('пилот, уже состоящий в эскадрилье сайта, новую по журналу не создаёт', async () => {
  const before = await db.query('SELECT count(*)::int AS n FROM public.squadrons');
  const result = await apply(PILOT, {
    id: 999001, name: 'SOME OTHER WING', at: '2026-11-16T20:00:00Z',
  });
  assert.equal(result.created, false);
  assert.equal(result.squadronId, null);
  assert.equal(result.reason, 'squadron_not_found');
  const after = await db.query('SELECT count(*)::int AS n FROM public.squadrons');
  assert.equal(after.rows[0].n, before.rows[0].n, 'иначе на каждый чужой тег появлялась бы пустая эскадрилья');
});

test('витрина public_profiles получила колонки эскадрильи из журнала', async () => {
  // Sable (FRESH2) последней записью получила HUSHED WING (888888) — здесь
  // важен и сам набор колонок, и то, что витрина видит именно последнее.
  const { rows } = await db.query('SELECT * FROM public.public_profiles WHERE id = $1', [FRESH2]);
  assert.equal(Number(rows[0].game_squadron_id), 888888);
  assert.equal(typeof rows[0].game_squadron_name, 'string');
  assert.ok('game_squadron_rank' in rows[0]);
  assert.ok('game_squadron_site_id' in rows[0]);
  // Прежние колонки никуда не делись.
  assert.equal(rows[0].cmdr_name, 'Sable');
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
