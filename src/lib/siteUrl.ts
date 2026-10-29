export const DEFAULT_SITE_URL = 'https://edringcolony.ru';
export const DEFAULT_SUPABASE_URL = 'https://supabase.edringcolony.ru';

/** Use a configured public origin, never Docker's request URL or an untrusted Host header. */
export function getSiteUrl(value = process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_SITE_URL): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('NEXT_PUBLIC_SITE_URL must be a public HTTPS origin (HTTP is only allowed for localhost)');
  }
  return url.origin;
}

/**
 * Публичный origin для ссылок, которые уезжают клиенту в ответе API.
 *
 * Адрес берётся из настройки, а не из запроса: за nginx `Host` приходит
 * `0.0.0.0:3000` (так `proxy_pass` подставляет `$proxy_host`), и ссылка
 * «скачать» уводила пилота на `https://0.0.0.0:3000/...`. Если настройка
 * испорчена, отдаём адрес проекта, а не внутренний адрес контейнера.
 */
export function publicOrigin(): string {
  try {
    return getSiteUrl();
  } catch {
    return DEFAULT_SITE_URL;
  }
}
