import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { INSTALLATIONS } from '../../src/lib/architect/catalogue';
import { distributeLoadingRecipes, loadingProgress, type LoadingPattern } from '../../src/lib/architect/loadingPatterns';

// Isolated real workspace + production stylesheet. No live pilot, database,
// tokens, Next dev server or external requests are needed for layout checks.
let javascript: string;
const css = readFileSync('src/app/globals.css', 'utf8');
const outpost = INSTALLATIONS.find(item => item.buildClass === 'outpost' && item.primary)!;
const pattern: LoadingPattern = {
  name: 'Три основных аванпоста', visibility: 'private',
  buildings: [{ installationId: outpost.id, count: 3, primary: true }],
  carriers: [
    { carrierId: '123', name: 'Личный авианосец Alpha', capacity: 25000, recipeLimit: 1 },
    { carrierId: '456', name: 'Эскадронный авианосец Beta', capacity: 60000, recipeLimit: 2 },
  ], allocations: {},
};
pattern.allocations = distributeLoadingRecipes(pattern.buildings, pattern.carriers);
const id = '11111111-2222-4333-8444-555555555555';
const view = { id, version: 1, canEdit: true, author: 'CommanderNameWithoutSpaces'.repeat(3), updatedAt: '2026-11-23T12:00:00Z', pattern, requirements: {}, total: 65505, unassigned: {} };
const detail = { ok: true, pattern: view, progress: loadingProgress(pattern, new Map()), checkedAt: view.updatedAt };

test.beforeAll(async () => {
  const stubs: Record<string, string> = {
    '@/lib/i18n/I18nContext': `import {translations} from '@/lib/i18n/translations'; export function useI18n(){return {locale:'ru',t:(key,params={})=>(translations.ru[key]??key).replace(/\\{(\\w+)\\}/g,(m,n)=>params[n]??m)};}`,
    '@/lib/supabaseClient': `export const authFetch=async(url)=>({ok:true,json:async()=>url.includes('?scope=')?{ok:true,patterns:${JSON.stringify([view, { ...view, id: 'other', pattern: { ...pattern, name: 'ОченьДлинноеНазваниеБезПробелов'.repeat(4).slice(0, 100) } }])}}:${JSON.stringify(detail)}});export const supabase={auth:{onAuthStateChange:(fn)=>{fn('INITIAL_SESSION',{user:{id:'owner'}});return {data:{subscription:{unsubscribe(){}}}}}}};`,
    'next/link': `import React from 'react';export default function Link({href,children,...props}){return React.createElement('a',{href,...props},children)}`,
  };
  const result = await build({
    stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import Workspace from './src/components/Architect/LoadingPatternsWorkspace.tsx';createRoot(document.getElementById('root')).render(React.createElement(Workspace));`, resolveDir: process.cwd(), sourcefile: 'loading-layout.tsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'loading-stubs', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => stubs[args.path] ? { path: args.path, namespace: 'stub' } : null);
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'tsx', resolveDir: process.cwd() }));
    } }],
  });
  javascript = result.outputFiles[0].text;
});

test('loading library and editor fit narrow screens; only the allocation matrix scrolls horizontally', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://loading.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      contentType: path === '/app.js' ? 'text/javascript' : path === '/app.css' ? 'text/css' : 'text/html',
      body: path === '/app.js' ? javascript : path === '/app.css' ? css : '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
    });
  });
  await page.goto(`https://loading.test/architect/loading?pattern=${id}`);
  await page.getByLabel('Группировка и порядок').selectOption('category');
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const sizes = await page.evaluate(() => {
      const library = document.querySelector('.lp-library')!;
      const matrix = document.querySelector('.lp-table-scroll')!;
      return { page: document.documentElement.scrollWidth, viewport: innerWidth, library: library.scrollWidth, libraryWidth: library.clientWidth, matrix: matrix.scrollWidth, matrixWidth: matrix.clientWidth };
    });
    expect(sizes.page, `page at ${width}px`).toBeLessThanOrEqual(sizes.viewport + 1);
    expect(sizes.library, `library at ${width}px`).toBeLessThanOrEqual(sizes.libraryWidth + 1);
    if (width <= 390) expect(sizes.matrix).toBeGreaterThan(sizes.matrixWidth);
  }
  // Actual CSS colors, not just alternating class names. Category headings
  // must not consume stripe parity; each carrier's list restarts at dark.
  const assertStripes = async () => {
    const lists = await page.evaluate(() => [
      Array.from(document.querySelectorAll('.lp-table .lp-good-row')),
      ...Array.from(document.querySelectorAll('.lp-progress-grid details')).map(
        card => Array.from(card.querySelectorAll('.lp-progress-item'))),
    ].map(rows => rows.map(row => getComputedStyle(row).backgroundColor)));
    for (const colors of lists) {
      expect(colors.length).toBeGreaterThan(1);
      colors.forEach((color, index) => expect(color).toBe(index % 2 ? 'rgb(41, 50, 62)' : 'rgb(21, 25, 31)'));
    }
  };
  await page.mouse.move(0, 0);
  await assertStripes();
  await page.getByLabel('Категория', { exact: true }).selectOption('Metals');
  await expect(page.locator('tbody .lp-good-name')).toHaveCount(4);
  await assertStripes();
  await expect(page.getByRole('button', { name: 'Обновить', exact: true }).last()).toBeEnabled();
  await page.getByLabel('Категория', { exact: true }).selectOption('');
  await page.getByLabel('Запас на каждую заполненную ячейку, т').fill('2');
  const positive = Object.values(pattern.allocations).reduce((n, rows) => n + Object.values(rows).filter(qty => qty > 0).length, 0);
  await page.getByRole('button', { name: 'Добавить +2 т к заполненным ячейкам', exact: true }).click();
  await expect(page.locator('.lp-cell-extra')).toHaveCount(positive);
  await expect(page.getByRole('status').first()).toContainText(`всего +${positive * 2} т`);
  const steelCells = page.locator('input[aria-label$=": Сталь"]');
  const assignedSteel = await steelCells.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value));
  expect(assignedSteel).toEqual(pattern.carriers.map(c => String(pattern.allocations[c.carrierId].steel + 2)));
  // Exactly fill the first carrier; another click must change neither carrier.
  const firstId = pattern.carriers[0].carrierId;
  const firstTarget = Object.values(pattern.allocations[firstId]).reduce((a,b)=>a+b,0) + Object.keys(pattern.allocations[firstId]).length * 2;
  await page.getByLabel('Выделено места', { exact: true }).first().fill(String(firstTarget));
  await page.getByRole('button', { name: 'Добавить +2 т к заполненным ячейкам', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('не хватает');
  expect(await steelCells.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value))).toEqual(assignedSteel);
  await page.setViewportSize({ width:320, height:1000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321);
  expect(errors).toEqual([]);
});
