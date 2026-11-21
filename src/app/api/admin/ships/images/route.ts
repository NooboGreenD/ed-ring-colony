import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { getPublicSupabaseUrl } from '@/lib/supabaseUrl';
import { requireAdmin } from '@/lib/billing/auth';
import { readFileSync } from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function response(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return NextResponse.json(body, { ...init, headers });
}

/** GET — список всех кораблей с indication, есть ли у них картинка */
export async function GET() {
  try {
    const auth = await requireAdmin(new Request('http://localhost/api/admin/ships/images'));
    if ('response' in auth) return auth.response;
  } catch {
    return response({ error: 'Unauthorized' }, { status: 401 });
  }

  const svc = createServiceClient();

  // Загружаем каталог кораблей из локального файла public/data/outfitting.json
  let ships: Array<{ id: string; name: string; manufacturer: string }> = [];
  try {
    const filePath = path.join(process.cwd(), 'public', 'data', 'outfitting.json');
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    ships = Object.entries(data.ships || {}).map(([id, s]: [string, any]) => ({
      id,
      name: s.properties?.name || id,
      manufacturer: s.properties?.manufacturer || '',
    }));
  } catch {
    // ignore
  }

  // Проверяем, какие картинки уже загружены в bucket ship-images.
  // o.name приходит с префиксом bucket: "ship-images/cobra_mk_iii.png"
  // Извлекаем shipId (без префикса и расширения) и сохраняем расширение для URL.
  const { data: objects } = await svc.storage.from('ship-images').list('', { limit: 1000 });
  const uploadedIds = new Set<string>();
  const imageExts = new Map<string, string>();
  for (const o of (objects || [])) {
    const name = o.name;
    // Убираем префикс bucket и расширение
    const withoutPrefix = name.replace(/^ship-images\//, '');
    const shipId = withoutPrefix.replace(/\.(png|jpg|jpeg|webp|gif)$/i, '');
    const ext = name.match(/\.(png|jpg|jpeg|webp|gif)$/i)?.[1] || 'png';
    uploadedIds.add(shipId);
    imageExts.set(shipId, ext);
  }

  const result = ships.map((s) => {
    const has = uploadedIds.has(s.id);
    const ext = imageExts.get(s.id) || 'png';
    return {
      ...s,
      hasImage: has,
      imageExt: ext,
      imageUrl: has
        ? `${getPublicSupabaseUrl()}/storage/v1/object/public/ship-images/${s.id}.${ext}`
        : null,
    };
  });

  return response({ ships: result });
}

/** POST — загрузить картинку корабля */
export async function POST(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
  } catch {
    return response({ error: 'Unauthorized' }, { status: 401 });
  }

  const svc = createServiceClient();
  const formData = await req.formData();
  const file = formData.get('file') as File | null;
  const shipId = String(formData.get('ship_id') ?? '').trim();

  if (!(file instanceof File) || !shipId) {
    return response({ error: 'file and ship_id required' }, { status: 400 });
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return response({ error: 'File type not allowed. Allowed: png, jpg, jpeg, webp, gif' }, { status: 400 });
  }
  if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
    return response({ error: 'File too large (max 10 MB)' }, { status: 400 });
  }

  // Всегда сохраняем как .png, чтобы shipImageUrlFromStorage() (используемую
  // на stronie корабля и в верфи) с хардкодом .png работала корректно.
  const extension = 'png';
  const path = `ship-images/${shipId}.${extension}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await svc.storage.from('ship-images').upload(path, buffer, {
    contentType: file.type,
    upsert: true,
  });
  if (uploadError) {
    console.error('[admin/ships/images POST] Storage upload failed:', uploadError.message);
    return response({ error: 'Could not upload image' }, { status: 500 });
  }

  const publicUrl = `${getPublicSupabaseUrl()}/storage/v1/object/public/${path}`;
  return response({ success: true, shipId, imageUrl: publicUrl, path }, { status: 201 });
}

/** DELETE — удалить картинку корабля */
export async function DELETE(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
  } catch {
    return response({ error: 'Unauthorized' }, { status: 401 });
  }

  const svc = createServiceClient();
  const { searchParams } = new URL(req.url);
  const shipId = searchParams.get('ship_id');
  const extension = searchParams.get('ext') || 'png';

  if (!shipId) {
    return response({ error: 'ship_id required' }, { status: 400 });
  }

  const path = `ship-images/${shipId}.${extension}`;
  const { error } = await svc.storage.from('ship-images').remove([path]);
  if (error) {
    console.error('[admin/ships/images DELETE] Storage delete failed:', error.message);
    return response({ error: 'Could not delete image' }, { status: 500 });
  }

  return response({ success: true, shipId });
}
