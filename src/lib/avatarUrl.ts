/**
 * Адреса аватаров: почему без этого модуля картинки «не загружаются».
 *
 * Проект переезжал с Supabase Cloud на свой сервер
 * (`https://<ref>.supabase.co` → `https://supabase.edringcolony.ru`), а в
 * `profiles.avatar_url` остались полные адреса старого хоста. Файлы там больше
 * не отдаются, поэтому браузер показывает «битую» картинку у каждого пилота,
 * загруженного до переезда. Тот же эффект даёт смена схемы (http → https).
 *
 * Здесь чистая функция без сети и зависимостей: её зовут и клиентские
 * компоненты, и серверные маршруты, и тесты. Адрес не «чинится» в базе —
 * перезаписывать чужие строки миграцией опаснее, чем переписывать хост при
 * отображении: имя объекта в бакете одно и то же, меняется только источник.
 */

/** Публичные объекты Storage всегда лежат под этим префиксом. */
const STORAGE_PUBLIC_PREFIX = '/storage/v1/object/public/';
const STORAGE_SIGNED_PREFIX = '/storage/v1/object/sign/';

/** Адрес Supabase, настроенный для текущего стенда. */
export function configuredSupabaseUrl(
  value: string | null | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL,
): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Похож ли адрес на объект Supabase Storage (неважно, какого стенда).
 * Проверяется путь, а не хост: у self-hosted он произвольный.
 */
export function isSupabaseStorageUrl(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return pathname.startsWith(STORAGE_PUBLIC_PREFIX) || pathname.startsWith(STORAGE_SIGNED_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Привести адрес аватара к рабочему виду.
 *
 *  • пустые значения → `null` (компонент покажет инициалы, а не «битый» файл);
 *  • относительные пути (`/api/avatars/…`) и `data:` остаются как есть;
 *  • объект Storage со ЧУЖОГО хоста переписывается на текущий Supabase —
 *    это и чинит аватары, загруженные до переезда;
 *  • внешние картинки (Discord, Яндекс, Gravatar) не трогаются.
 */
export function resolveAvatarUrl(
  url: string | null | undefined,
  supabaseUrl: string | null = configuredSupabaseUrl(),
): string | null {
  const raw = (url ?? '').trim();
  if (!raw) return null;
  // Относительный путь или data-URL — отдаём как есть.
  if (raw.startsWith('/') || raw.startsWith('data:')) return raw;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!supabaseUrl || !isSupabaseStorageUrl(raw)) return raw;

  let target: URL;
  try {
    target = new URL(supabaseUrl);
  } catch {
    return raw;
  }
  if (parsed.origin === target.origin) return raw;

  // Тот же объект, но с текущего хоста: путь и параметры сохраняются.
  parsed.protocol = target.protocol;
  parsed.host = target.host;
  return parsed.toString();
}

/** Инициалы для запасной «плашки», когда картинки нет или она не открылась. */
export function avatarInitials(name: string | null | undefined): string {
  const clean = (name ?? '').trim();
  if (!clean) return '?';
  const words = clean.split(/[\s_.-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

/** Устойчивый цвет плашки по имени — чтобы пилоты различались без картинки. */
export function avatarColor(name: string | null | undefined): string {
  const clean = (name ?? '').trim() || '?';
  let hash = 0;
  for (let i = 0; i < clean.length; i += 1) hash = (hash * 31 + clean.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue} 45% 32%)`;
}
