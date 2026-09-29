import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { getPublicSupabaseUrl } from '@/lib/supabaseUrl';
import { getSquadronMembership } from '@/lib/squadronData';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BUCKET = 'squadron-media';
const ALLOWED: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const LIMITS = { logo: 2 * 1024 * 1024, banner: 6 * 1024 * 1024 } as const;
type Kind = keyof typeof LIMITS;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function canEdit(req: Request, squadronId: number) {
  const { user, supabase } = await authFromRequest(req);
  if (!user) return { ok: false as const, status: 401, error: 'Войдите в аккаунт' };
  const [{ data: squadron }, membership] = await Promise.all([
    supabase.from('squadrons').select('created_by').eq('id', squadronId).maybeSingle(),
    getSquadronMembership(supabase, squadronId, user.id),
  ]);
  if (!squadron) return { ok: false as const, status: 404, error: 'Эскадрилья не найдена' };
  if (squadron.created_by !== user.id && !membership?.can_edit_squadron) {
    return { ok: false as const, status: 403, error: 'Нет права редактировать оформление эскадрильи' };
  }
  return { ok: true as const, user };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const squadronId = Number.parseInt((await params).id, 10);
  if (!Number.isSafeInteger(squadronId) || squadronId <= 0) return json({ error: 'Not found' }, 404);
  const access = await canEdit(req, squadronId);
  if (!access.ok) return json({ error: access.error }, access.status);

  const form = await req.formData().catch(() => null);
  const kind = String(form?.get('kind') ?? '') as Kind;
  const file = form?.get('file');
  if (!Object.hasOwn(LIMITS, kind)) return json({ error: 'kind должен быть logo или banner' }, 400);
  if (!(file instanceof File) || file.size <= 0) return json({ error: 'Выберите изображение' }, 400);
  const ext = ALLOWED[file.type.toLowerCase()];
  if (!ext) return json({ error: 'Поддерживаются JPG, PNG, WebP и GIF' }, 415);
  if (file.size > LIMITS[kind]) return json({ error: `${kind === 'logo' ? 'Логотип' : 'Фон'} слишком большой` }, 413);

  const bytes = Buffer.from(await file.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const path = `${squadronId}/${kind}-${hash}.${ext}`;
  const svc = createServiceClient();
  let result = await svc.storage.from(BUCKET).upload(path, bytes, { contentType: file.type, upsert: true });
  if (result.error && /bucket not found/i.test(result.error.message)) {
    const created = await svc.storage.createBucket(BUCKET, { public: true, fileSizeLimit: `${LIMITS.banner}` });
    if (!created.error) result = await svc.storage.from(BUCKET).upload(path, bytes, { contentType: file.type, upsert: true });
  }
  if (result.error) return json({ error: `Не удалось сохранить изображение: ${result.error.message}` }, 502);

  const url = `${getPublicSupabaseUrl()}/storage/v1/object/public/${BUCKET}/${path}`;
  const column = kind === 'logo' ? 'logo_url' : 'banner_url';
  const { data, error } = await svc.from('squadrons').update({ [column]: url }).eq('id', squadronId).select('*').single();
  if (error) return json({ error: error.message }, 500);
  return json({ squadron: data, kind, url });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const squadronId = Number.parseInt((await params).id, 10);
  if (!Number.isSafeInteger(squadronId) || squadronId <= 0) return json({ error: 'Not found' }, 404);
  const access = await canEdit(req, squadronId);
  if (!access.ok) return json({ error: access.error }, access.status);
  const kind = new URL(req.url).searchParams.get('kind') as Kind;
  if (!Object.hasOwn(LIMITS, kind)) return json({ error: 'kind должен быть logo или banner' }, 400);
  const svc = createServiceClient();
  const column = kind === 'logo' ? 'logo_url' : 'banner_url';
  const { data, error } = await svc.from('squadrons').update({ [column]: null }).eq('id', squadronId).select('*').single();
  if (error) return json({ error: error.message }, 500);
  return json({ squadron: data, kind, url: null });
}
