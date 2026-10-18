import { NextResponse } from 'next/server';

import { runCronTask } from '@/lib/cronAuth';
import { createServiceClient } from '@/lib/supabaseServer';
import { decideBgsScheduledSync, readBgsSyncState, startBgsSync } from '@/lib/bgsSync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Обновление минорных фракций из дампа EDSM `systemsPopulated.json.gz`.
 *
 * Планировщик зовёт задачу раз в сутки (`factions-sync` в
 * scripts/job-schedule.mjs). Дамп весит ≈0,5 ГБ, поэтому задача:
 *   * не делает ПЕРВЫЙ импорт — его запускает администратор (Админка →
 *     Игровые данные → Фракции), чтобы большая загрузка не началась сама;
 *   * после него обновляет данные, когда прошлый импорт старше
 *     FACTIONS_REFRESH_DAYS (7 дней по умолчанию), — между импортами базу
 *     держат свежей Colonial Helper и загрузчик журналов на сайте;
 *   * продолжает импорт, оборванный перезапуском сайта (докачка с диска).
 *
 * Запрос не ждёт импорта: он идёт фоном, ход — в админке. `?force=1` —
 * запустить сейчас в любом случае. Вручную:
 * `node scripts/server-jobs.mjs --once factions-sync`.
 */
async function handle(request: Request) {
  const force = new URL(request.url).searchParams.get('force') === '1';
  const svc = createServiceClient();
  const state = await readBgsSyncState(svc);
  const decision = decideBgsScheduledSync(state, { force });
  if (decision.action === 'skip') {
    return NextResponse.json({ ok: true, skipped: true, reason: decision.reason, synced_at: state.synced_at, systems: state.systems_total });
  }
  const started = startBgsSync(svc, { trigger: 'cron', force });
  return NextResponse.json({ ok: true, started: started.started, reason: decision.reason, ...(started.reason ? { note: started.reason } : {}) });
}

export async function GET(request: Request) {
  return runCronTask(request, 'factions-sync', () => handle(request));
}

export const POST = GET;
