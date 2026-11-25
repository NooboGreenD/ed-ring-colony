import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { apiTranslate } from '@/lib/i18n/apiT';
import { checkRateLimit } from '@/lib/rateLimit';
import { DM_BUCKET, DM_MAX_TEXT, DM_MAX_FILES, DM_MAX_FILE_BYTES, DM_MAX_TOTAL_BYTES, DM_EXTENSIONS, fileExtension, imageMime, isUuid, type DirectAttachment } from '@/lib/directMessages';
import { messageFriends, messageForm, MessageRequestError } from '@/lib/directMessageServer';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

/** Upload all files first, then atomically publish one complete message row. */
export async function POST(request: Request) {
  const t = await apiTranslate();
  const uploaded: string[] = [];
  let svc: ReturnType<typeof createServiceClient> | undefined;
  try {
    const { user } = await authFromRequest(request);
    if (!user) return NextResponse.json({ error: t('dm.login') }, { status: 401, headers });
    if (!checkRateLimit(`dm:${user.id}`, 30)) return NextResponse.json({ error: t('dm.rate') }, { status: 429, headers });
    const form = await messageForm(request);
    const peer = String(form.get('peerId') ?? '');
    const content = String(form.get('content') ?? '').trim();
    const files = form.getAll('files').filter((entry): entry is File => typeof entry !== 'string');
    if (!isUuid(peer) || peer === user.id || content.length > DM_MAX_TEXT || (!content && !files.length)) {
      throw new MessageRequestError(400, 'dm.sendError');
    }
    if (files.length > DM_MAX_FILES || files.some(file => !file.size || file.size > DM_MAX_FILE_BYTES)
      || files.reduce((n, file) => n + file.size, 0) > DM_MAX_TOTAL_BYTES) throw new MessageRequestError(413, 'dm.limit');
    if (files.some(file => !DM_EXTENSIONS.includes(fileExtension(file.name)))) throw new MessageRequestError(415, 'dm.fileType');
    svc = createServiceClient();
    if (!await messageFriends(svc, user.id, peer)) return NextResponse.json({ error: t('dm.friendsOnly') }, { status: 403, headers });
    const attachments: DirectAttachment[] = [];
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ext = fileExtension(file.name);
      const image = imageMime(bytes);
      if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext) && !image) throw new MessageRequestError(415, 'dm.fileType');
      const id = randomUUID();
      const path = `${user.id}/${peer}/${id}.${ext}`;
      const mime = image ?? 'application/octet-stream';
      const { error } = await svc.storage.from(DM_BUCKET).upload(path, bytes, { contentType: mime, upsert: false });
      if (error) throw new Error('Private attachment storage unavailable');
      uploaded.push(path);
      attachments.push({ id, path, mime, size: file.size, name: file.name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0,180) });
    }
    const { data: profile, error: profileError } = await svc.from('profiles').select('cmdr_name, avatar_url').eq('id', user.id).maybeSingle();
    if (profileError) throw new Error('Could not load sender');
    const { data, error } = await svc.from('messages').insert({ sender_id: user.id, recipient_id: peer,
      content, author_name: profile?.cmdr_name ?? 'Pilot', avatar_url: profile?.avatar_url ?? null,
      ...(attachments.length ? { attachments } : {}),
    }).select('*').single();
    if (error || !data) throw new Error('Could not save message');
    return NextResponse.json({ ok: true, message: data }, { headers });
  } catch (error) {
    if (svc && uploaded.length) {
      try { await svc.storage.from(DM_BUCKET).remove(uploaded); } catch { /* Not exposed: no message references these objects. */ }
    }
    if (!(error instanceof MessageRequestError)) console.error('[messages POST]', error instanceof Error ? error.message : 'send failed');
    return NextResponse.json({ error: t(error instanceof MessageRequestError ? error.message : 'dm.sendError') }, { status: error instanceof MessageRequestError ? error.status : 503, headers });
  }
}
