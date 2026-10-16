import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { canonicalReport, saveStationReport } from '@/lib/stationCommerce';
import { resolveRequestUser } from '@/lib/helperAuth';
import { carrierOpsFromStationReport, type CarrierOp } from '@/lib/fleetCarriers';
import { applyCarrierOps } from '@/lib/fleetCarrierStore';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const MAX_BYTES = 4 * 1024 * 1024;

/** Authenticated Colonial Helper uploads only; source cannot be forged by the caller. */
export async function POST(request: Request) {
  try {
    if (Number(request.headers.get('content-length')) > MAX_BYTES)
      return NextResponse.json({ error: 'Report too large' }, { status: 413 });
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_BYTES)
      return NextResponse.json({ error: 'Report too large' }, { status: 413 });
    let body;
    try { body = JSON.parse(text); } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return NextResponse.json({ error: 'Invalid report' }, { status: 400 });
    const svc = createServiceClient();
    // Слишком длинный «токен» не проверяем по базе, но сессию сайта — как и раньше.
    const user = await resolveRequestUser(request,
      typeof body.token === 'string' && body.token.length <= 1000 ? body.token : undefined);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!Array.isArray(body.reports) || !body.reports.length || body.reports.length > 20)
      return NextResponse.json({ error: 'Expected 1–20 station reports' }, { status: 400 });
    // Validate the entire batch before writing anything. Retries after a database
    // failure are safe: the RPC compares observation times atomically.
    let reports;
    try { reports = body.reports.map((report: unknown) => canonicalReport(report, 'colonial-helper')); }
    catch { return NextResponse.json({ error: 'Invalid station report or inventory' }, { status: 400 }); }
    for (const report of reports) await saveStationReport(svc, report, 'colonial-helper');

    // Рынок авианосца обновляет и учёт самого носителя: его систему, службы и
    // груз (товары на продажу = что лежит на борту). Берём исходные имена
    // товаров ($steel_name;), а не локализованные: ключи должны совпасть с
    // MarketSell/CargoTransfer. Сбой учёта носителей не отменяет отчёт о станции.
    const carrierOps: CarrierOp[] = body.reports.flatMap((raw: any) => {
      try { return carrierOpsFromStationReport(raw); } catch { return []; }
    });
    if (carrierOps.length) {
      try {
        await applyCarrierOps(svc, user.userId, 'helper', carrierOps);
      } catch (error) {
        console.warn('[Station Report] carrier accounting skipped:', error instanceof Error ? error.message : error);
      }
    }
    return NextResponse.json({ ok: true, accepted: reports.length, carriers: carrierOps.length ? 'updated' : undefined });
  } catch (error) {
    console.error('[Station Report]', error);
    return NextResponse.json({ error: 'Station database unavailable; retry the report' }, { status: 503 });
  }
}
