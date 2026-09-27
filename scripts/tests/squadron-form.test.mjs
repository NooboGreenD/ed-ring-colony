/**
 * Разбор формы эскадрильи.
 *
 * Жалоба: «не создаются эскадрильи». Форма `/squadrons` отправляла пустые
 * строки (`tag: ""`), проверка требовала 2–10 символов, и запрос отклонялся
 * ещё до базы — с единственным словом «Некорректные данные эскадрильи».
 * Здесь закрепляется, что пустые поля считаются незаполненными, привычная
 * запись тега «[RCV]» принимается, а отказы базы переводятся в понятный текст.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTag,
  parseSquadronInput,
  squadronWriteError,
  tagFromName,
} from '../../src/lib/squadronForm.ts';

test('пустые строки формы не мешают созданию', () => {
  // Ровно то, что слал интерфейс: незаполненные поля как ''.
  const parsed = parseSquadronInput({
    name: 'Ring Colony Vanguard',
    tag: '',
    description: '',
    color: '#e67e22',
    allegiance: 'Independent',
    power: '',
    language: 'Russian',
    timezone: 'UTC+03:00',
    discord_url: '',
    website_url: '',
    home_system: '',
    activity_type: 'Mixed',
  });

  assert.equal(parsed.ok, true, parsed.errors.join('. '));
  assert.equal(parsed.value.description, null);
  assert.equal(parsed.value.power, null);
  assert.equal(parsed.value.home_system, null);
  assert.equal(parsed.value.discord_url, null);
  // Тег собран из названия: NULL в NOT NULL-колонку больше не уходит.
  assert.equal(parsed.value.tag, 'RCV');
  assert.equal(parsed.value.timezone, 'UTC+03:00');
  assert.equal(parsed.value.is_open_recruitment, true);
});

test('тег принимается в привычной записи «[RCV]» и приводится к верхнему регистру', () => {
  assert.equal(normalizeTag('[rcv]'), 'RCV');
  assert.equal(normalizeTag(' r c v '), 'RCV');
  assert.equal(normalizeTag('r-c_v'), 'RCV');
  assert.equal(normalizeTag('ABCDEFGHIJKLMN'), 'ABCDEFGHIJ'); // не длиннее 10
  assert.equal(parseSquadronInput({ name: 'Colonia Rangers', tag: '[CR7]' }).value.tag, 'CR7');
});

test('нелатинский или слишком короткий тег объясняется по-человечески', () => {
  const cyrillic = parseSquadronInput({ name: 'Заря Колонии', tag: 'ЗАРЯ' });
  assert.equal(cyrillic.ok, false);
  assert.deepEqual(cyrillic.errors, ['Тег: только латинские буквы и цифры']);

  const short = parseSquadronInput({ name: 'Colonia Rangers', tag: 'X' });
  assert.equal(short.ok, false);
  assert.deepEqual(short.errors, ['Тег: не короче 2 символов']);
});

test('название проверяется и сообщает причину', () => {
  assert.deepEqual(parseSquadronInput({ name: '   ' }).errors, ['Укажите название эскадрильи']);
  assert.deepEqual(parseSquadronInput({ name: 'ab' }).errors, ['Название короче 3 символов']);
  assert.deepEqual(parseSquadronInput({ name: 'x'.repeat(101) }).errors, ['Название длиннее 100 символов']);
  assert.deepEqual(parseSquadronInput(null).errors, ['Ожидались данные эскадрильи']);
  assert.deepEqual(parseSquadronInput([]).errors, ['Ожидались данные эскадрильи']);
});

test('цвет и ссылки проверяются, ошибки копятся все сразу', () => {
  const parsed = parseSquadronInput({
    name: 'Colonia Rangers',
    color: 'красный',
    discord_url: 'discord.gg/abc',
    website_url: 'сайт',
  });
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.errors, [
    'Цвет: ожидается #RRGGBB',
    'Ссылка на Discord: нужен полный адрес (https://…)',
    'Ссылка на сайт: нужен полный адрес (https://…)',
  ]);
});

test('тег из названия: инициалы, транслитерация и запасной вариант', () => {
  assert.equal(tagFromName('Ring Colony Vanguard'), 'RCV');
  assert.equal(tagFromName('Vanguard'), 'VANG');
  assert.equal(tagFromName('Заря Колонии'), 'ZK');
  assert.equal(tagFromName('Заря'), 'ZARY');
  assert.equal(tagFromName('中文'), 'SQDN');
  assert.equal(tagFromName(''), 'SQDN');
  // Результат всегда годится для колонки: латиница/цифры, 2–10 символов.
  for (const name of ['Ring Colony Vanguard', 'Заря', '中文', 'A']) {
    const tag = tagFromName(name);
    assert.match(tag, /^[A-Z0-9]{2,10}$/, name);
  }
});

test('лимит участников и значения по умолчанию не зависят от клиента', () => {
  const parsed = parseSquadronInput({ name: 'Colonia Rangers', member_limit: 99999 });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.member_limit, 600);
  assert.equal(parsed.value.allegiance, 'Independent');
  assert.equal(parsed.value.activity_type, 'Mixed');
  assert.equal(parsed.value.icon, 'squadron');
  assert.equal(parsed.value.color, '#e67e22');
});

test('отказ базы превращается в подсказку, а не в код ошибки', () => {
  assert.match(
    squadronWriteError({ code: '23502', message: 'null value in column "tag" violates not-null constraint' }),
    /Поле «tag» обязательно/,
  );
  assert.match(
    squadronWriteError({ code: '23503', message: 'insert or update on table "squadrons" violates foreign key constraint' }),
    /Профиль пилота не найден/,
  );
  assert.match(
    squadronWriteError({ code: '23505', message: 'duplicate key value violates unique constraint "squadrons_tag_key"' }),
    /таким тегом уже есть/,
  );
  assert.match(
    squadronWriteError({ code: 'PGRST204', message: "Could not find the 'home_system' column of 'squadrons' in the schema cache" }),
    /нет колонки «home_system» — примените миграции/,
  );
  assert.match(
    squadronWriteError({ code: '42P01', message: 'relation "public.squadrons" does not exist' }),
    /примените миграции/,
  );
  assert.match(
    squadronWriteError({ code: '42501', message: 'new row violates row-level security policy' }),
    /SUPABASE_SERVICE_ROLE_KEY/,
  );
  assert.equal(squadronWriteError(null), 'Не удалось создать эскадрилью');
});
