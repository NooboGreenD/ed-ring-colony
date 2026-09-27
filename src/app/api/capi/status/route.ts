import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { getSiteUrl } from '@/lib/siteUrl';
import {
  FRONTIER_CALLBACK_PATH,
  frontierClientId,
  frontierClientSecret,
  frontierRedirectUri,
} from '@/lib/capi/oauth';
import { capiSession } from '@/lib/capi/session';
import { CapiError, describeCapiError, isUnauthorizedError } from '@/lib/capi/client';
import { isBlankProfile } from '@/lib/capi/profile';

export const dynamic = 'force-dynamic';

/**
 * Диагностика привязки Frontier CAPI — «почему не подтянулось».
 *
 * Появился потому, что раньше отладка сводилась к чтению логов контейнера:
 * интерфейс показывал либо «Подключите Frontier Account», либо пустые поля,
 * а причина (не совпал redirect_uri, база без миграции, CAPI на
 * техобслуживании, командир ни разу не заходил в игру) нигде не отражалась.
 *
 * `GET /api/capi/status`        — быстрая проверка по базе, без запросов к Frontier.
 * `GET /api/capi/status?probe=1`— плюс живой запрос `/profile` (расходует лимит CAPI).
 *
 * Секреты не возвращаются: Client ID маскируется, наличие Shared Key —
 * булево, токены не отдаются вовсе.
 */
function maskId(value: string): string {
  if (value.length <= 10) return value ? `${value.slice(0, 2)}…` : '';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export async function GET(req: Request) {
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const probe = url.searchParams.get('probe') === '1';

  let site = '';
  let siteError: string | null = null;
  try {
    site = getSiteUrl();
  } catch (err) {
    siteError = err instanceof Error ? err.message : String(err);
  }

  const redirectUri = frontierRedirectUri();
  const expectedRedirect = site ? `${site}${FRONTIER_CALLBACK_PATH}` : null;

  const config = {
    siteUrl: site || null,
    siteUrlError: siteError,
    clientId: maskId(frontierClientId()),
    clientIdSource: process.env.FRONTIER_CLIENT_ID ? 'env' : 'built-in',
    hasSharedKey: Boolean(frontierClientSecret()),
    redirectUri: redirectUri || null,
    redirectUriSource: process.env.FRONTIER_REDIRECT_URI ? 'env' : 'site-url',
    /** Несовпадение — самая частая причина «код не обменивается». */
    redirectMatchesSite: Boolean(redirectUri && expectedRedirect && redirectUri === expectedRedirect),
    expectedRedirectUri: expectedRedirect,
  };

  const svc = createServiceClient();
  const [{ data: token }, { data: profile }] = await Promise.all([
    svc.from('capi_tokens').select('*').eq('user_id', user.id).maybeSingle(),
    svc.from('capi_profiles').select('*').eq('user_id', user.id).maybeSingle(),
  ]);

  const expiresAt = token?.expires_at ? Date.parse(token.expires_at) : NaN;
  const link = {
    linked: Boolean(token),
    active: Boolean(token) && token?.is_active !== false,
    cmdrName: token?.cmdr_name ?? null,
    frontierId: token?.frontier_id ?? null,
    platform: token?.platform ?? null,
    scope: token?.scope ?? null,
    expiresAt: token?.expires_at ?? null,
    accessExpired: Number.isFinite(expiresAt) ? expiresAt <= Date.now() : null,
    lastSyncedAt: token?.last_synced_at ?? null,
    lastError: token?.last_error ?? null,
    hasRefreshToken: Boolean(token?.refresh_token),
  };

  const stored = {
    saved: Boolean(profile),
    cmdrName: profile?.cmdr_name ?? null,
    lastUpdated: profile?.last_updated ?? null,
    credits: profile?.credits ?? null,
    currentSystem: profile?.current_system ?? null,
    currentShip: profile?.current_ship ?? null,
    ships: Array.isArray(profile?.ships) ? profile.ships.length : 0,
    /** Пустая строка — верный признак того, что разбор профиля не сработал. */
    looksEmpty: Boolean(profile) &&
      profile?.credits == null &&
      !profile?.current_system &&
      !profile?.current_ship,
  };

  let live: Record<string, unknown> | null = null;
  if (probe && token) {
    try {
      const session = await capiSession(svc, user.id, token);
      const fresh = await session.run((client) => client.getProfile());
      live = {
        ok: true,
        cmdrName: fresh.cmdrName,
        credits: fresh.credits,
        currentSystem: fresh.currentSystem?.name ?? null,
        currentShip: fresh.currentShip,
        docked: fresh.docked,
        ships: fresh.ships.length,
        blank: isBlankProfile(fresh),
      };
    } catch (err) {
      live = {
        ok: false,
        status: err instanceof CapiError ? err.status : null,
        kind: err instanceof CapiError ? err.kind : 'unknown',
        needsReauth: isUnauthorizedError(err),
        message: describeCapiError(err),
      };
    }
  }

  return NextResponse.json({ config, link, stored, live, probed: probe });
}
