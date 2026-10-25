import { normalizeAudience, normalizePlatform } from './platform.ts';

export const NO_ENTITLEMENT_MESSAGE = 'CAPI Frontier не подтвердил доступ к Elite Dangerous';
export const ENTITLEMENT_RECOVERY_HINT =
  'Авторизация сохранена — повторять вход по кругу не нужно. '
  + 'Запустите Elite Dangerous из магазина, где куплена игра (Steam или Epic Games Store, EGS), '
  + 'загрузите командира и повторите синхронизацию. Проверьте связь магазина с Frontier '
  + 'на user.frontierstore.net → Linked Thirdparty Accounts. Если отказ сохраняется, обратитесь в поддержку Frontier.';

/** HTTP 400 сам по себе не означает отсутствие игры: проверяем сообщение Frontier. */
export function isNoEntitlementResponse(body: string): boolean {
  return /\b(?:no|missing)[_\s-]entitlement\b/i.test(body)
    || /(?:purchase|not own|no game)[\s\S]{0,100}elite\s*:?\s*dangerous/i.test(body)
    || /elite\s*:?\s*dangerous[\s\S]{0,100}(?:not owned|not purchased)/i.test(body);
}

/**
 * Даже настоящее «Please Visit the store…» не доказывает неверный вход:
 * CAPI может не видеть права Steam/EGS при рабочем OAuth правильной платформы.
 * Переподключение требуется лишь при ПОДТВЕРЖДЁННОМ несовпадении выбора и /me.
 */
export function assessCapiEntitlement(requestedPlatform: unknown, actualPlatform: unknown) {
  const actual = normalizePlatform(actualPlatform);
  const requested = requestedPlatform ? normalizeAudience(requestedPlatform) : null;
  const mismatch = Boolean(actual && requested && !requested.split(',').includes(actual));

  if (mismatch) {
    return {
      // Keep the requested/observed difference as diagnostic evidence, but
      // don't invalidate OAuth on an entitlement HTTP 400. EGS-linked users
      // have a documented Frontier CAPI failure even when OAuth succeeds;
      // the reported identity platform alone does not prove a bad login.
      reason: 'platform_not_entitled' as const,
      needsReauth: false,
      platform: actual,
      hint: `Запрошена платформа: ${requested}; в identity Frontier указана «${actual}». `
        + 'Это расхождение само по себе не доказывает, что OAuth неверный или покупка отсутствует. '
        + 'Для EGS известны случаи, когда OAuth проходит, но CAPI отвечает HTTP 400. '
        + 'Сохранённую привязку не отключаем; повторный OAuth может не помочь. '
        + 'Проверьте состояние CAPI позже или передайте ошибку в поддержку Frontier.',
    };
  }

  return {
    reason: 'entitlement_unavailable' as const,
    needsReauth: false,
    platform: actual,
    hint: (actual
      ? `Frontier подтвердил платформу «${actual}». `
      : 'Frontier не сообщил платформу токена — это не доказательство входа почтой. ')
      + ENTITLEMENT_RECOVERY_HINT,
  };
}
