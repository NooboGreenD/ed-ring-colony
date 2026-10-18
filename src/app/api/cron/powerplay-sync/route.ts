import { NextResponse } from 'next/server';

import { runCronTask } from '@/lib/cronAuth';
import { createServiceClient } from '@/lib/supabaseServer';
import { runPowerplaySync } from '@/lib/powerplaySync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Обновление систем PowerPlay из ночного дампа EDSM (`powerPlay.json.gz`).
 *
 * Планировщик зовёт задачу раз в 12 часов (`powerplay-sync` в
 * scripts/job-schedule.mjs): дамп выходит раз в сутки, а условный запрос
 * (ETag / If-Modified-Since) возвращает 304, если он не менялся. `?force=1`
 * качает дамп заново и принимает его, даже если он заметно меньше прошлого.
 *
 * Вручную: `node scripts/server-jobs.mjs --once powerplay-sync`.
 */
async function handle(request: Request) {
  const force = new URL(request.url).searchParams.get('force') === '1';
  const result = await runPowerplaySync(createServiceClient(), { force, trigger: 'cron' });
  if (result.status === 'error' || result.status === 'cancelled') {
    return NextResponse.json({ ok: false, ...result }, { status: 502 });
  }
  return NextResponse.json({ ok: true, ...result });
}

export async function GET(request: Request) {
  return runCronTask(request, 'powerplay-sync', () => handle(request));
}

export const POST = GET;
