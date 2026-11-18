import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { z } from 'zod';
import { getAtlasFavoritesLimit } from '@/lib/billing/subscriptionBonus';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';
const favoriteSchema = z.object({
  candidate_id: z.string().uuid().optional(),
  search_id: z.string().uuid().optional(),
  system_name: z.string().min(1),
  x: z.number(), y: z.number(), z: z.number(),
  world_type: z.string(),
  body_name: z.string().optional(),
  note: z.string().max(500).optional(),
});

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('atlas_favorites')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ favorites: data || [] });
}

export async function POST(req: Request) {
  const t = await apiTranslate();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const parse = favoriteSchema.safeParse(body);
  if (!parse.success) return NextResponse.json({ error: 'Invalid data', details: parse.error.flatten() }, { status: 400 });

  // Лимит избранных систем в Атласе зависит от активной подписки пилота.
  const limit = await getAtlasFavoritesLimit(user.id);
  if (limit !== null) {
    const { count } = await supabase
      .from('atlas_favorites')
      .select('*', { head: true, count: 'exact' })
      .eq('user_id', user.id);
    if ((count || 0) >= limit) {
      return NextResponse.json(
        {
          error: t('api.favoritesLimitReached', { limit }),
          code: 'favorites_limit_reached',
          limit,
        },
        { status: 403 },
      );
    }
  }

  const { data, error } = await supabase
    .from('atlas_favorites')
    .insert({ ...parse.data, user_id: user.id })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ favorite: data, favorites_limit: limit });
}

export async function DELETE(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { error } = await supabase.from('atlas_favorites').delete().eq('id', id).eq('user_id', user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
