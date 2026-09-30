export type HelperReleaseJobKind = 'bundle' | 'launcher' | 'promote';
export type HelperReleaseJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'aborted';
export type HelperReleaseLogLevel = 'info' | 'success' | 'warning' | 'error';

export interface HelperReleaseJobStats {
  files: number;
  totalBytes: number;
  hashedFiles: number;
  storedBlobs: number;
  archiveBytes: number;
  durationMs: number;
}

export interface HelperReleaseLogEntry {
  at: string;
  level: HelperReleaseLogLevel;
  line: string;
}

/** Safe-to-display state returned by the admin-only release job endpoint. */
export interface HelperReleaseJob {
  id: string;
  kind: HelperReleaseJobKind;
  state: HelperReleaseJobState;
  active: boolean;
  version: string | null;
  channel: string | null;
  stage: string;
  stageLabel: string;
  percent: number;
  message: string;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  error: string | null;
  stats: HelperReleaseJobStats;
  log: HelperReleaseLogEntry[];
}
