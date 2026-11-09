import { NextResponse } from 'next/server';
import { ravenBase } from '@/lib/ravenColonial';
import { apiTranslate } from '@/lib/i18n/apiT';
import { createServiceClient } from '@/lib/supabaseServer';
import {
  buildSystemCards,
  type JournalSiteRow,
  type StoredProjectRow,
} from '@/lib/siteProjects';

export const dynamic = 'force-dynamic';

/**
 * Реально существующая застройка системы для архитектора.
 *
 * `GET /api/architect/existing?system=<имя>` собирает два независимых
 * источника и отдаёт их сырыми — разбор и сопоставление с каталогом делает
 * клиентский модуль `src/lib/architect/existing.ts`:
 *
 *   * **Raven Colonial** (`/api/v2/system/<имя>`) — список `sites` системы,
 *     включая давно достроенные. Именно его не хватало: `/api/systems/progress`
 *     отдаёт только активные стройплощадки, поэтому готовая система выглядела
 *     пустой.
 *   * **EDSM** (`api-system-v1/stations`) — станции систем, застроенных до
 *     Trailblazers, которых в Raven нет вовсе.
 *   * **Сайт проекта** (`construction_projects`, кэш `system_progress` и
 *     снимки `colonisation_sites`) — собственный учёт строек. Именно он
 *     остаётся, когда Raven Colonial отвечает 503: Helper регистрирует
 *     проекты здесь, а депоты из журналов дают точные Required/Provided.
 *
 * Все источники необязательны: если один недоступен, ответ приходит с
 * остальными и списком ошибок в `warnings`. Пустой ответ честнее выдуманного.
 *
 * Поле `projects` — карточки строек для автоматического переноса в план
 * (`adoptExisting`): они уже слиты по площадке в `src/lib/siteProjects.ts`,
 * поэтому клиенту не нужно разбирать три источника самостоятельно.
 */

const TIMEOUT_MS = 9000;

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function GET(req: Request) {
  const t = await apiTranslate();
  const system = new URL(req.url).searchParams.get('system')?.trim() ?? '';
  if (!system) return NextResponse.json({ error: t('api.systemNotSpecified') }, { status: 400 });

  const warnings: string[] = [];

  const ravenPromise = getJson(`${ravenBase()}/api/v2/system/${encodeURIComponent(system)}`)
    .then((data) => asRecord(data))
    .catch((error: unknown) => {
      warnings.push(`Raven Colonial: ${error instanceof Error ? error.message : t('api.edsmNoAnswer')}`);
      return null;
    });

  const edsmPromise = getJson(
    `https://www.edsm.net/api-system-v1/stations?systemName=${encodeURIComponent(system)}`,
  )
    .then((data) => asRecord(data))
    .catch((error: unknown) => {
      warnings.push(`EDSM: ${error instanceof Error ? error.message : t('api.edsmNoAnswer')}`);
      return null;
    });

  const [raven, edsm] = await Promise.all([ravenPromise, edsmPromise]);

  // ── Собственный учёт строек: работает без Raven ────────────────────────
  let storedProjects: StoredProjectRow[] = [];
  let journalSites: JournalSiteRow[] = [];
  let ravenCache: { system_name: string | null; data: unknown; updated_at: string | null }[] = [];
  const svc = (() => {
    try {
      return createServiceClient();
    } catch {
      // Нет ключа service_role (локальный запуск без базы) — источник просто
      // отсутствует, Raven и EDSM продолжают работать.
      return null;
    }
  })();
  if (!svc) {
    warnings.push('Сайт: нет доступа к базе проекта');
  }
  try {
    if (!svc) throw new Error(t('api.edsmNoAnswer'));
    const { data, error } = await svc
      .from('construction_projects')
      .select('*')
      .ilike('system_name', system)
      .order('updated_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    storedProjects = (data ?? []) as StoredProjectRow[];
  } catch (projectError: unknown) {
    warnings.push(`Сайт: ${projectError instanceof Error ? projectError.message : t('api.edsmNoAnswer')}`);
  }

  try {
    if (!svc) throw new Error('no client');
    const { data } = await svc
      .from('colonisation_sites')
      .select('market_id, system_name, construction_name, construction_progress, resources_total, event_timestamp')
      .ilike('system_name', system)
      .limit(200);
    journalSites = (data ?? []) as JournalSiteRow[];
  } catch {
    // Снимков нет — не ошибка: проект мог быть создан без единого депота.
  }

  // Живой ответ Raven уже есть; кэш нужен, когда он недоступен (503).
  if (!raven) {
    try {
      if (!svc) throw new Error('no client');
      const { data } = await svc
        .from('system_progress')
        .select('system_name, data, updated_at')
        .ilike('system_name', system)
        .limit(5);
      ravenCache = (data ?? []) as typeof ravenCache;
      if (ravenCache.length > 0) {
        warnings.push('Raven Colonial недоступен — данные взяты из кэша сайта');
      }
    } catch {
      // Таблицы кэша может не быть в старой базе — просто нет запасного пути.
    }
  }

  const projects = buildSystemCards({
    stored: storedProjects,
    journalSites,
    ravenCache: raven && typeof raven === 'object'
      ? [{ system_name: system, data: raven, updated_at: null }]
      : ravenCache,
    system,
  });

  const sites = Array.isArray(raven?.sites) ? (raven!.sites as unknown[]) : [];
  const rawStations = Array.isArray(edsm?.stations) ? (edsm!.stations as unknown[]) : [];
  // Флотоносцы игроков — не застройка системы, они кочуют между системами.
  const stations = rawStations.filter((entry) => {
    const station = asRecord(entry);
    const type = String(station?.type ?? '').toLowerCase();
    return !type.includes('carrier') && type !== 'mega ship';
  }).map((entry) => {
    const station = asRecord(entry) ?? {};
    const body = asRecord(station.body);
    return {
      id: station.id ?? station.marketId ?? null,
      marketId: station.marketId ?? null,
      name: station.name ?? null,
      type: station.type ?? null,
      bodyName: typeof body?.name === 'string' ? body.name : null,
      economy: station.economy ?? null,
    };
  });

  return NextResponse.json({
    system: typeof raven?.name === 'string' ? raven.name : system,
    architect: typeof raven?.architect === 'string' ? raven.architect : null,
    sites,
    stations,
    // Готовые карточки строек: клиент переносит их в план одним вызовом
    // `parseExistingStructures` -> `adoptExisting`.
    projects,
    sources: {
      raven: raven ? 'ok' : 'unavailable',
      edsm: edsm ? 'ok' : 'unavailable',
      site: storedProjects.length > 0 || journalSites.length > 0 ? 'ok' : 'unavailable',
    },
    warnings,
  });
}
