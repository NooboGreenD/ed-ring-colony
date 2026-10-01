import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DUMP_BASE_URL,
  DUMP_LADDER,
  DUMP_VARIANTS,
  archiveFileNameForVariant,
  dumpBaseUrl,
  dumpVariantUrl,
  formatGap,
  isDumpVariant,
  planDumpDownload,
  variantCoversGap,
  variantFromUrl,
  widerVariant,
} from '../../src/lib/galaxyDumpVariants.ts';
import { galaxyArchivePathForVariant } from '../../src/lib/galaxyImport.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-01T00:00:00Z');

// ───────────────────────── the ladder itself ─────────────────────────

test('каждый вариант указывает на реальный файл дампов Spansh', () => {
  assert.deepEqual(DUMP_LADDER, ['1day', '1week', '2weeks', '1month', '6months', 'full']);
  assert.equal(DUMP_VARIANTS.full.file, 'systems.json.gz');
  assert.equal(DUMP_VARIANTS['1day'].file, 'systems_1day.json.gz');
  assert.equal(DUMP_VARIANTS['1week'].file, 'systems_1week.json.gz');
  assert.equal(DUMP_VARIANTS['2weeks'].file, 'systems_2weeks.json.gz');
  assert.equal(DUMP_VARIANTS['1month'].file, 'systems_1month.json.gz');
  assert.equal(DUMP_VARIANTS['6months'].file, 'systems_6months.json.gz');
  // Полный дамп — единственный без окна покрытия.
  assert.equal(DUMP_VARIANTS.full.coversMs, null);
  for (const variant of DUMP_LADDER.filter((v) => v !== 'full')) {
    assert.ok(DUMP_VARIANTS[variant].coversMs > 0, `${variant} должен покрывать окно`);
  }
  // Лестница отсортирована и по окну, и по размеру — иначе выбор «самого
  // дешёвого подходящего» перестал бы быть самым дешёвым.
  const deltas = DUMP_LADDER.filter((v) => v !== 'full');
  for (let i = 1; i < deltas.length; i++) {
    assert.ok(DUMP_VARIANTS[deltas[i]].coversMs > DUMP_VARIANTS[deltas[i - 1]].coversMs);
    assert.ok(DUMP_VARIANTS[deltas[i]].approxBytes > DUMP_VARIANTS[deltas[i - 1]].approxBytes);
  }
  assert.ok(DUMP_VARIANTS.full.approxBytes > 5 * 1024 ** 3);
});

test('isDumpVariant отсеивает мусор из тела запроса', () => {
  assert.ok(isDumpVariant('1day'));
  assert.ok(isDumpVariant('full'));
  assert.ok(!isDumpVariant('auto'));
  assert.ok(!isDumpVariant('../../etc/passwd'));
  assert.ok(!isDumpVariant(null));
});

// ───────────────────────── URL и зеркала ─────────────────────────

test('dumpVariantUrl по умолчанию ведёт на downloads.spansh.co.uk', () => {
  assert.equal(dumpVariantUrl('full', {}), `${DEFAULT_DUMP_BASE_URL}systems.json.gz`);
  assert.equal(dumpVariantUrl('1day', {}), `${DEFAULT_DUMP_BASE_URL}systems_1day.json.gz`);
});

test('GALAXY_DUMP_BASE_URL переносит на зеркало всю лестницу', () => {
  const env = { GALAXY_DUMP_BASE_URL: 'https://mirror.example.org/spansh' };
  assert.equal(dumpBaseUrl(env), 'https://mirror.example.org/spansh/');
  assert.equal(dumpVariantUrl('1week', env), 'https://mirror.example.org/spansh/systems_1week.json.gz');
});

test('GALAXY_IMPORT_URL задаёт полный дамп и подсказывает каталог для дельт', () => {
  const env = { GALAXY_IMPORT_URL: 'https://mirror.example.org/dumps/systems.json.gz' };
  assert.equal(dumpVariantUrl('full', env), 'https://mirror.example.org/dumps/systems.json.gz');
  // Дельты лежат рядом с полным дампом — зеркало получает их бесплатно.
  assert.equal(dumpVariantUrl('1day', env), 'https://mirror.example.org/dumps/systems_1day.json.gz');

  // Зеркало с нестандартным именем файла не навязывает каталог дельтам.
  const custom = { GALAXY_IMPORT_URL: 'https://mirror.example.org/private/nightly.gz' };
  assert.equal(dumpVariantUrl('full', custom), 'https://mirror.example.org/private/nightly.gz');
  assert.equal(dumpVariantUrl('1day', custom), `${DEFAULT_DUMP_BASE_URL}systems_1day.json.gz`);
});

test('variantFromUrl узнаёт файл по имени', () => {
  assert.equal(variantFromUrl('https://downloads.spansh.co.uk/systems.json.gz'), 'full');
  assert.equal(variantFromUrl('https://downloads.spansh.co.uk/systems_1month.json.gz'), '1month');
  assert.equal(variantFromUrl('/app/data/spansh/systems_1day.json.gz'), '1day');
  assert.equal(variantFromUrl('https://downloads.spansh.co.uk/galaxy.json.gz'), null);
  assert.equal(variantFromUrl(null), null);
});

test('каждый вариант хранится в своём файле: дельта не затирает полный архив', () => {
  const env = { GALAXY_ARCHIVE_DIR: '/data/spansh' };
  assert.equal(archiveFileNameForVariant('full'), 'systems.json.gz');
  assert.equal(archiveFileNameForVariant('1day'), 'systems_1day.json.gz');
  assert.equal(galaxyArchivePathForVariant('full', env), '/data/spansh/systems.json.gz');
  assert.equal(galaxyArchivePathForVariant('1day', env), '/data/spansh/systems_1day.json.gz');
  assert.notEqual(galaxyArchivePathForVariant('full', env), galaxyArchivePathForVariant('1day', env));
});

// ───────────────────────── выбор дампа ─────────────────────────

test('пустой каталог требует полного дампа', () => {
  const plan = planDumpDownload({ catalogComplete: false, dataAsOf: null, now: NOW });
  assert.equal(plan.variant, 'full');
  assert.match(plan.reason, /полный дамп/);
});

test('известный, но свежий каталог обновляется суточной дельтой (4 МиБ вместо 5.9 ГиБ)', () => {
  const plan = planDumpDownload({
    catalogComplete: true,
    dataAsOf: new Date(NOW - 6 * HOUR).toISOString(),
    now: NOW,
  });
  assert.equal(plan.variant, '1day');
  assert.ok(plan.gapMs >= 6 * HOUR);
  assert.ok(plan.info.approxBytes < 10 * 1024 * 1024);
});

test('чем дольше простой, тем шире дельта — и только полгода возвращают полный дамп', () => {
  const pick = (gapMs) =>
    planDumpDownload({ catalogComplete: true, dataAsOf: new Date(NOW - gapMs).toISOString(), now: NOW }).variant;

  assert.equal(pick(1 * HOUR), '1day');
  // 20 ч + 12 ч запаса уже не влезают в суточный файл.
  assert.equal(pick(20 * HOUR), '1week');
  assert.equal(pick(5 * DAY), '1week');
  assert.equal(pick(10 * DAY), '2weeks');
  assert.equal(pick(20 * DAY), '1month');
  assert.equal(pick(60 * DAY), '6months');
  assert.equal(pick(200 * DAY), 'full');
});

test('без времени генерации дампа отставание считается консервативно', () => {
  // Каталог импортирован 2 часа назад, но дамп мог быть сгенерирован за сутки
  // до этого: 2 ч + 24 ч лага + 12 ч запаса > суток, значит недельная дельта.
  const plan = planDumpDownload({
    catalogComplete: true,
    dataAsOf: null,
    importedAt: new Date(NOW - 2 * HOUR).toISOString(),
    now: NOW,
  });
  assert.equal(plan.variant, '1week');
});

test('совсем без отметок берётся полный дамп один раз', () => {
  const plan = planDumpDownload({ catalogComplete: true, dataAsOf: null, importedAt: null, now: NOW });
  assert.equal(plan.variant, 'full');
  assert.match(plan.reason, /неизвестно/);
});

test('minVariant не даёт опуститься ниже заданного файла', () => {
  const plan = planDumpDownload({
    catalogComplete: true,
    dataAsOf: new Date(NOW - 1 * HOUR).toISOString(),
    now: NOW,
    minVariant: '1month',
  });
  assert.equal(plan.variant, '1month');
});

test('widerVariant поднимается по лестнице до полного дампа', () => {
  assert.equal(widerVariant('1day'), '1week');
  assert.equal(widerVariant('1month'), '6months');
  assert.equal(widerVariant('6months'), 'full');
  assert.equal(widerVariant('full'), 'full');
});

// ───────────────────── проверка покрытия после скачивания ─────────────────────

test('variantCoversGap ловит дыру между дельтой и каталогом', () => {
  const generated = new Date(NOW).toISOString();

  // Суточный дамп, сгенерированный сейчас, покрывает каталог 6-часовой давности.
  const ok = variantCoversGap('1day', generated, new Date(NOW - 6 * HOUR).toISOString());
  assert.ok(ok.ok);

  // …но не каталог трёхдневной давности: между ними дыра.
  const hole = variantCoversGap('1day', generated, new Date(NOW - 3 * DAY).toISOString());
  assert.ok(!hole.ok);
  assert.match(hole.reason, /дыра/);

  // Полный дамп покрывает всё, неизвестные отметки проверку пропускают.
  assert.ok(variantCoversGap('full', generated, new Date(NOW - 10 * DAY).toISOString()).ok);
  assert.ok(variantCoversGap('1day', null, new Date(NOW - 10 * DAY).toISOString()).ok);
});

test('formatGap говорит по-русски и в правильных единицах', () => {
  assert.equal(formatGap(0), '0 ч');
  assert.equal(formatGap(5 * HOUR), '5.0 ч');
  assert.equal(formatGap(10 * DAY), '10 дн');
  assert.match(formatGap(120 * DAY), /мес$/);
});
