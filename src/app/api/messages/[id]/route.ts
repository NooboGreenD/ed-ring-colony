import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { attachmentValidForMessage, DM_BUCKET, type DirectAttachment } from '@/lib/directMessages';
export const dynamic = 'force-dynamic';
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    const { user } = await authFromRequest(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });
    const { id } = await params;
    if (!/^\d{1,20}$/.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404, headers });
    const svc = createServiceClient();
    const { data, error } = await svc.from('messages').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data || data.sender_id !== user.id) return NextResponse.json({ error: 'Not found' }, { status: 404, headers });
    const { error: deletionError } = await svc.from('messages').delete().eq('id', id).eq('sender_id', user.id);
    if (deletionError) throw deletionError;
    const paths = (Array.isArray(data.attachments) ? data.attachments : []).filter((file: DirectAttachment) => attachmentValidForMessage(file, data)).map((file: DirectAttachment) => file.path);
    if (paths.length) {
      try {
        const cleanup = await svc.storage.from(DM_BUCKET).remove(paths);
        if (cleanup.error) console.warn('[messages DELETE] Private object cleanup failed');
      } catch { console.warn('[messages DELETE] Private object cleanup failed'); }
    }
    return NextResponse.json({ ok: true }, { headers });
  } catch { return NextResponse.json({ error: 'Could not delete message' }, { status: 503, headers }); }
}
