#!/usr/bin/env node
/**
 * Сборка автономного движка карты системы для Colonial Helper.
 *
 * Источник — `src/lib/orrery3d` (тот же код, что и на сайте). Выход —
 * `uploader/assets/orrery-viewer.js`: один самодостаточный файл (three.js
 * внутри, react снаружи), который Python вкладывает в HTML-экспорт карты.
 *
 * Запуск:
 *   npm run viewer:build     собрать и записать файл
 *   npm run viewer:check     проверить, что файл в репозитории свежий
 *
 * Сборка лежит в репозитории намеренно: EXE для Windows собирается на раннере
 * без Node, а Python обязан уметь отдать карту сразу после установки.
 */

import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'src', 'lib', 'orrery3d', 'auto.ts');
const TARGET = join(ROOT, 'uploader', 'assets', 'orrery-viewer.js');
const BANNER = '/* ED Ring Colony — 3D-карта системы (three.js). Собрано из src/lib/orrery3d, не редактировать вручную: npm run viewer:build */';

// Версия контракта: Python сверяет её со своей, чтобы не отдать страницу со
// старым рендерером и новым пакетом (или наоборот).
const CONTRACT_VERSION = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8'),
).orreryViewerContract ?? 3;

export async function bundleViewer({ minify = true } = {}) {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'iife',
    globalName: 'Orrery3D',
    platform: 'browser',
    target: ['chrome90', 'firefox90', 'safari15'],
    outfile: TARGET,
    write: false,
    minify,
    legalComments: 'none',
    banner: { js: `${BANNER}\n/* contract=${CONTRACT_VERSION} */` },
    alias: { '@': join(ROOT, 'src') },
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    logLevel: 'silent',
  });
  const output = result.outputFiles?.[0]?.text ?? '';
  return output;
}

async function main() {
  const check = process.argv.includes('--check');
  const minify = !process.argv.includes('--no-minify');
  const code = await bundleViewer({ minify });
  const header = `${BANNER.replace(/\/\*|\*\//g, '').trim()}\n`;
  if (check) {
    let current = '';
    try {
      current = readFileSync(TARGET, 'utf8');
    } catch {
      console.error(`Нет сборки ${TARGET}. Запустите npm run viewer:build.`);
      process.exit(1);
    }
    if (current !== code) {
      console.error('Сборка uploader/assets/orrery-viewer.js устарела: запустите npm run viewer:build и закоммитьте файл.');
      process.exit(1);
    }
    console.log(`Сборка актуальна: ${(code.length / 1024).toFixed(0)} КиБ, контракт v${CONTRACT_VERSION}.`);
    return;
  }
  mkdirSync(dirname(TARGET), { recursive: true });
  writeFileSync(TARGET, code, 'utf8');
  console.log(`Собрано: uploader/assets/orrery-viewer.js — ${(code.length / 1024).toFixed(0)} КиБ (${header.trim()}), контракт v${CONTRACT_VERSION}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
