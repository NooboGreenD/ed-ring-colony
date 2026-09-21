/** Browser-safe VK ID helpers: no secrets, no node:crypto. */
export const VK_PROVIDER = 'vk';
export const VK_LABEL = 'VK ID';

export function vkErrorMessage(raw: string): string {
  const code = raw.toLowerCase();
  if (/not_configured/.test(code)) return 'Вход через VK ID не настроен на сервере (VK_ID_CLIENT_ID).';
  if (/cancelled|access_denied/.test(code)) return 'Авторизация VK отменена. Аккаунт не изменён.';
  if (/expired|no_code|state_mismatch/.test(code)) return 'Срок авторизации VK истёк или запрос подделан. Начните заново в той же вкладке.';
  if (/already_linked_other/.test(code)) return 'Этот аккаунт VK уже привязан к другому досье. Сначала отвяжите его там.';
  if (/already_linked/.test(code)) return 'К вашему аккаунту уже привязан другой VK. Сначала отвяжите его.';
  if (/email_exists/.test(code)) return 'Почта из VK уже зарегистрирована на сайте. Войдите прежним способом и привяжите VK ID в профиле — автоматического объединения нет.';
  if (/not_authenticated/.test(code)) return 'Сначала войдите в аккаунт, к которому нужно привязать VK ID.';
  if (/account_mismatch/.test(code)) return 'Аккаунт во время привязки изменился. Войдите в исходное досье и повторите.';
  if (/last_identity/.test(code)) return 'Нельзя отвязать единственный способ входа. Сначала добавьте пароль или другого провайдера.';
  if (/vk_unavailable/.test(code)) return 'Сервис VK ID недоступен. Повторите попытку позже.';
  if (/session/.test(code)) return 'Не удалось создать сессию. Проверьте настройки Supabase Auth (service role, magic link).';
  return 'Не удалось завершить вход через VK ID. Повторите попытку.';
}
