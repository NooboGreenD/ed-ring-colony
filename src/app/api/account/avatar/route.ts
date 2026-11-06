import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { uploadImageToStorage } from '@/lib/imageStorage';
import { AVATAR_MAX_BYTES } from '@/lib/imageLimits';
import { apiTranslate } from '@/lib/i18n/apiT';

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
  const t = await apiTranslate();
  let user;
  try {
    ({ user } = await authFromRequest(req));
  } catch {
    user = null;
  }
  if (!user) return json({ error: t('api.signInRequired') }, 401);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: t('api.formWithFileExpected') }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) return json({ error: t('api.fileMissing') }, 400);
  if (file.size <= 0) return json({ error: t('api.fileEmpty') }, 400);
  if (file.size > MAX_BYTES) {
    return json({ error: t('api.fileTooLarge', { size: Math.round(MAX_BYTES / 1024 / 1024) }) }, 413);
  }

  const mime = (file.type || '').toLowerCase();
  const ext = ALLOWED[mime];
  if (!ext) return json({ error: t('api.avatarFormats') }, 415);

  const buffer = Buffer.from(await file.arrayBuffer());
  // Размер из заголовка мультипарта мог соврать — проверяем фактический.
  if (buffer.byteLength <= 0 || buffer.byteLength > MAX_BYTES) {
    return json({ error: t('api.fileTooLarge', { size: Math.round(MAX_BYTES / 1024 / 1024) }) }, 413);
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
        ? t('api.storageDownFallbackFailed')
        : stored.error;
      return json({ error: t('api.avatarSaveFailed', { detail: detail ?? '' }) }, 502);
    }

    backend = 'database';
    avatarUrl = `/api/avatars/${user.id}?v=${checksum.slice(0, 12)}`;
    warning = stored.unavailable
      ? t('api.storageDownAvatarInDb')
      : t('api.storageRejectedAvatarInDb', { reason: stored.error ?? '' });
    console.warn('[account/avatar] fallback to database:', stored.error);
  }

  const { error: profileError } = await svc
    .from('profiles')
    .update({ avatar_url: avatarUrl })
    .eq('id', user.id);
  if (profileError) {
    console.error('[account/avatar] profile update:', profileError.message);
    return json({ error: t('api.avatarProfileFailed', { detail: profileError.message }) }, 500);
  }

  return json({ avatarUrl, storage: backend, warning });
}

/** Убрать аватар: и ссылку в профиле, и запасную копию в базе. */
export async function DELETE(req: NextRequest) {
  const t = await apiTranslate();
  let user;
  try {
    ({ user } = await authFromRequest(req));
  } catch {
    user = null;
  }
  if (!user) return json({ error: t('api.signInRequired') }, 401);

  const svc = createServiceClient();
  const { error } = await svc.from('profiles').update({ avatar_url: null }).eq('id', user.id);
  if (error) return json({ error: error.message }, 500);
  // Ошибку удаления запасной копии не показываем: профиль уже без аватара.
  await svc.from('profile_avatars').delete().eq('user_id', user.id);
  return json({ avatarUrl: null });
}
