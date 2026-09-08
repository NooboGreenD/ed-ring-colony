import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const systemName = url.searchParams.get('system');
  const eventType = url.searchParams.get('event');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);

  const supabase = await createClient();
  let query = supabase.from('eddn_messages').select('*').order('received_at', { ascending: false }).limit(limit);
  if (systemName) query = query.ilike('system_name', systemName);
  if (eventType) query = query.eq('event_type', eventType);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ messages: data || [], count: (data || []).length });
}

export async function POST(req: Request) {
  const body = await req.json();
  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: 'messages array required' }, { status: 400 });
  }
  const rows = messages.map((msg: any) => ({
    schema_ref: msg.$schemaRef || 'unknown',
    uploader_id: msg.header?.uploaderID || null,
    software_name: msg.header?.softwareName || null,
    system_name: msg.message?.StarSystem || msg.message?.systemName || null,
    system_address: msg.message?.SystemAddress || null,
    star_pos: msg.message?.StarPos ? JSON.stringify(msg.message.StarPos) : null,
    station_name: msg.message?.StationName || null,
    event_type: msg.message?.event || 'unknown',
    message: msg.message,
  }));
  const { supabaseAdmin } = await import('@/lib/supabaseAdmin');
  const { data, error } = await supabaseAdmin.from('eddn_messages').insert(rows).select();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ inserted: (data || []).length });
}
