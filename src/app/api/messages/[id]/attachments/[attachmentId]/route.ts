import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { attachmentValidForMessage, DM_BUCKET, DM_MAX_FILE_BYTES, imageMime, isUuid, type DirectAttachment } from '@/lib/directMessages';

export const dynamic = 'force-dynamic';
const PRIVATE = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Authorization, Cookie' };

export async function GET(request: Request, { params }: { params: Promise<{ id: string; attachmentId: string }> }) {
  try {
    const { user } = await authFromRequest(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: PRIVATE });
    const { id, attachmentId } = await params;
    if (!/^\d{1,20}$/.test(id) || !isUuid(attachmentId)) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: PRIVATE });
    const svc = createServiceClient();
    const { data: message, error } = await svc.from('messages').select('sender_id, recipient_id, attachments').eq('id', id).maybeSingle();
    if (error) throw new Error('Message lookup failed');
    if (!message || ![message.sender_id, message.recipient_id].includes(user.id)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: PRIVATE });
    }
    const file = (Array.isArray(message.attachments) ? message.attachments : []).find((item: DirectAttachment) => item && item.id === attachmentId) as DirectAttachment | undefined;
    if (!file || !attachmentValidForMessage(file, message)) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: PRIVATE });
    const { data, error: downloadError } = await svc.storage.from(DM_BUCKET).download(file.path);
    if (downloadError || !data) throw new Error('Attachment storage unavailable');
    if (data.size > DM_MAX_FILE_BYTES) throw new Error('Invalid attachment size');
    const bytes = new Uint8Array(await data.arrayBuffer());
    // Ignore client-editable JSON MIME values. Never render HTML/SVG as images.
    const mime = imageMime(bytes);
    const name = file.name.replace(/[\x00-\x1f\x7f]/g, '_');
    const encoded = encodeURIComponent(name).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16));
    return new Response(bytes, { headers: { ...PRIVATE,
      'Content-Type': mime ?? 'application/octet-stream',
      'Content-Disposition': `${mime ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encoded}`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
    } });
  } catch {
    return NextResponse.json({ error: 'Attachment unavailable' }, { status: 503, headers: PRIVATE });
  }
}
