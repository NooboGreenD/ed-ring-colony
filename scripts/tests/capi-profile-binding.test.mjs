import test from 'node:test';
import assert from 'node:assert/strict';
import { assessProfileBinding, normalizePilotName } from '../../src/lib/capi/profileBinding.ts';

test('пустой профиль получает имя CMDR из Frontier', () => {
  assert.deepEqual(assessProfileBinding('', 'CMDR Nova'), {
    status: 'linked', displayName: 'CMDR Nova', nameMismatch: false,
  });
});

test('привязка сравнивает имена без учёта регистра и лишних пробелов', () => {
  assert.equal(normalizePilotName('  CMDR   Nova '), 'cmdr nova');
  assert.equal(assessProfileBinding('CMDR Nova', ' cmdr   nova ').status, 'already_linked');
});

test('существующий ник сайта не перезаписывается чужим именем Frontier', () => {
  const result = assessProfileBinding('CMDR Site', 'CMDR Frontier');
  assert.equal(result.status, 'conflict');
  assert.equal(result.displayName, 'CMDR Site');
  assert.equal(result.nameMismatch, true);
});

test('отсутствующее имя Frontier не создаёт ложную привязку', () => {
  assert.deepEqual(assessProfileBinding('CMDR Site', null), {
    status: 'missing', displayName: 'CMDR Site', nameMismatch: false,
  });
});
