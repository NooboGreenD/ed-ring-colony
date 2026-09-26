import { NextResponse } from 'next/server';
import { ravenBase } from '@/lib/ravenColonial';

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
 *
 * Оба источника необязательны: если один недоступен, ответ приходит со вторым
 * и списком ошибок в `warnings`. Пустой ответ честнее выдуманного.
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
  const system = new URL(req.url).searchParams.get('system')?.trim() ?? '';
  if (!system) return NextResponse.json({ error: 'Не указана система' }, { status: 400 });

  const warnings: string[] = [];

  const ravenPromise = getJson(`${ravenBase()}/api/v2/system/${encodeURIComponent(system)}`)
    .then((data) => asRecord(data))
    .catch((error: unknown) => {
      warnings.push(`Raven Colonial: ${error instanceof Error ? error.message : 'нет ответа'}`);
      return null;
    });

  const edsmPromise = getJson(
    `https://www.edsm.net/api-system-v1/stations?systemName=${encodeURIComponent(system)}`,
  )
    .then((data) => asRecord(data))
    .catch((error: unknown) => {
      warnings.push(`EDSM: ${error instanceof Error ? error.message : 'нет ответа'}`);
      return null;
    });

  const [raven, edsm] = await Promise.all([ravenPromise, edsmPromise]);

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
    sources: {
      raven: raven ? 'ok' : 'unavailable',
      edsm: edsm ? 'ok' : 'unavailable',
    },
    warnings,
  });
}
