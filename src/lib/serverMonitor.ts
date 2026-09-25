import type {
  MonitorAgent,
  MonitorContainer,
  MonitorContainerMetrics,
  MonitorContentPipeline,
  MonitorDatabase,
  MonitorDatabaseSize,
  MonitorDatabaseTable,
  MonitorDisk,
  MonitorDocker,
  MonitorJob,
  MonitorLevel,
  MonitorProject,
  MonitorScheduler,
  MonitorTranslationQueue,
  ServerMonitorSnapshot,
} from '@/types/monitor';
import { describePgConnectionError, galaxyDbUrl, loadPg, type PgClientLike } from './pgModule';
import { hasTranslateCredentials } from './translate';
import { getUpdateAgentStatus } from './updateAgent';

const DATABASE_TIMEOUT_MS = 4_000;
/** `pg_database_size` is cheap; a huge catalogue is not — keep the probe bounded. */
const DISK_PROBE_TIMEOUT_MS = 8_000;
const AGENT_TIMEOUT_MS = 3_000;
const GITHUB_CACHE_MS = 5 * 60_000;
const DEFAULT_REPOSITORY = 'NooboGreenD/ed-ring-colony';
const DEFAULT_BRANCH = 'main';
const TRANSLATION_RETRY_STATUSES = 'pending,failed,partial';
const MIGRATION_FILE = /^supabase\/migrations\/[A-Za-z0-9._-]{1,80}\.sql$/;

interface CachedUpstream {
  expiresAt: number;
  checkedAt: string;
  sha: string | null;
  aheadBy: number | null;
  newMigrations: string[];
}

let upstreamCache: CachedUpstream | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** `pg` hands bigint columns back as strings. */
function nonNegativeNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function safeSha(value: string | undefined): string | null {
  const sha = value?.trim();
  return sha && /^[a-f0-9]{7,64}$/i.test(sha) ? sha.toLowerCase() : null;
}

function safeIdentifier(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && /^[A-Za-z0-9._/-]{1,120}$/.test(trimmed) ? trimmed : fallback;
}

function safeRepository(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed) ? trimmed : DEFAULT_REPOSITORY;
}

function safeText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function configuredMonitorAgent(): { configured: boolean; url: URL | null; token: string | null } {
  const token = process.env.MONITOR_AGENT_TOKEN?.trim() || null;
  const rawUrl = process.env.MONITOR_AGENT_URL?.trim();
  if (!token || !rawUrl) return { configured: false, url: null, token: null };

  try {
    const url = new URL(rawUrl);
    // The agent is an internal Compose service. Do not forward the private
    // token to an arbitrary URL or a path supplied by a loose environment var.
    if (url.protocol !== 'http:' || url.hostname !== 'monitor-agent' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '')) {
      return { configured: false, url: null, token: null };
    }
    return { configured: true, url, token };
  } catch {
    return { configured: false, url: null, token: null };
  }
}

function supabaseRest(): { origin: URL; serviceKey: string } | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!base || !serviceKey) return null;
  try {
    const origin = new URL(base);
    if (!['http:', 'https:'].includes(origin.protocol)) return null;
    return { origin, serviceKey };
  } catch {
    return null;
  }
}

async function probeDatabase(): Promise<MonitorDatabase> {
  const rest = supabaseRest();
  if (!rest) return { status: 'unknown', configured: false, latencyMs: null, size: emptyDatabaseSize('Service role key или URL Supabase не заданы') };


  try {
    const probe = new URL('/rest/v1/profiles', rest.origin);
    probe.searchParams.set('select', 'id');
    probe.searchParams.set('limit', '1');

    const started = Date.now();
    const response = await fetch(probe, {
      headers: {
        apikey: rest.serviceKey,
        Authorization: `Bearer ${rest.serviceKey}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
    });
    // We intentionally do not read a row: the probe must never handle PII.
    void response.body?.cancel().catch(() => undefined);
    return {
      status: response.ok ? 'healthy' : 'critical',
      configured: true,
      latencyMs: Date.now() - started,
      size: emptyDatabaseSize(null),
    };
  } catch {
    // Do not expose network/SQL/auth errors from an operations endpoint.
    return { status: 'critical', configured: true, latencyMs: null, size: emptyDatabaseSize(null) };
  }
}

function emptyDatabaseSize(note: string | null): MonitorDatabaseSize {
  return {
    available: false,
    databaseName: null,
    databaseBytes: null,
    schemaBytes: null,
    tableBytes: null,
    indexBytes: null,
    toastBytes: null,
    largest: [],
    measuredAt: null,
    note,
  };
}

function emptyDisk(): MonitorDisk {
  return { available: false, totalBytes: null, usedBytes: null, availableBytes: null, usedPercent: null };
}

function emptyPipeline(note: string | null): MonitorContentPipeline {
  return {
    available: false,
    note,
    translateConfigured: hasTranslateCredentials(),
    lastSync: null,
    queue: [],
    pendingTotal: null,
  };
}

const DB_TOP_RELATIONS_SQL = `
  SELECT c.relname AS name,
         c.relkind AS kind,
         pg_total_relation_size(c.oid) AS total_bytes,
         pg_table_size(c.oid) AS table_bytes,
         pg_indexes_size(c.oid) AS index_bytes,
         COALESCE(s.n_live_tup, -1) AS live_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'm', 'p')
   ORDER BY pg_total_relation_size(c.oid) DESC
   LIMIT 12`;

const DB_SCHEMA_TOTAL_SQL = `
  SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS schema_bytes,
         COALESCE(SUM(pg_table_size(c.oid)), 0) AS table_bytes,
         COALESCE(SUM(pg_indexes_size(c.oid)), 0) AS index_bytes,
         COALESCE(SUM(GREATEST(pg_total_relation_size(c.oid) - pg_table_size(c.oid) - pg_indexes_size(c.oid), 0)), 0) AS toast_bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'm', 'p')`;

function sanitizeTable(value: unknown): MonitorDatabaseTable | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  const name = value.name.replace(/[^A-Za-z0-9_.$-]/g, '').slice(0, 80);
  if (!name) return null;
  const kind = value.kind === 'm' ? 'materialized view' : value.kind === 'p' ? 'partitioned table' : 'table';
  const rows = nonNegativeNumber(value.live_rows);
  return {
    name,
    kind,
    totalBytes: nonNegativeNumber(value.total_bytes) ?? 0,
    tableBytes: nonNegativeNumber(value.table_bytes) ?? 0,
    indexBytes: nonNegativeNumber(value.index_bytes) ?? 0,
    liveRows: rows == null || rows < 0 ? null : rows,
  };
}

/** Строки «largest» уже нормализованы агентом (camelCase) — проверяем, но не пересчитываем. */
function sanitizeAgentDbTable(value: unknown): MonitorDatabaseTable | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  const name = value.name.replace(/[^A-Za-z0-9_.$-]/g, '').slice(0, 80);
  if (!name) return null;
  return {
    name,
    kind: value.kind === 'materialized view' ? 'materialized view'
      : value.kind === 'partitioned table' ? 'partitioned table' : 'table',
    totalBytes: nonNegativeNumber(value.totalBytes) ?? 0,
    tableBytes: nonNegativeNumber(value.tableBytes) ?? 0,
    indexBytes: nonNegativeNumber(value.indexBytes) ?? 0,
    liveRows: nonNegativeNumber(value.liveRows),
  };
}

/**
 * Блок «db» из /status монитора. web-контейнер может не иметь DATABASE_URL
 * (Supabase живёт на хосте), тогда единственный, кто видит размер БД, —
 * monitor-agent: его замеры используются как запасной источник.
 */
function sanitizeAgentDb(value: unknown): MonitorDatabaseSize | null {
  if (!isRecord(value)) return null;
  const note = typeof value.note === 'string' ? value.note.slice(0, 300) : null;
  if (value.available !== true) return note ? { ...emptyDatabaseSize(null), note } : null;
  return {
    available: true,
    databaseName: typeof value.databaseName === 'string' ? value.databaseName.slice(0, 63) : null,
    databaseBytes: nonNegativeNumber(value.databaseBytes),
    schemaBytes: nonNegativeNumber(value.schemaBytes),
    tableBytes: nonNegativeNumber(value.tableBytes),
    indexBytes: nonNegativeNumber(value.indexBytes),
    toastBytes: nonNegativeNumber(value.toastBytes),
    largest: Array.isArray(value.largest)
      ? value.largest.map(sanitizeAgentDbTable).filter((row): row is MonitorDatabaseTable => row !== null)
      : [],
    measuredAt: typeof value.measuredAt === 'string' ? value.measuredAt : null,
    note: null,
  };
}

/** Прямая проба web-контейнера впереди; замеры monitor-agent — запасной вариант. */
function mergeDatabaseSize(size: MonitorDatabaseSize, agentDb: MonitorDatabaseSize | null): MonitorDatabaseSize {
  if (size.available) return size;
  if (agentDb?.available) return agentDb;
  return agentDb?.note ? { ...size, note: agentDb.note } : size;
}

/**
 * How much disk the database occupies. Uses the same direct Postgres path as
 * the Spansh import (`DATABASE_URL` / `SUPABASE_DB_URL`); when neither is set
 * the panel says so instead of guessing a size from HTTP latency.
 */
async function probeDatabaseSize(): Promise<MonitorDatabaseSize> {
  const url = galaxyDbUrl();
  if (!url) {
    return emptyDatabaseSize('DATABASE_URL/SUPABASE_DB_URL не заданы: размер БД считается только по прямому подключению к Postgres');
  }

  let client: PgClientLike | null = null;
  try {
    const pg = await loadPg();
    client = new pg.Client({
      connectionString: url,
      statement_timeout: DISK_PROBE_TIMEOUT_MS,
      query_timeout: DISK_PROBE_TIMEOUT_MS,
      connectionTimeoutMillis: 3_000,
    });
    await client.connect();

    const [sizeResult, totalsResult, topResult] = await Promise.all([
      client.query(`SELECT current_database() AS name, pg_database_size(current_database()) AS bytes`),
      client.query(DB_SCHEMA_TOTAL_SQL),
      client.query(DB_TOP_RELATIONS_SQL),
    ]);

    const sizeRow = isRecord(sizeResult.rows[0]) ? sizeResult.rows[0] : null;
    const totals = isRecord(totalsResult.rows[0]) ? totalsResult.rows[0] : {};

    return {
      available: true,
      databaseName: typeof sizeRow?.name === 'string' ? sizeRow.name.slice(0, 63) : null,
      databaseBytes: nonNegativeNumber(sizeRow?.bytes),
      schemaBytes: nonNegativeNumber(totals.schema_bytes),
      tableBytes: nonNegativeNumber(totals.table_bytes),
      indexBytes: nonNegativeNumber(totals.index_bytes),
      toastBytes: nonNegativeNumber(totals.toast_bytes),
      largest: (topResult.rows || []).map(sanitizeTable).filter((row): row is MonitorDatabaseTable => row !== null),
      measuredAt: new Date().toISOString(),
      note: null,
    };
  } catch (error) {
    // The size probe is optional: it must never change the health verdict, but
    // the panel can still say why the direct connection did not work.
    const reason = describePgConnectionError(error, url).detail;
    return emptyDatabaseSize(
      `Прямой запрос к Postgres не прошёл (${reason}) — проверьте DATABASE_URL и права роли`,
    );
  } finally {
    try { await client?.end(); } catch { /* the probe is best-effort */ }
  }
}

function sanitizeMetrics(value: unknown): MonitorContainerMetrics | null {
  if (!isRecord(value)) return null;
  return {
    memoryBytes: positiveNumber(value.memoryBytes),
    memoryLimitBytes: positiveNumber(value.memoryLimitBytes),
    cpuPercent: positiveNumber(value.cpuPercent),
  };
}

function sanitizeContainer(value: unknown): MonitorContainer | null {
  if (!isRecord(value)) return null;
  const service = typeof value.service === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value.service)
    ? value.service
    : null;
  if (!service) return null;
  const state = typeof value.state === 'string' && /^[a-z_ -]{1,32}$/i.test(value.state) ? value.state : 'unknown';
  const health = value.health === 'healthy' || value.health === 'unhealthy' || value.health === 'starting'
    ? value.health
    : 'not_configured';
  return {
    service,
    state,
    health,
    startedAt: validIso(value.startedAt),
    finishedAt: validIso(value.finishedAt),
    exitCode: positiveNumber(value.exitCode),
    restartCount: positiveNumber(value.restartCount) ?? 0,
    metrics: sanitizeMetrics(value.metrics),
  };
}

function sanitizeJob(value: unknown): MonitorJob | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(value.name)) return null;
  const status = value.status === 'healthy' || value.status === 'warning' ? value.status : 'unknown';
  return {
    name: value.name,
    status,
    lastSuccessAt: validIso(value.lastSuccessAt),
    nextRunAt: validIso(value.nextRunAt),
    ageSeconds: positiveNumber(value.ageSeconds),
    everySeconds: positiveNumber(value.everySeconds),
    // Failure facts come from the runner's own state file; the agent already
    // bounds the text — here we only re-validate shape and length.
    lastError: safeText(value.lastError, 240),
    lastFailureAt: validIso(value.lastFailureAt),
    failures: positiveNumber(value.failures),
  };
}

/** Only sizes leave the agent — never paths, mounts or the container's layout. */
function sanitizeDisk(value: unknown): MonitorDisk {
  if (!isRecord(value) || value.available !== true) return emptyDisk();
  const total = positiveNumber(value.totalBytes);
  const available = positiveNumber(value.availableBytes);
  if (total == null || available == null || total <= 0) return emptyDisk();
  const used = positiveNumber(value.usedBytes) ?? Math.max(0, total - available);
  return {
    available: true,
    totalBytes: total,
    usedBytes: used,
    availableBytes: available,
    usedPercent: Math.round((used / total) * 1000) / 10,
  };
}

function emptyDocker(configured: boolean): MonitorDocker {
  return { configured, available: false, containers: [] };
}

function emptyScheduler(): MonitorScheduler {
  return { available: false, state: 'unavailable', jobs: [] };
}

async function probeMonitorAgent(): Promise<{
  agent: MonitorAgent;
  docker: MonitorDocker;
  scheduler: MonitorScheduler;
  disk: MonitorDisk;
  db: MonitorDatabaseSize | null;
}> {
  const config = configuredMonitorAgent();
  if (!config.configured || !config.url || !config.token) {
    return { agent: { configured: false, connected: false }, docker: emptyDocker(false), scheduler: emptyScheduler(), disk: emptyDisk(), db: null };
  }

  try {
    const target = new URL('/status', config.url);
    const response = await fetch(target, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('Agent unavailable');
    const payload: unknown = await response.json();
    if (!isRecord(payload) || payload.ok !== true) throw new Error('Invalid agent response');

    const rawDocker = isRecord(payload.docker) ? payload.docker : {};
    const rawScheduler = isRecord(payload.scheduler) ? payload.scheduler : {};
    const containers = Array.isArray(rawDocker.containers)
      ? rawDocker.containers.map(sanitizeContainer).filter((item): item is MonitorContainer => item !== null)
      : [];
    const jobs = Array.isArray(rawScheduler.jobs)
      ? rawScheduler.jobs.map(sanitizeJob).filter((item): item is MonitorJob => item !== null)
      : [];
    const schedulerState = rawScheduler.state;
    const state: MonitorScheduler['state'] = schedulerState === 'ready' || schedulerState === 'waiting_for_state'
      || schedulerState === 'not_configured' || schedulerState === 'invalid' || schedulerState === 'unavailable'
      ? schedulerState
      : 'unavailable';

    return {
      agent: { configured: true, connected: true },
      docker: {
        configured: rawDocker.configured === true,
        available: rawDocker.available === true,
        containers,
      },
      scheduler: {
        available: rawScheduler.available === true,
        state,
        jobs,
      },
      disk: sanitizeDisk(payload.disk),
      db: sanitizeAgentDb(payload.db),
    };
  } catch {
    // An agent failure must not hide the app/database/project checks.
    return {
      agent: { configured: true, connected: false },
      docker: emptyDocker(true),
      scheduler: emptyScheduler(),
      disk: emptyDisk(),
      db: null,
    };
  }
}

/** PostgREST answers `Prefer: count=exact` with `content-range: 0-0/123`. */
async function countRows(
  origin: URL,
  serviceKey: string,
  table: string,
  translationStatus: string | null,
): Promise<number | null> {
  try {
    const target = new URL(`/rest/v1/${table}`, origin);
    target.searchParams.set('select', 'id');
    if (translationStatus) target.searchParams.set('translation_status', `in.(${translationStatus})`);
    target.searchParams.set('limit', '1');
    const response = await fetch(target, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: 'count=exact',
        Range: '0-0',
        Accept: 'application/json',
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const match = /\/(\d+)$/.exec(response.headers.get('content-range') || '');
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

/**
 * Galnet/news pipeline: the last sync result and how many rows still wait for
 * a translation. This is what answers «почему на сайте нет Galnet».
 */
async function probeContentPipeline(): Promise<MonitorContentPipeline> {
  const rest = supabaseRest();
  if (!rest) return emptyPipeline('Service role key не задан — очередь переводов недоступна');
  const { origin, serviceKey } = rest;

  let lastSync: MonitorContentPipeline['lastSync'] = null;
  try {
    const logUrl = new URL('/rest/v1/galnet_sync_log', origin);
    logUrl.searchParams.set('select', 'fetched_at,status,articles_count,new_count,translated_count,error_msg');
    logUrl.searchParams.set('order', 'id.desc');
    logUrl.searchParams.set('limit', '1');
    const response = await fetch(logUrl, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
    });
    if (response.ok) {
      const rows: unknown = await response.json();
      const row = Array.isArray(rows) && isRecord(rows[0]) ? rows[0] : null;
      if (row) {
        lastSync = {
          at: validIso(row.fetched_at),
          status: safeText(row.status, 24),
          articlesCount: nonNegativeNumber(row.articles_count),
          newCount: nonNegativeNumber(row.new_count),
          translatedCount: nonNegativeNumber(row.translated_count),
          error: safeText(row.error_msg, 240),
        };
      }
    }
  } catch {
    // An absent log table is a normal state for a fresh or minimal database.
  }

  const queue: MonitorTranslationQueue[] = [];
  let pendingTotal: number | null = 0;
  for (const table of ['galnet_news', 'news']) {
    const pending = await countRows(origin, serviceKey, table, TRANSLATION_RETRY_STATUSES);
    queue.push({ table, pending });
    if (pending != null) pendingTotal += pending;
  }

  return {
    available: true,
    note: lastSync ? null : 'В galnet_sync_log нет записей: синхронизация Galnet ещё не выполнялась',
    translateConfigured: hasTranslateCredentials(),
    lastSync,
    queue,
    pendingTotal,
  };
}

/**
 * Upstream revision and what it would bring: commit count plus the new SQL
 * migrations. Cached for five minutes — the panel refreshes every 20 seconds.
 */
async function compareUpstream(repository: string, branch: string, currentSha: string | null) {
  const now = Date.now();
  if (upstreamCache && upstreamCache.expiresAt > now) {
    return { checkedAt: upstreamCache.checkedAt, sha: upstreamCache.sha, aheadBy: upstreamCache.aheadBy, newMigrations: upstreamCache.newMigrations };
  }

  const checkedAt = new Date(now).toISOString();
  let sha: string | null = null;
  let aheadBy: number | null = null;
  let newMigrations: string[] = [];
  const [owner = '', repo = ''] = repository.split('/');
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ed-ring-colony-operations-dashboard',
    ...(process.env.GITHUB_TOKEN?.trim() ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN.trim()}` } : {}),
  };

  try {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}`;
    const response = await fetch(url, { headers, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(AGENT_TIMEOUT_MS) });
    if (response.ok) {
      const body: unknown = await response.json();
      sha = isRecord(body) && typeof body.sha === 'string' ? safeSha(body.sha) : null;
    }
  } catch {
    // An optional remote update check must never change app health.
  }

  if (sha && currentSha) {
    try {
      const compareUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${currentSha}...${encodeURIComponent(sha)}`;
      const response = await fetch(compareUrl, { headers, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(AGENT_TIMEOUT_MS) });
      if (response.ok) {
        const body: unknown = await response.json();
        if (isRecord(body)) {
          aheadBy = nonNegativeNumber(body.ahead_by);
          const files = Array.isArray(body.files) ? body.files : [];
          newMigrations = files
            .map((file) => (isRecord(file) && typeof file.filename === 'string' ? file.filename : ''))
            .filter((name) => MIGRATION_FILE.test(name))
            .sort();
        }
      }
    } catch {
      // Compare is a bonus on top of the head revision.
    }
  }

  upstreamCache = { expiresAt: now + GITHUB_CACHE_MS, checkedAt, sha, aheadBy, newMigrations };
  return { checkedAt, sha, aheadBy, newMigrations };
}

async function projectStatus(): Promise<MonitorProject> {
  const currentSha = safeSha(process.env.APP_GIT_SHA);
  const currentRef = safeIdentifier(process.env.APP_GIT_REF, 'unknown');
  const builtAt = validIso(process.env.APP_BUILD_TIME);
  const repository = safeRepository(process.env.PROJECT_REPOSITORY);
  const branch = safeIdentifier(process.env.PROJECT_UPDATE_BRANCH, DEFAULT_BRANCH);
  const upstream = await compareUpstream(repository, branch, currentSha);
  const sameRevision = !!currentSha && !!upstream.sha && upstream.sha.startsWith(currentSha);
  const updater = await getUpdateAgentStatus();

  // Неприменённые миграции: земля истины — update-agent (сверка с
  // migrations.mark на хосте показывает и «забытые» после сбоя файлы). Сверка
  // GitHub видит только то, что ново между ревизиями, и остаётся запасным
  // источником, когда агент недоступен. Имена — без каталога: путь на хосте
  // браузеру не нужен.
  const pendingMigrations = (updater.connected ? updater.pendingMigrations : upstream.newMigrations)
    .map((name) => name.split('/').pop() || name)
    .filter((name) => MIGRATION_FILE.test(`supabase/migrations/${name}`));

  return {
    currentSha,
    currentRef: currentRef === 'unknown' ? null : currentRef,
    builtAt,
    upstreamBranch: branch,
    upstreamSha: upstream.sha,
    upstreamCheckedAt: upstream.checkedAt,
    aheadBy: !currentSha || upstream.sha == null ? upstream.aheadBy : sameRevision ? 0 : upstream.aheadBy,
    pendingMigrations,
    updateStatus: !currentSha || !upstream.sha ? 'unknown' : sameRevision ? 'current' : 'different',
    updater: {
      configured: updater.configured,
      connected: updater.connected,
      active: updater.public.active,
      state: updater.public.state,
      reason: updater.connected ? null : updater.reason,
    },
  };
}

function overallLevel(
  database: MonitorDatabase,
  agent: MonitorAgent,
  docker: MonitorDocker,
  scheduler: MonitorScheduler,
  disk: MonitorDisk,
): MonitorLevel {
  if (database.status === 'critical') return 'critical';
  if (agent.connected && !docker.available) return 'critical';
  if (agent.connected && docker.available && docker.containers.some((container) =>
    container.state === 'missing' || container.state === 'stopped' || container.health === 'unhealthy')) return 'critical';
  if (disk.available && disk.availableBytes != null && disk.availableBytes < 1_073_741_824) return 'critical';
  if (database.status !== 'healthy') return 'warning';
  if (!agent.configured || !agent.connected || !docker.available || !scheduler.available) return 'warning';
  if (docker.containers.some((container) => container.health === 'starting' || container.restartCount > 3)) return 'warning';
  if (scheduler.jobs.some((job) => job.status !== 'healthy')) return 'warning';
  if (disk.available && disk.usedPercent != null && disk.usedPercent >= 90) return 'warning';
  if (database.size.available && database.size.databaseBytes != null && database.size.databaseBytes > 8 * 1024 ** 3) return 'warning';
  return 'healthy';
}

/** Collect a credential-free operational snapshot for an already-authorised admin. */
export async function getServerMonitorSnapshot(): Promise<ServerMonitorSnapshot> {
  const now = Date.now();
  const startedAt = new Date(now - process.uptime() * 1000).toISOString();
  const memory = process.memoryUsage();
  const [databaseCheck, size, agentResult, content, project] = await Promise.all([
    probeDatabase(),
    probeDatabaseSize(),
    probeMonitorAgent(),
    probeContentPipeline(),
    projectStatus(),
  ]);
  // Если web-контейнер не видит Postgres напрямую (нет DATABASE_URL), а
  // monitor-agent его видит — показываем замеры агента, а не «не настроено».
  const database = { ...databaseCheck, size: mergeDatabaseSize(size, agentResult.db) };
  const application = {
    status: 'healthy' as const,
    uptimeSeconds: Math.floor(process.uptime()),
    startedAt,
    nodeVersion: process.version,
    memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
  };

  return {
    checkedAt: new Date(now).toISOString(),
    overall: overallLevel(database, agentResult.agent, agentResult.docker, agentResult.scheduler, agentResult.disk),
    application,
    database,
    disk: agentResult.disk,
    content,
    agent: agentResult.agent,
    docker: agentResult.docker,
    scheduler: agentResult.scheduler,
    project,
  };
}
