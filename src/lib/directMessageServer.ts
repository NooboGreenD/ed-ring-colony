import { DM_MAX_TOTAL_BYTES } from './directMessages';

/** Support both deployed friendship schemas; a pending request is not friendship. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function messageFriends(svc: any, user: string, peer: string): Promise<boolean> {
  const matches = (rows: Record<string, unknown>[]) => rows.some(row => {
    const a = row.requester_id ?? row.user_id;
    const b = row.addressee_id ?? row.friend_id;
    return ((a === user && b === peer) || (a === peer && b === user))
      && (row.status === 'accepted' || !Object.hasOwn(row, 'status'));
  });
  const modern = await svc.from('friends').select('*').or(`requester_id.eq.${user},addressee_id.eq.${user}`);
  if (modern.error && !['42703', 'PGRST204'].includes(modern.error.code)) throw new Error('Could not verify friendship');
  if (!modern.error && matches(modern.data ?? [])) return true;
  const legacy = await svc.from('friends').select('*').or(`user_id.eq.${user},friend_id.eq.${user}`);
  if (legacy.error) {
    if (!modern.error && ['42703', 'PGRST204'].includes(legacy.error.code)) return false;
    throw new Error('Could not verify friendship');
  }
  return matches(legacy.data ?? []);
}

export class MessageRequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
/** Bound actual bytes too: Content-Length is untrusted and may be absent. */
export async function messageForm(request: Request): Promise<FormData> {
  const max = DM_MAX_TOTAL_BYTES + 1024 * 1024;
  if (Number(request.headers.get('content-length')) > max) throw new MessageRequestError(413, 'dm.limit');
  const reader = request.body?.getReader();
  if (!reader) throw new MessageRequestError(400, 'dm.sendError');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > max) { await reader.cancel(); throw new MessageRequestError(413, 'dm.limit'); }
    chunks.push(part.value);
  }
  try {
    return await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': request.headers.get('content-type') ?? '' } }).formData();
  } catch { throw new MessageRequestError(400, 'dm.sendError'); }
}
