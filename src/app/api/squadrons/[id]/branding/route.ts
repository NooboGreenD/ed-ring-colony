import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { uploadImageToStorage } from '@/lib/imageStorage';
import { SQUADRON_IMAGE_LIMITS } from '@/lib/imageLimits';
import { getSquadronMembership } from '@/lib/squadronData';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BUCKET = 'squadron-media';
const ALLOWED: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const LIMITS = SQUADRON_IMAGE_LIMITS;
type Kind = keyof typeof LIMITS;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function canEdit(req: Request, squadronId: number, t: (key: string) => string) {
  const { user, supabase } = await authFromRequest(req);
  if (!user) return { ok: false as const, status: 401, error: t('api.signInRequired') };
  const [{ data: squadron }, membership] = await Promise.all([
    supabase.from('squadrons').select('created_by').eq('id', squadronId).maybeSingle(),
    getSquadronMembership(supabase, squadronId, user.id),
  ]);
  if (!squadron) return { ok: false as const, status: 404, error: t('api.squadronNotFound') };
  if (squadron.created_by !== user.id && !membership?.can_edit_squadron) {
    return { ok: false as const, status: 403, error: t('api.squadronBrandingDenied') };
  }
  return { ok: true as const, user };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await apiTranslate();
  const squadronId = Number((await params).id);
  if (!Number.isSafeInteger(squadronId) || squadronId <= 0) return json({ error: 'Not found' }, 404);
  const access = await canEdit(req, squadronId, t);
  if (!access.ok) return json({ error: access.error }, access.status);

  const form = await req.formData().catch(() => null);
  const kind = String(form?.get('kind') ?? '') as Kind;
  const file = form?.get('file');
  if (!Object.hasOwn(LIMITS, kind)) return json({ error: t('api.brandingKind') }, 400);
  if (!(file instanceof File) || file.size <= 0) return json({ error: t('api.chooseImage') }, 400);
  const ext = ALLOWED[file.type.toLowerCase()];
  if (!ext) return json({ error: t('api.avatarFormats') }, 415);
  if (file.size > LIMITS[kind]) return json({ error: `${kind === 'logo' ? t('sq.logoTooLarge') : t('sq.backgroundTooLarge')}` }, 413);

  const bytes = Buffer.from(await file.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  const path = `${squadronId}/${kind}-${hash}.${ext}`;
  const svc = createServiceClient();
  const stored = await uploadImageToStorage(svc, BUCKET, LIMITS.banner, path, bytes, file.type.toLowerCase());
  let url = stored.url;
  let storage: 'storage' | 'database' = 'storage';
  let warning: string | undefined;
  if (!url) {
    try {
      const { error } = await svc.from('squadron_images').upsert({
        squadron_id: squadronId, kind, mime: file.type.toLowerCase(),
        bytes: `\\x${bytes.toString('hex')}`, byte_size: bytes.byteLength,
        checksum: hash, updated_at: new Date().toISOString(),
      }, { onConflict: 'squadron_id,kind' });
      if (error) throw new Error(error.message);
    } catch (error) {
      console.error('[squadron branding] storage:', stored.error, '| database:', error);
      return json({ error: t('api.brandingSaveFailed') }, 503);
    }
    storage = 'database';
    url = `/api/squadrons/${squadronId}/images/${kind}?v=${hash}`;
    warning = 'Supabase Storage недоступен или отклонил загрузку — изображение сохранено в базе сайта. Администратору нужно проверить Storage.';
    console.warn('[squadron branding] fallback to database:', stored.error);
  }
  const column = kind === 'logo' ? 'logo_url' : 'banner_url';
  const { data, error } = await svc.from('squadrons').update({ [column]: url }).eq('id', squadronId).select('*').single();
  if (error) return json({ error: error.message }, 500);
  return json({ squadron: data, kind, url, storage, warning });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await apiTranslate();
  const squadronId = Number((await params).id);
  if (!Number.isSafeInteger(squadronId) || squadronId <= 0) return json({ error: 'Not found' }, 404);
  const access = await canEdit(req, squadronId, t);
  if (!access.ok) return json({ error: access.error }, access.status);
  const kind = new URL(req.url).searchParams.get('kind') as Kind;
  if (!Object.hasOwn(LIMITS, kind)) return json({ error: t('api.brandingKind') }, 400);
  const svc = createServiceClient();
  const column = kind === 'logo' ? 'logo_url' : 'banner_url';
  const { data, error } = await svc.from('squadrons').update({ [column]: null }).eq('id', squadronId).select('*').single();
  if (error) return json({ error: error.message }, 500);
  // Ссылка уже убрана; сбой очистки не должен отменять удаление в интерфейсе.
  try {
    const { error: cleanupError } = await svc.from('squadron_images').delete().eq('squadron_id', squadronId).eq('kind', kind);
    if (cleanupError) console.warn('[squadron branding] cleanup:', cleanupError.message);
  } catch (error) { console.warn('[squadron branding] cleanup:', error); }
  return json({ squadron: data, kind, url: null });
}
