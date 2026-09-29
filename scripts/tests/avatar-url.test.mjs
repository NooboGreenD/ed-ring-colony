/**
 * Адреса аватаров.
 *
 * Жалоба: «картинки профиля не загружаются». Причина — переезд сайта на свой
 * сервер: в `profiles.avatar_url` остались полные ссылки на прежний хост
 * Supabase Cloud, где файлов больше нет. Здесь закрепляется правило «тот же
 * объект, но с текущего хоста» и то, что чужие картинки (Discord, Яндекс)
 * не трогаются.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  avatarColor,
  avatarInitials,
  configuredSupabaseUrl,
  isSupabaseStorageUrl,
  resolveAvatarUrl,
} from '../../src/lib/avatarUrl.ts';

const CURRENT = 'https://supabase.edringcolony.ru';
const LEGACY_OBJECT =
  'https://sgukfplhxdhmkqponwft.supabase.co/storage/v1/object/public/avatars/user-1/1695800000000.png';

test('ссылка на прежний хост Supabase переписывается на текущий', () => {
  assert.equal(
    resolveAvatarUrl(LEGACY_OBJECT, CURRENT),
    'https://supabase.edringcolony.ru/storage/v1/object/public/avatars/user-1/1695800000000.png',
  );
});

test('адрес с текущего хоста остаётся прежним', () => {
  const same = `${CURRENT}/storage/v1/object/public/avatars/user-1/a.png`;
  assert.equal(resolveAvatarUrl(same, CURRENT), same);
});

test('same-origin gateway сохраняет свой path prefix для старых и новых Storage-ссылок', () => {
  const gateway = 'https://edringcolony.ru/api/supabase';
  assert.equal(
    resolveAvatarUrl(LEGACY_OBJECT, gateway),
    'https://edringcolony.ru/api/supabase/storage/v1/object/public/avatars/user-1/1695800000000.png',
  );
  const same = 'https://edringcolony.ru/api/supabase/storage/v1/object/public/avatars/user-1/a.png';
  assert.equal(resolveAvatarUrl(same, gateway), same);
});

test('подписанные ссылки Storage тоже переносятся вместе с параметрами', () => {
  const signed = 'https://old.supabase.co/storage/v1/object/sign/avatars/u/a.png?token=abc';
  assert.equal(
    resolveAvatarUrl(signed, CURRENT),
    'https://supabase.edringcolony.ru/storage/v1/object/sign/avatars/u/a.png?token=abc',
  );
});

test('внешние аватары (Discord, Яндекс) не трогаются', () => {
  for (const url of [
    'https://cdn.discordapp.com/avatars/1/abc.png',
    'https://avatars.yandex.net/get-yapic/1234/islands-200',
  ]) {
    assert.equal(resolveAvatarUrl(url, CURRENT), url, url);
  }
});

test('относительный адрес запасного хранилища остаётся относительным', () => {
  // Такие ссылки ставит /api/account/avatar, когда Storage недоступен.
  assert.equal(resolveAvatarUrl('/api/avatars/uuid?v=abc', CURRENT), '/api/avatars/uuid?v=abc');
  assert.equal(resolveAvatarUrl('data:image/png;base64,AAA', CURRENT), 'data:image/png;base64,AAA');
});

test('пустое, битое и небезопасное значение превращается в null', () => {
  for (const value of [null, undefined, '', '   ', 'не адрес', 'javascript:alert(1)']) {
    assert.equal(resolveAvatarUrl(value, CURRENT), null, JSON.stringify(value));
  }
});

test('без настроенного Supabase адрес остаётся как есть', () => {
  assert.equal(resolveAvatarUrl(LEGACY_OBJECT, null), LEGACY_OBJECT);
});

test('configuredSupabaseUrl сохраняет base path gateway и переживает мусор', () => {
  assert.equal(configuredSupabaseUrl('https://db.example.com/rest/v1/'), 'https://db.example.com/rest/v1');
  assert.equal(configuredSupabaseUrl(''), null);
  assert.equal(configuredSupabaseUrl('не адрес'), null);
});

test('isSupabaseStorageUrl смотрит на путь, а не на хост', () => {
  assert.equal(isSupabaseStorageUrl('https://любой.хост/storage/v1/object/public/avatars/a.png'), true);
  assert.equal(isSupabaseStorageUrl('https://cdn.discordapp.com/avatars/1/abc.png'), false);
  assert.equal(isSupabaseStorageUrl('не адрес'), false);
});

test('инициалы и цвет заглушки устойчивы', () => {
  assert.equal(avatarInitials('Nova Prime'), 'NP');
  assert.equal(avatarInitials('nova'), 'NO');
  assert.equal(avatarInitials('  '), '?');
  assert.equal(avatarInitials(null), '?');
  // Один и тот же пилот всегда одного цвета, разные — обычно разных.
  assert.equal(avatarColor('Nova'), avatarColor('Nova'));
  assert.notEqual(avatarColor('Nova'), avatarColor('Orion'));
  assert.match(avatarColor('Nova'), /^hsl\(\d+ 45% 32%\)$/);
});
