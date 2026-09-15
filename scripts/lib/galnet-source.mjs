/**
 * Galnet (Elite Dangerous) — загрузка и разбор официальной ленты Frontier.
 *
 * Источник: Drupal JSON:API на cms.zaonce.net
 *   GET https://cms.zaonce.net/en-GB/jsonapi/node/galnet_article
 *       ?sort=-published_at&page[offset]=0&page[limit]=30
 *
 * Заголовок Accept: application/vnd.api+json обязателен — без него Drupal
 * отвечает 406 Not Acceptable.
 *
 * Модуль не зависит от базы данных и используется и из Next.js-роутов,
 * и из автономных скриптов GitHub Actions.
 */

export const GALNET_FEED_URL = 'https://cms.zaonce.net/en-GB/jsonapi/node/galnet_article';
export const GALNET_IMAGE_BASE = 'https://hosting.zaonce.net/elite-dangerous/galnet/';
export const GALNET_SOURCE_LANG = 'en';

const DEFAULT_LIMIT = 30;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RETRIES = 3;

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Раскрывает HTML-сущности, которые встречаются в body.value ленты Galnet.
 * Выполняется один проход, чтобы не испортить уже обычный текст.
 * @param {string} input
 * @returns {string}
 */
export function decodeEntities(input) {
  let text = String(input ?? '');
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  });
  text = text.replace(/&#(\d+);/g, (_, dec) => {
    const code = Number.parseInt(dec, 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  });
  text = text.replace(/&([a-z]+);/gi, (match, name) => {
    const key = String(name).toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
  });
  return text;
}

/**
 * Убирает HTML-теги (на случай, если используется body.processed).
 * @param {string} input
 * @returns {string}
 */
export function stripHtml(input) {
  return String(input ?? '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*p\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '');
}

/**
 * Приводит текст статьи к аккуратному plain text:
 * переводы строк CRLF → LF, декодирование сущностей, схлопывание мусорных пробелов.
 * @param {string} input
 * @returns {string}
 */
export function normalizeBody(input) {
  let text = String(input ?? '');
  if (/<[a-z!/][^>]*>/i.test(text)) text = stripHtml(text);
  text = decodeEntities(text);
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/**
 * Превращает сырое значение даты в ISO-строку.
 * ВАЖНО: поле field_galnet_date вида «11 SEP 3312» — это внутриигровая дата,
 * она НЕ является корректной меткой времени и в колонку TIMESTAMPTZ
 * попадать не должна (именно из-за неё статьи молча отбрасывались).
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function toIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const fromNumber = new Date(value > 1e12 ? value : value * 1000);
    return Number.isFinite(fromNumber.getTime()) ? fromNumber.toISOString() : null;
  }
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (!raw) return null;

  // «11 SEP 3312» — внутриигровая дата Galnet (3312 год!).
  // V8 благополучно разбирает её в дату 3312 года, поэтому проверяем формат
  // ДО вызова new Date(), иначе такие статьи навсегда встают в начало ленты.
  if (/^\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{3,5}$/.test(raw)) return null;

  const parsed = new Date(raw);
  const time = parsed.getTime();
  if (Number.isNaN(time)) return null;

  // Защита от любых других «далёких» дат: реалистичный диапазон 2000–2100.
  const year = parsed.getUTCFullYear();
  if (year < 2000 || year > 2100) return null;

  return parsed.toISOString();
}

/**
 * Строит URL обложки статьи.
 * @param {unknown} field
 * @returns {string | null}
 */
export function buildImageUrl(field) {
  if (!field) return null;
  const raw = String(field).trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const name = raw.replace(/\.(png|jpe?g|webp)$/i, '');
  if (!name) return null;
  return `${GALNET_IMAGE_BASE}${name}.png`;
}

/**
 * Разбирает один элемент JSON:API в нормализованную статью.
 * @param {any} item
 * @returns {{nid: string, guid: string | null, slug: string | null, title: string, body: string, image: string | null, publishedAt: string | null, lang: string} | null}
 */
export function parseArticle(item) {
  if (!item || typeof item !== 'object') return null;

  const attributes = item.attributes && typeof item.attributes === 'object' ? item.attributes : {};
  // В заголовках тоже встречаются HTML-сущности (&amp;, &#039;).
  const title = decodeEntities(String(attributes.title ?? '')).trim();
  if (!title) return null;

  // nid: приоритет — внутренний nid Drupal, затем UUID ресурса.
  // Поле field_galnet_guid храним отдельно: оно стабильно и помогает
  // при дедупликации, если Frontier поменяет UUID.
  const nid = String(
    attributes.drupal_internal__nid ?? item.id ?? attributes.field_galnet_guid ?? ''
  ).trim();
  if (!nid) return null;

  const bodyRaw =
    (attributes.body && typeof attributes.body === 'object'
      ? attributes.body.value ?? attributes.body.processed
      : null) ?? attributes.body;

  const body = normalizeBody(bodyRaw ?? '');
  if (!body) return null;

  const publishedAt =
    toIsoDate(attributes.published_at) ??
    toIsoDate(attributes.created) ??
    toIsoDate(attributes.changed);

  return {
    nid,
    guid: attributes.field_galnet_guid ? String(attributes.field_galnet_guid) : null,
    slug: attributes.field_slug ? String(attributes.field_slug) : null,
    title,
    body,
    image: buildImageUrl(attributes.field_galnet_image),
    publishedAt,
    lang: attributes.langcode ? String(attributes.langcode).toLowerCase() : GALNET_SOURCE_LANG,
  };
}

/**
 * Разбирает ответ JSON:API в массив статей (битые элементы отбрасываются).
 * @param {any} json
 * @returns {ReturnType<typeof parseArticle>[]}
 */
export function parseGalnetFeed(json) {
  const data = Array.isArray(json?.data) ? json.data : [];
  /** @type {any[]} */
  const articles = [];
  for (const item of data) {
    const parsed = parseArticle(item);
    if (parsed) articles.push(parsed);
  }
  return articles;
}

/**
 * Собирает URL ленты с корректным кодированием параметров.
 * @param {{limit?: number, offset?: number}} [params]
 * @returns {string}
 */
export function buildFeedUrl(params = {}) {
  const limit = Number.isFinite(params.limit) ? Math.max(1, Math.trunc(params.limit)) : DEFAULT_LIMIT;
  const offset = Number.isFinite(params.offset) ? Math.max(0, Math.trunc(params.offset)) : 0;
  // GALNET_FEED_URL позволяет подменить источник (тесты, зеркало, прокси).
  const base = readEnv('GALNET_FEED_URL') || GALNET_FEED_URL;
  const url = new URL(base);
  url.searchParams.set('sort', '-published_at');
  url.searchParams.set('page[offset]', String(offset));
  url.searchParams.set('page[limit]', String(limit));
  return url.toString();
}

/**
 * Загружает и разбирает ленту Galnet.
 *
 * @param {{limit?: number, offset?: number, timeoutMs?: number, retries?: number, fetchImpl?: typeof fetch, userAgent?: string}} [options]
 * @returns {Promise<{ok: true, url: string, fetched: number, articles: ReturnType<typeof parseArticle>[]} | {ok: false, url: string, error: string, status?: number}>}
 */
export async function fetchGalnetFeed(options = {}) {
  const {
    limit = DEFAULT_LIMIT,
    offset = 0,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    fetchImpl = fetch,
    userAgent = 'ed-ring-colony-galnet-sync/1.0 (+https://github.com/NooboGreenD/ed-ring-colony)',
  } = options;

  const url = buildFeedUrl({ limit, offset });
  let lastError = 'unknown error';
  let lastStatus;

  for (let attempt = 1; attempt <= Math.max(1, retries); attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.api+json',
          'User-Agent': userAgent,
        },
        cache: 'no-store',
        signal: controller.signal,
      });

      lastStatus = res.status;
      const raw = await res.text();

      if (!res.ok) {
        lastError = `Galnet HTTP ${res.status}: ${raw.slice(0, 300)}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
      } else {
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {
          lastError = `Galnet returned non-JSON payload (${raw.slice(0, 120)})`;
          json = null;
        }

        if (json) {
          const articles = parseGalnetFeed(json);
          if (articles.length === 0 && Array.isArray(json.data) && json.data.length > 0) {
            return {
              ok: false,
              url,
              status: res.status,
              error: `Galnet feed parsed to 0 valid articles from ${json.data.length} items — parser/API contract mismatch`,
            };
          }
          return { ok: true, url, fetched: articles.length, articles };
        }
      }
    } catch (err) {
      lastError = err?.name === 'AbortError'
        ? `Galnet request timed out after ${timeoutMs} ms`
        : String(err?.message || err);
    } finally {
      clearTimeout(timer);
    }

    if (attempt < retries) await sleep(1000 * attempt);
  }

  return { ok: false, url, error: lastError, status: lastStatus };
}
