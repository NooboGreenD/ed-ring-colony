import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
// Liveness, not a claim that external services/SMTP are healthy. No keys or PII.
export function GET() { return NextResponse.json({ ok: true, service: 'ed-ring-colony' }, { headers: { 'Cache-Control': 'no-store' } }); }
