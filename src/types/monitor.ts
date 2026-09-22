export type MonitorLevel = 'healthy' | 'warning' | 'critical' | 'unknown';

/** Largest relations reported by `pg_total_relation_size` for one schema. */
export interface MonitorDatabaseTable {
  name: string;
  kind: 'table' | 'materialized view' | 'partitioned table';
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  liveRows: number | null;
}

/**
 * How much disk the database occupies. Collected over a direct Postgres
 * connection (`DATABASE_URL` / `SUPABASE_DB_URL`); when neither is configured
 * the panel says so instead of pretending the measurement happened.
 */
export interface MonitorDatabaseSize {
  available: boolean;
  databaseName: string | null;
  databaseBytes: number | null;
  schemaBytes: number | null;
  tableBytes: number | null;
  indexBytes: number | null;
  toastBytes: number | null;
  largest: MonitorDatabaseTable[];
  measuredAt: string | null;
  note: string | null;
}

/** Free space of the filesystem that hosts the data (from the private agent). */
export interface MonitorDisk {
  available: boolean;
  totalBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  usedPercent: number | null;
}

export interface MonitorTranslationQueue {
  table: string;
  pending: number | null;
}

/**
 * Galnet/news pipeline facts: last sync result and the translation backlog.
 * Errors are our own log lines, truncated and stripped of URLs.
 */
export interface MonitorContentPipeline {
  available: boolean;
  note: string | null;
  translateConfigured: boolean;
  lastSync: {
    at: string | null;
    status: string | null;
    articlesCount: number | null;
    newCount: number | null;
    translatedCount: number | null;
    error: string | null;
  } | null;
  queue: MonitorTranslationQueue[];
  pendingTotal: number | null;
}

export interface MonitorApplication {
  status: 'healthy';
  uptimeSeconds: number;
  startedAt: string;
  nodeVersion: string;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
  };
}

export interface MonitorDatabase {
  status: MonitorLevel;
  configured: boolean;
  latencyMs: number | null;
  size: MonitorDatabaseSize;
}

export interface MonitorContainerMetrics {
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  cpuPercent: number | null;
}

export interface MonitorContainer {
  service: string;
  state: string;
  health: 'healthy' | 'unhealthy' | 'starting' | 'not_configured';
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  restartCount: number;
  metrics: MonitorContainerMetrics | null;
}

export interface MonitorDocker {
  available: boolean;
  configured: boolean;
  containers: MonitorContainer[];
}

export interface MonitorJob {
  name: string;
  status: 'healthy' | 'warning' | 'unknown';
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  ageSeconds: number | null;
  everySeconds: number | null;
}

export interface MonitorScheduler {
  available: boolean;
  state: 'ready' | 'waiting_for_state' | 'not_configured' | 'invalid' | 'unavailable';
  jobs: MonitorJob[];
}

export interface MonitorAgent {
  configured: boolean;
  connected: boolean;
}

export interface MonitorProject {
  currentSha: string | null;
  currentRef: string | null;
  builtAt: string | null;
  upstreamBranch: string;
  upstreamSha: string | null;
  upstreamCheckedAt: string | null;
  /** Commits on the upstream branch that the deployed build does not have. */
  aheadBy: number | null;
  /** New `supabase/migrations/*.sql` files between the two revisions. */
  pendingMigrations: string[];
  updateStatus: 'current' | 'different' | 'unknown';
  /** Whether a manual (button-driven) update can be started at all. */
  updater: {
    configured: boolean;
    connected: boolean;
    active: boolean;
    state: string | null;
    reason: string | null;
  };
}

export interface ServerMonitorSnapshot {
  checkedAt: string;
  overall: MonitorLevel;
  application: MonitorApplication;
  database: MonitorDatabase;
  disk: MonitorDisk;
  content: MonitorContentPipeline;
  agent: MonitorAgent;
  docker: MonitorDocker;
  scheduler: MonitorScheduler;
  project: MonitorProject;
}
