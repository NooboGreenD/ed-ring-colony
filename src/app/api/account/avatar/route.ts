import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { uploadImageToStorage } from '@/lib/imageStorage';
import { AVATAR_MAX_BYTES } from '@/lib/imageLimits';

export const dynamic = 'force-dynamic';

/**
 * Смена аватара пилота.
 *
 * Почему через сайт, а не напрямую в Storage. Раньше браузер грузил файл
 * прямо в `supabase.<домен>/storage/v1/...`. Когда контейнер storage не
 * поднят (или Kong не видит живой upstream), шлюз отвечает **503 Service
 * Unavailable**, SDK показывал голый текст ошибки, и сменить аватар было
 * нельзя вообще. Теперь:
 *
 *   1. файл проверяется на сервере (тип, размер, непустое содержимое);
 *   2. сначала пробуем Storage — бакет создаётся, если его нет;
 *   3. если Storage недоступен, картинка сохраняется в базе
 *      (`profile_avatars`) и отдаётся маршрутом `/api/avatars/<id>`;
 *   4. `profiles.avatar_url` обновляется в обоих случаях.
 *
 * То есть авария хранилища больше не мешает пилоту поменять аватар, а
 * администратор видит в ответе (`storage: 'database'`), что Storage лежит.
 */

const BUCKET = 'avatars';
const MAX_BYTES = AVATAR_MAX_BYTES;
const ALLOWED: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  let user;
  try {
    ({ user } = await authFromRequest(req));
  } catch {
    user = null;
  }
  if (!user) return json({ error: 'Войдите в аккаунт' }, 401);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: 'Ожидается форма с файлом' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) return json({ error: 'Файл не передан' }, 400);
  if (file.size <= 0) return json({ error: 'Файл пустой' }, 400);
  if (file.size > MAX_BYTES) {
    return json({ error: `Файл больше ${MAX_BYTES / 1024 / 1024} МБ — уменьшите картинку` }, 413);
  }

  const mime = (file.type || '').toLowerCase();
  const ext = ALLOWED[mime];
  if (!ext) return json({ error: 'Поддерживаются JPG, PNG, WebP и GIF' }, 415);

  const buffer = Buffer.from(await file.arrayBuffer());
  // Размер из заголовка мультипарта мог соврать — проверяем фактический.
  if (buffer.byteLength <= 0 || buffer.byteLength > MAX_BYTES) {
    return json({ error: `Файл больше ${MAX_BYTES / 1024 / 1024} МБ — уменьшите картинку` }, 413);
  }

  const svc = createServiceClient();
  const checksum = createHash('sha256').update(buffer).digest('hex');
  const path = `${user.id}/${Date.now()}.${ext}`;

  const stored = await uploadImageToStorage(svc, BUCKET, MAX_BYTES, path, buffer, mime);
  let avatarUrl = stored.url;
  let backend: 'storage' | 'database' = 'storage';
  let warning: string | null = null;

  if (!avatarUrl) {
    // ── Запасной путь: картинка в базе ────────────────────────────
    const { error: dbError } = await svc.from('profile_avatars').upsert(
      {
        user_id: user.id,
        mime,
        // PostgREST принимает bytea в hex-формате `\x…`.
        bytes: `\\x${buffer.toString('hex')}`,
        byte_size: buffer.byteLength,
        checksum,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );

    if (dbError) {
      console.error('[account/avatar] storage:', stored.error, '| database:', dbError.message);
      const detail = stored.unavailable
        ? 'хранилище картинок недоступно, и резервное сохранение в БД не удалось — администратору нужно проверить БД и миграции'
        : stored.error;
      return json({ error: `Не удалось сохранить аватар: ${detail}` }, 502);
    }

    backend = 'database';
    avatarUrl = `/api/avatars/${user.id}?v=${checksum.slice(0, 12)}`;
    warning = stored.unavailable
      ? 'Supabase Storage сейчас недоступен — аватар сохранён в базе сайта. Картинка работает, но администратору стоит проверить контейнер storage.'
      : `Storage отклонил загрузку (${stored.error}) — аватар сохранён в базе сайта.`;
    console.warn('[account/avatar] fallback to database:', stored.error);
  }

  const { error: profileError } = await svc
    .from('profiles')
    .update({ avatar_url: avatarUrl })
    .eq('id', user.id);
  if (profileError) {
    console.error('[account/avatar] profile update:', profileError.message);
    return json({ error: `Аватар загружен, но профиль не обновлён: ${profileError.message}` }, 500);
  }

  return json({ avatarUrl, storage: backend, warning });
}

/** Убрать аватар: и ссылку в профиле, и запасную копию в базе. */
export async function DELETE(req: NextRequest) {
  let user;
  try {
    ({ user } = await authFromRequest(req));
  } catch {
    user = null;
  }
  if (!user) return json({ error: 'Войдите в аккаунт' }, 401);

  const svc = createServiceClient();
  const { error } = await svc.from('profiles').update({ avatar_url: null }).eq('id', user.id);
  if (error) return json({ error: error.message }, 500);
  // Ошибку удаления запасной копии не показываем: профиль уже без аватара.
  await svc.from('profile_avatars').delete().eq('user_id', user.id);
  return json({ avatarUrl: null });
}
