import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { signalsFromRecord, signalsToColumns } from '@/lib/bodySignals';
import { compareBodySources, normalizeEdsmBody, normalizeSpanshBody } from '@/lib/architect/bodySync';
import { findSystemByName } from '@/lib/galaxySystemsDb';
import { spanshSystemDump } from '@/lib/spanshClient';

export const dynamic = 'force-dynamic';

const EDSM_FETCH_TIMEOUT = 8000;

/** Что вернул источник — нужно «Архитектору», чтобы честно показать статус синхронизации. */
type SourceStatus = 'ok' | 'empty' | 'unavailable' | 'skipped';

interface EdsmBodiesResult {
  bodies: any[] | null;
  /** id64 системы: EDSM отдаёт его вместе с телами, и он нужен для дампа Spansh. */
  id64: number | null;
  status: SourceStatus;
  error?: string;
}

async function fetchEdsmBodies(systemName: string): Promise<EdsmBodiesResult> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), EDSM_FETCH_TIMEOUT);
  try {
    const url = `https://www.edsm.net/api-system-v1/bodies?systemName=${encodeURIComponent(systemName)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) return { bodies: null, id64: null, status: 'unavailable', error: `HTTP ${res.status}` };
    const data = await res.json();
    const bodies = Array.isArray(data?.bodies) ? data.bodies : null;
    return {
      bodies,
      id64: typeof data?.id64 === 'number' ? data.id64 : null,
      status: bodies && bodies.length > 0 ? 'ok' : 'empty',
    };
  } catch (err: any) {
    console.error(`[system-bodies] EDSM fetch error for ${systemName}:`, err.message);
    return { bodies: null, id64: null, status: 'unavailable', error: err.message };
  } finally {
    clearTimeout(id);
  }
}

/**
 * id64 системы для дампа Spansh: сначала то, что вернул EDSM, иначе локальный
 * каталог галактики. Без сети и без обращения к Spansh по имени.
 */
async function resolveId64(systemName: string, fromEdsm: number | null): Promise<string | null> {
  if (fromEdsm) return String(fromEdsm);
  try {
    const row = await findSystemByName(systemName);
    return row?.id64 ? String(row.id64) : null;
  } catch {
    return null;
  }
}

/** Самая свежая отметка времени среди строк — для подписи «данные от …». */
function latestUpdate(rows: any[]): string | null {
  let best: number | null = null;
  for (const row of rows) {
    const value = Date.parse(String(row?.updated_at ?? ''));
    if (Number.isFinite(value) && (best === null || value > best)) best = value;
  }
  return best === null ? null : new Date(best).toISOString();
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const system = (searchParams.get('system') || searchParams.get('name') || '').trim();
    const forceRefresh = searchParams.get('refresh') === '1';
    // Режим сверки: используется «Архитектором» — оба источника запрашиваются
    // всегда, а не только когда база пустая, и для каждого тела побеждает
    // более точный/свежий источник (см. src/lib/architect/bodySync.ts).
    const compareMode = searchParams.get('compare') === '1';

    if (!system) {
      return NextResponse.json({ error: 'system parameter is required' }, { status: 400 });
    }

    if (compareMode) {
      // Spansh опрашивается только по явному запросу «Архитектора»
      // (`?spansh=1`, по умолчанию включён): дампы больших систем тяжёлые.
      const useSpansh = searchParams.get('spansh') !== '0';

      const [dbResult, edsm] = await Promise.all([
        supabaseAdmin
          .from('system_scans')
          .select('*')
          .ilike('system_name', system)
          .order('distance_ls', { ascending: true }),
        fetchEdsmBodies(system),
      ]);

      const dbRows = (!dbResult.error && Array.isArray(dbResult.data)) ? dbResult.data : [];
      const edsmRows = (edsm.bodies ?? []).map((b: any) => normalizeEdsmBody(system, b));

      let spanshRows: any[] = [];
      let spanshStatus: SourceStatus = useSpansh ? 'empty' : 'skipped';
      let spanshNote: string | undefined;
      let spanshUpdated: string | null = null;
      if (useSpansh) {
        const id64 = await resolveId64(system, edsm.id64);
        if (!id64) {
          spanshStatus = 'skipped';
          spanshNote = 'id64 системы неизвестен';
        } else {
          const dump = await spanshSystemDump(id64);
          if (dump.ok) {
            spanshRows = dump.bodies.map((b) => normalizeSpanshBody(system, b as Record<string, unknown>));
            spanshStatus = spanshRows.length > 0 ? 'ok' : 'empty';
            spanshUpdated = dump.updatedAt;
          } else {
            spanshStatus = dump.reason === 'not-found' ? 'empty' : 'unavailable';
            spanshNote = dump.reason;
          }
        }
      }

      const sync = {
        database: {
          status: (dbResult.error ? 'unavailable' : dbRows.length > 0 ? 'ok' : 'empty') as SourceStatus,
          count: dbRows.length,
          updatedAt: latestUpdate(dbRows),
          note: dbResult.error?.message,
        },
        edsm: {
          status: edsm.status,
          count: edsmRows.length,
          updatedAt: null as string | null,
          note: edsm.error,
        },
        spansh: {
          status: spanshStatus,
          count: spanshRows.length,
          updatedAt: spanshUpdated,
          note: spanshNote,
        },
      };

      if (dbRows.length === 0 && edsmRows.length === 0 && spanshRows.length === 0) {
        return NextResponse.json({
          ok: true,
          system,
          count: 0,
          source: 'none',
          sources: { database: 0, edsm: 0, spansh: 0, merged: 0, total: 0 },
          sync,
          bodies: [],
        });
      }

      const { bodies, stats, toUpsert, duplicates } = compareBodySources({
        database: dbRows,
        edsm: edsmRows,
        spansh: spanshRows,
      });

      // Дозаписываем в базу проекта только то, что сверка реально уточнила —
      // не блокируя ответ при сбое записи.
      let cached = 0;
      if (toUpsert.length > 0) {
        try {
          await supabaseAdmin.from('system_scans').upsert(toUpsert, {
            onConflict: 'system_name,body_name',
          });
          cached = toUpsert.length;
        } catch (saveErr: any) {
          console.warn('[system-bodies] Failed caching compared bodies into DB:', saveErr.message);
        }
      }

      return NextResponse.json({
        ok: true,
        system,
        count: bodies.length,
        source: 'compare',
        sources: stats,
        sync: { ...sync, cached, duplicates },
        bodies,
      });
    }

    // 1. Поиск в БД проекта
    if (!forceRefresh) {
      const { data: dbBodies, error: dbError } = await supabaseAdmin
        .from('system_scans')
        .select('*')
        .ilike('system_name', system)
        .order('distance_ls', { ascending: true });

      if (!dbError && dbBodies && dbBodies.length > 0) {
        return NextResponse.json({
          ok: true,
          system,
          count: dbBodies.length,
          source: 'database',
          bodies: dbBodies,
        });
      }
    }

    // 2. Если в БД нет данных, запрашиваем EDSM
    const { bodies: edsmBodies } = await fetchEdsmBodies(system);
    if (!edsmBodies || edsmBodies.length === 0) {
      return NextResponse.json({
        ok: true,
        system,
        count: 0,
        source: 'none',
        bodies: [],
      });
    }

    // 3. Форматируем и сохраняем тела из EDSM в базу данных проекта
    const rowsToInsert = edsmBodies.map((b: any) => normalizeEdsmBody(system, b));

    // Фоновая запись в базу данных (не блокируя ответ при сбоях)
    try {
      await supabaseAdmin.from('system_scans').upsert(rowsToInsert, {
        onConflict: 'system_name,body_name',
      });
    } catch (saveErr: any) {
      console.warn('[system-bodies] Failed caching EDSM bodies into DB:', saveErr.message);
    }

    return NextResponse.json({
      ok: true,
      system,
      count: rowsToInsert.length,
      source: 'edsm',
      bodies: rowsToInsert,
    });
  } catch (err: any) {
    console.error('[system-bodies] GET error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    // Сканы отправляет Colonial Helper по API-токену. Раньше этот POST был
    // открыт через service-role клиент, поэтому любой мог перезаписывать
    // каталог тел чужим именем командира.
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) return NextResponse.json({ error: 'API token required' }, { status: 401 });
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const { data: apiToken, error: tokenError } = await supabaseAdmin
      .from('api_tokens')
      .select('user_id,is_revoked')
      .eq('token_hash', tokenHash)
      .maybeSingle();
    if (tokenError || !apiToken || apiToken.is_revoked) {
      return NextResponse.json({ error: 'Invalid or revoked token' }, { status: 401 });
    }

    const systemName = (body.system || body.system_name || '').trim();
    const bodies = Array.isArray(body.bodies) ? body.bodies : [];
    const cmdr = (body.cmdr || body.commander || '').trim() || null;

    if (!systemName) {
      return NextResponse.json({ error: 'system parameter is required' }, { status: 400 });
    }
    if (bodies.length === 0) {
      return NextResponse.json({ ok: true, saved: 0, system: systemName });
    }
    if (bodies.length > 500) {
      return NextResponse.json({ error: 'Too many bodies in one request (max 500)' }, { status: 413 });
    }

    const rows = bodies.map((b: any) => ({
      system_name: systemName,
      body_name: (b.body_name || b.name || `${systemName} Body`).trim(),
      body_id: typeof b.body_id === 'number' ? b.body_id : (typeof b.bodyId === 'number' ? b.bodyId : null),
      body_type: b.body_type || b.type || null,
      sub_type: b.sub_type || b.subType || b.planet_class || b.star_type || null,
      distance_ls: typeof b.distance_ls === 'number' ? b.distance_ls : (typeof b.distanceToArrival === 'number' ? b.distanceToArrival : 0),
      semi_major_axis_ls: typeof b.semi_major_axis_ls === 'number' ? b.semi_major_axis_ls : (typeof b.semiMajorAxis === 'number' ? b.semiMajorAxis : null),
      parents: Array.isArray(b.parents) ? b.parents : [],
      radius_m: typeof b.radius_m === 'number' ? b.radius_m : (typeof b.radius === 'number' ? b.radius : 0),
      gravity: typeof b.gravity === 'number' ? b.gravity : 0,
      earth_masses: typeof b.earth_masses === 'number' ? b.earth_masses : 0,
      surface_temp_k: typeof b.surface_temp_k === 'number' ? b.surface_temp_k : (typeof b.surfaceTemperature === 'number' ? b.surfaceTemperature : 0),
      surface_pressure: typeof b.surface_pressure === 'number' ? b.surface_pressure : (typeof b.surfacePressure === 'number' ? b.surfacePressure : 0),
      volcanism: b.volcanism || null,
      atmosphere: b.atmosphere || null,
      atmosphere_type: b.atmosphere_type || b.atmosphereType || null,
      atmosphere_composition: Array.isArray(b.atmosphere_composition) ? b.atmosphere_composition : [],
      solid_composition: b.solid_composition || {},
      materials: b.materials || {},
      rings: Array.isArray(b.rings) ? b.rings : [],
      is_landable: !!(b.is_landable || b.landable || b.isLandable),
      // Сигналы тела: биология, геология, следы людей, стражи и таргоиды.
      // Помощник присылает либо готовые счётчики, либо сырой список
      // `signals` из события журнала — разбираем оба вида.
      ...signalsToColumns(signalsFromRecord(b)),
      signals: Array.isArray(b.signals) ? b.signals.slice(0, 32) : [],
      first_discovered_by: b.first_discovered_by || null,
      first_mapped_by: b.first_mapped_by || null,
      first_footfall_by: b.first_footfall_by || null,
      scanned_by_cmdr: cmdr,
      source: b.source || 'helper',
      raw_data: b.raw_data || b,
      updated_at: new Date().toISOString(),
    }));

    const { error: upsertError } = await supabaseAdmin
      .from('system_scans')
      .upsert(rows, { onConflict: 'system_name,body_name' });

    if (upsertError) {
      console.error('[system-bodies] POST upsert error:', upsertError.message);
      return NextResponse.json({ error: upsertError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, saved: rows.length, system: systemName });
  } catch (err: any) {
    console.error('[system-bodies] POST error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
