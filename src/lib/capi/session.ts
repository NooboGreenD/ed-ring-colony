// ═══════════════════════════════════════════════════════════════════
// Сессия Frontier CAPI: один токен на запрос, обновление по месту
// ═══════════════════════════════════════════════════════════════════
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
//   • refresh-токен Frontier ОДНОРАЗОВЫЙ. Два параллельных маршрута могли
//     обновиться по одному и тому же значению, и второй ответ затирал
//     в базе свежий токен уже недействительным.
//
// `capiSession()` решает это: обновляет заранее (за `REFRESH_SKEW_MS` до
// истечения), сохраняет новую пару в `capi_tokens` и даёт `run()`, который
// повторяет ЛЮБОЙ вызов после однократного обновления.
//
// Четвёртая проблема — гонка за одноразовый refresh — решается здесь же:
// ручной синк, cron и колбэк OAuth работают параллельно, и два одновременных
// обновления по одному refresh-токену гарантированно ломают один из них (а
// следом — и привязку: `markCapiTokenBroken` принимал чужую гонку за отзыв).
// Поэтому обновление сериализуется на процесс (мьютекс на user_id), а перед
// и после обращения к Frontier строка `capi_tokens` ПЕРЕЧИТЫВАЕТСЯ: если
// кто-то уже успел обновить пару, свежая пара ПРИНИМАЕТСЯ вместо повторного
// (заведомо неудачного) запроса. Переход на свежую пару чужого процесса —
// норма, а не ошибка; ошибкой считается только отказ Frontier при
// неизменной строке.

import { CapiClient, isUnauthorizedError } from './client.ts';
import { refreshAccessToken } from './oauth.ts';

/** За сколько до истечения обновляем токен, не дожидаясь 422. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface CapiTokenRow {
  access_token: string;
  refresh_token: string;
  expires_at?: string | null;
}

/**
 * Минимум от Supabase-клиента, который нам нужен: `.from().update().eq()`
 * и чтение строки `.from().select().eq().maybeSingle()` для сверки при гонке
 * обновлений. Описан структурно, чтобы сессию можно было проверять тестовой
 * заглушкой, не поднимая настоящий Supabase.
 *
 * `select()` возвращает `any` намеренно: настоящий клиент supabase-js строит
 * цепочку глубоко параметризованными Postgrest-типами, и попытка сверить их
 * со строгим интерфейсом заканчивается TS2589 («type instantiation is
 * excessively deep») в каждом маршруте, который передаёт клиент в сессию.
 */
interface TokenStore {
  from(table: string): {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    select(columns: string): any;
    update(values: Record<string, unknown>): { eq(column: string, value: string): PromiseLike<unknown> };
  };
}

/** Обновление токена. Подменяется в тестах, в бою — Frontier. */
export type RefreshFn = typeof refreshAccessToken;

/* ── Мьютекс обновления токена на процесс ──────────────────────────── */

/**
 * Очереди по user_id: пока один обработчик обновляет токен, остальные ждут
 * и затем перечитывают строку (см. `CapiSession.refresh`). Без этого два
 * параллельных синка гарантированно тратят один и тот же одноразовый
 * refresh-токен: один выигрывает, второй падает и роняет живую привязку.
 */
const refreshGates = new Map<string, Promise<void>>();

async function withRefreshLock<T>(userId: string, body: () => Promise<T>): Promise<T> {
  const previous = refreshGates.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const chained = previous.then(() => gate);
  refreshGates.set(userId, chained);
  await previous.catch(() => { /* чужой сбой не должен ломать наш захват */ });
  try {
    return await body();
  } finally {
    release();
    // Не копим калитки по каждому пилоту: как только цепочка свободна,
    // удаляем ссылку, если за ней никто не встал.
    void chained.then(() => {
      if (refreshGates.get(userId) === chained) refreshGates.delete(userId);
    });
  }
}

export class CapiSession {
  private client: CapiClient;
  private svc: TokenStore;
  private userId: string;
  private accessToken: string;
  private refreshToken: string;
  private expiresAt: number | null;
  private refreshFn: RefreshFn;

  constructor(
    svc: TokenStore,
    userId: string,
    accessToken: string,
    refreshToken: string,
    refreshFn: RefreshFn = refreshAccessToken,
    expiresAt?: string | null,
  ) {
    this.svc = svc;
    this.userId = userId;
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.refreshFn = refreshFn;
    this.expiresAt = expiresAt ? Date.parse(expiresAt) : null;
    this.client = new CapiClient(accessToken);
  }

  get token(): string {
    return this.accessToken;
  }

  /** Текущая пара токенов — после возможного обновления. */
  get tokens(): CapiTokenRow {
    return {
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      expires_at: this.expiresAt ? new Date(this.expiresAt).toISOString() : null,
    };
  }

  /** Выполнить обращение к CAPI, обновив токен при 401/403/422 (один раз). */
  async run<T>(action: (client: CapiClient) => Promise<T>): Promise<T> {
    try {
      return await action(this.client);
    } catch (err) {
      // 418 (техобслуживание), 204 и сетевые сбои обновлением токена не
      // лечатся — повторять их бессмысленно и вредно для лимитов Frontier.
      if (!isUnauthorizedError(err)) throw err;
      await this.refresh();
      return action(this.client);
    }
  }

  /**
   * Обновить access-токен, сохранив новую пару в `capi_tokens`.
   *
   * Refresh-токен Frontier одноразовый, поэтому гонка двух обновлений — не
   * «второй повторит первый», а «второй получит отказ и потеряет привязку».
   * Защита в трёх шагах:
   *
   *   1. мьютекс на user_id — параллельные обработчики одного процесса
   *      обновляются строго по очереди;
   *   2. перед запросом к Frontier строка перечитывается: если refresh-токен
   *      в базе уже другой, кто-то обновился раньше — принимаем его пару без
   *      запроса (свой старый refresh уже потрачен и не сработает);
   *   3. после отказа Frontier строка перечитывается ещё раз: если она
   *      изменилась, побеждаем чужой парой; иначе refresh-токен правда
   *      отозван — пробрасываем ошибку (привязку пометят сломанной).
   */
  async refresh(): Promise<void> {
    await withRefreshLock(this.userId, async () => {
      const current = await this.readStoredTokens();
      if (current?.refresh_token && current.refresh_token !== this.refreshToken) {
        this.adoptTokens(current);
        return;
      }

      let refreshed;
      try {
        refreshed = await this.refreshFn(this.refreshToken);
      } catch (err) {
        const after = await this.readStoredTokens();
        if (after?.refresh_token && after.refresh_token !== this.refreshToken) {
          this.adoptTokens(after);
          return;
        }
        throw err;
      }

      this.accessToken = refreshed.access_token;
      this.refreshToken = refreshed.refresh_token;
      this.expiresAt = Date.now() + refreshed.expires_in * 1000;
      this.client = new CapiClient(this.accessToken);
      await this.svc.from('capi_tokens').update({
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_at: new Date(this.expiresAt).toISOString(),
      }).eq('user_id', this.userId);
    });
  }

  /** Принять пару токенов, которую успел записать другой обработчик. */
  private adoptTokens(row: Partial<CapiTokenRow>): void {
    if (row.access_token) this.accessToken = row.access_token;
    if (row.refresh_token) this.refreshToken = row.refresh_token;
    if (row.expires_at) {
      const parsed = Date.parse(row.expires_at);
      if (Number.isFinite(parsed)) this.expiresAt = parsed;
    }
    this.client = new CapiClient(this.accessToken);
  }

  /**
   * Перечитать строку токенов. Сбой чтения (или старая заглушка без select)
   * не роняет обновление: сверка — оптимизация, а не обязательный шаг.
   */
  private async readStoredTokens(): Promise<Partial<CapiTokenRow> | null> {
    try {
      const query = this.svc
        .from('capi_tokens')
        .select('access_token, refresh_token, expires_at')
        .eq('user_id', this.userId);
      const { data } = await query.maybeSingle();
      return data ?? null;
    } catch {
      return null;
    }
  }
}

/** Готовая сессия: токен уже обновлён, если срок вот-вот истечёт. */
export async function capiSession(
  svc: TokenStore,
  userId: string,
  row: CapiTokenRow,
  refreshFn: RefreshFn = refreshAccessToken,
): Promise<CapiSession> {
  const session = new CapiSession(
    svc,
    userId,
    row.access_token,
    row.refresh_token,
    refreshFn,
    row.expires_at,
  );
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
