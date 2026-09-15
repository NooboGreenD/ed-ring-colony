/**
 * Тесты парсера ленты Galnet + клиента перевода.
 *
 * Запуск:
 *   node --test scripts/tests/
 *   npm run test:galnet
 *
 * Тесты не требуют сети: лента подменяется фикстурой с реальной
 * структурой ответа cms.zaonce.net (Drupal JSON:API).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildFeedUrl,
  buildImageUrl,
  decodeEntities,
  fetchGalnetFeed,
  normalizeBody,
  parseArticle,
  parseGalnetFeed,
  toIsoDate,
} from '../lib/galnet-source.mjs';
import { splitIntoChunks, translateTexts } from '../lib/translate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  await readFile(path.join(here, 'fixtures', 'galnet-feed.json'), 'utf8')
);

function findArticle(articles, nid) {
  return articles.find((article) => article.nid === nid);
}

test('parseGalnetFeed разбирает реальную структуру JSON:API', () => {
  const articles = parseGalnetFeed(fixture);
  // 7 элементов, но 2 должны быть отброшены (пустой title / пустой body).
  assert.equal(articles.length, 5);

  const newest = articles[0];
  assert.equal(newest.nid, 'cc9f3a38-3e90-4a1a-8205-1bbf5fe5d518');
  assert.equal(newest.title, 'Federation Condemns Ongoing October Accords Exclusion');
  assert.equal(newest.slug, 'federation-condemns-ongoing-october-accords-exclusion');
  assert.equal(newest.guid, '6aa3bc366f39584229038902');
  assert.equal(newest.image, 'https://hosting.zaonce.net/elite-dangerous/galnet/NewsImageCombat01.png');
  assert.equal(newest.publishedAt, '2026-09-11T14:00:46.000Z');
  assert.equal(newest.lang, 'en');
});

test('parseGalnetFeed устойчив к мусорному вводу', () => {
  assert.deepEqual(parseGalnetFeed(null), []);
  assert.deepEqual(parseGalnetFeed({}), []);
  assert.deepEqual(parseGalnetFeed({ data: null }), []);
  assert.deepEqual(parseGalnetFeed({ data: [null, 42, { id: 'x' }] }), []);
});

test('тело статьи приводится к читаемому plain text', () => {
  const article = findArticle(parseGalnetFeed(fixture), 'cc9f3a38-3e90-4a1a-8205-1bbf5fe5d518');
  assert.ok(!article.body.includes('\r'), 'CRLF должны быть нормализованы');
  assert.ok(!article.body.includes('&quot;'), 'HTML-сущности должны быть раскрыты');
  assert.ok(article.body.includes('"'));
  assert.ok(article.body.includes('\n'));
});

test('HTML-тело (body.processed) очищается от разметки', () => {
  const article = findArticle(parseGalnetFeed(fixture), 'edge-case-html-body');
  assert.equal(article.title, 'HTML Body Only & Entities');
  assert.ok(!/<[a-z!/]/i.test(article.body), 'HTML-теги должны быть удалены');
  assert.ok(article.body.includes('&'), 'сущность &amp; должна стать &');
});

test('статьи без заголовка или без текста отбрасываются', () => {
  const articles = parseGalnetFeed(fixture);
  assert.equal(findArticle(articles, 'edge-case-empty-title'), undefined);
  assert.equal(findArticle(articles, 'edge-case-empty-body'), undefined);
});

test('даты: ISO-поля используются, внутриигровая дата игнорируется', () => {
  assert.equal(toIsoDate('2026-09-11T14:00:46+00:00'), '2026-09-11T14:00:46.000Z');
  assert.equal(toIsoDate('11 SEP 3312'), null, '«11 SEP 3312» — не метка времени');
  assert.equal(toIsoDate(null), null);
  assert.equal(toIsoDate('not a date'), null);

  const articles = parseGalnetFeed(fixture);
  // Нет published_at → берём created.
  assert.equal(findArticle(articles, 'edge-case-no-published-at').publishedAt, '2026-08-01T10:00:00.000Z');
  // Нет ни одного машиночитаемого поля → null, но статья не теряется.
  assert.equal(findArticle(articles, 'edge-case-only-lore-date').publishedAt, null);
});

test('URL обложки строится корректно', () => {
  assert.equal(
    buildImageUrl('NewsImageCombat01'),
    'https://hosting.zaonce.net/elite-dangerous/galnet/NewsImageCombat01.png'
  );
  // Расширение в значении не должно дублироваться.
  assert.equal(
    buildImageUrl('NewsImageGoldRushMining.png'),
    'https://hosting.zaonce.net/elite-dangerous/galnet/NewsImageGoldRushMining.png'
  );
  assert.equal(buildImageUrl(null), null);
  assert.equal(buildImageUrl('  '), null);
  assert.equal(buildImageUrl('https://cdn.example.com/a.png'), 'https://cdn.example.com/a.png');
});

test('URL ленты кодирует параметры JSON:API', () => {
  const url = buildFeedUrl({ limit: 12, offset: 30 });
  assert.ok(url.startsWith('https://cms.zaonce.net/en-GB/jsonapi/node/galnet_article?'));
  assert.ok(url.includes('page%5Blimit%5D=12'), url);
  assert.ok(url.includes('page%5Boffset%5D=30'), url);
  assert.ok(url.includes('sort=-published_at'), url);
});

test('fetchGalnetFeed сообщает о проблеме, а не падает молча', async () => {
  const okFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(fixture),
  });

  const ok = await fetchGalnetFeed({ limit: 10, fetchImpl: okFetch, retries: 1 });
  assert.equal(ok.ok, true);
  assert.equal(ok.fetched, 5);

  const httpError = await fetchGalnetFeed({
    limit: 10,
    retries: 1,
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'Service Unavailable' }),
  });
  assert.equal(httpError.ok, false);
  assert.match(httpError.error, /503/);

  const brokenContract = await fetchGalnetFeed({
    limit: 10,
    retries: 1,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ id: 'a', attributes: { title: 'x' } }] }),
    }),
  });
  assert.equal(brokenContract.ok, false, 'пустые статьи должны считаться поломкой парсера');
});

test('decodeEntities раскрывает основные сущности', () => {
  assert.equal(decodeEntities('&quot;hi&quot;'), '"hi"');
  assert.equal(decodeEntities('&amp;'), '&');
  assert.equal(decodeEntities('&#39;'), "'");
  assert.equal(decodeEntities('already plain'), 'already plain');
});

test('normalizeBody убирает лишние переводы строк', () => {
  assert.equal(normalizeBody('a\r\n\r\n\r\n\r\nb'), 'a\n\nb');
  assert.equal(normalizeBody('  spaced  \n'), 'spaced');
});

test('splitIntoChunks режет длинные тексты по границам абзацев', () => {
  const text = `${'word '.repeat(2000)}\n\n${'other '.repeat(2000)}`;
  const chunks = splitIntoChunks(text, 5000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 5000));
  assert.equal(chunks.join('').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
});

test('translateTexts сохраняет количество строк и склеивает части обратно', async () => {
  const calls = [];
  // «Переводчик»-заглушка возвращает текст без изменений,
  // так удобнее проверять разбиение на части и обратную склейку.
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ target: body.targetLanguageCode, count: body.texts.length });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ translations: body.texts.map((text) => ({ text })) }),
    };
  };

  const originalKey = process.env.YANDEX_TRANSLATE_API_KEY;
  process.env.YANDEX_TRANSLATE_API_KEY = 'test-key';

  try {
    const long = 'x'.repeat(9000);
    const result = await translateTexts(['short', long], 'ru', 'en', { fetchImpl: fakeFetch });

    assert.equal(result.length, 2);
    assert.equal(result[0], 'short');
    assert.equal(result[1], long, 'длинный текст должен склеиться без потерь');
    assert.ok(calls.length >= 2, 'длинный текст должен быть разбит на несколько запросов');
    assert.equal(calls[0].target, 'ru');
    assert.ok(
      calls.every((call) => call.count >= 1),
      'каждый запрос должен содержать хотя бы один текст'
    );

    // Язык оригинала не отправляется в API.
    const same = await translateTexts(['as-is'], 'en', 'en', { fetchImpl: fakeFetch });
    assert.deepEqual(same, ['as-is']);
  } finally {
    if (originalKey === undefined) delete process.env.YANDEX_TRANSLATE_API_KEY;
    else process.env.YANDEX_TRANSLATE_API_KEY = originalKey;
  }
});

test('translateTexts требует реквизиты и понятно ругается', async () => {
  const originalKey = process.env.YANDEX_TRANSLATE_API_KEY;
  const originalIam = process.env.YANDEX_TRANSLATE_IAM_TOKEN;
  delete process.env.YANDEX_TRANSLATE_API_KEY;
  delete process.env.YANDEX_TRANSLATE_IAM_TOKEN;

  try {
    await assert.rejects(() => translateTexts(['x'], 'ru', 'en'), /Yandex Translate credentials missing/);
  } finally {
    if (originalKey !== undefined) process.env.YANDEX_TRANSLATE_API_KEY = originalKey;
    if (originalIam !== undefined) process.env.YANDEX_TRANSLATE_IAM_TOKEN = originalIam;
  }
});

test('parseArticle возвращает null для некорректного элемента', () => {
  assert.equal(parseArticle(null), null);
  assert.equal(parseArticle({ id: 'only-id' }), null);
  assert.equal(parseArticle({ id: 'x', attributes: { title: 'T', body: { value: 'B' } } }).nid, 'x');
});
