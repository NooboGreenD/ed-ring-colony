import { NextResponse } from 'next/server';
import { authFromRequest } from '@/lib/supabaseServer';

/** No host-based or BILLING_PREVIEW_ADMIN override for catalogue writes. */
export async function requireCatalogAdmin(request: Request): Promise<
  { actor: string } | { response: NextResponse }
> {
  const { user, supabase } = await authFromRequest(request);
  if (!user) {
    // Allow a usable local sandbox, but never grant anonymous access to a
    // configured database or to a production server, even on a preview host.
    if (process.env.NODE_ENV === 'development' && !process.env.SUPABASE_SERVICE_ROLE_KEY && !request.headers.has('authorization')) {
      return { actor: 'CMDR Preview (local)' };
    }
    return { response: NextResponse.json({ error: 'Требуется авторизация' }, { status: 401, headers: { 'Cache-Control': 'no-store' } }) };
  }
  const { data, error } = await supabase.from('profiles').select('role,cmdr_name').eq('id', user.id).maybeSingle();
  if (error) return { response: NextResponse.json({ error: 'Не удалось проверить права доступа' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) };
  if (data?.role !== 'admin') return { response: NextResponse.json({ error: 'Управление верфью доступно только администратору' }, { status: 403, headers: { 'Cache-Control': 'no-store' } }) };
  return { actor: data.cmdr_name || user.id };
}
