/** Browser-safe Yandex ID helpers: no secrets, no node:crypto. */
export const YANDEX_PROVIDER = 'yandex';
export const YANDEX_LABEL = 'Яндекс ID';

export function yandexErrorMessage(raw: string): string {
  const code = raw.toLowerCase();
  if (/not_configured/.test(code)) return 'Вход через Яндекс ID не настроен на сервере (YANDEX_ID_CLIENT_ID).';
  if (/cancelled|access_denied/.test(code)) return 'Авторизация Яндекса отменена. Аккаунт не изменён.';
  if (/expired|no_code|state_mismatch/.test(code)) return 'Срок авторизации Яндекса истёк или запрос подделан. Начните заново в той же вкладке.';
  if (/already_linked_other/.test(code)) return 'Этот аккаунт Яндекса уже привязан к другому досье. Сначала отвяжите его там.';
  if (/already_linked/.test(code)) return 'К вашему аккаунту уже привязан другой Яндекс ID. Сначала отвяжите его.';
  if (/email_exists/.test(code)) return 'Почта из Яндекса уже зарегистрирована на сайте. Войдите прежним способом и привяжите Яндекс ID в профиле — автоматического объединения нет.';
  if (/not_authenticated/.test(code)) return 'Сначала войдите в аккаунт, к которому нужно привязать Яндекс ID.';
  if (/account_mismatch/.test(code)) return 'Аккаунт во время привязки изменился. Войдите в исходное досье и повторите.';
  if (/last_identity/.test(code)) return 'Нельзя отвязать единственный способ входа. Сначала добавьте пароль или другого провайдера.';
  if (/yandex_unavailable/.test(code)) return 'Сервис Яндекс ID недоступен. Повторите попытку позже.';
  if (/session/.test(code)) return 'Не удалось создать сессию. Проверьте настройки Supabase Auth (service role, magic link).';
  return 'Не удалось завершить вход через Яндекс ID. Повторите попытку.';
}
