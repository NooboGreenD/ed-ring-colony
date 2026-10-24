import { NextRequest, NextResponse } from 'next/server';
import { getSiteUrl } from '@/lib/siteUrl';
import {
  FrontierAuthError,
  exchangeCode,
  fetchFrontierIdentity,
  frontierRedirectUri,
} from '@/lib/capi/oauth';
import { createServiceClient, authFromRequest } from '@/lib/supabaseServer';
import { upsertResilient, schemaWarning } from '@/lib/capi/persist';
import { enqueueCapiSyncJob, safeCapiDiagnostic } from '@/lib/capi/syncJobs';
import {
  CAPI_LINK_COOKIE,
  CAPI_PLATFORM_COOKIE,
  CAPI_PKCE_COOKIE,
  CAPI_STATE_COOKIE,
  buildCapiRedirect,
  parseCookies,
  safeEqual,
  verifyLinkState,
  type CapiRedirectOptions,
} from '@/lib/capi/linkState';

export const dynamic = 'force-dynamic';

/**
 * Колбэк Frontier: обмен кода на токены и собственно ПРИВЯЗКА.
 *
 * Порядок действий здесь — главное лекарство от «все этапы проходят, а
 * привязки нет». Раньше колбэк сначала ходил в CAPI за профилем и только
 * потом писал токены: любой сбой Companion API (418 на техобслуживании, 204
 * у аккаунта, ещё не заходившего в игру, отсутствующая после миграции
 * колонка `capi_profiles`) уничтожал всю авторизацию. Пилот возвращался на
 * страницу, где снова предлагалось «Подключить Frontier Account», и никаких
 * объяснений: параметры `status`/`message` страница попросту игнорировала.
 *
 * Теперь:
 *   1. токены сохраняются СРАЗУ после обмена — это и есть привязка;
 *   2. короткое durable-задание ставится в очередь; CAPI и журнал запрашиваются
 *      worker-ом после редиректа, не удерживая браузерный callback;
 *   3. callback возвращается на `/account/capi`, где страница возобновляет
 *      опрос задания и показывает результат/диагностику этапов.
 */
export async function GET(req: NextRequest) {
  const site = getSiteUrl();
  const url = new URL(req.url);
  const cookies = parseCookies(req.headers.get('cookie'));

  // Ответ всегда чистит cookie потока: они одноразовые, и оставлять
  // верификатор PKCE в браузере незачем.
  const requestedPlatform = cookies[CAPI_PLATFORM_COOKIE] || null;
  const finish = (options: CapiRedirectOptions) => {
    const response = NextResponse.redirect(buildCapiRedirect(site, {
      platform: requestedPlatform,
      ...options,
    }));
    for (const name of [CAPI_STATE_COOKIE, CAPI_PKCE_COOKIE, CAPI_LINK_COOKIE, CAPI_PLATFORM_COOKIE]) {
      response.cookies.set(name, '', { path: '/', maxAge: 0 });
    }
    return response;
  };

  // ── 0. Отказ на стороне Frontier ────────────────────────────────
  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    return finish({
      status: 'error',
      reason: oauthError === 'access_denied' ? 'access_denied' : 'token_exchange_failed',
      detail: url.searchParams.get('error_description') || oauthError,
    });
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = cookies[CAPI_STATE_COOKIE] ?? null;
  const codeVerifier = cookies[CAPI_PKCE_COOKIE] ?? null;

  if (!code) return finish({ status: 'error', reason: 'missing_code' });
  if (!cookieState) {
    // Cookie не дожила до возвращения: чаще всего вход у Frontier занял
    // больше получаса либо браузер чистит cookie между доменами.
    return finish({ status: 'error', reason: 'expired_state' });
  }
  if (!safeEqual(state, cookieState)) {
    return finish({ status: 'error', reason: 'invalid_state' });
  }

  // ── 1. Кто привязывает ──────────────────────────────────────────
  // Основной путь — сессия сайта. Запасной — подписанная на старте потока
  // cookie: она переживает переход с домена Frontier даже там, где
  // сессионная cookie Supabase не доезжает.
  let userId: string | null = null;
  try {
    const { user } = await authFromRequest(req);
    userId = user?.id ?? null;
  } catch {
    userId = null;
  }
  if (!userId) userId = verifyLinkState(cookies[CAPI_LINK_COOKIE]);
  if (!userId) return finish({ status: 'error', reason: 'not_logged_in' });

  const redirectUri = frontierRedirectUri();
  if (!redirectUri) return finish({ status: 'error', reason: 'redirect_uri_missing' });

  // ── 2. Обмен кода на токены ─────────────────────────────────────
  let tokens;
  try {
    tokens = await exchangeCode(code, { codeVerifier, redirectUri });
  } catch (err) {
    console.error('[CAPI Callback] token exchange', err);
    const detail = err instanceof FrontierAuthError
      ? `HTTP ${err.status}: ${err.body || 'ответ без тела'}`
      : err instanceof Error ? err.message : String(err);
    return finish({ status: 'error', reason: 'token_exchange_failed', detail });
  }

  const svc = createServiceClient();
  const now = new Date();

  // Идентификатор аккаунта Frontier: стабильнее имени командира и позволяет
  // заметить попытку привязать один аккаунт к двум учётным записям сайта.
  const identity = await fetchFrontierIdentity(tokens.access_token);

  if (identity?.frontierId) {
    const { data: clash } = await svc
      .from('capi_tokens')
      .select('user_id')
      .eq('frontier_id', identity.frontierId)
      .neq('user_id', userId)
      .maybeSingle();
    if (clash?.user_id) {
      return finish({ status: 'error', reason: 'already_linked_elsewhere' });
    }
  }

  // ── 3. ПРИВЯЗКА: сохраняем токены до любых обращений к CAPI ─────
  const tokenWrite = await upsertResilient(
    svc,
    'capi_tokens',
    {
      user_id: userId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(now.getTime() + tokens.expires_in * 1000).toISOString(),
      frontier_id: identity?.frontierId ?? null,
      scope: 'auth capi',
      is_active: true,
      platform: identity?.platform ?? null,
      linked_at: now.toISOString(),
      last_error: null,
      last_error_at: null,
      updated_at: now.toISOString(),
    },
    { onConflict: 'user_id', required: ['access_token', 'refresh_token', 'expires_at'] },
  );

  if (!tokenWrite.ok) {
    console.error('[CAPI Callback] token save', tokenWrite.error);
    return finish({
      status: 'error',
      reason: 'token_save_failed',
      detail: tokenWrite.error?.message ?? null,
    });
  }
  const tokenSchemaWarning = schemaWarning('capi_tokens', tokenWrite.droppedColumns);
  if (tokenSchemaWarning) console.warn('[CAPI Callback]', tokenSchemaWarning);

  // ── 4. Первая загрузка данных ───────────────────────────────────
  // Не вызываем syncCapiPilot из OAuth callback: профиль+журнал могут
  // пережить внешний HTTP timeout. Привязка уже сохранена; этот запрос
  // только создаёт durable job, который UI затем опрашивает.
  const queued = await enqueueCapiSyncJob(svc, userId, { requestedPlatform, skipCommunityGoals: false });
  if (queued.error || !queued.data) {
    console.error('[CAPI Callback] sync enqueue failed', safeCapiDiagnostic(queued.error?.message));
    return finish({
      status: 'partial',
      reason: 'sync_queue_failed',
      detail: 'Привязка Frontier сохранена, но задание синхронизации не поставлено. Нажмите «Синхронизировать» на странице.',
      actualPlatform: identity?.platform ?? null,
    });
  }

  console.info('[CAPI Callback] initial sync queued', {
    jobId: queued.data.id,
    reused: queued.reused,
    elapsedMs: Date.now() - now.getTime(),
  });
  return finish({
    status: 'partial',
    reason: 'sync_queued',
    actualPlatform: identity?.platform ?? null,
  });
}
