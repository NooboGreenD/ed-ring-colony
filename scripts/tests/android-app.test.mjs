import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Android-приложение (android-app/) здесь не собрать: нужны JDK, Android SDK и
 * репозиторий Google. Поэтому статически ловится тот класс ошибок, который
 * сломал сборку после #139: вызов методов, которых в классе уже нет
 * (`RetrofitClient.create`, `tokenManager.saveTokens`…), модификатор Compose
 * без получателя и запрос к API, которого нет на сайте.
 */
const ROOT = 'android-app/app/src/main/java/com/edringcolony/monitor';

function kotlinFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? kotlinFiles(path) : path.endsWith('.kt') ? [path] : [];
  });
}
/** Код без комментариев: закомментированный пример не должен ни проходить, ни падать. */
const code = (path) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const declaredFunctions = (path) => new Set([...code(path).matchAll(/\bfun\s+([A-Za-z_]\w*)\s*\(/g)].map((match) => match[1]));
const files = kotlinFiles(ROOT);

test('Android code calls only methods its own classes declare', () => {
  const receivers = {
    tokenManager: `${ROOT}/data/local/TokenManager.kt`,
    RetrofitClient: `${ROOT}/data/network/RetrofitClient.kt`,
    repository: `${ROOT}/data/repository/MonitorRepository.kt`,
    repo: `${ROOT}/data/repository/MonitorRepository.kt`,
    api: `${ROOT}/data/network/ApiService.kt`,
  };
  const declared = Object.fromEntries(Object.entries(receivers).map(([name, path]) => [name, declaredFunctions(path)]));
  let calls = 0;
  for (const file of files) {
    for (const [, receiver, method] of code(file).matchAll(/\b(tokenManager|RetrofitClient|repository|repo|api)\.([A-Za-z_]\w*)\s*\(/g)) {
      calls += 1;
      assert.ok(declared[receiver].has(method), `${file}: ${receiver}.${method}() — такого метода нет в ${receivers[receiver]}`);
    }
  }
  assert.ok(calls >= 10, `проверено вызовов: ${calls}`);
});

test('Compose modifiers are chained on a receiver, never called bare', () => {
  for (const file of files) {
    code(file).split('\n').forEach((line, index) => {
      assert.doesNotMatch(line, /^\s*(?:androidx\.compose\.foundation\.)?(?:clickable|combinedClickable)\s*[({]/, `${file}:${index + 1}`);
    });
  }
});

test('every ApiService endpoint exists on the site', () => {
  const service = code(`${ROOT}/data/network/ApiService.kt`);
  const paths = [...service.matchAll(/@(?:GET|POST|PUT|PATCH|DELETE)\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(paths.length >= 3);
  for (const path of paths) {
    assert.ok(existsSync(`src/app/${path}/route.ts`), `${path}: нет src/app/${path}/route.ts`);
  }
});

test('cleartext HTTP is allowed only in debug builds and only for local dev hosts', () => {
  const main = readFileSync('android-app/app/src/main/AndroidManifest.xml', 'utf8');
  assert.match(main, /android:usesCleartextTraffic="false"/);
  assert.doesNotMatch(main, /networkSecurityConfig/);
  const debug = readFileSync('android-app/app/src/debug/AndroidManifest.xml', 'utf8');
  assert.match(debug, /android:networkSecurityConfig="@xml\/network_security_config"/);
  const config = readFileSync('android-app/app/src/debug/res/xml/network_security_config.xml', 'utf8');
  assert.match(config, /<base-config cleartextTrafficPermitted="false"/);
  const hosts = [...config.matchAll(/<domain[^>]*>([^<]+)<\/domain>/g)].map((match) => match[1].trim()).sort();
  assert.deepEqual(hosts, ['10.0.2.2', '127.0.0.1', 'localhost']);
  assert.ok(!existsSync('android-app/app/src/release/res/xml/network_security_config.xml'));
});
