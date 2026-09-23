/**
 * Тесты цепочки «Админка → API-ключи»: клиент `src/lib/updateAgent.ts`
 * собирается esbuild'ом (тот же код, что работает в web-контейнере) и
 * гоняет настоящий сервер update-agent'а: чтение, маскировка, запись,
 * удаление и применение ключей (job kind=env) — всё по протоколу.
 *
 * Без esbuild тест честно пропускается, а не падает.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let esbuild = null;
try {
  esbuild = await import('esbuild');
} catch {
  // devDependencies не установлены — пропускаем.
}

const maybe = esbuild ? test : test.skip;

import { createUpdateManager, createUpdateServer, updateAgentConfig } from '../update-agent.mjs';
import { UPDATE_PROTOCOL } from '../lib/update-state.mjs';

async function buildClient() {
  const dir = mkdtempSync(join(ROOT, '.tmp-env-client-'));
  const outfile = join(dir, 'updateAgent.mjs');
  await esbuild.build({
    entryPoints: [join(ROOT, 'src', 'lib', 'updateAgent.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile,
  });
  const mod = await import(outfile);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

maybe('клиент + агент: чтение, маскировка, запись, удаление, применение ключей', async (t) => {
  const { mod, cleanup } = await buildClient();
  const dir = mkdtempSync(join(ROOT, '.tmp-env-agent-'));
  const envFile = join(dir, '.env.production');
  const applyScript = join(dir, 'apply-env.sh');
  const proto = (obj) => UPDATE_PROTOCOL + JSON.stringify(obj);
  writeFileSync(applyScript, [
    '#!/usr/bin/env bash',
    `echo '${proto({ stage: 'env_prepare', percent: 10 })}'`,
    'sleep 0.2',
    `echo '${proto({ stage: 'env_switch', percent: 40, message: 'recreating services' })}'`,
    `echo '${proto({ stage: 'done', percent: 100 })}'`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });

  const token = 'e2e-env-token-not-a-real-secret';
  const config = updateAgentConfig({
    UPDATE_AGENT_HOST: '127.0.0.1',
    UPDATE_AGENT_TOKEN: token,
    PROJECT_DIR: dir,
    UPDATE_STATE_DIR: join(dir, 'state'),
    UPDATE_SCRIPT: join(dir, 'update-project.sh'),
    ENV_FILE: envFile,
    APPLY_ENV_SCRIPT: applyScript,
  });
  const manager = createUpdateManager(config);
  const server = createUpdateServer({ config, manager });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  // Клиент читает настройки из окружения, как web-контейнер в compose.
  const prevUrl = process.env.UPDATE_AGENT_URL;
  const prevToken = process.env.UPDATE_AGENT_TOKEN;
  process.env.UPDATE_AGENT_URL = `http://127.0.0.1:${port}`;
  process.env.UPDATE_AGENT_TOKEN = token;

  t.after(async () => {
    if (prevUrl === undefined) delete process.env.UPDATE_AGENT_URL; else process.env.UPDATE_AGENT_URL = prevUrl;
    if (prevToken === undefined) delete process.env.UPDATE_AGENT_TOKEN; else process.env.UPDATE_AGENT_TOKEN = prevToken;
    manager.stop();
    await new Promise((resolve) => server.close(resolve));
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  const initial = await mod.listEnvKeys();
  assert.equal(initial.ok, true);
  assert.equal(initial.payload.configured, false, 'файла окружения ещё нет');

  const saved = await mod.saveEnvKey('YANDEX_TRANSLATE_API_KEY', 'test-key-value-123');
  assert.equal(saved.ok, true);
  assert.equal(saved.status, 201);
  assert.equal(JSON.stringify(saved).includes('test-key-value-123'), false, 'сырой ключ не уходит в браузер');
  assert.match(readFileSync(envFile, 'utf8'), /^YANDEX_TRANSLATE_API_KEY=test-key-value-123$/m, 'ключ лег в файл');

  const listed = await mod.listEnvKeys();
  assert.equal(listed.ok, true);
  assert.equal(listed.payload.configured, true);
  const row = (listed.payload.keys || []).find((k) => k.name === 'YANDEX_TRANSLATE_API_KEY');
  assert.ok(row, 'ключ виден в списке');
  assert.equal(row.length, 'test-key-value-123'.length, 'длина — чтобы знать, что именно изменилось');
  assert.equal(row.masked.includes('test-key-value-123'), false, 'маска не содержит значения');
  assert.match(row.masked, /-123/, 'маска заканчивается хвостом значения');

  const applied = await mod.applyEnvKeys('web');
  assert.equal(applied.ok, true);
  assert.equal(applied.status, 202, 'применение — фоновый job');
  assert.equal(applied.update.kind, 'env', 'панель понимает: это ключи, а не обновление');
  assert.equal(applied.update.mode, 'web');

  const deadline = Date.now() + 15000;
  while (manager.isBusy() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const done = manager.status();
  assert.equal(done.state, 'succeeded', 'stub apply-env.sh дошёл до конца');
  assert.equal(done.kind, 'env');
  assert.equal(done.percent, 100);

  const removed = await mod.deleteEnvKey('YANDEX_TRANSLATE_API_KEY');
  assert.equal(removed.ok, true);
  assert.equal(readFileSync(envFile, 'utf8').includes('YANDEX_TRANSLATE_API_KEY'), false, 'ключ стёрт из файла');
});
