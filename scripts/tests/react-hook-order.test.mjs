import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Порядок хуков в клиентских компонентах.
 *
 * Причина теста реальная: страница `/system/[name]` упала в проде с
 * «Application error: a client-side exception has occurred», потому что четыре
 * `useMemo` стояли ПОСЛЕ `if (loading) return …`. На первом рендере React
 * насчитал 5 хуков, после загрузки данных — 9, и выкинул
 * "Rendered more hooks than during the previous render". ни `tsc`, ни сборка, ni
 * SSR-рендер (он проходит ровно один раз) этого не видят, поэтому проверка
 * статическая — по исходнику.
 *
 * Правила сознательно узкие, чтобы не ругаться на нормальный код:
 *  - смотрим только `export default function <Component>()` файла с `'use client'`;
 *  - только тело этого компонента на его верхнем уровне (глубина скобок 1) —
 *    хуки внутри `useEffect(() => …)`, `.map()` и вложенных функций не считаются;
 *  - «ранний возврат» — это `if (...)`, внутри блока которого есть `return`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK_CALL = /(?:^|[^.\w$])(use(?:State|Effect|LayoutEffect|Memo|Callback|Ref|SyncExternalStore|Context|Reducer|Id|Transition|DeferredValue|ImperativeHandle))\s*\(/g;
const IF_LINE = /^if\s*\(/;

function sourceFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
  if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

function lineHasHook(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
  HOOK_CALL.lastIndex = 0;
  return HOOK_CALL.test(trimmed);
}

/** Индекс строки, закрывающей блок `{`, открытый на строке `start`. */
function blockEnd(lines, start) {
  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    depth += (lines[index].match(/\{/g) ?? []).length - (lines[index].match(/\}/g) ?? []).length;
    if (depth <= 0) return index;
  }
  return lines.length - 1;
}

export function analyzeSource(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (!/'use client'/.test(lines.slice(0, 4).join('\n'))) return null;
  const start = lines.findIndex((line) => /^export default function [A-Z]\w*\(/.test(line));
  if (start < 0) return null;

  // Глубина 1 = верхний уровень тела компонента: хуки внутри useEffect(() => …),
  // .map() и прочих вложенных функций не считаются.
  let depth = 0;
  let earlyReturnLine = null;
  const offenders = [];

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    const depthBefore = depth;

    if (index > start && depthBefore === 1 && trimmed && !trimmed.startsWith('//')) {
      if (earlyReturnLine === null && IF_LINE.test(trimmed)) {
        const block = lines.slice(index, blockEnd(lines, index) + 1).join('\n');
        if (/^\s*return\b/m.test(block)) earlyReturnLine = index + 1;
      } else if (earlyReturnLine !== null && lineHasHook(line)) {
        offenders.push({ line: index + 1, text: trimmed.slice(0, 72) });
      }
    }

    depth += opens - closes;
    if (index > start && depth <= 0) break;
  }

  return { earlyReturnLine, offenders };
}

test("клиентские страницы вызывают все хуки до ранних return", () => {
  const problems = [];
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const result = analyzeSource(file);
    if (result && result.offenders.length > 0) {
      problems.push(
        `${path.relative(ROOT, file)} (early return на строке ${result.earlyReturnLine}): `
        + result.offenders.map((offender) => `${offender.line} → ${offender.text}`).join(' | '),
      );
    }
  }
  assert.deepEqual(problems, [], `хуки после early return ломают порядок хуков React:\n${problems.join('\n')}`);
});

test('детектор ловит нарушение (самопроверка на фикстуре)', (t) => {
  // Без этого теста проверка умела бы «зеленеть» из-за опечатки в регулярке.
  const fixture = path.join(ROOT, 'scripts/tests/fixtures/HookOrderFixture.client.tsx');
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  fs.writeFileSync(fixture, `'use client';
import { useState, useMemo } from 'react';

export default function BrokenPage() {
  const [loading] = useState(true);
  const [value] = useState(1);
  if (loading) {
    return null;
  }
  const derived = useMemo(() => value * 2, [value]);
  return <div>{derived}</div>;
}
`, 'utf8');
  t.after(() => fs.rmSync(fixture, { force: true }));

  const result = analyzeSource(fixture);
  assert.ok(result, 'фикстура не распознана как клиентский компонент');
  assert.equal(result.earlyReturnLine, 7);
  assert.equal(result.offenders.length, 1, JSON.stringify(result.offenders));
  assert.equal(result.offenders[0].line, 10);
});

test('обычный ранний возврат без хуков после него — не нарушение', (t) => {
  const fixture = path.join(ROOT, 'scripts/tests/fixtures/HookOrderOk.client.tsx');
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  fs.writeFileSync(fixture, `'use client';
import { useState, useEffect } from 'react';

export default function OkPage() {
  const [loading] = useState(true);
  const [data, setData] = useState(null);
  useEffect(() => { setData(1); }, []);
  if (loading) {
    return null;
  }
  return <div>{data}</div>;
}
`, 'utf8');
  t.after(() => fs.rmSync(fixture, { force: true }));

  const result = analyzeSource(fixture);
  assert.ok(result);
  assert.deepEqual(result.offenders, []);
});
