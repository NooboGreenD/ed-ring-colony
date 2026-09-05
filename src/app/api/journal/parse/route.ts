import { NextResponse } from 'next/server';
import { parseColonisationEvents } from '@/lib/journalParser';
import { authFromRequest } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { user } = await authFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (!file.name.endsWith('.log')) {
      return NextResponse.json({ error: 'Only .log files are accepted' }, { status: 400 });
    }

    const text = await file.text();
    const result = parseColonisationEvents(text);

    return NextResponse.json({
      filename: file.name,
      cmdrName: result.cmdrName,
      depotEvents: result.depotEvents,
      contributionEvents: result.contributionEvents,
      stats: result.stats,
    });
  } catch (err: any) {
    console.error('[Journal Parse] Error:', err);
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
