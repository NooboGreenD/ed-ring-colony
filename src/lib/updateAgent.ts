/**
 * Client for the private, host-side project updater (`scripts/update-agent.mjs`).
 *
 * The web container has no git, no Docker socket and no shell, so a manual
 * «обновить проект» always goes through this narrow, token-guarded HTTP hop.
 * The agent answers with a sanitised progress document; anything that leaves
 * this module for the browser is a further reduced `public` projection
 * (stage + percent only), because «System Update» is shown to every visitor.
 */
import {
  UPDATE_AGENT_PROTOCOL,
  emptyUpdateState,
  publicUpdateView,
  sanitizeAgentInfo,
  sanitizeUpdateState,
} from '../../scripts/lib/update-state.mjs';

export type UpdateAgentInfo = NonNullable<ReturnType<typeof sanitizeAgentInfo>> & {
  /** Версия протокола, которую ждёт сайт (константа этой сборки). */
  expectedProtocol: number;
  /** true — агент старее сайта/клона: флажки прогона могут игнорироваться. */
  outdated: boolean;
};

export interface UpdateAgentStatus {
  configured: boolean;
  connected: boolean;
  /** Admin-only detail (progress + log tail). Never exposed anonymously. */
  update: ReturnType<typeof sanitizeUpdateState> | null;
  /**
   * Кто именно отвечает на запросы: версия протокола агента и признак того,
   * что он работает на устаревшем коде. Обновление намеренно не пересоздаёт
   * контейнер апдейтера, поэтому он легко оказывается старее сайта — и тогда
   * новые флажки («только миграции», «без бэкапа», «без тестов») до скрипта
   * не доезжают. Панель показывает предупреждение и кнопку перезапуска.
   */
  agent: UpdateAgentInfo | null;
  /** What /api/status may reveal to any visitor. */
  public: ReturnType<typeof publicUpdateView>;
  /**
   * Имена файлов supabase/migrations/*.sql, которых агент не видит
   * применёнными (сверка с migrations.mark на хосте). Ровно то, что кнопка
   * донашивает при следующем обновлении.
   */
  pendingMigrations: string[];
  reason: string | null;
}

const MIGRATION_NAME = /^[A-Za-z0-9._-]{1,80}\.sql$/;

const STATUS_TIMEOUT_MS = 2_500;
/** Two seconds is short enough for a live progress bar, long enough to absorb a page flood. */
export const PUBLIC_STATUS_CACHE_MS = 2_000;

interface AgentConfig {
  configured: boolean;
  url: URL | null;
  token: string | null;
  reason: string | null;
}

export function configuredUpdateAgent(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const token = env.UPDATE_AGENT_TOKEN?.trim() || null;
  const raw = env.UPDATE_AGENT_URL?.trim();
  if (!raw) return { configured: false, url: null, token: null, reason: 'UPDATE_AGENT_URL не задан' };
  if (!token) return { configured: false, url: null, token: null, reason: 'UPDATE_AGENT_TOKEN не задан' };

  try {
    const url = new URL(raw);
    // Internal updater only: plain http, no path, no credentials embedded.
    if (url.protocol !== 'http:' || url.username || url.password || (url.pathname !== '' && url.pathname !== '/')) {
      return { configured: false, url: null, token: null, reason: 'UPDATE_AGENT_URL должен быть внутренним http-адресом без пути и учётных данных' };
    }
    return { configured: true, url, token, reason: null };
  } catch {
    return { configured: false, url: null, token: null, reason: 'UPDATE_AGENT_URL не разобран как URL' };
  }
}

const idleState = () => sanitizeUpdateState(emptyUpdateState());

function offline(configured: boolean, reason: string | null): UpdateAgentStatus {
  const update = idleState();
  return { configured, connected: false, update, agent: null, public: publicUpdateView(update), pendingMigrations: [], reason };
}

interface CachedStatus {
  expiresAt: number;
  value: UpdateAgentStatus;
  /**
   * Был ли ответ получен с `?full=1`. Без этого флага кэш, заполненный
   * публичным /api/status (там журнал не запрашивается), отдавался и
   * админской панели — и хвост журнала в ней то появлялся, то пропадал
   * каждые пару секунд. Проекция «полного» в «короткий» безопасна, обратная
   * — нет, поэтому короткий ответ никогда не обслуживает полный запрос.
   */
  full: boolean;
}

let cache: CachedStatus | null = null;

export function invalidateUpdateAgentCache() {
  cache = null;
}

/** Reads the updater progress. `full` additionally keeps the log tail. */
export async function getUpdateAgentStatus(options: { full?: boolean; cacheMs?: number } = {}): Promise<UpdateAgentStatus> {
  const config = configuredUpdateAgent();
  if (!config.configured || !config.url || !config.token) return offline(false, config.reason);

  const cacheMs = options.cacheMs ?? PUBLIC_STATUS_CACHE_MS;
  const now = Date.now();
  const wantFull = options.full === true;
  // cacheMs = 0 («дай свежее», так ходит админская панель) обязан миновать
  // кэш и на чтение: раньше он лишь не продлевал запись, но сам продолжал
  // читать чужой — публичный — ответ без журнала.
  if (cacheMs > 0 && cache && cache.expiresAt > now && (cache.full || !wantFull)) {
    return project(cache.value, wantFull);
  }

  try {
    const target = new URL('/status', config.url);
    if (wantFull) target.searchParams.set('full', '1');
    const response = await fetch(target, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
    const update = sanitizeUpdateState(record.update ?? null);
    const pendingMigrations = Array.isArray(record.pendingMigrations)
      ? (record.pendingMigrations as unknown[])
          .filter((name): name is string => typeof name === 'string' && MIGRATION_NAME.test(name))
          .sort()
      : [];
    const value: UpdateAgentStatus = {
      configured: true,
      connected: true,
      update,
      agent: describeAgent(record.agent),
      public: publicUpdateView(update),
      pendingMigrations,
      reason: null,
    };
    cache = { expiresAt: now + cacheMs, value, full: wantFull };
    return project(value, wantFull);
  } catch {
    // An unreachable updater never means "the site is broken": the header
    // falls back to System Online and the button explains what is missing.
    const value = offline(true, 'update-agent не отвечает (проверьте, что update-agent запущен на хосте и токен совпадает)');
    cache = { expiresAt: now + Math.max(cacheMs, 5_000), value, full: true };
    return value;
  }
}

/**
 * Свести ответ агента о себе к тому, что нужно панели.
 *
 * Агент старее сайта — не экзотика, а норма при нынешней схеме: обновление
 * не пересоздаёт его контейнер. Молчащий про это интерфейс и порождал
 * «галочки не влияют на сборку» и «кнопка миграций пересобирает проект».
 */
function describeAgent(raw: unknown): UpdateAgentInfo | null {
  const info = sanitizeAgentInfo(raw);
  if (!info) {
    // Совсем старый агент про себя ничего не рассказывает — сам факт
    // отсутствия поля и есть признак устаревшей версии.
    return {
      protocol: 0,
      stale: true,
      fromRepo: false,
      revision: null,
      repoRevision: null,
      startedAt: null,
      migrationsOnlySupported: false,
      canRestart: false,
      expectedProtocol: UPDATE_AGENT_PROTOCOL,
      outdated: true,
    };
  }
  return {
    ...info,
    expectedProtocol: UPDATE_AGENT_PROTOCOL,
    outdated: info.stale || info.protocol < UPDATE_AGENT_PROTOCOL,
  };
}

function project(value: UpdateAgentStatus, wantFull: boolean): UpdateAgentStatus {
  if (wantFull) return value;
  return { ...value, update: value.update ? { ...value.update, log: [] } : null };
}

/**
 * Действия агента. `backup` идёт в тот же процессный слот, что и `start`:
 * дамп базы и пересборка стека не должны выполняться одновременно.
 */
export type UpdateAction = 'start' | 'abort' | 'backup' | 'restart';

/**
 * Mapping to the agent's HTTP contract (see the endpoint list at the top of
 * `scripts/update-agent.mjs`): starting an update is `POST /update`. A naive
 * `POST /start` falls through the agent's router and answers 404 — the admin
 * button reported «ошибка 404» for exactly this reason.
 */
const AGENT_PATHS: Record<UpdateAction, string> = {
  start: 'update',
  abort: 'abort',
  backup: 'backup',
  // Перезапуск нужен, когда агент остался на старом коде: пока он не поднят
  // заново, новые флажки прогона он попросту не понимает.
  restart: 'restart',
};

/** Forwards an admin-confirmed action to the updater. Returns the raw agent answer. */
export async function callUpdateAgent(action: UpdateAction, body?: Record<string, unknown>) {
  const config = configuredUpdateAgent();
  if (!config.configured || !config.url || !config.token) {
    return { ok: false as const, status: 503, error: config.reason || 'Update-агент не настроен' };
  }

  try {
    const response = await fetch(new URL(`/${AGENT_PATHS[action]}`, config.url), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    invalidateUpdateAgentCache();
    const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
    if (!response.ok) {
      // Агент объясняет отказ человеческим текстом (`reason`/`error`): режим
      // «только миграции» не поддержан старым скриптом, самоперезапуск
      // выключен и т.п. Такое сообщение полезнее, чем «ответил 503».
      const said = typeof record.error === 'string' && record.error.trim()
        ? record.error.trim()
        : typeof record.reason === 'string' && record.reason.trim()
          ? record.reason.trim()
          : null;
      const reason = said || (response.status === 409
        ? 'Агент уже занят (обновление или резервная копия) — дождитесь окончания'
        : `Update-агент ответил ${response.status}`);
      return { ok: false as const, status: response.status, error: reason, update: sanitizeUpdateState(record.update ?? null) };
    }
    return {
      ok: true as const,
      status: response.status,
      update: sanitizeUpdateState(record.update ?? null),
    };
  } catch {
    invalidateUpdateAgentCache();
    return { ok: false as const, status: 502, error: 'Update-агент недоступен: обновление не запущено' };
  }
}

// ── Управление ключами .env.production (Админка → Мониторинг → API-ключи) ────
//
// Веб-контейнер не имеет ни git, ни Docker, ни доступа к файлам хоста, поэтому
// и ключи редактируются через тот же узкий, защищённый токеном хоппинг в
// update-agent — единственный процесс, которому разрешено трогать файл
// окружения. Снаружи уходит только маска: сырое значение ключа никогда не
// доезжает до браузера, «изменить» = заменить целиком.

export interface EnvKeyEntry {
  name: string;
  masked: string;
  length: number;
}

interface AgentResult<T> {
  ok: boolean;
  status: number;
  error?: string;
  payload: T | null;
}

async function agentRequest<T extends Record<string, unknown>>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<AgentResult<T>> {
  const config = configuredUpdateAgent();
  if (!config.configured || !config.url || !config.token) {
    return { ok: false, status: 503, error: config.reason || 'Update-агент не настроен', payload: null };
  }

  try {
    const response = await fetch(new URL(path, config.url), {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    invalidateUpdateAgentCache();
    const record = (payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}) as T;
    if (!response.ok) {
      const reason = typeof (record as { error?: unknown }).error === 'string'
        ? (record as unknown as { error: string }).error
        : `Update-агент ответил ${response.status}`;
      return { ok: false, status: response.status, error: reason, payload: record };
    }
    return { ok: true, status: response.status, payload: record };
  } catch {
    invalidateUpdateAgentCache();
    return { ok: false, status: 502, error: 'Update-агент недоступен', payload: null };
  }
}

/** Список ключей файла окружения — в маске (длина + хвост), без сырых значений. */
export function listEnvKeys() {
  return agentRequest<{ configured?: boolean; keys?: EnvKeyEntry[] }>('GET', '/env');
}

/** Записать/обновить один ключ. Возврат: 201 — создан, 200 — обновлён. */
export function saveEnvKey(key: string, value: string) {
  return agentRequest<{ key?: string; created?: boolean; masked?: string; length?: number }>('POST', '/env', { key, value });
}

export function deleteEnvKey(key: string) {
  return agentRequest<{ key?: string; removed?: boolean }>('DELETE', `/env?key=${encodeURIComponent(key)}`);
}

/**
 * Применить изменения: пересоздать сервисы, чтобы они подняли новые ключи.
 * Задача идёт в тот же процессный слот, что и update/backup, и видна в панели
 * как job с `kind: 'env'` (стадии ENV_STAGES).
 */
export async function applyEnvKeys(scope: 'web' | 'all' = 'web') {
  const result = await agentRequest<{ update?: unknown }>('POST', '/env/apply', { scope });
  return {
    ok: result.ok,
    status: result.status,
    error: result.error,
    update: result.payload && result.payload.update != null
      ? sanitizeUpdateState(result.payload.update)
      : null,
  };
}
