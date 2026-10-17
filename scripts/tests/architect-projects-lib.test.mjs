import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_LIMITS,
  canChangeRole,
  canEditDuty,
  canRemoveMember,
  editableSystemFields,
  normalizeColor,
  parseDateOnly,
  parseProgressSnapshot,
  parseSystemList,
  progressSnapshot,
  projectPermissions,
  sanitizeProjectPatch,
  sanitizeSystemPatch,
  sortMembers,
  systemKey,
  validateNewProject,
} from '../../src/lib/architect/projects.ts';
import {
  buildProjectProgress,
  buildSystemProgress,
  cleanDepotName,
  mergeSites,
  pickRavenRow,
  siteDirectory,
  staleSystems,
  summarizeProject,
} from '../../src/lib/architect/projectProgress.ts';
import {
  buildProjectLeaders,
  canonicalCommodity,
  periodSince,
} from '../../src/lib/architect/projectLeaders.ts';
import { addSite, createPlan, linkSiteToRaven } from '../../src/lib/architect/planner.ts';

/* «Проекты систем» Архитектора: чистая логика (права, ввод, прогресс,
   лидеры). БД — architect-projects-db.test.mjs, маршруты —
   architect-projects-routes.test.mjs, интерфейс — architect-projects-ui.test.mjs. */

// ── Права ──────────────────────────────────────────────────────────────────

test('права: создатель ведёт всё, модератор — без модераторов и удаления, участник смотрит', () => {
  const owner = projectPermissions('owner');
  const moderator = projectPermissions('moderator');
  const member = projectPermissions('member');
  const stranger = projectPermissions(null);
  const admin = projectPermissions(null, true);

  assert.equal(owner.deleteProject, true);
  assert.equal(owner.manageModerators, true);
  assert.equal(owner.transfer, true);
  assert.equal(owner.leave, false, 'создатель не может просто уйти — только передать');

  assert.equal(moderator.manageSystems, true);
  assert.equal(moderator.manageMembers, true);
  assert.equal(moderator.bindAnyCarrier, true);
  assert.equal(moderator.manageModerators, false);
  assert.equal(moderator.deleteProject, false);
  assert.equal(moderator.transfer, false);

  assert.equal(member.view, true);
  assert.equal(member.refresh, true);
  assert.equal(member.bindOwnCarrier, true);
  assert.equal(member.manageSystems, false);
  assert.equal(member.bindAnyCarrier, false);
  assert.equal(member.leave, true);

  assert.equal(stranger.view, false);
  assert.equal(admin.view, true);
  assert.equal(admin.deleteProject, true, 'администратор сайта может разобрать спор');
  assert.equal(admin.bindOwnCarrier, false, 'но «своего» носителя в чужом проекте у него нет');
});

test('права на участников: модератора убирает только создатель, создателя — никто', () => {
  const owner = { userId: 'o', role: 'owner', isAdmin: false };
  const moderator = { userId: 'm', role: 'moderator', isAdmin: false };
  const member = { userId: 'u', role: 'member', isAdmin: false };

  assert.equal(canRemoveMember(moderator, { userId: 'u', role: 'member' }).ok, true);
  assert.equal(canRemoveMember(moderator, { userId: 'm2', role: 'moderator' }).ok, false);
  assert.equal(canRemoveMember(owner, { userId: 'm', role: 'moderator' }).ok, true);
  assert.equal(canRemoveMember(member, { userId: 'u2', role: 'member' }).ok, false);
  assert.equal(canRemoveMember(member, { userId: 'u', role: 'member' }).ok, true, 'выйти сам может любой участник');
  assert.equal(canRemoveMember(moderator, { userId: 'm', role: 'moderator' }).ok, true, 'и модератор тоже');
  const ownerLeaves = canRemoveMember(owner, { userId: 'o', role: 'owner' });
  assert.equal(ownerLeaves.ok, false);
  assert.match(ownerLeaves.reason, /передайте/);

  assert.equal(canChangeRole(owner, { userId: 'u', role: 'member' }, 'moderator').ok, true);
  assert.equal(canChangeRole(moderator, { userId: 'u', role: 'member' }, 'moderator').ok, false, 'модератор не плодит модераторов');
  assert.equal(canChangeRole(owner, { userId: 'u', role: 'member' }, 'owner').ok, true, 'передача проекта');
  assert.equal(canChangeRole(moderator, { userId: 'u', role: 'member' }, 'owner').ok, false);
  assert.equal(canChangeRole({ userId: 'a', role: null, isAdmin: true }, { userId: 'o', role: 'owner' }, 'member').ok, false,
    'роль создателя меняется только передачей');
  assert.equal(canChangeRole(owner, { userId: 'u', role: 'member' }, 'member').ok, false);

  assert.equal(canEditDuty(member, { userId: 'u', role: 'member' }), true, 'свою обязанность подписывает сам');
  assert.equal(canEditDuty(member, { userId: 'u2', role: 'member' }), false);
  assert.equal(canEditDuty(moderator, { userId: 'u', role: 'member' }), true);
});

test('права на систему: ответственный меняет только этап и заметки', () => {
  const member = { userId: 'u', role: 'member', isAdmin: false };
  assert.deepEqual([...editableSystemFields(member, 'u')], ['stage', 'notes']);
  assert.deepEqual([...editableSystemFields(member, 'someone-else')], []);
  assert.deepEqual([...editableSystemFields({ userId: 'x', role: null, isAdmin: false }, 'x')], [], 'не участник — даже если записан ответственным');
  assert.ok(editableSystemFields({ userId: 'm', role: 'moderator', isAdmin: false }, null).includes('planId'));

  const { patch, forbidden } = sanitizeSystemPatch({ stage: 'building', priority: 1, notes: '  везём сталь  ' }, ['stage', 'notes']);
  assert.deepEqual(patch, { stage: 'building', notes: 'везём сталь' });
  assert.deepEqual(forbidden, ['priority']);
});

// ── Ввод ───────────────────────────────────────────────────────────────────

test('список систем: строки, запятые, табуляция из таблиц, повторы и лимит', () => {
  const parsed = parseSystemList('HIP 90297\n hip  90297 \nCol 285 Sector AB-C d14-2\tеще колонка\nSol; Achenar, Lave\n\n', {
    existing: ['Lave'],
    limit: 3,
  });
  assert.deepEqual(parsed.names, ['HIP 90297', 'Col 285 Sector AB-C d14-2', 'Sol']);
  assert.deepEqual(parsed.duplicates, ['hip 90297', 'Lave']);
  assert.deepEqual(parsed.overflow, ['Achenar']);
  assert.equal(systemKey('  HIP   90297 '), 'hip 90297');

  const long = parseSystemList(['x'.repeat(200), 'Ok']);
  assert.deepEqual(long.names, ['Ok']);
  assert.equal(long.invalid.length, 1);
  assert.equal(parseSystemList(Array.from({ length: 150 }, (_, i) => `S${i}`)).names.length, PROJECT_LIMITS.systems);
});

test('поля проекта: даты, цвет, статус; неверное не проходит молча', () => {
  assert.equal(parseDateOnly('2026-02-28'), '2026-02-28');
  assert.equal(parseDateOnly('2026-02-31'), undefined, 'несуществующая дата');
  assert.equal(parseDateOnly(''), null);
  assert.equal(normalizeColor('#3498DB'), '#3498db');
  assert.equal(normalizeColor('red'), null);

  const ok = sanitizeProjectPatch({ name: '  Кольцо  ', status: 'paused', color: '#2ECC71', targetDate: '2026-12-01', trackingSince: '2026-10-01' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.patch.name, 'Кольцо');
  assert.equal(ok.patch.status, 'paused');
  assert.equal(ok.patch.color, '#2ecc71');
  assert.equal(ok.patch.target_date, '2026-12-01');
  assert.equal(ok.patch.tracking_since, '2026-10-01T00:00:00.000Z');

  const bad = sanitizeProjectPatch({ name: '   ', status: 'deleted', color: 'blue', targetDate: '01.12.2026' });
  assert.equal(bad.errors.length, 4);

  assert.equal(validateNewProject({ name: '' }).error, 'Укажите название проекта');
  const created = validateNewProject({ name: 'Проект', systems: 'A\nB\nA', color: 'nope' });
  assert.deepEqual(created.value.systems.names, ['A', 'B']);
  assert.equal(created.value.color, '#e67e22', 'неверный цвет — цвет по умолчанию');
});

test('сводка прогресса для списка: только числа, разбор терпит мусор', () => {
  const snapshot = progressSnapshot({ progress: 42.5, systems: 3, systemsDone: 1, systemsBuilding: 1, sites: 5, sitesComplete: 2, doneTons: 1000, totalTons: 2400, remaining: 1400, needs: [{}] });
  assert.equal('needs' in snapshot, false);
  assert.deepEqual(parseProgressSnapshot(snapshot), snapshot);
  assert.equal(parseProgressSnapshot(null), null);
  assert.equal(parseProgressSnapshot({ progress: 'x' }).progress, null);
});

test('участники сортируются: создатель, модераторы, участники', () => {
  const sorted = sortMembers([
    { role: 'member', name: 'Б' }, { role: 'owner', name: 'Я' }, { role: 'moderator', name: 'В' }, { role: 'member', name: 'А' },
  ]);
  assert.deepEqual(sorted.map((member) => member.name), ['Я', 'В', 'А', 'Б']);
});

// ── Прогресс ───────────────────────────────────────────────────────────────

const SYSTEM = 'Projtest';
const ravenRow = (projects, updatedAt = '2026-10-10T00:00:00Z') => ({ system_name: SYSTEM, updated_at: updatedAt, data: { projects, architectName: 'CMDR Arch' } });
const ravenProject = (overrides = {}) => ({
  buildId: 'b1', marketId: '3900000001', buildName: 'Alpha Port', buildType: 'coriolis', complete: false, progress: 50,
  bodyName: `${SYSTEM} A`, resources: [{ name: 'Steel', key: 'steel', required: null, provided: null, remaining: 500, exact: false }],
  totalRequired: null, totalProvided: null, totalRemaining: 500, ...overrides,
});
const depot = (overrides = {}) => ({
  market_id: '3900000001', system_name: SYSTEM, construction_name: 'Orbital Construction Site: Alpha', construction_progress: 50,
  resources_total: [{ Name: '$steel_name;', Name_Localised: 'Steel', RequiredAmount: 1000, ProvidedAmount: 500 }],
  event_timestamp: '2026-10-09T00:00:00Z', ...overrides,
});

test('площадки: старый журнал уточняет Raven, свежий журнал побеждает, журнальные добавляются', () => {
  // Журнал старше Raven: «нужно» из журнала + остаток Raven = точные цифры.
  const enriched = mergeSites(ravenRow([ravenProject()]), [depot()]);
  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].source, 'both');
  assert.equal(enriched[0].required, 1000);
  assert.equal(enriched[0].provided, 500);
  assert.equal(enriched[0].progress, 50);
  assert.equal(enriched[0].commodities[0].label, 'Сталь');

  // Журнал новее Raven: берём его цифры, имя площадки — из Raven.
  const fresh = mergeSites(ravenRow([ravenProject()]), [depot({
    event_timestamp: '2026-10-11T00:00:00Z',
    resources_total: [{ Name: '$steel_name;', RequiredAmount: 1000, ProvidedAmount: 900 }],
  })]);
  assert.equal(fresh[0].name, 'Alpha Port');
  assert.equal(fresh[0].provided, 900);
  assert.equal(fresh[0].remaining, 100);
  assert.equal(fresh[0].key, 'b1', 'ключ площадки — buildId Raven, чтобы план мог сослаться на него');

  // Площадка, которой Raven не знает, приходит из журнала.
  const extra = mergeSites(ravenRow([ravenProject()]), [depot({ market_id: '3900000002', construction_name: '$EXT_PANEL_ColonisationShip; Beta Ship', construction_progress: 100 })]);
  assert.equal(extra.length, 2);
  const journalOnly = extra.find((site) => site.source === 'journal');
  assert.equal(journalOnly.key, 'm:3900000002');
  assert.equal(journalOnly.name, 'Beta Ship');
  assert.equal(journalOnly.complete, true);
  assert.equal(cleanDepotName('$EXT_PANEL_ColonisationShip; Beta Ship'), 'Beta Ship');

  assert.deepEqual(mergeSites(null, []), []);
  assert.equal(pickRavenRow([{ system_name: 'a', updated_at: '2026-01-01' }, { system_name: 'A', updated_at: '2026-02-01' }]).system_name, 'A');
});

test('прогресс системы без плана — по тоннажу площадок; все готовы — система готова', () => {
  const building = buildSystemProgress({
    systemId: 's1', systemName: SYSTEM, plan: null,
    raven: ravenRow([ravenProject({ totalRequired: 1000, totalProvided: 250, totalRemaining: 750 })]),
    depots: [],
  });
  assert.equal(building.basis, 'sites');
  assert.equal(building.status, 'building');
  assert.equal(building.progress, 25);
  assert.equal(building.needs[0].key, 'steel');
  assert.equal(building.architectName, 'CMDR Arch');

  const done = buildSystemProgress({
    systemId: 's1', systemName: SYSTEM, plan: null,
    raven: ravenRow([ravenProject({ complete: true, totalRequired: 1000, totalProvided: 1000, totalRemaining: 0 })]),
    depots: [],
  });
  assert.equal(done.status, 'done');
  assert.equal(done.progress, 100);
  assert.deepEqual(done.needs, [], 'у готовой площадки нечего везти');

  const empty = buildSystemProgress({ systemId: 's2', systemName: 'Nowhere', plan: null, raven: null, depots: [] });
  assert.equal(empty.status, 'unknown');
  assert.equal(empty.progress, null);
});

test('прогресс системы по плану: связь ravenBuildId, факт вместо каталога, не начатые площадки', () => {
  let plan = createPlan(SYSTEM, 'CMDR Arch');
  plan = addSite(plan, `${SYSTEM} A`, 'no_truss');
  plan = addSite(plan, `${SYSTEM} A 1`, 'picumnus');
  plan = linkSiteToRaven(plan, plan.sites[0].id, 'b1');

  const view = buildSystemProgress({
    systemId: 's1', systemName: SYSTEM,
    plan: { id: 'plan-1', title: 'План', site_count: 2, haul_tons: 999, plan },
    raven: ravenRow([
      ravenProject({ totalRequired: 1000, totalProvided: 500, totalRemaining: 500 }),
      ravenProject({ buildId: 'x9', marketId: '3900000009', buildName: 'Вне плана', buildType: 'outpost', bodyName: `${SYSTEM} B`, totalRequired: 200, totalProvided: 200, totalRemaining: 0, complete: true }),
    ]),
    depots: [],
  });
  assert.equal(view.basis, 'plan');
  assert.equal(view.status, 'building', 'вторая запись плана не начата');
  assert.equal(view.plan.matched, 1);
  const [linked, pending] = view.plan.sites;
  assert.equal(linked.siteKey, 'b1');
  assert.equal(linked.tons, 1000, 'у сопоставленной площадки — фактический тоннаж');
  assert.equal(pending.siteKey, null);
  assert.equal(pending.status, 'planned');
  assert.ok(pending.tons > 0, 'у не начатой — тоннаж каталога');
  assert.equal(view.totalTons, 1000 + pending.tons + 200, 'площадка вне плана добавлена своим тоннажем');
  assert.equal(view.doneTons, 500 + 200);
  assert.equal(view.sites.find((site) => site.key === 'b1').planSiteId, linked.siteId);

  const broken = buildSystemProgress({ systemId: 's1', systemName: SYSTEM, plan: { id: 'p', plan: { sites: 'не список' } }, raven: null, depots: [] });
  assert.ok(broken.plan.error, 'битый план не роняет расчёт');
  assert.equal(broken.status, 'planned');
});

test('прогресс проекта: тонны по всем системам, потребности складываются, кэш без учёта регистра', () => {
  const progress = buildProjectProgress(
    [{ id: 's1', name: 'Alpha', planId: null }, { id: 's2', name: 'Beta', planId: null }, { id: 's3', name: 'Gamma', planId: null }],
    {
      raven: [
        { system_key: 'alpha', system_name: 'ALPHA', updated_at: '2026-10-01T00:00:00Z', data: { projects: [ravenProject({ totalRequired: 1000, totalProvided: 0, totalRemaining: 1000 })] } },
        { system_key: 'alpha', system_name: 'Alpha', updated_at: '2026-10-05T00:00:00Z', data: { projects: [ravenProject({ totalRequired: 1000, totalProvided: 600, totalRemaining: 400, resources: [{ key: 'steel', name: 'Steel', remaining: 400, required: null, provided: null }] })] } },
      ],
      depots: [depot({ system_key: 'beta', system_name: 'beta', market_id: '3900000005', resources_total: [
        { Name: '$steel_name;', RequiredAmount: 300, ProvidedAmount: 100 },
        { Name: '$titanium_name;', RequiredAmount: 700, ProvidedAmount: 700 },
      ] })],
      plans: [],
    },
  );
  const [alpha, beta, gamma] = progress.systems;
  assert.equal(alpha.progress, 60, 'взят свежий вариант кэша');
  assert.equal(beta.progress, 80);
  assert.equal(gamma.status, 'unknown');
  assert.equal(progress.summary.totalTons, 2000);
  assert.equal(progress.summary.doneTons, 1400);
  assert.equal(progress.summary.progress, 70);
  assert.equal(progress.summary.systemsBuilding, 2);
  assert.equal(progress.summary.systemsUnknown, 1);
  assert.deepEqual(progress.summary.needs.map((need) => [need.key, need.remaining]), [['steel', 600]]);
  assert.equal(siteDirectory(progress).get('3900000001').systemName, 'Alpha');

  const queue = staleSystems([{ id: 's1', name: 'Alpha' }, { id: 's2', name: 'Beta' }, { id: 's3', name: 'Gamma' }], progress, Date.parse('2026-10-05T00:04:00Z'), 5 * 60_000);
  assert.deepEqual(queue.map((system) => system.id), ['s2', 's3'], 'свежий кэш Alpha не перезапрашивается');

  assert.equal(summarizeProject([]).progress, null);
});

// ── Лидеры ─────────────────────────────────────────────────────────────────

test('товар из любой строки учёта приводится к одному ключу', () => {
  assert.deepEqual(canonicalCommodity('Steel'), { key: 'steel', label: 'Сталь' });
  assert.deepEqual(canonicalCommodity('Сталь'), { key: 'steel', label: 'Сталь' });
  assert.deepEqual(canonicalCommodity('$steel_name;'), { key: 'steel', label: 'Сталь' });
  assert.equal(canonicalCommodity('Agri-Medicines').key, 'agriculturalmedicines');
  assert.equal(canonicalCommodity('H.E. Suits').key, 'hazardousenvironmentsuits');
  assert.equal(canonicalCommodity('Жидкий кислород').key, 'liquidoxygen');
  assert.equal(canonicalCommodity('Gold').key, 'gold');
  assert.equal(canonicalCommodity('Неведомый груз').key, 'x:неведомыйгруз');
  assert.equal(canonicalCommodity('').key, 'unknown');
  assert.equal(periodSince('all'), null);
  assert.equal(periodSince('7d', Date.parse('2026-10-17T00:00:00Z')), '2026-10-10T00:00:00.000Z');
});

const PILOTS = new Map([
  ['u1', { name: 'Alice', member: true, role: 'owner', hidden: false }],
  ['u2', { name: 'Bob', member: true, role: 'member', hidden: false }],
  ['u3', { name: 'Secret', member: false, role: null, hidden: true }],
  ['u4', { name: 'Guest', member: false, role: null, hidden: false }],
]);
const row = (user, market, commodity, tons, extra = {}) => ({
  user_id: user, target: 'site', system_name: 'Alpha', market_id: market, station_name: null, commodity, tons, ops: 1,
  first_at: '2026-10-01T00:00:00Z', last_at: '2026-10-02T00:00:00Z', ...extra,
});

test('лидеры: рейтинг по тоннам площадок, товары сведены, авианосцы отдельно', () => {
  const view = buildProjectLeaders({
    rows: [
      row('u1', '3900000001', 'Steel', 500),
      row('u1', '3900000001', 'Сталь', 300),
      row('u1', '3900000002', 'Titanium', 100),
      row('u2', '3900000001', 'steel', 1200),
      row('u3', '3900000002', 'Copper', 50),
      row('u4', null, 'Copper', 10, { system_name: 'Beta' }),
      { user_id: 'u1', target: 'carrier', system_name: null, market_id: '3700000001', station_name: 'X-1', commodity: 'titanium', tons: 5000, ops: 3 },
    ],
    pilots: PILOTS,
    sites: new Map([['3900000001', { name: 'Alpha Port', systemName: 'Alpha' }]]),
    carriers: new Map([['3700000001', 'Склад · ABC-123']]),
    viewerId: 'u2',
  });
  assert.deepEqual(view.pilots.map((pilot) => [pilot.name, pilot.siteTons]), [
    ['Bob', 1200], ['Alice', 900], ['Скрытый командир 1', 50], ['Guest', 10],
  ], 'тонны на авианосец не поднимают Alice над Bob');
  const alice = view.pilots[1];
  assert.equal(alice.carrierTons, 5000);
  assert.equal(alice.commodities[0].key, 'steel');
  assert.equal(alice.commodities[0].tons, 800, 'Steel и Сталь — один товар');
  assert.equal(view.pilots[0].isYou, true);
  assert.equal(view.pilots[2].key, 'hidden-1', 'скрытый пилот не выдаёт свой id');
  assert.equal(view.pilots[2].hidden, true);

  assert.equal(view.totals.siteTons, 2160);
  assert.equal(view.totals.carrierTons, 5000);
  assert.equal(view.totals.members, 2);
  assert.equal(view.totals.guests, 2);

  const steel = view.commodities.find((commodity) => commodity.key === 'steel');
  assert.equal(steel.tons, 2000);
  assert.deepEqual(steel.pilots.map((slice) => [slice.label, slice.tons]), [['Bob', 1200], ['Alice', 800]]);
  assert.equal(view.sites[0].name, 'Alpha Port', 'имя площадки из прогресса');
  assert.equal(view.sites.find((site) => site.key === 'sys:beta').name, 'Без площадки · Beta');
  assert.equal(view.carriers[0].name, 'Склад · ABC-123');
  assert.equal(view.matrix.pilots.length, 4);
  assert.equal(view.matrix.cells[0][0], 1200, 'Bob → Alpha Port');
  assert.ok(alice.breakdown.some((line) => line.siteName === 'Alpha Port' && line.commodity === 'steel' && line.tons === 800));
});

test('лидеры: зритель видит себя, участник не скрывается, фильтр «только участники»', () => {
  const asSecret = buildProjectLeaders({ rows: [row('u3', '1', 'Steel', 50)], pilots: PILOTS, viewerId: 'u3' });
  assert.equal(asSecret.pilots[0].name, 'Secret', 'сам пилот всегда видит своё имя');

  const hiddenMember = new Map(PILOTS);
  hiddenMember.set('u2', { name: 'Bob', member: true, role: 'member', hidden: true });
  const view = buildProjectLeaders({ rows: [row('u2', '1', 'Steel', 50)], pilots: hiddenMember, viewerId: 'u1' });
  assert.equal(view.pilots[0].name, 'Bob', 'участник проекта виден команде по имени');

  const members = buildProjectLeaders({
    rows: [row('u1', '1', 'Steel', 10), row('u3', '1', 'Steel', 999), row('u4', '1', 'Steel', 5)],
    pilots: PILOTS, scope: 'members', viewerId: 'u1',
  });
  assert.deepEqual(members.pilots.map((pilot) => pilot.name), ['Alice']);
  assert.equal(members.totals.siteTons, 10);
});

test('лента активности: пустые дни заполнены, лидеры отдельно, длинный период — по неделям', () => {
  const view = buildProjectLeaders({
    rows: [row('u1', '1', 'Steel', 100), row('u2', '1', 'Steel', 50)],
    activity: [
      { day: '2026-10-01', user_id: 'u1', target: 'site', tons: 60 },
      { day: '2026-10-03', user_id: 'u1', target: 'site', tons: 40 },
      { day: '2026-10-03', user_id: 'u2', target: 'site', tons: 50 },
      { day: '2026-10-03', user_id: 'u2', target: 'carrier', tons: 70 },
    ],
    pilots: PILOTS,
  });
  const { timeline } = view;
  assert.equal(timeline.bucket, 'day');
  assert.deepEqual(timeline.points.map((point) => point.day), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.equal(timeline.points[1].siteTons, 0);
  assert.equal(timeline.points[2].byPilot.u1, 40);
  assert.equal(timeline.points[2].carrierTons, 70);
  assert.equal(timeline.max, 160);
  assert.deepEqual(timeline.pilots.map((pilot) => [pilot.label, pilot.tons]), [['Alice', 100], ['Bob', 50]]);

  const weekly = buildProjectLeaders({
    rows: [row('u1', '1', 'Steel', 10)],
    activity: [
      { day: '2026-01-07', user_id: 'u1', target: 'site', tons: 5 },
      { day: '2026-06-03', user_id: 'u1', target: 'site', tons: 5 },
    ],
    pilots: PILOTS,
  });
  assert.equal(weekly.timeline.bucket, 'week');
  assert.equal(weekly.timeline.points[0].day, '2026-01-05', 'неделя начинается в понедельник');
});
