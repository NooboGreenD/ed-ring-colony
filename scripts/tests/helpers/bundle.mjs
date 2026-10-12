/**
 * Общий кэш сборок esbuild для тестов.
 *
 * Половина набора тестов собирает TS/TSX компоненты esbuild'ом перед проверкой,
 * и каждый вызов заново пакует React, three и половину `src`: на полном прогоне
 * это десятки секунд чистой перекомпиляции одного и того же кода. Сборка здесь
 * кладётся в `.cache/test-bundles` под именем от содержимого входа и опций, а
 * повторное использование проверяется по размеру и mtime каждого файла, который
 * esbuild в неё втянул (список берётся из metafile), — изменился любой исходник,
 * заглушка или опция, сборка пересобирается.
 *
 * Заглушки (`next/link`, `next/server`, …) пишутся по стабильным путям, иначе
 * ключ кэша менялся бы на каждом прогоне из-за нового временного каталога.
 */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Корень репозитория: helpers/ → tests/ → scripts/ → корень. */
export const TEST_ROOT = resolve(HERE, '..', '..', '..');
const CACHE_DIR = join(TEST_ROOT, '.cache', 'test-bundles');
const STUB_DIR = join(CACHE_DIR, 'stubs');

/** Счётчик для отладки: сколько сборок реально выполнено, а не взято из кэша. */
export const bundleStats = { built: 0, cached: 0 };

function hash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function toAbsolute(path) {
  return isAbsolute(path) ? path : join(TEST_ROOT, path);
}

/** Заглушка модуля по стабильному пути: имя файла зависит только от содержимого. */
function stubPath(specifier, source, extension = '.mjs') {
  mkdirSync(STUB_DIR, { recursive: true });
  const safe = specifier.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'stub';
  const file = join(STUB_DIR, `${safe}-${hash(source)}${extension}`);
  if (!existsSync(file) || readFileSync(file, 'utf8') !== source) writeFileSync(file, source);
  return file;
}

/** Все файлы сборки всё ещё на месте и не менялись — кэш пригоден. */
function inputsUnchanged(inputs) {
  for (const [file, stamp] of Object.entries(inputs)) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      return false;
    }
    if (stat.size !== stamp.size || Math.round(stat.mtimeMs) !== stamp.mtimeMs) return false;
  }
  return true;
}

function readInputs(metaFile) {
  try {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    return meta && typeof meta.inputs === 'object' && meta.inputs ? meta.inputs : null;
  } catch {
    return null;
  }
}

/**
 * Собрать модуль (и вернуть путь к файлу сборки).
 *
 * @param {object} options
 * @param {string} options.entry  файл-вход относительно корня репозитория;
 * @param {string} [options.entrySource]  вместо файла — исходник входа (пишется в кэш);
 * @param {Record<string,string>} [options.stubs]  подменяемые модули: спецификатор → исходник;
 * @param {Record<string,string>} [options.alias]  дополнительные алиасы esbuild;
 * @param {string[]} [options.external]  не паковать эти модули;
 * @param {object} [options.define]  подстановка констант esbuild;
 */
export async function bundleFile(options) {
  const {
    entry,
    entrySource,
    stubs = {},
    alias = {},
    external = [],
    define,
    jsx = 'automatic',
    format = 'esm',
    platform = 'node',
    loader = { '.tsx': 'tsx', '.ts': 'ts', '.mjs': 'js' },
    tsconfig,
  } = options;

  mkdirSync(CACHE_DIR, { recursive: true });

  const stubAliases = {};
  for (const [specifier, source] of Object.entries(stubs)) {
    const extension = specifier.endsWith('.tsx') || source.includes('<') ? '.tsx' : '.ts';
    stubAliases[specifier] = stubPath(specifier, source, extension);
  }

  let entryPoint;
  if (entrySource != null) {
    const file = join(CACHE_DIR, `entry-${hash(entrySource)}.tsx`);
    if (!existsSync(file) || readFileSync(file, 'utf8') !== entrySource) writeFileSync(file, entrySource);
    entryPoint = file;
  } else if (entry) {
    entryPoint = toAbsolute(entry);
  } else {
    throw new Error('bundleFile: нужен entry или entrySource');
  }

  const resolvedAlias = { '@': join(TEST_ROOT, 'src'), ...stubAliases, ...alias };
  const key = hash(JSON.stringify({
    entryPoint,
    alias: Object.entries(resolvedAlias).sort(),
    external: [...external].sort(),
    define: define || null,
    jsx,
    format,
    platform,
    loader,
    tsconfig: tsconfig || null,
  }));

  const outfile = join(CACHE_DIR, `${key}.mjs`);
  const metaFile = join(CACHE_DIR, `${key}.json`);

  const cachedInputs = readInputs(metaFile);
  if (existsSync(outfile) && cachedInputs && inputsUnchanged(cachedInputs)) {
    bundleStats.cached++;
    return outfile;
  }

  const tempFile = `${outfile}.${process.pid}.tmp`;
  const result = await build({
    absWorkingDir: TEST_ROOT,
    entryPoints: [entryPoint],
    outfile: tempFile,
    bundle: true,
    format,
    platform,
    jsx,
    external,
    define,
    alias: resolvedAlias,
    loader,
    tsconfig,
    metafile: true,
    logLevel: 'silent',
  });

  // Кэш пишется через временный файл и переименование: параллельные процессы
  // тестов не подхватят чужую недописанную сборку.
  renameSync(tempFile, outfile);
  const inputs = {};
  for (const relative of Object.keys(result.metafile?.inputs || {})) {
    const file = resolve(TEST_ROOT, relative);
    try {
      const stat = statSync(file);
      inputs[file] = { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
    } catch {
      // Файл пропал между сборкой и снимком — кэш просто не будет использован.
    }
  }
  writeFileSync(metaFile, JSON.stringify({ inputs }));
  bundleStats.built++;
  return outfile;
}

/** Собрать и импортировать модуль: то же, что `await import(await bundleFile(...))`. */
export async function importBundle(options) {
  const file = await bundleFile(options);
  return import(file);
}
