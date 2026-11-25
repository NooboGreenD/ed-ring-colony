export const DM_MAX_TEXT = 10000;
export const DM_MAX_FILES = 5;
export const DM_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DM_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const DM_BUCKET = 'direct-message-files';
export const DM_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'csv', 'log', 'json', 'zip', '7z', 'rar', 'docx', 'xlsx', 'pptx'];
export const DM_ACCEPT = DM_EXTENSIONS.map(ext => '.' + ext).join(',');
export const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export type DirectAttachment = { id: string; name: string; path: string; size: number; mime: string };
export type DirectMessage = { id: string | number; sender_id: string; recipient_id: string; content: string; author_name?: string; avatar_url?: string | null; created_at: string; attachments?: DirectAttachment[] };

export function mergeDirectMessages(previous: DirectMessage[], incoming: DirectMessage[]): DirectMessage[] {
  const rows = new Map(previous.map(message => [String(message.id), message]));
  for (const message of incoming) rows.set(String(message.id), message);
  return [...rows.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)
    || String(a.id).localeCompare(String(b.id), 'en', { numeric: true })).slice(-300);
}
export function fileExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}
export function attachmentValidForMessage(file: DirectAttachment, message: Pick<DirectMessage, 'sender_id' | 'recipient_id'>): boolean {
  return !!file && typeof file.id === 'string' && isUuid(file.id) && typeof file.mime === 'string'
    && Number.isInteger(file.size) && file.size > 0 && file.size <= DM_MAX_FILE_BYTES && typeof file.name === 'string' && file.name.length <= 180
    && typeof file.path === 'string' && DM_EXTENSIONS.some(ext => file.path === `${message.sender_id}/${message.recipient_id}/${file.id}.${ext}`);
}
export function imageMime(bytes: Uint8Array): string | null {
  const head = Array.from(bytes.slice(0, 12));
  if ([137,80,78,71,13,10,26,10].every((n,i) => head[i] === n)) return 'image/png';
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) return 'image/jpeg';
  const text = String.fromCharCode(...head);
  if (text.startsWith('GIF87a') || text.startsWith('GIF89a')) return 'image/gif';
  if (text.startsWith('RIFF') && text.slice(8,12) === 'WEBP') return 'image/webp';
  return null;
}
