import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = new URL('../../', import.meta.url);
const read = (file) => readFileSync(new URL(file, repoRoot), 'utf8');

const nginxConfigs = [
  'deploy/nginx.conf',
  'deploy/selfhost/nginx-selfhost.conf',
  'deploy/selfhost/install.sh',
];

const docs = ['DEPLOY.md', 'SELFHOST.md', 'SERVER-SETUP.md'];

const RELEASE_PATH = '/api/admin/uploader/release';
const RELEASE_LOCATION = new RegExp(`location\\s*=\\s*${RELEASE_PATH.replace(/\//g, '\\/')}\\s*\\{([^}]*)\\}`, 's');

/**
 * nginx применяет `location` только внутри своего `server {}`, поэтому шаблон
 * считается корректным, только если КАЖДЫЙ активный блок, отдающий сайт, несёт
 * нужный location. Комментарии (в том числе закомментированный HTTPS-блок в
 * nginx-selfhost.conf) игнорируются так же, как их игнорирует сам nginx.
 */
function siteServerBlocks(source) {
  const blocks = [];
  let depth = 0;
  let buffer = null;
  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/#.*$/, '');
    if (!buffer) {
      if (!/(^|\s)server\s*\{/.test(line)) continue;
      buffer = [line.replace(/^[^{]*\{/, '')];
      depth = 1;
    } else {
      buffer.push(line);
      for (const char of line) {
        if (char === '{') depth += 1;
        else if (char === '}') depth -= 1;
      }
      if (depth > 0) continue;
      const block = buffer.join('\n');
      buffer = null;
      // Только site-блоки: Supabase/Kong живёт по своим лимитам Storage.
      if (/proxy_pass[^;]*:3000/.test(block)) blocks.push(block);
    }
  }
  return blocks;
}

function maxBodySizeMib(body) {
  const match = body.match(/client_max_body_size\s+(\d+)\s*(k|m|g)?\s*;/i);
  if (!match) return 0;
  const value = Number(match[1]);
  if (match[2]?.toLowerCase() === 'k') return value / 1024;
  if (match[2]?.toLowerCase() === 'g') return value * 1024;
  return value;
}

test('ColonialHelper release endpoint has a 200 MiB limit in every project nginx template', () => {
  for (const file of nginxConfigs) {
    const location = read(file).match(RELEASE_LOCATION)?.[1];
    assert.ok(location, `${file} contains the release-upload location`);
    assert.match(location, /client_max_body_size\s+200m\s*;/, `${file} allows a 200 MiB request`);
  }
});

test('every site-facing server block in the templates carries the release location', () => {
  for (const file of nginxConfigs) {
    const blocks = siteServerBlocks(read(file));
    assert.ok(blocks.length > 0, `${file} declares at least one server block for the site`);
    blocks.forEach((block, index) => {
      const location = block.match(RELEASE_LOCATION)?.[1];
      assert.ok(
        location,
        `${file}: server block #${index + 1} proxies the site but has no \`location = ${RELEASE_PATH}\` — such a request gets the server-level limit and answers 413`,
      );
      assert.ok(
        maxBodySizeMib(location) >= 200,
        `${file}: server block #${index + 1} limits ${RELEASE_PATH} to ${maxBodySizeMib(location)} MiB`,
      );
      assert.ok(
        maxBodySizeMib(location) >= maxBodySizeMib(block.replace(RELEASE_LOCATION, '')),
        `${file}: server block #${index + 1} keeps a server-level limit above the release location`,
      );
    });
  }
});

test('nginx headroom stays above the app-side exe cap so only the app can refuse a build', () => {
  const store = read('src/lib/uploaderStore.ts');
  const cap = Number(store.match(/data\.length\s*>\s*(\d+)\s*\*\s*1024\s*\*\s*1024/)?.[1]);
  assert.ok(Number.isFinite(cap) && cap > 0, 'saveLauncherBinary declares an explicit MiB cap for the exe');
  for (const file of nginxConfigs) {
    const location = read(file).match(RELEASE_LOCATION)[1];
    assert.ok(
      maxBodySizeMib(location) > cap,
      `${file} must not be the limiter: it allows ${maxBodySizeMib(location)} MiB while the app allows ${cap} MiB`,
    );
  }
});

test('templates keep the "duplicate it into the HTTPS server block" warning', () => {
  for (const file of ['deploy/nginx.conf', 'deploy/selfhost/nginx-selfhost.conf']) {
    // Формулировка в шаблонах разная, смысл один: локации живут внутри server {}.
    assert.match(read(file), /между server-блоками/, `${file} explains server-block scoping`);
  }
});

test('docs name the real limit and the verification commands, never a stale number', () => {
  for (const file of docs) {
    const source = read(file);
    assert.doesNotMatch(
      source,
      /150m[^.]{0,80}\/api\/admin\/uploader\/release|\/api\/admin\/uploader\/release[^.]{0,80}150m/,
      `${file} still documents a 150m limit for the release endpoint`,
    );
    if (!source.includes(RELEASE_PATH)) continue;
    assert.match(source, /nginx -T/, `${file} tells the admin to inspect the active config`);
    assert.match(source, /systemctl reload nginx/, `${file} tells the admin to reload nginx`);
    assert.match(source, /CDN|внешн/i, `${file} mentions the outer proxy/CDN case`);
  }
});

test('the checker reports both a healthy config and a missing HTTPS location', { skip: process.platform === 'win32' }, () => {
  const script = join(repoRoot.pathname, 'deploy/selfhost/check-release-upload-limit.sh');
  assert.equal(spawnSync('bash', ['-n', script]).status, 0, 'the checker parses as bash');

  const dir = mkdtempSync(join(tmpdir(), 'release-limit-'));
  const header = `# configuration file /etc/nginx/sites-enabled/ed-ring-colony:
`;
  const location = `    location = ${RELEASE_PATH} {
        client_max_body_size 200m;
        proxy_pass http://127.0.0.1:3000;
    }
`;
  const siteBlock = (listen) => `server {
    listen ${listen};
    server_name edringcolony.ru;
    location / {
        proxy_pass http://127.0.0.1:3000;
    }
    client_max_body_size 25m;
${location}}
`;
  const errorLog = join(dir, 'error.log');
  writeFileSync(errorLog, '');

  const run = (name, body) => {
    const file = join(dir, `${name}.txt`);
    writeFileSync(file, header + body);
    return spawnSync('bash', [script], {
      env: { ...process.env, CHECK_NGINX_T_OUTPUT: file, CHECK_NGINX_ERROR_LOG: errorLog },
      encoding: 'utf8',
    });
  };

  const good = run('good', siteBlock('80') + siteBlock('443 ssl'));
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /location разрешает ≈200 MiB/);

  const broken = run('broken', siteBlock('80') + `server {
    listen 443 ssl;
    server_name edringcolony.ru;
    location / {
        proxy_pass http://127.0.0.1:3000;
    }
    client_max_body_size 25m;
}
`);
  assert.equal(broken.status, 1, 'a TLS server block without the location must fail the check');
  assert.match(broken.stdout, /нет location = \/api\/admin\/uploader\/release/);

  writeFileSync(errorLog, 'client intended to send too large body: 26422067 bytes\n');
  const logged = run('logged', siteBlock('80'));
  assert.match(logged.stdout, /nginx сам отклонял запросы по размеру \(1 раз\)/);
  assert.match(logged.stdout, /26422067 bytes/);
});
