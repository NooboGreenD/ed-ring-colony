import { NextRequest, NextResponse } from 'next/server';
import { getSiteUrl } from '@/lib/siteUrl';
import {
  FrontierAuthError,
  exchangeCode,
  fetchFrontierIdentity,
  frontierRedirectUri,
} from '@/lib/capi/oauth';
import { createServiceClient, authFromRequest } from '@/lib/supabaseServer';
import { markCapiTokenBroken, syncCapiPilot } from '@/lib/capi/syncPilot';
import { upsertResilient, schemaWarning } from '@/lib/capi/persist';
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
 *   2. профиль и журнал подтягиваются следом, и их сбой даёт `status=partial`
 *      с причиной, а не потерю связи;
 *   3. любой исход возвращается на `/account/capi` с машинным кодом причины,
 *      который страница разворачивает в человеческий текст.
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
  // Сбой здесь уже не отменяет привязку: пилот сможет нажать
  // «Синхронизировать» позже, когда CAPI оживёт.
  const sync = await syncCapiPilot(svc, userId, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(now.getTime() + tokens.expires_in * 1000).toISOString(),
    cmdr_name: null,
  });

  for (const warning of sync.warnings) console.warn('[CAPI Callback]', warning);

  if (!sync.ok) {
    console.error('[CAPI Callback] first sync failed:', sync.error);
    if (sync.needsReauth) {
      // OAuth уже выдал токен, но CAPI подтвердил, что выбранная учётка не
      // владеет игрой (частый случай: игра куплена в Steam/EGS, а вошли
      // кнопкой Frontier). Не оставляем такую привязку зелёной: страница
      // покажет «Переподключить» и сохранит причину для диагностики.
      await markCapiTokenBroken(svc, userId, sync.error || 'Требуется повторная авторизация Frontier');
    }
    // Диагностика платформы: что просили и что выдал Frontier. Если пилот
    // выбирал Steam/Epic, а токен оказался frontier-учёткой (на
    // auth.frontierstore.net осталась сессия почтой), без этой пары
    // «переподключение с той же платформой» уходило в бесконечный круг.
    let detail = sync.error;
    if (sync.needsReauth) {
      const requested = requestedPlatform || 'frontier,steam,epic';
      const actual = identity?.platform || null;
      const parts = [`Запрошена платформа: ${requested}.`, `Токен выдан платформой: ${actual || 'неизвестно'}.`];
      if (actual && actual === requested) {
        // Платформа совпала с выбором — этой учётки игра просто нет.
        parts.push('Выберите платформу, где куплена Elite Dangerous, и подключитесь заново.');
      } else {
        // Вошли не той учёткой: на странице Frontier осталась сессия почтой,
        // и кнопка Steam/Epic не успела сработать.
        parts.push(
          'Похоже, вход выполнен другой учётной записью: выйдите из аккаунта на '
          + 'auth.frontierstore.net (или откройте приватное окно браузера) и пройдите '
          + 'подключение заново, войдя именно кнопкой Steam/Epic, а не почтой.',
        );
      }
      detail = `${parts.join(' ')} ${sync.error ?? ''}`.trim();
    }
    return finish({
      status: 'partial',
      reason: sync.needsReauth
        ? 'platform_not_entitled'
        : sync.profileSaved ? 'profile_save_failed' : 'profile_unavailable',
      detail,
      actualPlatform: identity?.platform ?? null,
      binding: sync.binding.status,
    });
  }

  return finish({
    status: 'success',
    binding: sync.binding.status,
    cmdr: sync.cmdrName,
    reason: sync.cmdrName ? undefined : 'profile_empty',
  });
}
