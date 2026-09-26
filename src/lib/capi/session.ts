// ═══════════════════════════════════════════════════════════════
// Сессия Frontier CAPI: один токен на запрос, обновление по месту
// ═══════════════════════════════════════════════════════════════
//
// Раньше каждый маршрут (`/api/capi/sync`, `/api/capi/journal`) сам писал
// один и тот же блок: дёрнуть CAPI, поймать 'UNAUTHORIZED', обновить токен,
// повторить. Отсюда три проблемы:
//
//   • обновление прикрывало только ПЕРВЫЙ вызов. В `sync` после `/profile`
//     идут `syncMemberLocation` и `/journal` — если токен истекал между ними
//     (а он живёт всего ~4 часа), синк падал с 500 и ничего не сохранял;
//   • токен обновлялся только «по факту ошибки», хотя `expires_at` лежит
//     в базе: каждый синк начинался с заведомо неудачного запроса;
//   • refresh-токен Frontier одноразовый. Два параллельных маршрута могли
//     обновиться по одному и тому же значению, и второй ответ затирал
//     в базе свежий токен уже недействительным.
//
// `capiSession()` решает это: обновляет заранее (за `REFRESH_SKEW_MS` до
// истечения), сохраняет новую пару в `capi_tokens` и даёт `run()`, который
// повторяет ЛЮБОЙ вызов после однократного обновления.

import { CapiClient } from './client.ts';
import { refreshAccessToken } from './oauth.ts';

/** За сколько до истечения обновляем токен, не дожидаясь 422. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface CapiTokenRow {
  access_token: string;
  refresh_token: string;
  expires_at?: string | null;
}

/**
 * Минимум от Supabase-клиента, который нам нужен: `.from().update().eq()`.
 * Описан структурно, чтобы сессию можно было проверять тестовой заглушкой,
 * не поднимая настоящий Supabase. PostgREST-построитель — «thenable», а не
 * Promise, поэтому возвращаемый тип намеренно широкий.
 */
interface TokenStore {
  from(table: string): {
    update(values: Record<string, unknown>): { eq(column: string, value: string): PromiseLike<unknown> };
  };
}

/** Обновление токена. Подменяется в тестах, в бою — Frontier. */
export type RefreshFn = typeof refreshAccessToken;

export class CapiSession {
  private client: CapiClient;
  private svc: TokenStore;
  private userId: string;
  private accessToken: string;
  private refreshToken: string;
  private refreshFn: RefreshFn;

  constructor(
    svc: TokenStore,
    userId: string,
    accessToken: string,
    refreshToken: string,
    refreshFn: RefreshFn = refreshAccessToken,
  ) {
    this.svc = svc;
    this.userId = userId;
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.refreshFn = refreshFn;
    this.client = new CapiClient(accessToken);
  }

  get token(): string {
    return this.accessToken;
  }

  /** Выполнить обращение к CAPI, обновив токен при 401/403/422 (один раз). */
  async run<T>(action: (client: CapiClient) => Promise<T>): Promise<T> {
    try {
      return await action(this.client);
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'UNAUTHORIZED') throw err;
      await this.refresh();
      return action(this.client);
    }
  }

  async refresh(): Promise<void> {
    const refreshed = await this.refreshFn(this.refreshToken);
    this.accessToken = refreshed.access_token;
    this.refreshToken = refreshed.refresh_token;
    this.client = new CapiClient(this.accessToken);
    await this.svc.from('capi_tokens').update({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
    }).eq('user_id', this.userId);
  }
}

/** Готовая сессия: токен уже обновлён, если срок вот-вот истечёт. */
export async function capiSession(
  svc: TokenStore,
  userId: string,
  row: CapiTokenRow,
  refreshFn: RefreshFn = refreshAccessToken,
): Promise<CapiSession> {
  const session = new CapiSession(svc, userId, row.access_token, row.refresh_token, refreshFn);
  const expiresAt = row.expires_at ? Date.parse(row.expires_at) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() < REFRESH_SKEW_MS && row.refresh_token) {
    try {
      await session.refresh();
    } catch {
      // Не смертельно: попробуем текущим токеном, а `run()` повторит обновление.
    }
  }
  return session;
}
