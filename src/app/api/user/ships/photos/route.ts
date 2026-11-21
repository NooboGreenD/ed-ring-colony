import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { getPublicStorageUrl } from '@/lib/supabaseUrl';
import { userHasShipPhotoGallery } from '@/lib/billing/subscriptionBonus';
import { billingRepo } from '@/lib/billingData';
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

    if (!(file instanceof File) || !shipId) {
      return response({ error: 'file and ship_id required' }, { status: 400 });
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return response({ error: 'File type not allowed. Allowed: png, jpg, jpeg, webp, gif' }, { status: 400 });
    }
    if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
      return response({ error: 'File too large (max 10 MB)' }, { status: 400 });
    }

    // Проверяем лимит фото на корабль
    const { count } = await supabase
      .from('user_ship_photos')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('ship_id', shipId);

    if (count && count >= MAX_PHOTOS_PER_SHIP) {
      return response({ error: `Максимум ${MAX_PHOTOS_PER_SHIP} фото на один корабль` }, { status: 400 });
    }

    const extension = file.name.split('.').pop()?.toLowerCase() || 'png';
    const path = `user-photos/${user.id}/${shipId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extension}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await supabase.storage.from('ship-images').upload(path, buffer, {
      contentType: file.type,
      upsert: false,
    });
    if (uploadError) {
      console.error('[user/ships/photos POST] Storage upload failed:', uploadError.message);
      return response({ error: 'Could not upload image' }, { status: 500 });
    }

    const publicUrl = getPublicStorageUrl('ship-images', path);

    // Если помечаем как основное — снимаем флаг с остальных
    if (isPrimary) {
      await supabase
        .from('user_ship_photos')
        .update({ is_primary: false })
        .eq('user_id', user.id)
        .eq('ship_id', shipId);
    }

    const { data: photo, error } = await supabase
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
      await supabase.storage.from('ship-images').remove([path]);
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

    // Удаляем файл из Storage
    const path = photo.image_url.split('/storage/v1/object/public/').pop() || '';
    if (path) {
      await supabase.storage.from('ship-images').remove([path]);
    }

    const { error } = await supabase.from('user_ship_photos').delete().eq('id', photoId);
    if (error) return errorResponse(error, 500);

    return response({ success: true });
  } catch (err: any) {
    return errorResponse(err);
  }
}
