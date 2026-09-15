#!/usr/bin/env node
/**
 * Galnet sync CLI — точка входа для GitHub Actions.
 *
 * Запускается раз в сутки (см. .github/workflows/galnet-sync.yml):
 *   1) забирает ленту Galnet с cms.zaonce.net;
 *   2) складывает новые/изменённые статьи в Supabase;
 *   3) переводит их через Yandex Cloud Translate API v2.
 *
 * Использование:
 *   node scripts/galnet-sync.mjs                    # синхронизация + перевод
 *   node scripts/galnet-sync.mjs --dry-run          # только разбор ленты, без записи в БД
 *   node scripts/galnet-sync.mjs --translate-only   # только догон очереди переводов
 *   node scripts/galnet-sync.mjs --no-translate     # только синхронизация
 *   node scripts/galnet-sync.mjs --limit=50 --translate-limit=15 --json
 *
 * Переменные окружения:
 *   NEXT_PUBLIC_SUPABASE_URL   (обязательно, кроме --dry-run)
 *   SUPABASE_SERVICE_ROLE_KEY  (обязательно, кроме --dry-run)
 *   YANDEX_TRANSLATE_API_KEY   (нужен для перевода; без него статьи остаются pending)
 *   YANDEX_TRANSLATE_FOLDER_ID (опционально)
 *   YANDEX_TRANSLATE_IAM_TOKEN (альтернатива API-ключу)
 *   GALNET_FEED_LIMIT          (по умолчанию 30)
 *   GALNET_TRANSLATE_LIMIT     (по умолчанию 10)
 */

import { createClient } from '@supabase/supabase-js';
import { fetchGalnetFeed } from './lib/galnet-source.mjs';
import {
  GALNET_TABLE,
  NEWS_TABLE,
  DEFAULT_FEED_LIMIT,
  DEFAULT_TRANSLATE_LIMIT,
  countPendingTranslations,
  syncGalnet,
  translatePending,
} from './lib/galnet-sync.mjs';
import { hasTranslateCredentials } from './lib/translate.mjs';

const args = process.argv.slice(2);

function hasFlag(...names) {
  return args.some((arg) => names.includes(arg));
}

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  if (!found) return fallback;
  const value = found.slice(prefix.length);
  return value.trim() === '' ? fallback : value;
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const options = {
  dryRun: hasFlag('--dry-run', '-n'),
  translateOnly: hasFlag('--translate-only'),
  noTranslate: hasFlag('--no-translate'),
  json: hasFlag('--json'),
  verbose: hasFlag('--verbose', '-v'),
  limit: toInt(
    argValue('limit', process.env.GALNET_FEED_LIMIT ?? String(DEFAULT_FEED_LIMIT)),
    DEFAULT_FEED_LIMIT
  ),
  translateLimit: toInt(
    argValue('translate-limit', process.env.GALNET_TRANSLATE_LIMIT ?? String(DEFAULT_TRANSLATE_LIMIT)),
    DEFAULT_TRANSLATE_LIMIT
  ),
  tables: String(argValue('tables', `${GALNET_TABLE},${NEWS_TABLE}`))
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),
};

const log = (message) => {
  if (options.json) return;
  console.log(`[galnet] ${message}`);
};

function fail(message, code = 1) {
  if (options.json) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  } else {
    console.error(`[galnet] FATAL: ${message}`);
  }
  process.exit(code);
}

/** Проверка ленты без базы: ловит поломку парсера до записи данных. */
async function dryRun() {
  const feed = await fetchGalnetFeed({ limit: options.limit });

  if (!feed.ok) {
    fail(`feed unavailable: ${feed.error}`);
    return;
  }

  const summary = {
    ok: true,
    mode: 'dry-run',
    url: feed.url,
    fetched: feed.articles.length,
    translateCredentials: hasTranslateCredentials(),
    articles: feed.articles.slice(0, 5).map((article) => ({
      nid: article.nid,
      slug: article.slug,
      guid: article.guid,
      title: article.title,
      publishedAt: article.publishedAt,
      image: article.image,
      bodyChars: article.body.length,
      bodyPreview: article.body.slice(0, 160),
    })),
  };

  if (feed.articles.length === 0) {
    fail('feed returned 0 valid articles — parser is broken');
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[galnet] dry-run OK, ${summary.fetched} article(s) parsed from ${feed.url}`);
    for (const article of summary.articles) {
      console.log(`  • ${article.publishedAt ?? 'no-date'}  ${article.title}  (${article.nid})`);
    }
  }
  process.exit(0);
}

async function main() {
  if (options.dryRun) return dryRun();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    fail(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (add them as repository secrets)'
    );
    return;
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (options.translateOnly) {
    const result = await translatePending({
      supabase,
      tables: options.tables,
      limit: options.translateLimit,
      log,
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      log(`translated=${result.translated} failed=${result.failed} remaining=${result.remaining}`);
      result.errors.forEach((error) => console.error(`[galnet] ${error}`));
    }

    process.exit(result.failed > 0 && result.translated === 0 ? 1 : 0);
    return;
  }

  const result = await syncGalnet({
    supabase,
    limit: options.limit,
    translate: !options.noTranslate,
    translateLimit: options.translateLimit,
    log,
  });

  const pending = await countPendingTranslations(supabase, GALNET_TABLE);
  const report = { ...result, pendingGalnetTranslations: pending };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    log(
      `fetched=${result.fetched} inserted=${result.inserted} updated=${result.updated} ` +
        `unchanged=${result.unchanged} translated=${result.translated} ` +
        `translateFailed=${result.translationFailed} pending=${pending ?? '?'} ` +
        `in ${result.durationMs} ms`
    );
    result.errors.forEach((error) => console.error(`[galnet] ${error}`));
  }

  // Нет новых статей — это нормально, а не ошибка.
  // Ошибка только если лента недоступна или ничего не удалось записать/перевести.
  const fatal =
    !result.ok ||
    (result.fetched === 0) ||
    (result.inserted + result.updated > 0 && !options.noTranslate && result.translated === 0 && hasTranslateCredentials());

  process.exit(fatal ? 1 : 0);
}

main().catch((err) => fail(err?.stack || err?.message || String(err)));
