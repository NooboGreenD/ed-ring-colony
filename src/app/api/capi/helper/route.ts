import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { getServerSupabaseUrl } from '@/lib/supabaseServerUrl';
import { checkRateLimit } from '@/lib/rateLimit';
import { markCapiTokenBroken, syncCapiPilot } from '@/lib/capi/syncPilot';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
};

function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim() || 'local';
  return req.headers.get('x-real-ip')?.trim() || 'local';
}

function unauthorized(req: Request) {
  if (!checkRateLimit(`capi-helper-unauth:${clientIp(req)}`, 10)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: HEADERS });
  }
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: HEADERS });
}

function serviceClient() {
  const url = getServerSupabaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Server credentials are not configured');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function resolveHelperUser(req: Request, svc: ReturnType<typeof serviceClient>): Promise<string | null> {
  const auth = req.headers.get('authorization') || '';
  const match = auth.match(/^Bearer\s+([^\s]+)$/i);
  const token = match?.[1] ?? '';
  // Website session JWTs are not project API tokens. Helper must authenticate
  // only with its revocable project token; Frontier credentials never cross here.
  if (!token || token.includes('.')) return null;

  const hash = createHash('sha256').update(token).digest('hex');
  const { data } = await svc
    .from('api_tokens')
    .select('user_id, is_revoked')
    .eq('token_hash', hash)
    .maybeSingle();
  return data && !data.is_revoked ? data.user_id : null;
}

async function readBinding(svc: ReturnType<typeof serviceClient>, userId: string) {
  const [{ data: token }, { data: profile }] = await Promise.all([
    svc.from('capi_tokens')
      .select('is_active, platform, cmdr_name, expires_at, last_synced_at, last_error')
      .eq('user_id', userId)
      .maybeSingle(),
    svc.from('capi_profiles')
      .select('cmdr_name, credits, loan, combat_rank, trade_rank, explore_rank, empire_rank, federation_rank, cqc_rank, mercenary_rank, exobiologist_rank, current_ship, current_system, current_station, ships, last_updated')
      .eq('user_id', userId)
      .maybeSingle(),
  ]);
  return {
    linked: Boolean(token),
    active: Boolean(token && token.is_active !== false),
    platform: token?.platform ?? null,
    cmdrName: profile?.cmdr_name ?? token?.cmdr_name ?? null,
    expiresAt: token?.expires_at ?? null,
    lastSyncedAt: token?.last_synced_at ?? profile?.last_updated ?? null,
    lastError: token?.last_error ?? null,
    profile: profile ?? null,
  };
}

export async function GET(req: Request) {
  try {
    const svc = serviceClient();
    const userId = await resolveHelperUser(req, svc);
    if (!userId) return unauthorized(req);
    const binding = await readBinding(svc, userId);
    return NextResponse.json(binding, { headers: HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed';
    console.error('[CAPI Helper GET]', message);
    return NextResponse.json({ error: message }, { status: 500, headers: HEADERS });
  }
}

export async function POST(req: Request) {
  try {
    const svc = serviceClient();
    const userId = await resolveHelperUser(req, svc);
    if (!userId) return unauthorized(req);

    const { data: tokenRow, error: tokenError } = await svc
      .from('capi_tokens')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (tokenError) {
      console.error('[CAPI Helper] token read', tokenError);
      return NextResponse.json({ error: tokenError.message }, { status: 500, headers: HEADERS });
    }
    if (!tokenRow || tokenRow.is_active === false) {
      return NextResponse.json({
        error: 'Сначала привяжите Frontier CAPI в личном кабинете сайта',
        needsSiteLink: true,
      }, { status: 403, headers: HEADERS });
    }

    // CAPI is intentionally serialized behind the website-owned binding. No
    // refresh/access token is accepted from or returned to Colonial Helper.
    if (!checkRateLimit(`capi-helper-sync:${userId}`, 1)) {
      return NextResponse.json({ error: 'Синхронизация CAPI доступна не чаще раза в минуту' }, { status: 429, headers: HEADERS });
    }

    // Helper already uploads local Journal files through the project API.
    // Do a single current-profile request here: don't re-poll CAPI Journal or
    // the optional Community Goals catalogue from the desktop action.
    const result = await syncCapiPilot(svc, userId, tokenRow, {
      skipJournal: true,
      skipCommunityGoals: true,
    });
    for (const warning of result.warnings) console.warn('[CAPI Helper]', warning);
    if (!result.ok) {
      if (result.needsReauth) {
        await markCapiTokenBroken(svc, userId, result.error || 'Frontier отклонил токен');
      }
      return NextResponse.json({
        error: result.error || 'Синхронизация CAPI не удалась',
        needsReauth: result.needsReauth,
        reason: result.reason,
        kind: result.errorKind,
        status: result.httpStatus,
        endpoint: result.endpoint,
        host: result.host,
        platform: result.platform,
        detail: result.detail,
        warnings: result.warnings,
      }, { status: result.needsReauth ? 401 : 502, headers: HEADERS });
    }

    const binding = await readBinding(svc, userId);
    return NextResponse.json({
      ok: true,
      cmdrName: result.cmdrName,
      profileSaved: result.profileSaved,
      journalStatus: result.journalStatus,
      eventsImported: result.eventsImported,
      eventsDuplicate: result.eventsDuplicate,
      eventsSkipped: result.eventsSkipped,
      warnings: result.warnings,
      binding: result.binding,
      profile: binding.profile,
    }, { headers: HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed';
    console.error('[CAPI Helper POST]', message);
    return NextResponse.json({ error: message }, { status: 500, headers: HEADERS });
  }
}
