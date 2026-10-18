/**
 * `fetch`, который на КАЖДЫЙ запрос открывает новое TCP-соединение.
 *
 * Зачем: часть сетей (у российских провайдеров — ТСПУ) «замораживает»
 * TCP-сессию к зарубежным хостингам и CDN (Cloudflare, OVH, Hetzner…), как
 * только по ней прошло ~16–20 КБ: пакеты просто перестают приходить, через
 * 70 с ядро закрывает сокет с `read ETIMEDOUT`. Обычный `fetch` (undici)
 * держит соединения открытыми и отправляет следующий запрос в ту же, уже
 * «замороженную» сессию. Здесь соединение живёт ровно один запрос, поэтому
 * короткие Range-запросы (меньше порога) проходят целиком.
 *
 * TLS-сессии кэширует общий `https.Agent`: новое соединение возобновляет
 * сессию и не тянет сертификат заново — меньше байт до тела ответа.
 *
 * Поддерживается то, что нужно скачиванию дампов: GET/HEAD, заголовки,
 * `signal`, редиректы (до 5), тело ответа потоком. Сжатие не запрашивается
 * (архив и так gzip), тайм-аут простоя сокета — `idleTimeoutMs`.
 */

import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

export interface FreshFetchOptions {
  /** Соединение молчит дольше — запрос обрывается с ETIMEDOUT (по умолчанию 60 с). */
  idleTimeoutMs?: number;
  /** Редиректов подряд (по умолчанию 5). */
  maxRedirects?: number;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === 'string' && reason ? reason : 'This operation was aborted');
  error.name = 'AbortError';
  return error;
}

function toUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  return new URL((input as Request).url);
}

function responseHeaders(raw: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value == null) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, String(value));
  }
  return headers;
}

export function createFreshConnectionFetch(options: FreshFetchOptions = {}): typeof fetch {
  const idleTimeoutMs = Math.max(1000, options.idleTimeoutMs ?? 60_000);
  const maxRedirects = Math.max(0, options.maxRedirects ?? 5);
  // keepAlive: false — сокет закрывается после ответа, следующий запрос идёт в новом.
  const agents = {
    'https:': new https.Agent({ keepAlive: false, maxCachedSessions: 64 }),
    'http:': new http.Agent({ keepAlive: false }),
  } as const;

  const once = (url: URL, method: string, headers: Record<string, string>, signal: AbortSignal | null | undefined) =>
    new Promise<http.IncomingMessage>((resolveResponse, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const secure = url.protocol === 'https:';
      if (!secure && url.protocol !== 'http:') {
        reject(new TypeError(`Неподдерживаемый протокол: ${url.protocol}`));
        return;
      }
      const request = (secure ? https : http).request(url, {
        method,
        headers: { ...headers, connection: 'close' },
        agent: agents[secure ? 'https:' : 'http:'],
      });
      let response: http.IncomingMessage | null = null;
      // Отмена — и до ответа, и посреди тела: поток тела падает с причиной отмены.
      const onAbort = () => {
        const reason = abortError(signal!);
        response?.destroy(reason);
        request.destroy(reason);
      };
      const detach = () => signal?.removeEventListener('abort', onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      request.setTimeout(idleTimeoutMs, () => {
        const error = Object.assign(new Error(`read ETIMEDOUT (нет данных ${Math.round(idleTimeoutMs / 1000)} с)`), { code: 'ETIMEDOUT' });
        response?.destroy(error);
        request.destroy(error);
      });
      request.once('error', (error) => {
        if (!response) detach();
        reject(error);
      });
      request.once('response', (res) => {
        response = res;
        res.once('close', detach);
        resolveResponse(res);
      });
      request.end();
    });

  return (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) => {
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') throw new TypeError(`freshFetch: только GET и HEAD, а не ${method}`);
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, name) => {
      headers[name] = value;
    });
    const signal = init?.signal ?? null;
    let url = toUrl(input);
    for (let hop = 0; ; hop++) {
      const res = await once(url, method, headers, signal);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (REDIRECTS.has(status) && location && hop < maxRedirects) {
        res.resume();
        res.destroy();
        url = new URL(location, url);
        continue;
      }
      const empty = method === 'HEAD' || status === 204 || status === 304 || (status >= 100 && status < 200);
      if (empty) res.resume();
      const body = empty ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
      const response = new Response(body, {
        status: status >= 200 && status <= 599 ? status : 502,
        statusText: res.statusMessage ?? '',
        headers: responseHeaders(res.headers),
      });
      Object.defineProperty(response, 'url', { value: url.toString() });
      return response;
    }
  }) as typeof fetch;
}
