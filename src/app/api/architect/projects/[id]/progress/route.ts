import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { fetchRavenSystemV2 } from '@/lib/ravenColonial';
import { enrichRavenSystemWithJournalSnapshots } from '@/lib/ravenDepotSnapshots';
import { persistRavenSystemProgress, readableProgress } from '@/lib/systemProgress';
import { staleSystems } from '@/lib/architect/projectProgress';
import { computeProjectProgress, loadSystemRows, storeProgressSummary } from '@/lib/architect/projectStore';
import { errorResponse, jsonError, openProject } from '@/lib/architect/projectRouteKit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Прогресс проекта систем.
 *
 *   GET  — прогресс каждой системы и проекта целиком из уже накопленных
 *          данных (кэш Raven, журнальные площадки, планы). Быстро и без
 *          внешних запросов; заодно обновляет сводку для списка проектов.
 *   POST — сначала перечитать из Raven Colonial системы, чей кэш старше
 *          5 минут (не больше REFRESH_BATCH за вызов), затем то же, что GET.
 *          Ответ говорит, сколько систем ещё ждут (`pending`): интерфейс
 *          повторяет запрос, пока очередь не опустеет.
 */

type Params = { params: Promise<{ id: string }> };

const STALE_MS = 5 * 60 * 1000;
const REFRESH_BATCH = 6;
const REFRESH_CONCURRENCY = 3;
const REFRESH_COOLDOWN_MS = 15 * 1000;
/** Система, которую Raven не отдал, не перезапрашивается полчаса. */
const FAILURE_BACKOFF_MS = 30 * 60 * 1000;
const lastRefresh = new Map<string, number>();
const recentFailures = new Map<string, number>();

function failureKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

async function respond(svc: unknown, projectId: string, extra: Record<string, unknown> = {}) {
  const systemRows = await loadSystemRows(svc, projectId);
  const progress = await computeProjectProgress(svc, projectId, systemRows);
  await storeProgressSummary(svc, projectId, progress.summary);
  return NextResponse.json({ ...progress, computedAt: new Date().toISOString(), ...extra });
}

export async function GET(req: Request, { params }: Params) {
  try {
    const opened = await openProject(req, (await params).id);
    if (!opened.ok) return opened.response;
    return await respond(opened.svc, opened.access.project.id);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const opened = await openProject(req, (await params).id);
    if (!opened.ok) return opened.response;
    const { svc, access } = opened;
    if (!access.permissions.refresh) return jsonError('Нет доступа', 403);
    const projectId = access.project.id;

    const now = Date.now();
    const previous = lastRefresh.get(projectId) ?? 0;
    if (now - previous < REFRESH_COOLDOWN_MS) {
      return await respond(svc, projectId, { refreshed: 0, failed: [], pending: null, throttled: true });
    }
    lastRefresh.set(projectId, now);

    const systemRows = await loadSystemRows(svc, projectId);
    const current = await computeProjectProgress(svc, projectId, systemRows, { includePlans: false });
    const queue = staleSystems(
      systemRows.map((row) => ({ id: String(row.id), name: String(row.system_name) })),
      current,
      now,
      STALE_MS,
    ).filter((system) => now - (recentFailures.get(failureKey(system.name)) ?? 0) > FAILURE_BACKOFF_MS);
    const batch = queue.slice(0, REFRESH_BATCH);
    const failed: string[] = [];
    let refreshed = 0;
    const writer = createServiceClient();
    let cursor = 0;
    const worker = async () => {
      while (cursor < batch.length) {
        const system = batch[cursor++];
        try {
          const live = await fetchRavenSystemV2(system.name);
          if (live.error || (readableProgress(live.progress) == null && live.projects.length === 0)) {
            failed.push(system.name);
            recentFailures.set(failureKey(system.name), Date.now());
            continue;
          }
          const enriched = await enrichRavenSystemWithJournalSnapshots(live);
          const result = await persistRavenSystemProgress(writer, system.name, enriched);
          if (result.cached) {
            refreshed += 1;
            recentFailures.delete(failureKey(system.name));
          } else {
            failed.push(system.name);
            recentFailures.set(failureKey(system.name), Date.now());
          }
        } catch {
          failed.push(system.name);
          recentFailures.set(failureKey(system.name), Date.now());
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, batch.length) }, worker));
    return await respond(svc, projectId, {
      refreshed,
      failed,
      pending: Math.max(0, queue.length - batch.length),
      throttled: false,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
