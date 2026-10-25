import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BINDING = { linked: true, tokenActive: true, platform: 'epic', status: 'missing',
  lastError: 'CAPI не подтвердил доступ к Elite Dangerous. Авторизация сохранена.' };

async function renderCapi({ binding = BINDING, query = '', api } = {}) {
  const dir = mkdtempSync(join(ROOT, '.tmp-capi-page-'));
  writeFileSync(join(dir, 'auth.mjs'), 'export const authFetch = (url, init) => globalThis.fetch(url, init);');
  const bundle = join(dir, 'page.mjs');
  await build({
    entryPoints: [join(ROOT, 'src/app/account/capi/page.tsx')], outfile: bundle,
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client'],
    alias: { '@/lib/supabaseClient': join(dir, 'auth.mjs'), '@': join(ROOT, 'src') },
    logLevel: 'silent',
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: `https://colony.test/account/capi${query}`, pretendToBeVisual: true,
  });
  // Keep status-polling tests deterministic and fast while retaining async turns.
  dom.window.setTimeout = (callback, _delay, ...args) => globalThis.setTimeout(callback, 0, ...args);
  const previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'Element', 'Node',
    'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'navigator']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key],
      configurable: true, writable: true });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET' });
    const custom = api?.(String(url), init);
    const body = custom?.body ?? { profile: null, binding: typeof binding === 'function' ? binding() : binding };
    return new Response(JSON.stringify(body), { status: custom?.status ?? 200 });
  };
  const { default: Page } = await import(bundle);
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => { root.render(React.createElement(Page)); });
  return {
    dom, calls,
    text: () => dom.window.document.body.textContent,
    click: async (element) => {
      await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    },
    cleanup: async () => {
      await act(async () => { root.unmount(); });
      dom.window.close();
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('EGS OAuth + отказ CAPI: страница показывает ожидание данных, не повторный вход', async () => {
  const ui = await renderCapi({ query: '?status=partial&reason=entitlement_unavailable&platform=epic' });
  try {
    assert.match(ui.text(), /Авторизация сохранена/);
    assert.doesNotMatch(ui.text(), /Требуется повторная авторизация|Переподключить|нужно нажать кнопку Steam\/Epic/);
    assert.ok(ui.dom.window.document.querySelector('.capi-status-pending'));
    assert.equal(ui.dom.window.document.querySelector('.capi-status-broken'), null);
    assert.ok([...ui.dom.window.document.querySelectorAll('button')].some((b) => b.textContent.includes('Синхронизировать')));
  } finally {
    await ui.cleanup();
  }
});

test('список audience после колбэка сохраняет «Авто», не выбирает Frontier', async () => {
  const ui = await renderCapi({ query: '?platform=frontier%2Csteam%2Cepic',
    binding: { ...BINDING, tokenActive: false } });
  try {
    assert.equal(ui.dom.window.document.querySelector('.capi-platform-active').textContent, 'Определить автоматически');
    assert.equal(ui.dom.window.document.querySelector('a[href^="/api/capi/auth"]').getAttribute('href'), '/api/capi/auth?platform=auto');
  } finally {
    await ui.cleanup();
  }
});

test('ошибка CAPI у Frontier identity не запускает цикл повторного OAuth для EGS', async () => {
  const ui = await renderCapi({ binding: {
    ...BINDING,
    platform: 'frontier',
    lastError: 'CAPI Frontier не подтвердил доступ к Elite Dangerous. Frontier подтвердил платформу «frontier».',
  } });
  try {
    assert.match(ui.text(), /не доказывает, что вы вошли не через Epic/);
    assert.match(ui.text(), /Инцидент Frontier #21258/);
    assert.equal(ui.dom.window.document.querySelector('a[href="/api/capi/auth?platform=epic"]'), null, 'do not send this user through another OAuth loop');
    assert.equal(ui.dom.window.document.querySelector('a[href="/api/capi/auth?platform=steam"]'), null);
    assert.ok(ui.dom.window.document.querySelector('a[href="https://issues.frontierstore.net/issue-detail/21258"]'));
    assert.ok(ui.dom.window.document.querySelector('button.danger-btn'), 'отвязка не выполняется автоматически');
  } finally {
    await ui.cleanup();
  }
});

test('старый false is_active от ложного platform mismatch не запускает повторный OAuth', async () => {
  const ui = await renderCapi({ binding: {
    ...BINDING,
    platform: 'frontier',
    tokenActive: false,
    lastError: 'CAPI Frontier не подтвердил доступ к Elite Dangerous. Запрошена платформа: epic. Frontier выдал токен платформы «frontier». Выйдите из аккаунта на auth.frontierstore.net.',
  } });
  try {
    assert.doesNotMatch(ui.text(), /Требуется повторная авторизация|Переподключить/);
    assert.match(ui.text(), /Инцидент Frontier #21258/);
    assert.ok([...ui.dom.window.document.querySelectorAll('button')].some((button) => button.textContent.includes('Синхронизировать')));
  } finally {
    await ui.cleanup();
  }
});

test('ошибка шлюза ручной синхронизации показывает HTTP статус вместо общего сообщения', async () => {
  const ui = await renderCapi({ api: (url, init) => {
    if (url === '/api/capi/sync' && init?.method === 'POST') return { status: 504, body: {} };
  } });
  try {
    const button = [...ui.dom.window.document.querySelectorAll('button')]
      .find((item) => item.textContent.includes('Синхронизировать'));
    await ui.click(button);
    assert.match(ui.text(), /Не удалось поставить синхронизацию в очередь \(HTTP 504/);
  } finally {
    await ui.cleanup();
  }
});

test('страница после OAuth автоматически возобновляет активную очередь и показывает результат', async () => {
  const ui = await renderCapi({ query: '?status=partial&reason=sync_queued', api: (url, init) => {
    if (url === '/api/capi/sync' && !init?.method) {
      return { body: { job: { id: 'initial-job', status: 'running', stage: 'profile_request', attempts: 1 } } };
    }
    if (url === '/api/capi/sync/initial-job') {
      return { body: { job: {
        id: 'initial-job', status: 'succeeded', stage: 'succeeded', total_duration_ms: 500,
        stage_timings: [{ stage: 'profile_request', attempt: 1, durationMs: 250 }],
        result: { ok: true, cmdrName: 'Nova', journalStatus: 'empty', eventsImported: 0, eventsDuplicate: 0, warnings: [] },
      } } };
    }
  } });
  try {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.ok(ui.calls.some((call) => call.url === '/api/capi/sync/initial-job'), 'page resumed polling after OAuth redirect');
    assert.match(ui.text(), /Синхронизация завершена/);
    assert.match(ui.text(), /Диагностика этапов/);
  } finally {
    await ui.cleanup();
  }
});

test('фоновый синк опрашивает статус задания и перечитывает привязку', async () => {
  let binding = { ...BINDING, tokenActive: false };
  const ui = await renderCapi({ binding: () => binding, api: (url, init) => {
    if (url === '/api/capi/sync' && init?.method === 'POST') {
      return { status: 202, body: { job: { id: 'job-1', status: 'queued', stage: 'queued', attempts: 0 } } };
    }
    if (url === '/api/capi/sync/job-1') {
      binding = { ...BINDING, tokenActive: true };
      return { body: { job: {
        id: 'job-1', status: 'failed', stage: 'failed', total_duration_ms: 1234,
        stage_timings: [{ stage: 'profile_request', durationMs: 1000 }],
        result: { error: BINDING.lastError, needsReauth: false, journalStatus: 'error', reason: 'profile_unavailable', errorKind: 'timeout',
          endpoint: '/profile', host: 'https://companion.orerve.net', httpStatus: 200, transportPhase: 'response_body',
          detail: 'The operation was aborted due to timeout', warnings: [] },
      } } };
    }
  } });
  try {
    assert.match(ui.text(), /Требуется повторная авторизация/);
    const button = [...ui.dom.window.document.querySelectorAll('button')].find((b) => b.textContent.includes('Синхронизировать'));
    await ui.click(button);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.ok(ui.calls.some((call) => call.url === '/api/capi/sync/job-1'), 'UI polls the durable job status');
    assert.ok(ui.calls.filter((call) => call.url === '/api/capi/profile').length >= 2);
    assert.doesNotMatch(ui.text(), /Требуется повторная авторизация|Переподключить/);
    assert.match(ui.text(), /Авторизация сохранена/);
    assert.match(ui.text(), /CAPI endpoint: \/profile · https:\/\/companion\.orerve\.net/);
    assert.match(ui.text(), /Тип ошибки: timeout · profile_unavailable/);
    assert.match(ui.text(), /журнал не запрашивался/);
    assert.match(ui.text(), /Транспорт: чтение тела HTTP-ответа/);
    assert.match(ui.text(), /HTTP: 200/);
    assert.match(ui.text(), /The operation was aborted due to timeout/);
    assert.ok(ui.dom.window.document.querySelector('.capi-status-pending'));
  } finally {
    await ui.cleanup();
  }
});
