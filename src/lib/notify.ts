/**
 * Единый канал уведомлений пилотам.
 *
 * Колокольчик (`NotificationBell`) уже читает `user_notifications` как
 * «универсальные уведомления» и подписан на них через Realtime, а web-push
 * (`pushNotifications.ts`) был отдельным механизмом, который никто, кроме
 * ручной рассылки, не вызывал. Здесь одна точка: строка в
 * `user_notifications` (колокольчик, Realtime) и, если на сервере настроен
 * VAPID, push на подписанные устройства.
 *
 * Сбой уведомления никогда не роняет основное действие (импорт журнала,
 * синхронизацию CAPI и т. д.): ошибка возвращается, а не бросается.
 */

type Svc = any;

export interface NotificationInput {
  /** Тип для колокольчика: `project_system`, `friend_request`, `squadron_chat`… */
  type: string;
  title: string;
  body?: string | null;
  href?: string | null;
  metadata?: Record<string, unknown>;
}

export interface NotifyResult {
  inserted: number;
  error: string | null;
}

const MAX_RECIPIENTS = 500;
const INSERT_CHUNK = 200;

function cleanIds(userIds: Iterable<string | null | undefined>, exclude: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const id of userIds) {
    if (typeof id !== 'string' || !id || id === exclude) continue;
    out.add(id);
    if (out.size >= MAX_RECIPIENTS) break;
  }
  return Array.from(out);
}

export async function notifyUsers(
  svc: Svc,
  userIds: Iterable<string | null | undefined>,
  input: NotificationInput,
  options: { exclude?: string | null; push?: boolean } = {},
): Promise<NotifyResult> {
  const ids = cleanIds(userIds, options.exclude);
  if (ids.length === 0) return { inserted: 0, error: null };
  const title = String(input.title || '').slice(0, 200);
  const body = input.body == null ? null : String(input.body).slice(0, 1000);
  const rows = ids.map((userId) => ({
    user_id: userId,
    type: String(input.type || 'info').slice(0, 64),
    title,
    body,
    href: input.href ?? null,
    metadata: input.metadata ?? {},
  }));

  let inserted = 0;
  let error: string | null = null;
  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
    try {
      const result = await svc.from('user_notifications').insert(rows.slice(offset, offset + INSERT_CHUNK));
      if (result?.error) throw new Error(result.error.message);
      inserted += Math.min(INSERT_CHUNK, rows.length - offset);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      break;
    }
  }

  // Push — только когда сервер настроен; иначе модуль web-push даже не грузится.
  if (inserted > 0 && options.push !== false && process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    try {
      const { sendPushToUsers } = await import('./pushNotifications');
      await sendPushToUsers(ids, title, body ?? '', input.href ?? '/', input.type);
    } catch {
      // Push — дополнение к колокольчику, его сбой ничего не отменяет.
    }
  }
  return { inserted, error };
}
