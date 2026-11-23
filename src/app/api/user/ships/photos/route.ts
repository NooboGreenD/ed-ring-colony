import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabaseServer';
import { getPublicStorageUrl } from '@/lib/supabaseUrl';
import { userHasShipPhotoGallery } from '@/lib/billing/subscriptionBonus';
import { randomUUID } from 'node:crypto';
import { userShipPhotoObjectKey } from '@/lib/userShipPhotoStorage';
import { errorResponse } from '@/lib/billing/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_PHOTOS_PER_SHIP = 5;

function response(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return NextResponse.json(body, { ...init, headers });
}

/** GET — список фото пользователя для заданного корабля */
export async function GET(req: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return response({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const shipId = searchParams.get('ship_id');
    if (!shipId) {
      return response({ error: 'ship_id required' }, { status: 400 });
    }

    const { data: photos, error } = await supabase
      .from('user_ship_photos')
      .select('*')
      .eq('user_id', user.id)
      .eq('ship_id', shipId)
      .order('is_primary', { ascending: false })
      .order('uploaded_at', { ascending: false });

    if (error) return errorResponse(error, 500);

    return response({ photos: photos || [] });
  } catch (err: any) {
    return errorResponse(err);
  }
}

/** POST — загрузить фото пользователя для корабля (только премиум с перком) */
export async function POST(req: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return response({ error: 'Unauthorized' }, { status: 401 });
    }

    // Проверяем перк «Фото Галерея кораблей»
    const hasPerk = await userHasShipPhotoGallery(user.id);
    if (!hasPerk) {
      return response({ error: 'Требуется премиум-подписка с перком «Фото Галерея кораблей»' }, { status: 403 });
    }

    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const shipId = String(formData.get('ship_id') ?? '').trim();
    const isPrimary = formData.get('is_primary') === 'true';

    if (!(file instanceof File) || !/^[a-zA-Z0-9_-]{1,80}$/.test(shipId)) {
      return response({ error: 'file and ship_id required' }, { status: 400 });
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return response({ error: 'File type not allowed. Allowed: png, jpg, jpeg, webp, gif' }, { status: 400 });
    }
    if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
      return response({ error: 'File too large (max 10 MB)' }, { status: 400 });
    }

    // Authentication/perk checks above use the caller, never the service role.
    // Writes go through the server; direct metadata DML is revoked by migration.
    const service = createServiceClient();
    // Friendly fast-path; the database trigger also enforces this atomically.
    const { count, error: countError } = await service
      .from('user_ship_photos')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('ship_id', shipId);

    if (countError) return response({ error: 'Could not check photo quota' }, { status: 503 });
    if (count && count >= MAX_PHOTOS_PER_SHIP) {
      return response({ error: `Максимум ${MAX_PHOTOS_PER_SHIP} фото на один корабль` }, { status: 400 });
    }

    const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[file.type];
    const path = `user-photos/${user.id}/${shipId}/${randomUUID()}.${extension}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await service.storage.from('ship-images').upload(path, buffer, {
      contentType: file.type,
      upsert: false,
    });
    if (uploadError) {
      console.error('[user/ships/photos POST] Storage upload failed:', uploadError.message);
      return response({ error: 'Could not upload image' }, { status: 500 });
    }

    const publicUrl = getPublicStorageUrl('ship-images', path);

    // The insert trigger serializes quota and primary-photo changes together.
    const { data: photo, error } = await service
      .from('user_ship_photos')
      .insert({
        user_id: user.id,
        ship_id: shipId,
        image_url: publicUrl,
        is_primary: isPrimary,
      })
      .select()
      .single();

    if (error || !photo) {
      // Удаляем загруженный файл, если запись не создалась
      await service.storage.from('ship-images').remove([path]);
      if (error?.code === '23514') {
        return response({ error: `Максимум ${MAX_PHOTOS_PER_SHIP} фото на один корабль` }, { status: 400 });
      }
      return response({ error: 'Could not save photo record' }, { status: 500 });
    }

    return response({ success: true, photo }, { status: 201 });
  } catch (err: any) {
    return errorResponse(err);
  }
}

/** DELETE — удалить фото пользователя */
export async function DELETE(req: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return response({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const photoId = searchParams.get('photo_id');
    if (!photoId) {
      return response({ error: 'photo_id required' }, { status: 400 });
    }

    // Проверяем, что фото принадлежит пользователю
    const { data: photo, error: fetchError } = await supabase
      .from('user_ship_photos')
      .select('*')
      .eq('id', photoId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (fetchError || !photo) {
      return response({ error: 'Photo not found' }, { status: 404 });
    }

    // Never pass an arbitrary URL/key from metadata to a privileged client.
    const path = userShipPhotoObjectKey(photo.image_url, user.id);
    if (!path) return response({ error: 'Invalid photo storage path' }, { status: 409 });
    const service = createServiceClient();
    const { error: removeError } = await service.storage.from('ship-images').remove([path]);
    if (removeError) {
      return response({ error: 'Could not delete image; please retry' }, { status: 502 });
    }

    const { error } = await service.from('user_ship_photos').delete().eq('id', photoId).eq('user_id', user.id);
    if (error) return errorResponse(error, 500);

    return response({ success: true });
  } catch (err: any) {
    return errorResponse(err);
  }
}
