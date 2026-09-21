/**
 * Yandex Cloud Translate API v2 — общий клиент.
 *
 * Модуль намеренно написан на чистом ESM JavaScript, чтобы его могли
 * использовать одновременно:
 *   - Next.js API-роуты (импортируют из src/lib/translate.ts);
 *   - автономные скрипты в GitHub Actions (scripts/*.mjs).
 *
 * Документация API:
 *   https://cloud.yandex.com/en/docs/translate/api-ref/Translation/translate
 *
 * Авторизация:
 *   Authorization: Api-Key <YANDEX_TRANSLATE_API_KEY>
 *   Authorization: Bearer  <YANDEX_TRANSLATE_IAM_TOKEN>   (альтернатива)
 *
 * Переменные окружения:
 *   YANDEX_TRANSLATE_API_KEY    — API-ключ (основной способ);
 *   YANDEX_TRANSLATE_IAM_TOKEN  — IAM-токен (альтернатива);
 *   YANDEX_TRANSLATE_FOLDER_ID  — идентификатор каталога (опционально,
 *                                 обязателен при работе с глоссариями).
 */

export const SUPPORTED_TRANSLATION_LANGS = /** @type {const} */ ([
  'ru',
  'en',
  'de',
  'it',
  'ko',
  'zh',
  'ja',
]);

const YANDEX_TRANSLATE_URL = 'https://translate.api.cloud.yandex.net/translate/v2/translate';

/** Yandex ограничивает суммарный размер текстов в одном запросе (10000 символов). */
const MAX_CHARS_PER_REQUEST = 8000;
const MAX_TEXTS_PER_REQUEST = 50;
const DEFAULT_RETRIES = 4;
// Yandex быстро отдаёт 429 при параллельных запросах с одного ключа.
const DEFAULT_LANG_CONCURRENCY = 2;
const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Возвращает реквизиты доступа к Yandex Translate или null, если они не заданы.
 * @returns {{apiKey: string, iamToken: string, folderId: string, authHeader: string} | null}
 */
export function getTranslateCredentials() {
  const apiKey = readEnv('YANDEX_TRANSLATE_API_KEY', 'YANDEX_API_KEY');
  const iamToken = readEnv('YANDEX_TRANSLATE_IAM_TOKEN', 'YANDEX_IAM_TOKEN');
  const folderId = readEnv('YANDEX_TRANSLATE_FOLDER_ID', 'YANDEX_FOLDER_ID');

  if (!apiKey && !iamToken) return null;

  return {
    apiKey,
    iamToken,
    folderId,
    authHeader: apiKey ? `Api-Key ${apiKey}` : `Bearer ${iamToken}`,
  };
}

export function hasTranslateCredentials() {
  return getTranslateCredentials() !== null;
}

/**
 * Разбивает длинный текст на куски, пригодные для отправки в API.
 * Старается резать по абзацам, затем по предложениям, затем жёстко.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
export function splitIntoChunks(text, maxChars = MAX_CHARS_PER_REQUEST) {
  const source = String(text ?? '');
  if (source.length <= maxChars) return source ? [source] : [];

  const chunks = [];
  let rest = source;

  while (rest.length > maxChars) {
    let cut = -1;
    const window = rest.slice(0, maxChars);

    const paragraphBreak = window.lastIndexOf('\n\n');
    if (paragraphBreak > maxChars * 0.4) cut = paragraphBreak + 2;

    if (cut <= 0) {
      const sentenceBreak = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('.\n'),
        window.lastIndexOf('! '),
        window.lastIndexOf('? '),
        window.lastIndexOf('\n')
      );
      if (sentenceBreak > maxChars * 0.4) cut = sentenceBreak + 1;
    }

    if (cut <= 0) cut = maxChars;

    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }

  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Несколько параллельных задач с ограничением параллелизма.
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<any>} worker
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Один вызов Yandex Translate с повторами при сетевых/временных ошибках.
 * @param {string[]} texts
 * @param {string} targetLang
 * @param {string} sourceLang
 * @param {{retries?: number, timeoutMs?: number, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<string[]>}
 */
async function callTranslateApi(texts, targetLang, sourceLang, opts = {}) {
  const credentials = getTranslateCredentials();
  if (!credentials) {
    throw new Error(
      'Yandex Translate credentials missing: set YANDEX_TRANSLATE_API_KEY (or YANDEX_TRANSLATE_IAM_TOKEN)'
    );
  }

  const retries = opts.retries ?? DEFAULT_RETRIES;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const body = {
    sourceLanguageCode: sourceLang,
    targetLanguageCode: targetLang,
    format: 'PLAIN_TEXT',
    texts,
  };
  if (credentials.folderId) body.folderId = credentials.folderId;

  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchImpl(YANDEX_TRANSLATE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: credentials.authHeader,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const raw = await res.text();

      if (!res.ok) {
        const error = new Error(`Yandex Translate API error ${res.status}: ${raw.slice(0, 300)}`);
        // 4xx (кроме 408/425/429) — ошибка в запросе или ключе, повторять бессмысленно.
        error.retriable = RETRY_STATUSES.has(res.status);
        // Лимит запросов: уважаем Retry-After, иначе ждём заметно дольше обычного бэкоффа.
        if (res.status === 429) {
          const retryAfter = Number(res.headers?.get?.('retry-after'));
          error.retryDelayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3000 * attempt;
        }
        throw error;
      }

      let json = null;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        throw new Error(`Yandex Translate API returned non-JSON response: ${raw.slice(0, 300)}`);
      }

      if (!json || !Array.isArray(json.translations) || json.translations.length !== texts.length) {
        throw new Error(
          `Yandex Translate API unexpected response: expected ${texts.length} translations, got ${
            json?.translations?.length ?? 'none'
          }`
        );
      }

      return json.translations.map((item) => String(item?.text ?? ''));
    } catch (err) {
      lastError = err;
      // Сетевые ошибки/таймауты и статусы из RETRY_STATUSES (в т.ч. 429) повторяем;
      // прочие 4xx (401/403 неверный ключ, 400 плохой запрос) — нет.
      const retriable = err?.retriable !== undefined ? err.retriable : true;
      if (attempt >= retries || !retriable) break;
      await sleep(err?.retryDelayMs || 500 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Yandex Translate failed after ${retries} attempt(s): ${lastError?.message || lastError}`);
}

/**
 * Переводит массив текстов на один язык.
 * Длинные тексты автоматически режутся на части и склеиваются обратно,
 * поэтому количество строк на выходе всегда равно количеству на входе.
 *
 * @param {string[]} texts
 * @param {string} targetLang
 * @param {string} [sourceLang]
 * @param {{retries?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<string[]>}
 */
export async function translateTexts(texts, targetLang, sourceLang = 'en', opts = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  if (targetLang === sourceLang) return texts.map((t) => String(t ?? ''));

  /** @type {{index: number, part: number, text: string}[]} */
  const segments = [];
  texts.forEach((text, index) => {
    const pieces = splitIntoChunks(String(text ?? ''), MAX_CHARS_PER_REQUEST);
    if (pieces.length === 0) {
      segments.push({ index, part: 0, text: '' });
      return;
    }
    pieces.forEach((piece, part) => segments.push({ index, part, text: piece }));
  });

  // Группируем сегменты в запросы, чтобы не превысить лимиты API.
  /** @type {{index: number, part: number, text: string}[][]} */
  const groups = [];
  let current = [];
  let currentChars = 0;

  for (const segment of segments) {
    // Пустые строки API отвергает (400) — они и так вернутся как есть.
    if (!segment.text.trim()) continue;
    const length = segment.text.length;
    if (
      current.length > 0 &&
      (currentChars + length > MAX_CHARS_PER_REQUEST || current.length >= MAX_TEXTS_PER_REQUEST)
    ) {
      groups.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(segment);
    currentChars += length;
  }
  if (current.length > 0) groups.push(current);

  /** @type {Map<number, {part: number, text: string}[]>} */
  const partsByIndex = new Map();

  for (const group of groups) {
    const translated = await callTranslateApi(
      group.map((segment) => segment.text),
      targetLang,
      sourceLang,
      opts
    );
    group.forEach((segment, i) => {
      if (!partsByIndex.has(segment.index)) partsByIndex.set(segment.index, []);
      partsByIndex.get(segment.index).push({ part: segment.part, text: translated[i] ?? '' });
    });
  }

  return texts.map((original, index) => {
    const parts = partsByIndex.get(index);
    if (!parts) return String(original ?? '');
    return parts
      .sort((a, b) => a.part - b.part)
      .map((p) => p.text)
      .join('')
      .trim() || String(original ?? '');
  });
}

/**
 * Переводит заголовок и тело статьи на все поддерживаемые языки.
 * Язык оригинала не отправляется в API — он копируется как есть.
 * Ошибка одного языка не отменяет остальные переводы.
 *
 * @param {{title: string, body: string, sourceLang?: string, langs?: readonly string[], concurrency?: number}} params
 * @returns {Promise<{title: Record<string, string>, body: Record<string, string>, translatedLangs: string[], skippedLangs: string[], errors: string[], status: 'completed' | 'partial' | 'failed', translatedAt: string}>}
 */
export async function translateArticleFields(params) {
  const {
    title,
    body,
    sourceLang = 'en',
    langs = SUPPORTED_TRANSLATION_LANGS,
    concurrency = DEFAULT_LANG_CONCURRENCY,
    fetchImpl,
  } = params || {};

  /** @type {Record<string, string>} */
  const titles = {};
  /** @type {Record<string, string>} */
  const bodies = {};
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const translatedLangs = [];
  /** @type {string[]} */
  const skippedLangs = [];

  titles[sourceLang] = String(title ?? '');
  bodies[sourceLang] = String(body ?? '');
  translatedLangs.push(sourceLang);

  const targets = langs.filter((lang) => lang !== sourceLang);

  if (targets.length > 0) {
    if (!hasTranslateCredentials()) {
      errors.push('YANDEX_TRANSLATE_API_KEY is not configured');
      targets.forEach((lang) => skippedLangs.push(lang));
    } else {
      await mapLimit(targets, concurrency, async (lang) => {
        try {
          const [translatedTitle, translatedBody] = await translateTexts(
            [String(title ?? ''), String(body ?? '')],
            lang,
            sourceLang,
            { fetchImpl }
          );
          titles[lang] = translatedTitle;
          bodies[lang] = translatedBody;
          translatedLangs.push(lang);
        } catch (err) {
          skippedLangs.push(lang);
          errors.push(`${lang}: ${err?.message || err}`);
        }
      });
    }
  }

  const status =
    skippedLangs.length === 0
      ? 'completed'
      : translatedLangs.length > 1
        ? 'partial'
        : 'failed';

  return {
    title: titles,
    body: bodies,
    translatedLangs,
    skippedLangs,
    errors,
    status,
    translatedAt: new Date().toISOString(),
  };
}

/**
 * Формирует объект для UPDATE-запроса в Supabase
 * (колонки title_<lang> / body_<lang> + служебные поля).
 *
 * @param {ReturnType<typeof translateArticleFields> extends Promise<infer R> ? R : never} translation
 * @param {readonly string[]} [langs]
 * @returns {Record<string, string>}
 */
export function buildTranslationUpdate(translation, langs = SUPPORTED_TRANSLATION_LANGS) {
  /** @type {Record<string, string>} */
  const update = {};

  for (const lang of langs) {
    const title = translation?.title?.[lang];
    const body = translation?.body?.[lang];
    // Не затираем уже существующие переводы пустыми значениями.
    if (typeof title === 'string' && title.trim()) update[`title_${lang}`] = title;
    if (typeof body === 'string' && body.trim()) update[`body_${lang}`] = body;
  }

  update.translation_status = translation?.status || 'failed';
  update.translated_at = translation?.translatedAt || new Date().toISOString();

  return update;
}
