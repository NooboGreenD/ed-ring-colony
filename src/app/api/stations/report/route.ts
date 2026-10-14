import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { canonicalReport, saveStationReport } from '@/lib/stationCommerce';

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
    let authorized = false;
    if (typeof body.token === 'string' && body.token.length <= 1000) {
      const { data, error } = await svc.from('api_tokens').select('user_id,is_revoked')
        .eq('token_hash', createHash('sha256').update(body.token.trim()).digest('hex')).maybeSingle();
      if (error) throw new Error(error.message);
      authorized = !!data?.user_id && !data.is_revoked;
    }
    if (!authorized) authorized = !!(await authFromRequest(request)).user;
    if (!authorized) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!Array.isArray(body.reports) || !body.reports.length || body.reports.length > 20)
      return NextResponse.json({ error: 'Expected 1–20 station reports' }, { status: 400 });
    // Validate the entire batch before writing anything. Retries after a database
    // failure are safe: the RPC compares observation times atomically.
    let reports;
    try { reports = body.reports.map((report: unknown) => canonicalReport(report, 'colonial-helper')); }
    catch { return NextResponse.json({ error: 'Invalid station report or inventory' }, { status: 400 }); }
    for (const report of reports) await saveStationReport(svc, report, 'colonial-helper');
    return NextResponse.json({ ok: true, accepted: reports.length });
  } catch (error) {
    console.error('[Station Report]', error);
    return NextResponse.json({ error: 'Station database unavailable; retry the report' }, { status: 503 });
  }
}
