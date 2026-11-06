// ═══════════════════════════════════════════════════════════════
// Человеческие объяснения результатов привязки Frontier CAPI
// ═══════════════════════════════════════════════════════════════
//
// Модуль намеренно без зависимостей: его импортирует и серверный маршрут, и
// клиентская страница `/account/capi`.
//
// Раньше колбэк возвращал `?status=error&message=<текст исключения>`, а
// страница эти параметры вообще не читала. Пилот видел всё ту же кнопку
// «Подключить Frontier Account» и делал единственный доступный вывод:
// «привязка не работает». Ниже — коды причин и то, что по каждой из них
// реально нужно сделать.

import type { CapiLinkReason } from './linkState.ts';
import { ENTITLEMENT_RECOVERY_HINT } from './entitlement.ts';

export interface CapiReasonText {
  title: string;
  hint: string;
  /** Поможет ли повторная авторизация. */
  retryAuth: boolean;
}

export const REASONS: Record<CapiLinkReason, CapiReasonText> = {
  not_logged_in: {
    title: 'Сессия сайта не найдена',
    hint: 'Привязка выполняется для вошедшего пилота. Войдите на сайт и начните подключение заново — из этой же вкладки.',
    retryAuth: true,
  },
  invalid_state: {
    title: 'Не совпал код защиты (state)',
    hint: 'Скорее всего, авторизация начиналась в другой вкладке или другом браузере. Начните подключение заново и завершите его в том же окне.',
    retryAuth: true,
  },
  expired_state: {
    title: 'Время на авторизацию истекло',
    hint: 'На вход у Frontier отводится 30 минут. Если подтверждение по почте пришло позже, просто начните подключение заново.',
    retryAuth: true,
  },
  missing_code: {
    title: 'Frontier не вернул код авторизации',
    hint: 'Такое бывает при обрыве на странице входа. Повторите подключение.',
    retryAuth: true,
  },
  access_denied: {
    title: 'Доступ не подтверждён',
    hint: 'На странице Frontier нужно нажать «Authorise» и разрешить доступ к Companion API.',
    retryAuth: true,
  },
  token_exchange_failed: {
    title: 'Frontier не выдал токен',
    hint: 'Проверьте, что адрес возврата (FRONTIER_REDIRECT_URI) совпадает с зарегистрированным в Developer Zone до символа. Подробности — в диагностике ниже.',
    retryAuth: true,
  },
  redirect_uri_missing: {
    title: 'Не настроен адрес возврата',
    hint: 'Укажите FRONTIER_REDIRECT_URI (или корректный NEXT_PUBLIC_SITE_URL) и перезапустите сайт.',
    retryAuth: false,
  },
  token_save_failed: {
    title: 'Токен не сохранился в базе',
    hint: 'Обычно это отставшая схема БД. Примените миграции supabase/migrations и повторите подключение.',
    retryAuth: true,
  },
  sync_queued: {
    title: 'Аккаунт Frontier привязан, синхронизация в очереди',
    hint: 'Профиль и журнал загружаются в фоне. Страница покажет этапы и результат; браузерный запрос не ждёт ответа Frontier.',
    retryAuth: false,
  },
  sync_queue_failed: {
    title: 'Аккаунт привязан, но синхронизация не поставлена в очередь',
    hint: 'OAuth-привязка сохранена. Нажмите «Синхронизировать» на странице CAPI, чтобы повторить постановку задания.',
    retryAuth: false,
  },
  profile_unavailable: {
    title: 'Аккаунт привязан, но профиль CAPI не получен',
    hint: 'Companion API мог быть недоступен. Привязка сохранена — нажмите «Синхронизировать» через несколько минут.',
    retryAuth: false,
  },
  profile_empty: {
    title: 'Аккаунт привязан, данных пока нет',
    hint: 'Frontier отдаёт профиль только после входа в игру. Зайдите в Elite Dangerous и синхронизируйте ещё раз.',
    retryAuth: false,
  },
  profile_save_failed: {
    title: 'Профиль получен, но не записан',
    hint: 'Проверьте миграции базы: в capi_profiles может не хватать колонок. Диагностика ниже покажет подробности.',
    retryAuth: false,
  },
  platform_not_entitled: {
    title: 'CAPI не подтвердил право на игру; платформа токена отличается',
    hint: 'Запрошенная и сообщённая Frontier платформы различаются, но это само по себе не доказывает неверный вход или потерю OAuth. Для EGS известны отдельные сбои CAPI после успешного OAuth. Привязка остаётся активной; повторный вход не запускается автоматически.',
    retryAuth: false,
  },
  entitlement_unavailable: {
    title: 'Авторизация сохранена, но CAPI не подтвердил доступ к игре',
    hint: ENTITLEMENT_RECOVERY_HINT,
    retryAuth: false,
  },
  token_rejected: {
    title: 'Frontier отклонил сохранённый токен',
    hint: 'Доступ отозван или refresh-токен истёк. Подключите аккаунт заново. Это ошибка авторизации, а не отсутствие купленной игры.',
    retryAuth: true,
  },
  capi_maintenance: {
    title: 'Companion API на техобслуживании',
    hint: 'Frontier отвечает HTTP 418. Привязка не пострадала, повторите синхронизацию позже.',
    retryAuth: false,
  },
  already_linked_elsewhere: {
    title: 'Этот аккаунт Frontier уже привязан',
    hint: 'Он используется другой учётной записью сайта. Отвяжите его там или войдите под ней.',
    retryAuth: false,
  },
  unknown: {
    title: 'Неизвестная ошибка привязки',
    hint: 'Откройте диагностику ниже — там видно, на каком шаге всё остановилось.',
    retryAuth: true,
  },
};

/**
 * Ключи каталога для интерфейса.
 *
 * `REASONS` выше — русский оригинал: на него опираются ответы сервера и
 * тесты, а страница `/account/capi` берёт текст из каталога по этим ключам.
 * Наборы идентификаторов обязаны совпадать — это проверяет
 * `scripts/tests/capi-binding.test.mjs`.
 */
export const CAPI_REASON_KEYS: Record<string, { titleKey: string; hintKey: string }> = {
  not_logged_in: { titleKey: 'capi.reason.not_logged_in.title', hintKey: 'capi.reason.not_logged_in.hint' },
  invalid_state: { titleKey: 'capi.reason.invalid_state.title', hintKey: 'capi.reason.invalid_state.hint' },
  expired_state: { titleKey: 'capi.reason.expired_state.title', hintKey: 'capi.reason.expired_state.hint' },
  missing_code: { titleKey: 'capi.reason.missing_code.title', hintKey: 'capi.reason.missing_code.hint' },
  access_denied: { titleKey: 'capi.reason.access_denied.title', hintKey: 'capi.reason.access_denied.hint' },
  token_exchange_failed: { titleKey: 'capi.reason.token_exchange_failed.title', hintKey: 'capi.reason.token_exchange_failed.hint' },
  redirect_uri_missing: { titleKey: 'capi.reason.redirect_uri_missing.title', hintKey: 'capi.reason.redirect_uri_missing.hint' },
  token_save_failed: { titleKey: 'capi.reason.token_save_failed.title', hintKey: 'capi.reason.token_save_failed.hint' },
  sync_queued: { titleKey: 'capi.reason.sync_queued.title', hintKey: 'capi.reason.sync_queued.hint' },
  sync_queue_failed: { titleKey: 'capi.reason.sync_queue_failed.title', hintKey: 'capi.reason.sync_queue_failed.hint' },
  profile_unavailable: { titleKey: 'capi.reason.profile_unavailable.title', hintKey: 'capi.reason.profile_unavailable.hint' },
  profile_empty: { titleKey: 'capi.reason.profile_empty.title', hintKey: 'capi.reason.profile_empty.hint' },
  profile_save_failed: { titleKey: 'capi.reason.profile_save_failed.title', hintKey: 'capi.reason.profile_save_failed.hint' },
  platform_not_entitled: { titleKey: 'capi.reason.platform_not_entitled.title', hintKey: 'capi.reason.platform_not_entitled.hint' },
  entitlement_unavailable: { titleKey: 'capi.reason.entitlement_unavailable.title', hintKey: 'capi.reason.entitlement_unavailable.hint' },
  token_rejected: { titleKey: 'capi.reason.token_rejected.title', hintKey: 'capi.reason.token_rejected.hint' },
  capi_maintenance: { titleKey: 'capi.reason.capi_maintenance.title', hintKey: 'capi.reason.capi_maintenance.hint' },
  already_linked_elsewhere: { titleKey: 'capi.reason.already_linked_elsewhere.title', hintKey: 'capi.reason.already_linked_elsewhere.hint' },
  unknown: { titleKey: 'capi.reason.unknown.title', hintKey: 'capi.reason.unknown.hint' },
};

export function capiReasonKeys(reason: string | null | undefined): { titleKey: string; hintKey: string } {
  return CAPI_REASON_KEYS[reason ?? 'unknown'] ?? CAPI_REASON_KEYS.unknown;
}

/** Ключи для строки «итог синхронизации» на странице CAPI. */
export const CAPI_JOURNAL_KEYS: Record<string, string> = {
  ok: 'capi.journal.ok',
  empty: 'capi.journal.empty',
  partial: 'capi.journal.partial',
  skipped: 'capi.journal.skipped',
  error: 'capi.journal.error',
};

export function capiJournalKey(status: string | null | undefined): string {
  return CAPI_JOURNAL_KEYS[status ?? 'error'] ?? CAPI_JOURNAL_KEYS.error;
}

export function capiReasonText(reason: string | null | undefined): CapiReasonText {
  if (!reason) return REASONS.unknown;
  return REASONS[reason as CapiLinkReason] ?? REASONS.unknown;
}
