import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const scriptPath = join(ROOT, 'deploy', 'configure-synology-ports.sh');
const helperPath = join(ROOT, 'deploy', 'compose-lib.sh');
const overridePath = join(ROOT, 'deploy', 'compose.synology.yml');
const needsBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0
  ? false
  : 'bash is not available in this image';

function text(path) {
  return readFileSync(path, 'utf8');
}

test('Synology deployment files keep site :9000 and Supabase :9100 as separate HTTP backends', () => {
  const script = text(scriptPath);
  const override = text(overridePath);
  const docs = text(join(ROOT, 'SYNOLOGY.md'));
  const example = text(join(ROOT, '.env.example'));

  assert.match(override, /SYNOLOGY_SITE_BIND/);
  assert.match(override, /\}:3000"/, 'Synology host port maps to the internal web :3000');
  assert.match(script, /SITE_PORT="\$\{SITE_PORT:-9000\}"/);
  assert.match(script, /SUPABASE_PORT="\$\{SUPABASE_PORT:-9100\}"/);
  assert.match(script, /PORT_BIND.*127\.0\.0\.1:3000:3000/);
  assert.match(script, /"PORT": "3000"/);
  assert.doesNotMatch(script, /"PORT": "9000"/);
  assert.match(script, /rollback_on_exit/);
  assert.match(script, /схема уже настроена/, 'повторный запуск должен быть идемпотентным');
  assert.match(script, /before-synology/);
  assert.match(docs, /Назначение:\s+HTTP,\s+192\.168\.8\.177, 9000/);
  assert.match(docs, /Назначение:\s+HTTP,\s+192\.168\.8\.177, 9100/);
  assert.match(example, /bash deploy\/configure-synology-ports\.sh/);
});

test('Synology setup and shared compose helper are syntactically valid bash', { skip: needsBash }, () => {
  for (const path of [scriptPath, helperPath]) {
    const result = spawnSync('bash', ['-n', path], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
  }
});

test('compose helper adds Synology override alone and together with Supabase override', { skip: needsBash }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-synology-'));
  const envFile = join(dir, '.env.production');
  writeFileSync(envFile, 'SYNOLOGY_SITE_BIND=192.168.8.177:9000\n');

  const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const command = `source ${quote(helperPath)}; edrc_extra_compose_files ${quote(ROOT)} ${quote(envFile)}`;
  let result = spawnSync('bash', ['-c', command], {
    encoding: 'utf8',
    env: { ...process.env, SUPABASE_NETWORK: '', SYNOLOGY_SITE_BIND: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '-f deploy/compose.synology.yml');

  writeFileSync(envFile, 'SUPABASE_NETWORK=supabase_default\nSYNOLOGY_SITE_BIND=192.168.8.177:9000\n');
  result = spawnSync('bash', ['-c', command], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '/usr/bin:/bin', SUPABASE_NETWORK: '', SYNOLOGY_SITE_BIND: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /-f deploy\/compose\.supabase-net\.yml/);
  assert.match(result.stdout, /-f deploy\/compose\.synology\.yml/);
});

test('all production compose entrypoints use the shared override helper', () => {
  for (const relative of [
    'deploy/start-docker.sh',
    'deploy/rebuild-now.sh',
    'deploy/start-monitoring.sh',
    'deploy/update-project.sh',
    'deploy/apply-env.sh',
  ]) {
    assert.match(text(join(ROOT, relative)), /compose-lib\.sh|edrc_extra_compose_files/, `${relative} must keep Synology publication`);
  }
  const pkg = JSON.parse(text(join(ROOT, 'package.json')));
  assert.equal(pkg.scripts['docker:synology'], 'bash deploy/configure-synology-ports.sh');
});
