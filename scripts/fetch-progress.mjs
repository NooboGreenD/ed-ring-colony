#!/usr/bin/env node
// Optional manual CLI. Scheduled execution uses /api/cron/update-progress.
import { createClient } from '@supabase/supabase-js';
import { syncProgress } from './lib/progress-sync.mjs';

try {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const result = await syncProgress({ supabase });
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  console.error('[progress]', error.message);
  process.exitCode = 1;
}
