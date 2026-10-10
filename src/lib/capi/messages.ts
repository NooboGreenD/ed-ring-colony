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

const REASONS: Record<CapiLinkReason, CapiReasonText> = {
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
    title: 'Платформа токена не совпала с выбранной',
    hint: 'Frontier подтвердил другую платформу токена. Выйдите из аккаунта на auth.frontierstore.net '
      + '(или начните подключение в приватном окне) и выберите способ входа своей платформы. '
      + 'Для Steam/Epic используйте кнопку магазина, а не почту.',
    retryAuth: true,
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

export function capiReasonText(reason: string | null | undefined): CapiReasonText {
  if (!reason) return REASONS.unknown;
  return REASONS[reason as CapiLinkReason] ?? REASONS.unknown;
}

/** Итог синхронизации одной строкой — для тоста на странице. */
export function describeJournalStatus(status: string | null | undefined): string {
  switch (status) {
    case 'ok':
      return 'журнал получен';
    case 'empty':
      return 'журнал за сегодня пуст — командир ещё не играл';
    case 'partial':
      return 'Frontier отдал журнал частично, повторите позже';
    case 'skipped':
      return 'журнал не запрашивался';
    case 'error':
    default:
      return 'журнал получить не удалось';
  }
}
