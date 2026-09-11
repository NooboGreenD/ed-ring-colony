import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { persistImportedDeliveries } from '@/lib/deliveryImport';

// Current browser/desktop clients send 100 rows. Keep a 500-row allowance for
// older helpers, while preventing an unbounded legacy payload from turning one
// serverless request into many sequential database batches.
const MAX_DELIVERIES_PER_REQUEST = 500;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Server delivery-import credentials are not configured');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const svc = getAdminClient();

    let body: Record<string, unknown> = {};
    try {
      const parsed = await req.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const deliveries = Array.isArray(body.deliveries) ? body.deliveries : [];
    if (deliveries.length > MAX_DELIVERIES_PER_REQUEST) {
      return NextResponse.json(
        { error: `Too many deliveries in one request (max ${MAX_DELIVERIES_PER_REQUEST})` },
        { status: 413 },
      );
    }
    const cmdr = typeof body.cmdr === 'string' ? body.cmdr.trim() : '';

    // Поддержка двух способов авторизации:
    // 1. API token (для Colonial Helper)
    // 2. Bearer token из Supabase session (для браузерной загрузки)
    let userId: string | null = null;

    const authHeader = req.headers.get('authorization') || '';
    const bearerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    const apiTokenStr = typeof body.token === 'string' ? body.token.trim() : '';

    if (bearerToken) {
      // Валидация Supabase session token
      const { data: { user }, error } = await svc.auth.getUser(bearerToken);
      if (error || !user) {
        return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
      }
      userId = user.id;
    } else if (apiTokenStr) {
      // Валидация API token (для Colonial Helper)
      const tokenHash = hashToken(apiTokenStr);
      const { data: apiToken, error: tokenError } = await svc
        .from('api_tokens')
        .select('user_id, is_revoked')
        .eq('token_hash', tokenHash)
        .maybeSingle();

      if (tokenError || !apiToken || apiToken.is_revoked) {
        return NextResponse.json({ error: 'Invalid or revoked token' }, { status: 401 });
      }
      userId = apiToken.user_id;
      // Обновляем last_used_at для API token. Do not make a successful upload
      // fail only because this non-critical bookkeeping update is delayed.
      void svc.from('api_tokens').update({ last_used_at: new Date().toISOString() }).eq('token_hash', tokenHash);
    } else {
      return NextResponse.json({ error: 'API token or session required' }, { status: 401 });
    }

    if (!userId) {
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 });
    }

    // Имя командира — только начальное значение для старого helper-клиента.
    // Уже сохранённый профиль не должен меняться при повторных batch-загрузках.
    if (cmdr) {
      const { data: profile, error: profileError } = await svc
        .from('profiles')
        .select('cmdr_name')
        .eq('id', userId)
        .maybeSingle();
      if (profileError) {
        console.warn('[logs/import] Could not inspect profile nickname:', profileError.message);
      } else if (!profile?.cmdr_name) {
        const { error: updateError } = await svc
          .from('profiles')
          .update({ cmdr_name: cmdr.slice(0, 250) })
          .eq('id', userId);
        if (updateError) console.warn('[logs/import] Could not initialise profile nickname:', updateError.message);
      }
    }

    const outcome = await persistImportedDeliveries(svc, userId, deliveries);
    return NextResponse.json(outcome);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not import deliveries';
    console.error('[logs/import] Failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
