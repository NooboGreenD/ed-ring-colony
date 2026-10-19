import { NextResponse } from 'next/server';

import { runCronTask } from '@/lib/cronAuth';
import { ensureEddnListener } from '@/lib/eddn/listener';
import { createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Живые данные EDDN: привести веб-процесс к флагу из базы.
 *
 * Планировщик зовёт задачу раз в 5 минут (`eddn-listener` в
 * scripts/job-schedule.mjs). Включено администратором — слушатель запускается,
 * если его нет (например, сайт перезапустили); выключено — останавливается.
 * Ответ сразу: сам слушатель живёт в веб-процессе.
 *
 * Вручную: `node scripts/server-jobs.mjs --once eddn-listener`.
 */
async function handle() {
  const result = await ensureEddnListener(createServiceClient());
  const { snapshot } = result;
  return NextResponse.json({
    ok: true,
    enabled: result.enabled,
    forbidden: result.forbidden,
    supported: result.supported,
    running: snapshot.running,
    status: snapshot.status,
    messages: snapshot.stats.messages,
    observations: snapshot.stats.observations,
    lastMessageAt: snapshot.stats.lastMessageAt,
    error: snapshot.error,
  });
}

export async function GET(request: Request) {
  return runCronTask(request, 'eddn-listener', () => handle());
}

export const POST = GET;
