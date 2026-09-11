import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { persistImportedDeliveries } from '@/lib/deliveryImport';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const svc = getAdminClient();

  let body: any = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const token = String(body.token ?? '').trim();
  const deliveries: any[] = body.deliveries || [];
  const cmdr: string | undefined = body.cmdr;

  if (!token) {
    return NextResponse.json({ error: 'API token required' }, { status: 401 });
  }

  // Валидируем токен
  const tokenHash = hashToken(token);
  const { data: apiToken } = await svc
    .from('api_tokens')
    .select('user_id, is_revoked')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (!apiToken || apiToken.is_revoked) {
    return NextResponse.json({ error: 'Invalid or revoked token' }, { status: 401 });
  }

  const userId = apiToken.user_id;

  // Обновляем last_used_at
  await svc.from('api_tokens').update({ last_used_at: new Date().toISOString() }).eq('token_hash', tokenHash);

  // Обновляем cmdr_name если передан
  if (cmdr) {
    const { data: profile } = await svc.from('profiles').select('cmdr_name').eq('id', userId).single();
    if (!profile?.cmdr_name) {
      await svc.from('profiles').update({ cmdr_name: cmdr }).eq('id', userId);
    }
  }

  try {
    const outcome = await persistImportedDeliveries(svc, userId, deliveries);
    return NextResponse.json(outcome);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not import deliveries';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
