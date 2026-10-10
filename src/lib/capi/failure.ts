import { CapiError, describeCapiError, needsCapiRelink, type CapiErrorKind } from './client.ts';
import { assessCapiEntitlement, NO_ENTITLEMENT_MESSAGE } from './entitlement.ts';
import { FrontierAuthError, fetchFrontierIdentity, type FrontierIdentity } from './oauth.ts';
import type { CapiLinkReason } from './linkState.ts';

export interface CapiFailure {
  error: string;
  needsReauth: boolean;
  reason: CapiLinkReason;
  httpStatus: number | null;
  errorKind: CapiErrorKind | 'oauth' | 'unknown';
  endpoint: string | null;
  host: string | null;
  detail: string | null;
  platform: string | null;
}

/** Общий разбор для колбэка, ручного/cron-синка, обмена токенами и диагностики. */
export async function diagnoseCapiFailure(
  err: unknown,
  accessToken: string,
  options: { requestedPlatform?: string | null; identity?: FrontierIdentity | null } = {},
): Promise<CapiFailure> {
  const needsReauth = needsCapiRelink(err) || (err instanceof FrontierAuthError && err.needsReauth);
  const result: CapiFailure = {
    error: describeCapiError(err),
    needsReauth,
    reason: needsReauth ? 'token_rejected' : 'profile_unavailable',
    httpStatus: err instanceof CapiError || err instanceof FrontierAuthError ? err.status : null,
    errorKind: err instanceof CapiError ? err.kind : err instanceof FrontierAuthError ? 'oauth' : 'unknown',
    endpoint: err instanceof CapiError ? err.endpoint : err instanceof FrontierAuthError ? '/token' : null,
    host: err instanceof CapiError ? err.host : null,
    detail: err instanceof CapiError ? err.detail || null : null,
    platform: options.identity?.platform ?? null,
  };
  if (err instanceof FrontierAuthError) {
    // Тело ответа OAuth может содержать секреты. Показываем только HTTP-код.
    result.error = needsReauth
      ? 'Frontier отклонил обновление токена — нужна повторная авторизация'
      : `Не удалось обновить токен Frontier (HTTP ${err.status}) — повторите позже`;
  }
  if (!(err instanceof CapiError) || err.kind !== 'no_entitlement') return result;

  const identity = options.identity === undefined ? await fetchFrontierIdentity(accessToken) : options.identity;
  const advice = assessCapiEntitlement(options.requestedPlatform, identity?.platform);
  result.error = `${NO_ENTITLEMENT_MESSAGE}. ${advice.hint}`;
  result.needsReauth = advice.needsReauth;
  result.reason = advice.reason;
  result.platform = advice.platform;
  result.detail = `Запрошена платформа: ${options.requestedPlatform || 'авто/неизвестно'}. `
    + `Подтверждена платформа: ${advice.platform || 'неизвестно'}. `
    + `CAPI ${err.endpoint}: HTTP ${err.status}. ${err.detail}`;
  return result;
}
