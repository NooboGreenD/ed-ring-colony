/**
 * Бюджет cookie: сколько байт занимает заголовок `Cookie` и что в нём лишнее.
 *
 * Сессия Supabase живёт в cookie `sb-edrc-auth-token`, и `@supabase/ssr` режет
 * её на куски по 3180 символов (`sb-edrc-auth-token.0`, `.1`, …). В куске лежит
 * весь объект сессии целиком — access token, refresh token и профиль
 * пользователя вместе со списком `identities`. У пилота, привязавшего Discord,
 * Google, VK и Yandex, этот список заметно длиннее, и заголовок `Cookie` легко
 * переходит за 8 КиБ — а это предел nginx по умолчанию
 * (`large_client_header_buffers 4 8k`) и половина предела Node
 * (`--max-http-header-size`, 16 КиБ). За пределом браузер получает 400/431 и
 * сайт не открывается вовсе; в инкогнито он открывается, потому что там cookies
 * ещё нет. Отсюда «иногда не открывается».
 *
 * Здесь только счёт и разбор — что считать мусором и когда сбрасывать. Сами
 * заголовки правит `src/proxy.ts`, пределы поднимают `deploy/nginx.conf`,
 * `Dockerfile` и `deploy/ed-ring-colony.service`.
 *
 * Модуль без зависимостей: его проверяют тесты без Next и Supabase.
 */

import { SUPABASE_AUTH_COOKIE_NAME } from './supabaseUrl';

/** Предел nginx по умолчанию: выше него сервер отвечает «Cookie Too Large». */
export const COOKIE_WARN_BYTES = 8 * 1024;

/**
 * Аварийный порог сброса. Ниже предела Node (16 КиБ), поэтому запрос с таким
 * заголовком ещё доходит до приложения и его можно вылечить, а не потерять.
 * Живая сессия столько не занимает: 3 куска — это ~9,6 КиБ, и до порога ещё
 * далеко. Сюда попадают только разросшиеся или испорченные наборы.
 */
export const COOKIE_RESET_BYTES = 20 * 1024;

/**
 * Сбрасываем только когда «наши» cookie и есть проблема: если заголовок
 * раздули чужие (аналитика, Cloudflare), трогать нечего — наши удаления его
 * не уменьшат, а выход из аккаунта пилот запомнит надолго.
 */
export const RESET_MIN_APP_BYTES = 4 * 1024;

/** Одноразовая отметка: она не даёт сбросу зациклиться. */
export const RESET_MARKER_COOKIE = 'edrc-cookie-reset';
export const RESET_MARKER_SECONDS = 600;

/** Cookie старой схемы входа: сайт удаляет её сам, но она переживает сбои. */
export const LEGACY_COOKIE_NAMES: readonly string[] = ['sb-session'];

/** Наши cookie: только их считаем своими при сбросе. */
export const APP_COOKIE_PREFIXES: readonly string[] = ['sb-', 'edrc-', 'capi_'];

/** Пути, где сброс запрещён: колбэки входа и API живут своей жизнью. */
const RESET_EXCLUDED_PREFIXES: readonly string[] = ['/api/', '/auth/'];

/** Методы, на которых переадресация ничего не теряет. */
const RESET_METHODS: readonly string[] = ['GET', 'HEAD'];

export interface CookieLike {
  name: string;
  value: string;
}

const encoder = new TextEncoder();

/** Сколько байт занимает заголовок `Cookie` (UTF-8, как его видит сервер). */
export function cookieHeaderBytes(header: string | null | undefined): number {
  if (!header) return 0;
  return encoder.encode(header).length;
}

/** Номер куска `base.N` или `null`, если имя к базовой cookie не относится. */
export function chunkIndexOf(name: string, base: string = SUPABASE_AUTH_COOKIE_NAME): number | null {
  if (!name.startsWith(`${base}.`)) return null;
  const tail = name.slice(base.length + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(tail)) return null;
  return Number(tail);
}

export function isAppCookie(name: string): boolean {
  return APP_COOKIE_PREFIXES.some(prefix => name.startsWith(prefix))
    || LEGACY_COOKIE_NAMES.includes(name);
}

/** Сколько байт занимают наши cookie в заголовке (`name=value; `). */
export function appCookieBytes(cookies: readonly CookieLike[]): number {
  let total = 0;
  for (const cookie of cookies) {
    if (!isAppCookie(cookie.name)) continue;
    total += encoder.encode(`${cookie.name}=${cookie.value}`).length + 2;
  }
  return total;
}

/**
 * Cookie, которые заведомо не прочитаются, — их можно удалить без потери сессии.
 *
 * Три случая, и в каждом мусор доказуем, а не «на глаз»:
 *
 * 1. `sb-edrc-auth-token` и куски `.0`, `.1` одновременно. `combineChunks`
 *    сначала читает базовую cookie и на ней останавливается — куски в этом
 *    состоянии не читает никто; библиотека сама удаляет их при записи, но
 *    после сбоя посреди ответа они остаются.
 * 2. Дырка в нумерации: `.1` без `.0`. Чтение останавливается на первом
 *    отсутствующем куске, поэтому всё после дырки — мёртвый груз.
 * 3. Пустое значение (`name=`) и старая cookie `sb-session`: их нет ни в одном
 *    чтении — `sb-session` сайт удаляет сам с 2.26, но у старых браузеров она
 *    могла остаться.
 */
export function deadCookieNames(cookies: readonly CookieLike[],
                                base: string = SUPABASE_AUTH_COOKIE_NAME): string[] {
  const names = new Set(cookies.map(cookie => cookie.name));
  const dead = new Set<string>();

  for (const legacy of LEGACY_COOKIE_NAMES) {
    if (names.has(legacy)) dead.add(legacy);
  }
  for (const cookie of cookies) {
    if (cookie.value !== '' || !isAppCookie(cookie.name)) continue;
    dead.add(cookie.name);
  }

  const chunks: number[] = [];
  for (const name of names) {
    const index = chunkIndexOf(name, base);
    if (index !== null) chunks.push(index);
  }
  if (chunks.length === 0) return [...dead].filter(name => names.has(name));
  chunks.sort((left, right) => left - right);

  if (names.has(base) || chunks[0] !== 0) {
    // Базовая cookie перекрывает куски, а нумерация без нуля не читается вовсе.
    for (const index of chunks) dead.add(`${base}.${index}`);
    return [...dead];
  }

  // Дырка в середине: всё, что за ней, уже не прочитать.
  const last = chunks[chunks.length - 1];
  for (let index = 0; index <= last; index++) {
    if (names.has(`${base}.${index}`)) continue;
    for (const chunk of chunks) {
      if (chunk > index) dead.add(`${base}.${chunk}`);
    }
    break;
  }
  return [...dead];
}

/** Все наши cookie из запроса — то, что удаляет аварийный сброс. */
export function resetCookieNames(cookies: readonly CookieLike[]): string[] {
  return cookies
    .map(cookie => cookie.name)
    .filter(name => isAppCookie(name) && name !== RESET_MARKER_COOKIE);
}

export interface ResetDecision {
  headerBytes: number;
  cookies: readonly CookieLike[];
  /** Отметка сброса ещё жива — второй раз за минуту не сбрасываем. */
  marker: boolean;
  method: string;
  path: string;
}

/**
 * Пора ли сбрасывать cookie.
 *
 * Сброс — крайняя мера: пилот останется без сессии и войдёт заново. Поэтому он
 * срабатывает только когда заголовок перевалил за аварийный порог, наши cookie
 * в нём — основная часть, а сам запрос безопасно повторить (GET/HEAD, не
 * колбэк входа и не API).
 */
export function shouldResetCookies({ headerBytes, cookies, marker, method, path }: ResetDecision): boolean {
  if (marker) return false;
  if (headerBytes < COOKIE_RESET_BYTES) return false;
  if (!RESET_METHODS.includes(method.toUpperCase())) return false;
  if (RESET_EXCLUDED_PREFIXES.some(prefix => path.startsWith(prefix))) return false;
  if (appCookieBytes(cookies) < RESET_MIN_APP_BYTES) return false;
  return true;
}
