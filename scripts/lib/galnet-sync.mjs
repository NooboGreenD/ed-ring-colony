/**
 * Оркестрация синхронизации Galnet: лента → Supabase → перевод.
 *
 * Один и тот же код используется:
 *   - Next.js роутом  POST /api/galnet         (триггер для Vercel Cron);
 *   - Next.js роутом  /api/cron/translate      (догон очереди переводов);
 *   - автономным CLI  scripts/galnet-sync.mjs  (GitHub Actions, раз в сутки).
 *
 * Модуль не создаёт клиент Supabase сам — он передаётся снаружи, поэтому
 * в проде используется service role ключ, а в CLI — тот же ключ из секретов.
 */

import {
  SUPPORTED_TRANSLATION_LANGS,
  hasTranslateCredentials,
  translateArticleFields,
  buildTranslationUpdate,
} from './translate.mjs';
import { GALNET_SOURCE_LANG, fetchGalnetFeed } from './galnet-source.mjs';

export const GALNET_TABLE = 'galnet_news';
export const NEWS_TABLE = 'news';
export const SYNC_LOG_TABLE = 'galnet_sync_log';

/** Сколько последних статей держим в памяти для проверки «уже есть / изменилось». */
const EXISTING_LOOKBACK = 300;

export const DEFAULT_FEED_LIMIT = 30;
export const DEFAULT_TRANSLATE_LIMIT = 10;

/**
 * Статусы переводов, которые нужно догонять.
 * ВАЖНО: PostgREST понимает только синтаксис `in.(a,b,c)` — одинарные
 * кавычки воспринимаются как часть значения и ломают фильтр.
 */
const RETRY_STATUSES = 'pending,failed,partial';

function noop() {}

function isUnknownColumnError(error) {
  const message = String(error?.message || error || '');
  return (
    message.includes('Could not find the') ||
    message.includes('column') && message.includes('does not exist') ||
    message.includes('schema cache')
  );
}

/**
 * Пишет строку в galnet_sync_log. Никогда не роняет основной процесс:
 * лог — это диагностика, а не часть бизнес-логики.
 */
export async function writeSyncLog(supabase, entry) {
  if (!supabase) return;
  const payload = {
    fetched_at: new Date().toISOString(),
    articles_count: entry.articlesCount ?? 0,
    new_count: entry.newCount ?? 0,
    error_msg: entry.errorMsg ? String(entry.errorMsg).slice(0, 900) : null,
    status: entry.status || 'success',
  };

  try {
    const { error } = await supabase.from(SYNC_LOG_TABLE).insert({ ...payload, ...(entry.extra || {}) });
    if (!error) return;

    // Расширенные колонки (duration_ms, translated_count) могут отсутствовать
    // в старых базах — пробуем записать минимальный набор.
    if (isUnknownColumnError(error)) {
      await supabase.from(SYNC_LOG_TABLE).insert(payload);
    }
  } catch {
    // intentionally ignored
  }
}

/**
 * Язык оригинала по умолчанию для таблицы. Galnet приходит с Frontier на
 * английском, новости сайта пишутся по-русски. Раньше для обеих таблиц
 * использовался `en`: Yandex получал русский текст как «английский оригинал»,
 * в `title_en` ложился русский, а нормальных переводов не получал никто.
 */
export const TABLE_SOURCE_LANG = {
  [GALNET_TABLE]: GALNET_SOURCE_LANG,
  [NEWS_TABLE]: 'ru',
};

/** Язык, указанный в строке (`source_lang`), важнее табличного значения. */
export function sourceLangForRow(row, table) {
  const declared = typeof row?.source_lang === 'string' ? row.source_lang.trim().toLowerCase() : '';
  if (/^[a-z]{2}$/.test(declared)) return declared;
  return TABLE_SOURCE_LANG[table] || GALNET_SOURCE_LANG;
}

function filledWith(row, lang, field) {
  const value = row?.[`${field}_${lang}`];
  return typeof value === 'string' && value.trim().length > 0;
}

function isFilled(row, lang, fields) {
  return !!row && fields.every((field) => filledWith(row, lang, field));
}

/**
 * Переводит одну строку и сохраняет переводы.
 *
 * Что исправлено по сравнению с первой версией:
 *   • язык оригинала берётся из таблицы/строки, а не жёстко `en`;
 *   • языки с готовым переводом не переводятся заново — дозаполняются только
 *     недостающие колонки `title_<lang>` / `body_<lang>`;
 *   • `translation_status` = completed только когда закрыты все языки, иначе
 *     partial — строка остаётся в очереди догона и следующий запуск её починит.
 *
 * @returns {Promise<{status: string, translatedLangs: string[], skippedLangs: string[], errors: string[], missingLangs: string[]}>}
 */
export async function translateArticleRow(params) {
  const {
    supabase,
    table,
    id,
    title,
    body,
    langs = SUPPORTED_TRANSLATION_LANGS,
    fetchImpl,
    existing = null,
    fields = ['title', 'body'],
    force = false,
  } = params;

  if (!hasTranslateCredentials()) {
    throw new Error('YANDEX_TRANSLATE_API_KEY is not configured');
  }

  const sourceLang = params.sourceLang || sourceLangForRow(existing, table);
  const targets = force ? langs : langs.filter((lang) => !isFilled(existing, lang, fields));

  if (targets.length === 0) {
    // Всё уже переведено — просто закрываем строку в очереди.
    const { error } = await supabase
      .from(table)
      .update({ translation_status: 'completed', translated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw new Error(error.message);
    return { status: 'completed', translatedLangs: [], skippedLangs: [], errors: [], missingLangs: [] };
  }

  // Язык оригинала в API не отправляем: его текст кладём в колонку как есть.
  const wanted = targets.filter((lang) => lang !== sourceLang);
  const translation = await translateArticleFields({
    title,
    body,
    sourceLang,
    langs: wanted.length > 0 ? wanted : [sourceLang],
    fetchImpl,
  });
  const update = buildTranslationUpdate(translation, wanted.length > 0 ? wanted : [sourceLang]);

  // Оригинал обязан попасть в языковые колонки: иначе читатель на «родном»
  // языке видит пустоту, когда базовая колонка не совпадает с локалью.
  if (!isFilled(existing, sourceLang, fields)) {
    for (const field of fields) {
      const value = String(translation?.[field]?.[sourceLang] ?? (field === 'title' ? title : body) ?? '');
      if (value.trim()) update[`${field}_${sourceLang}`] = value;
    }
  }

  const missingLangs = langs.filter((lang) =>
    fields.some((field) => {
      const next = update[`${field}_${lang}`] || existing?.[`${field}_${lang}`];
      return typeof next !== 'string' || !next.trim();
    }),
  );
  const translatedAny = wanted.length - (translation?.skippedLangs?.length || 0) > 0;
  update.translation_status = missingLangs.length === 0 ? 'completed' : translatedAny ? 'partial' : 'failed';
  update.translated_at = new Date().toISOString();

  const { error } = await supabase.from(table).update(update).eq('id', id);

  if (error) {
    if (isUnknownColumnError(error)) {
      throw new Error(
        `translation columns are missing in "${table}" — apply supabase/migrations/20260915000000_galnet_translations.sql (${error.message})`
      );
    }
    throw new Error(error.message);
  }

  return {
    ...translation,
    status: update.translation_status,
    missingLangs,
  };
}

/**
 * Загружает ленту Galnet и складывает новые/изменённые статьи в базу.
 *
 * @param {{
 *   supabase: any,
 *   limit?: number,
 *   translate?: boolean,
 *   translateLimit?: number,
 *   langs?: readonly string[],
 *   log?: (message: string) => void,
 * }} options
 */
export async function syncGalnet(options) {
  const {
    supabase,
    limit = DEFAULT_FEED_LIMIT,
    translate = true,
    translateLimit = DEFAULT_TRANSLATE_LIMIT,
    langs = SUPPORTED_TRANSLATION_LANGS,
    fetchImpl,
    log = noop,
  } = options || {};

  const startedAt = Date.now();
  const result = {
    ok: true,
    url: null,
    fetched: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    translated: 0,
    translationFailed: 0,
    translateSkipped: 0,
    newNids: [],
    errors: [],
    durationMs: 0,
  };

  const feed = await fetchGalnetFeed({ limit, fetchImpl });
  result.url = feed.url;

  if (!feed.ok) {
    result.ok = false;
    result.errors.push(feed.error);
    result.durationMs = Date.now() - startedAt;
    await writeSyncLog(supabase, {
      status: 'error',
      errorMsg: feed.error,
      extra: { duration_ms: result.durationMs },
    });
    return result;
  }

  result.fetched = feed.articles.length;
  log(`Galnet feed: ${feed.articles.length} article(s)`);

  // ── 1. Что уже есть в базе (одним запросом вместо N) ──
  let existingRows = [];
  try {
    const { data, error } = await supabase
      .from(GALNET_TABLE)
      .select('id, nid, guid, title, body, published_at, translation_status')
      .order('published_at', { ascending: false })
      .limit(EXISTING_LOOKBACK);

    if (error) throw new Error(error.message);
    existingRows = data || [];
  } catch (err) {
    // Колонка guid может отсутствовать — пробуем без неё.
    const fallback = await supabase
      .from(GALNET_TABLE)
      .select('id, nid, title, body, published_at, translation_status')
      .order('published_at', { ascending: false })
      .limit(EXISTING_LOOKBACK);

    if (fallback.error) {
      result.ok = false;
      result.errors.push(`existing-lookup: ${fallback.error.message}`);
      result.durationMs = Date.now() - startedAt;
      await writeSyncLog(supabase, {
        status: 'error',
        errorMsg: fallback.error.message,
        extra: { duration_ms: Date.now() - startedAt },
      });
      return result;
    }
    existingRows = fallback.data || [];
  }

  const byNid = new Map();
  const byGuid = new Map();
  for (const row of existingRows) {
    if (row.nid) byNid.set(String(row.nid), row);
    if (row.guid) byGuid.set(String(row.guid), row);
  }

  // ── 2. Разделяем на новые / изменённые / без изменений ──
  const toInsert = [];
  const toUpdate = [];

  for (const article of feed.articles) {
    const known = byNid.get(article.nid) || (article.guid ? byGuid.get(article.guid) : null);

    if (!known) {
      toInsert.push(article);
      continue;
    }

    const titleChanged = (known.title || '') !== article.title;
    const bodyChanged = (known.body || '') !== article.body;
    if (titleChanged || bodyChanged) {
      toUpdate.push({ id: known.id, article });
    } else {
      result.unchanged++;
    }
  }

  // ── 3. Вставляем новые ──
  if (toInsert.length > 0) {
    const rows = toInsert.map((article) => {
      const row = {
        nid: article.nid,
        title: article.title,
        body: article.body,
        image: article.image,
        published_at: article.publishedAt || new Date().toISOString(),
        translation_status: 'pending',
        translated_at: null,
        fetched_at: new Date().toISOString(),
      };
      // Сразу кладём оригинал в языковые колонки источника,
      // чтобы статья была читаемой даже до перевода.
      if (article.lang === GALNET_SOURCE_LANG) {
        row.title_en = article.title;
        row.body_en = article.body;
      }
      return row;
    });

    let { data: inserted, error } = await supabase
      .from(GALNET_TABLE)
      .upsert(rows, { onConflict: 'nid' })
      .select('id, nid');

    if (error && isUnknownColumnError(error)) {
      // База без колонок переводов/служебных полей — работаем в минимальном режиме.
      const minimal = rows.map(({ nid, title, body, image, published_at }) => ({
        nid,
        title,
        body,
        image,
        published_at,
      }));
      const retry = await supabase
        .from(GALNET_TABLE)
        .upsert(minimal, { onConflict: 'nid' })
        .select('id, nid');
      inserted = retry.data;
      error = retry.error;
      if (!error) {
        result.errors.push(
          'translation columns missing in galnet_news — inserted without translations, apply migration 20260915000000_galnet_translations.sql'
        );
      }
    }

    if (error) {
      result.ok = false;
      result.errors.push(`insert: ${error.message}`);
    } else {
      result.inserted = (inserted || []).length;
      result.newNids = (inserted || []).map((row) => row.nid);
      log(`Inserted ${result.inserted} new article(s): ${result.newNids.join(', ')}`);
    }
  }

  // ── 4. Обновляем изменившиеся ──
  for (const { id, article } of toUpdate) {
    const patch = {
      title: article.title,
      body: article.body,
      image: article.image,
      published_at: article.publishedAt || undefined,
      translation_status: 'pending',
      translated_at: null,
    };
    if (article.lang === GALNET_SOURCE_LANG) {
      patch.title_en = article.title;
      patch.body_en = article.body;
    }

    let { error } = await supabase.from(GALNET_TABLE).update(patch).eq('id', id);
    if (error && isUnknownColumnError(error)) {
      const retry = await supabase
        .from(GALNET_TABLE)
        .update({ title: article.title, body: article.body, image: article.image })
        .eq('id', id);
      error = retry.error;
    }

    if (error) {
      result.errors.push(`update:${id}: ${error.message}`);
    } else {
      result.updated++;
    }
  }

  // ── 5. Переводим свежие статьи ──
  /** @type {{id: number|string, nid: string, title: string, body: string}[]} */
  const freshRows = [];

  if (result.newNids.length > 0) {
    const { data } = await supabase
      .from(GALNET_TABLE)
      .select('*')
      .in('nid', result.newNids);
    (data || []).forEach((row) => freshRows.push(row));
  }

  const updatedIds = toUpdate.map((entry) => entry.id);
  if (updatedIds.length > 0) {
    const { data } = await supabase
      .from(GALNET_TABLE)
      .select('*')
      .in('id', updatedIds);
    (data || []).forEach((row) => freshRows.push(row));
  }

  const queue = freshRows.slice(0, Math.max(0, translateLimit));

  if (!translate) {
    result.translateSkipped = freshRows.length;
  } else if (!hasTranslateCredentials()) {
    result.translateSkipped = freshRows.length;
    result.errors.push('YANDEX_TRANSLATE_API_KEY is not configured — articles stored as "pending"');
  } else {
    for (const row of queue) {
      try {
        const translation = await translateArticleRow({
          supabase,
          table: GALNET_TABLE,
          id: row.id,
          title: row.title,
          body: row.body,
          langs,
          fetchImpl,
        });
        result.translated++;
        log(`Translated ${row.nid}`);
        // Частичный успех (например, упал один язык) не должен теряться молча.
        if (translation?.skippedLangs?.length > 0) {
          result.errors.push(
            `translate:${row.nid}: incomplete (${translation.skippedLangs.join(',')}) — ${
              (translation.errors || []).join('; ') || 'unknown reason'
            }`
          );
        }
      } catch (err) {
        result.translationFailed++;
        result.errors.push(`translate:${row.nid}: ${err?.message || err}`);
        try {
          await supabase.from(GALNET_TABLE).update({ translation_status: 'failed' }).eq('id', row.id);
        } catch {
          // ignore
        }
      }
    }
    result.translateSkipped = Math.max(0, freshRows.length - queue.length);
  }

  result.durationMs = Date.now() - startedAt;

  await writeSyncLog(supabase, {
    status: result.ok && result.errors.length === 0 ? 'success' : 'partial',
    articlesCount: result.fetched,
    newCount: result.inserted,
    errorMsg: result.errors.length ? result.errors.slice(0, 3).join(' | ') : null,
    extra: {
      duration_ms: result.durationMs,
      translated_count: result.translated,
      updated_count: result.updated,
    },
  });

  return result;
}

/**
 * Догоняет очередь необработанных переводов.
 *
 * @param {{
 *   supabase: any,
 *   tables?: string[],
 *   limit?: number,
 *   langs?: readonly string[],
 *   log?: (message: string) => void,
 * }} options
 */
export async function translatePending(options) {
  const {
    supabase,
    tables = [GALNET_TABLE, NEWS_TABLE],
    limit = DEFAULT_TRANSLATE_LIMIT,
    langs = SUPPORTED_TRANSLATION_LANGS,
    fetchImpl,
    log = noop,
  } = options || {};

  const result = {
    ok: true,
    processed: 0,
    translated: 0,
    failed: 0,
    remaining: 0,
    errors: [],
    byTable: {},
  };

  if (!hasTranslateCredentials()) {
    result.ok = false;
    result.errors.push('YANDEX_TRANSLATE_API_KEY is not configured');
    return result;
  }

  for (const table of tables) {
    const tableResult = { processed: 0, translated: 0, failed: 0, remaining: 0 };

    const { data: rows, error } = await supabase
      .from(table)
      // `*`, а не «id, title, body»: дозаполнение пропусков требует текущих
      // title_<lang>/body_<lang>, а язык оригинала читается из source_lang.
      .select('*')
      .or(`translation_status.in.(${RETRY_STATUSES}),translated_at.is.null`)
      // Свежие статьи первыми: иначе несколько старых «вечно failed» строк
      // занимают весь лимит и новые новости никогда не доходят до перевода.
      .order('id', { ascending: false })
      .limit(limit);

    if (error) {
      result.errors.push(`${table}: query failed — ${error.message}`);
      result.ok = false;
      result.byTable[table] = tableResult;
      continue;
    }

    const batch = rows || [];

    for (const row of batch) {
      result.processed++;
      tableResult.processed++;
      try {
        const translation = await translateArticleRow({
          supabase,
          table,
          id: row.id,
          title: row.title,
          body: row.body,
          langs,
          fetchImpl,
          existing: row,
        });
        // Считаем по фактическому статусу, а не по «функция не упала»:
        // иначе отчёт обещает переведённые статьи, которых читатель не видит.
        if (translation?.status === 'failed') {
          result.failed++;
          tableResult.failed++;
          result.errors.push(
            `${table}:${row.id}: ни один язык не переведён (${(translation.errors || []).join('; ') || 'no detail'})`
          );
          continue;
        }
        result.translated++;
        tableResult.translated++;
        log(`[${table}] translated #${row.id} (${translation?.status || 'completed'})`);
        if (translation?.skippedLangs?.length > 0) {
          result.errors.push(
            `${table}:${row.id}: incomplete (${translation.skippedLangs.join(',')}) — ${
              (translation.errors || []).join('; ') || 'unknown reason'
            }`
          );
        }
      } catch (err) {
        result.failed++;
        tableResult.failed++;
        const message = err?.message || String(err);
        result.errors.push(`${table}:${row.id}: ${message}`);
        try {
          await supabase.from(table).update({ translation_status: 'failed' }).eq('id', row.id);
        } catch {
          // ignore
        }
      }
    }

    tableResult.remaining = (await countPendingTranslations(supabase, table)) ?? 0;
    result.remaining += tableResult.remaining;
    result.byTable[table] = tableResult;
  }

  return result;
}

/**
 * Сколько всего статей ждут перевода (для отчётов в CI).
 */
export async function countPendingTranslations(supabase, table = GALNET_TABLE) {
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .or(`translation_status.in.(${RETRY_STATUSES}),translated_at.is.null`);
  if (error) return null;
  return count ?? 0;
}
