import type { CapiSyncResult } from './syncPilot';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Svc = any;
export const CAPI_SYNC_JOB_FIELDS = 'id,status,stage,requested_at,started_at,heartbeat_at,attempts,stage_timings,total_duration_ms,result,error';

export async function findActiveCapiSyncJob(svc: Svc, userId: string) {
  return svc.from('capi_sync_jobs')
    .select(CAPI_SYNC_JOB_FIELDS)
    .eq('user_id', userId)
    .in('status', ['queued', 'running'])
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

/** Idempotently join/create the single active job allowed per site account. */
export async function enqueueCapiSyncJob(svc: Svc, userId: string, options: {
  requestedPlatform?: string | null;
  skipCommunityGoals?: boolean;
} = {}) {
  const current = await findActiveCapiSyncJob(svc, userId);
  if (current.error || current.data) return { ...current, reused: Boolean(current.data) };

  const inserted = await svc.from('capi_sync_jobs')
    .insert({
      user_id: userId,
      status: 'queued',
      stage: 'queued',
      requested_platform: options.requestedPlatform ?? null,
      skip_community_goals: options.skipCommunityGoals ?? true,
    })
    .select(CAPI_SYNC_JOB_FIELDS)
    .single();
  if (inserted.error?.code === '23505') {
    const raced = await findActiveCapiSyncJob(svc, userId);
    return { ...raced, reused: Boolean(raced.data) };
  }
  return { ...inserted, reused: false };
}

/** Keep persisted/browser-visible diagnostics free of bearer and OAuth tokens. */
export function safeCapiDiagnostic(value: unknown, maxLength = 500): string {
  const message = value instanceof Error ? value.message : String(value ?? 'Unknown error');
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/((?:access|refresh)_token["'\s:=]+)[^\s,"'&}]+/gi, '$1[redacted]')
    .replace(/(client_secret["'\s:=]+)[^\s,"'&}]+/gi, '$1[redacted]')
    .slice(0, maxLength);
}

/** Narrow sync result before it is written to the durable queue or returned to the UI. */
export function publicCapiSyncResult(result: CapiSyncResult) {
  return {
    ok: result.ok,
    cmdrName: result.cmdrName,
    profileSaved: result.profileSaved,
    journalStatus: result.journalStatus,
    eventsImported: result.eventsImported,
    eventsDuplicate: result.eventsDuplicate,
    eventsSkipped: result.eventsSkipped,
    warnings: result.warnings.slice(0, 30).map((warning) => safeCapiDiagnostic(warning)),
    error: result.error ? safeCapiDiagnostic(result.error) : null,
    detail: result.detail ? safeCapiDiagnostic(result.detail) : null,
    needsReauth: result.needsReauth,
    reason: result.reason ?? null,
    errorKind: result.errorKind ?? null,
    transportPhase: result.transportPhase ?? null,
    httpStatus: result.httpStatus ?? null,
    endpoint: result.endpoint ?? null,
    host: result.host ?? null,
    platform: result.platform ?? null,
    binding: result.binding,
  };
}
