export type MonitorLevel = 'healthy' | 'warning' | 'critical' | 'unknown';

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
  updateStatus: 'current' | 'different' | 'unknown';
}

export interface ServerMonitorSnapshot {
  checkedAt: string;
  overall: MonitorLevel;
  application: MonitorApplication;
  database: MonitorDatabase;
  agent: MonitorAgent;
  docker: MonitorDocker;
  scheduler: MonitorScheduler;
  project: MonitorProject;
}
