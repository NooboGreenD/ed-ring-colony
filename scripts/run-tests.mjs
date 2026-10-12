#!/usr/bin/env node
/**
 * Запуск набора тестов.
 *
 * Зачем отдельный раннер, а не просто `node --test`:
 *
 *   1. `node --test` по умолчанию берёт `availableParallelism() - 1` файлов
 *      одновременно, то есть на двухъядерной машине (обычный CI-раннер и
 *      docker build) набор шёл строго последовательно. Здесь число воркеров
 *      задаётся явно и не опускается ниже четырёх — на том же железе полный
 *      прогон стал примерно вдвое быстрее.
 *   2. Есть быстрый контур `--quick`: он пропускает тяжёлые файлы (jsdom-рендеры
 *      компонентов и shell-интеграции с docker/git) и проходит за секунды,
 *      поэтому его удобно гонять на каждой правке, а полный набор — перед
 *      коммитом и в образе.
 *   3. Тяжёлые файлы определяются по их собственному содержимому (импорт jsdom
 *      или запуск внешних процессов), а не по списку, который протухнет.
 *
 * Использование:
 *   node scripts/run-tests.mjs                  # весь набор
 *   node scripts/run-tests.mjs --quick          # без тяжёлых файлов
 *   node scripts/run-tests.mjs --list           # показать файлы и их класс
 *   node scripts/run-tests.mjs atlas ring       # только файлы, где есть «atlas» или «ring»
 *   node scripts/run-tests.mjs -- --test-name-pattern="кольцо"   # аргументы node --test
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TESTS_DIR = join(ROOT, 'scripts', 'tests');

/** Признаки тяжёлого файла: свой браузерный стенд или внешние процессы. */
const HEAVY_PATTERNS = [
  /from\s+'jsdom'/,
  /import\('jsdom'\)/,
  /from\s+'node:child_process'/,
  /require\('node:child_process'\)/,
];

function isHeavy(file) {
  const source = readFileSync(join(TESTS_DIR, file), 'utf8');
  return HEAVY_PATTERNS.some((pattern) => pattern.test(source));
}

function collectFiles() {
  return readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => ({ name, heavy: isHeavy(name) }));
}

const args = process.argv.slice(2);
const passthroughAt = args.indexOf('--');
const passthrough = passthroughAt >= 0 ? args.slice(passthroughAt + 1) : [];
const flags = (passthroughAt >= 0 ? args.slice(0, passthroughAt) : args)
  .filter((argument) => argument.startsWith('--'));
const filters = (passthroughAt >= 0 ? args.slice(0, passthroughAt) : args)
  .filter((argument) => !argument.startsWith('--'))
  .map((argument) => argument.toLowerCase());

const quick = flags.includes('--quick');
const list = flags.includes('--list');

let files = collectFiles();
if (filters.length > 0) {
  files = files.filter((file) => filters.some((filter) => file.name.toLowerCase().includes(filter)));
}
const skippedHeavy = quick ? files.filter((file) => file.heavy).length : 0;
if (quick) files = files.filter((file) => !file.heavy);

if (files.length === 0) {
  console.error('Под фильтр не подошёл ни один тестовый файл.');
  process.exit(1);
}

if (list) {
  for (const file of files) {
    console.log(`${file.heavy ? 'heavy' : 'fast '}  scripts/tests/${file.name}`);
  }
  console.log(`\nФайлов: ${files.length}${quick ? ` (тяжёлых пропущено: ${skippedHeavy})` : ''}`);
  process.exit(0);
}

const concurrency = Number(process.env.TEST_CONCURRENCY)
  || Math.max(4, availableParallelism());

console.log(
  `[tests] файлов: ${files.length}, воркеров: ${concurrency}`
  + (quick ? `, тяжёлых пропущено: ${skippedHeavy} (npm run test — полный набор)` : ''),
);

const result = spawnSync(
  process.execPath,
  [
    '--test',
    `--test-concurrency=${concurrency}`,
    ...passthrough,
    ...files.map((file) => join('scripts', 'tests', file.name)),
  ],
  { cwd: ROOT, stdio: 'inherit' },
);

process.exit(result.status ?? 1);
