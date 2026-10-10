import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getServerSupabaseUrl } from '@/lib/supabaseServerUrl';
import { createHash } from 'crypto';
import { authFromRequest } from '@/lib/supabaseServer';
import { fetchFrontierIdentity } from '@/lib/capi/oauth';
import { upsertResilient, schemaWarning } from '@/lib/capi/persist';
import { capiSession } from '@/lib/capi/session';
import { markCapiTokenBroken, syncCapiPilot } from '@/lib/capi/syncPilot';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Обмен привязкой Frontier CAPI между Colonial Helper и сайтом.
 *
 * Зачем: у сайта и приложения были два независимых токена Frontier. Оба
 * протухают после 25 дней без обновления, поэтому пилоты постоянно проходили
 * вход у Frontier заново («синхронизация всё время через логин-пароль»), а
 * платформа, выбранная в одном месте, не появлялась в другом. Теперь токены
 * одни:
 *
 *   • `GET`  — Helper забирает живую привязку с сайта (сайт продлевает её
 *     расписанием `capi-sync`), когда собственная истекла;
 *   • `POST` — Helper делится свежей авторизацией: сайт сохраняет её и сразу
 *     подтягивает профиль командира.
 *
 * Авторизация — как у загрузки журналов: API-токен Helper'а или сессия сайта.
 * Токены Frontier видит только их владелец.
 */

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function getServiceClient() {
  const url = getServerSupabaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Server credentials are not configured');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/** API-токен Helper'а или сессия сайта → UUID пилота. */
async function resolveUserId(
  req: Request,
  svc: ReturnType<typeof getServiceClient>,
  bodyToken = '',
): Promise<string | null> {
  const candidates: string[] = [];
  const url = new URL(req.url);
  const queryToken = url.searchParams.get('token')?.trim() || '';
  if (queryToken) candidates.push(queryToken);
  if (bodyToken) candidates.push(bodyToken);
  const authHeader = req.headers.get('authorization') || '';
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  // JWT сессии Supabase содержит точки, API-токен Helper'а — нет.
  if (bearerToken && !bearerToken.includes('.')) candidates.push(bearerToken);

  for (const candidate of candidates) {
    const { data: apiToken } = await svc
      .from('api_tokens')
      .select('user_id, is_revoked')
      .eq('token_hash', hashToken(candidate))
      .maybeSingle();
    if (apiToken && !apiToken.is_revoked) return apiToken.user_id;
  }

  try {
    const { user } = await authFromRequest(req);
    if (user) return user.id;
  } catch {
    // сессии нет — ниже честный 401
  }
  return null;
}

export async function GET(req: Request) {
  try {
    const svc = getServiceClient();
    const userId = await resolveUserId(req, svc);
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: token } = await svc
      .from('capi_tokens')
      .select('access_token, refresh_token, expires_at, is_active, platform, cmdr_name')
      .eq('user_id', userId)
      .maybeSingle();

    // Сломанную привязку (отозванный refresh, аккаунт без игры) не отдаём:
    // Helper'у она не поможет, а просить заново входить должен сайт.
    if (!token?.refresh_token || token.is_active === false) {
      return NextResponse.json({ ok: false, error: 'No active CAPI binding' }, { status: 404 });
    }

    // Access-токен мог истечь: продлеваем его сами (сессия устойчива к
    // параллельным обновлениям), чтобы Helper получил ЖИВОЙ токен. Иначе
    // приложение обновляло бы токен своим refresh'ем — refresh-токен
    // одноразовый, и расход его приложением убил бы копию сайта до
    // ближайшего синка по расписанию.
    let { access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt } = token;
    try {
      const session = await capiSession(svc, userId, token);
      ({ access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt } = session.tokens);
    } catch (sessionError) {
      // Не смертельно: отдадим ту пару, что есть — Helper обновит её сам.
      console.warn('[CAPI Token GET] proactive refresh skipped:', (sessionError as Error).message);
    }

    return NextResponse.json({
      ok: true,
      tokens: {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        platform: token.platform,
        cmdr_name: token.cmdr_name,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed';
    console.error('[CAPI Token GET]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const svc = getServiceClient();
    let body: Record<string, unknown> = {};
    try {
      const parsed = await req.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const apiToken = typeof body.token === 'string' ? body.token.trim() : '';
    const userId = await resolveUserId(req, svc, apiToken);
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const accessToken = typeof body.access_token === 'string' ? body.access_token.trim() : '';
    const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token.trim() : '';
    if (accessToken.length < 20 || refreshToken.length < 20) {
      return NextResponse.json({ error: 'access_token/refresh_token required' }, { status: 400 });
    }

    // Срок действия: верим Helper'у в разумных пределах, иначе считаем
    // стандартные 4 часа Frontier.
    const expiresIn = Number.isFinite(Number(body.expires_in))
      ? Math.min(Math.max(Math.trunc(Number(body.expires_in)), 60), 31 * 24 * 60 * 60)
      : 14400;
    const obtainedAt = Number.isFinite(Number(body.obtained_at))
      ? Number(body.obtained_at)
      : Date.now() / 1000;
    const expiresAtMs = Math.min(
      Date.now() + 31 * 24 * 60 * 60 * 1000,
      Math.max(Date.now() + 60_000, obtainedAt * 1000 + expiresIn * 1000),
    );

    // Чей это токен: Frontier ID нужен для проверки «аккаунт уже привязан
    // к другой учётке», платформа — для честной диагностики в интерфейсе.
    const identity = await fetchFrontierIdentity(accessToken);
    if (identity?.frontierId) {
      const { data: clash } = await svc
        .from('capi_tokens')
        .select('user_id')
        .eq('frontier_id', identity.frontierId)
        .neq('user_id', userId)
        .maybeSingle();
      if (clash?.user_id) {
        return NextResponse.json({ error: 'already_linked_elsewhere' }, { status: 409 });
      }
    }

    // Helper мог прислать СТАРУЮ копию пары токенов: сайт уже продлил свою
    // (refresh-токен одноразовый — свежая пара сайта делает присланную
    // мёртвой). Перезапись свежей пары старой ломает продление по
    // расписанию, поэтому принимаем только более свежую пару того же
    // аккаунта Frontier. Перепривязка другого аккаунта — всегда свежая пара,
    // она проходит.
    const { data: existing } = await svc
      .from('capi_tokens')
      .select('expires_at, frontier_id, platform, is_active')
      .eq('user_id', userId)
      .maybeSingle();
    if (existing?.expires_at) {
      const existingExpiry = Date.parse(existing.expires_at);
      const sameAccount = !existing.frontier_id
        || !identity?.frontierId
        || existing.frontier_id === identity.frontierId;
      // У того же customer_id Frontier- и Epic-токены не взаимозаменяемы.
      // Не называем новую авторизацию EGS «старой» из-за более короткого TTL,
      // и не блокируем восстановление ранее ошибочно отключённой привязки.
      const samePlatform = !existing.platform || !identity?.platform || existing.platform === identity.platform;
      if (sameAccount && samePlatform && existing.is_active !== false
        && Number.isFinite(existingExpiry) && existingExpiry >= expiresAtMs) {
        return NextResponse.json({ ok: true, synced: false, stale: true, reason: 'site_tokens_newer' });
      }
    }

    const now = new Date();
    const tokenWrite = await upsertResilient(
      svc,
      'capi_tokens',
      {
        user_id: userId,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: new Date(expiresAtMs).toISOString(),
        frontier_id: identity?.frontierId ?? null,
        scope: 'auth capi',
        is_active: true,
        // Не подменяем фактическую платформу выбором пользователя.
        platform: identity?.platform ?? null,
        linked_at: now.toISOString(),
        last_error: null,
        last_error_at: null,
        updated_at: now.toISOString(),
      },
      { onConflict: 'user_id', required: ['access_token', 'refresh_token', 'expires_at'] },
    );
    if (!tokenWrite.ok) {
      console.error('[CAPI Token POST] save', tokenWrite.error);
      return NextResponse.json({ error: tokenWrite.error?.message ?? 'Save failed' }, { status: 500 });
    }
    const warning = schemaWarning('capi_tokens', tokenWrite.droppedColumns);
    if (warning) console.warn('[CAPI Token POST]', warning);

    // Профиль — сразу, чтобы досье на сайте не ждал ручного синка.
    // Журнал не трогаем: Helper сам загружает статистику пилота, а дублей
    // событий колонизации и так не бывает (source_hash).
    let cmdrName: string | null = null;
    let synced = false;
    let failure: Record<string, unknown> = {};
    try {
      const sync = await syncCapiPilot(svc, userId, {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: new Date(expiresAtMs).toISOString(),
      }, {
        skipJournal: true,
        identity,
        requestedPlatform: typeof body.audience === 'string' ? body.audience : null,
      });
      cmdrName = sync.cmdrName;
      synced = sync.ok;
      if (!sync.ok) {
        failure = {
          error: sync.error,
          needsReauth: sync.needsReauth,
          reason: sync.reason,
          status: sync.httpStatus,
          kind: sync.errorKind,
          platform: sync.platform,
          detail: sync.detail,
        };
        if (sync.needsReauth) await markCapiTokenBroken(svc, userId, sync.error || 'Frontier отклонил токен');
      }
      for (const item of sync.warnings) console.warn('[CAPI Token POST]', item);
    } catch (syncError) {
      console.warn('[CAPI Token POST] first sync skipped:', (syncError as Error).message);
    }

    return NextResponse.json({ ok: true, synced, cmdr: cmdrName, ...failure });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed';
    console.error('[CAPI Token POST]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
