import { getServerI18n, type ServerT } from './server';
import { translations } from './translations';

/**
 * Переводчик сообщений API.
 *
 * Маршруты отдают ошибки текстом (`{ error: '…' }`), и клиент показывает их
 * как есть. Локаль берём из той же cookie, что и страницы, поэтому ответ
 * приходит на языке пилота.
 *
 * Если запрос пришёл вне контекста Next (юнит-тесты вызывают обработчик
 * напрямую), `cookies()` бросает исключение — тогда отдаём русский текст,
 * как было до перевода: сообщение об ошибке не должно зависеть от того,
 * удалось ли прочитать язык.
 */
export async function apiTranslate(): Promise<ServerT> {
  try {
    const { t } = await getServerI18n();
    return t;
  } catch {
    const dict = translations['ru'];
    return (key, params) => {
      const template = dict[key] ?? key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name: string) => (
        name in params ? String(params[name]) : match
      ));
    };
  }
}
