-- Durable queue for manual Frontier CAPI syncs. The browser only enqueues;
-- the scheduled worker claims and executes one job outside the request lifetime.
CREATE TABLE IF NOT EXISTS public.capi_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  stage text NOT NULL DEFAULT 'queued',
  requested_platform text,
  skip_community_goals boolean NOT NULL DEFAULT true,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  stage_timings jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_duration_ms integer,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS capi_sync_jobs_queue_idx
  ON public.capi_sync_jobs (requested_at, created_at)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS capi_sync_jobs_user_recent_idx
  ON public.capi_sync_jobs (user_id, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS capi_sync_jobs_one_active_per_user_idx
  ON public.capi_sync_jobs (user_id)
  WHERE status IN ('queued', 'running');

ALTER TABLE public.capi_sync_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.capi_sync_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.capi_sync_jobs TO service_role;

-- Atomic cross-process claim. SKIP LOCKED prevents two web replicas from
-- running the same job. A crashed worker's lease is reclaimed after 15 min;
-- after three abandoned attempts it is surfaced as a terminal failure.
CREATE OR REPLACE FUNCTION public.claim_next_capi_sync_job()
RETURNS SETOF public.capi_sync_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.capi_sync_jobs
     SET status = 'failed',
         stage = 'worker_lost',
         error = 'Worker heartbeat expired after maximum attempts',
         finished_at = now(),
         updated_at = now()
   WHERE status = 'running'
     AND heartbeat_at < now() - interval '15 minutes'
     AND attempts >= 3;

  RETURN QUERY
  WITH candidate AS (
    SELECT id
      FROM public.capi_sync_jobs
     WHERE status = 'queued'
        OR (status = 'running'
            AND heartbeat_at < now() - interval '15 minutes'
            AND attempts < 3)
     ORDER BY requested_at, created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  UPDATE public.capi_sync_jobs AS job
     SET status = 'running',
         stage = 'starting',
         started_at = COALESCE(job.started_at, now()),
         heartbeat_at = now(),
         attempts = job.attempts + 1,
         error = NULL,
         updated_at = now()
    FROM candidate
   WHERE job.id = candidate.id
  RETURNING job.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_capi_sync_job() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_capi_sync_job() TO service_role;
