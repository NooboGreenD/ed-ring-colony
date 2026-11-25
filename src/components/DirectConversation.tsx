'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { authFetch, supabase } from '@/lib/supabaseClient';
import { useI18n } from '@/lib/i18n/I18nContext';
import PilotIdentity from './Cosmetics/PilotIdentity';
import { DM_ACCEPT, DM_MAX_FILES, DM_MAX_TEXT, DM_MAX_FILE_BYTES, DM_MAX_TOTAL_BYTES, DM_EXTENSIONS, fileExtension, attachmentValidForMessage, mergeDirectMessages, type DirectMessage, type DirectAttachment } from '@/lib/directMessages';

function Attachment({ file, messageId }: { file: DirectAttachment; messageId: string | number }) {
  const { t } = useI18n();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const objectUrl = useRef('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);
  const open = async () => {
    if (busy) return;
    setBusy(true); setError(false);
    controller.current = new AbortController();
    try {
      const response = await authFetch(`/api/messages/${messageId}/attachments/${file.id}`, { cache: 'no-store', signal: controller.current.signal });
      if (!response.ok) throw new Error('download failed');
      const blob = await response.blob();
      if (controller.current.signal.aborted) return;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(blob);
      if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.type)) setUrl(objectUrl.current);
      else {
        const a = document.createElement('a'); a.href = objectUrl.current; a.download = file.name;
        document.body.appendChild(a); a.click(); a.remove();
      }
    } catch { if (!controller.current.signal.aborted) setError(true); }
    finally { if (!controller.current.signal.aborted) setBusy(false); }
  };
  return <div className="dm-attachment">
    <button type="button" disabled={busy} onClick={() => void open()}>{file.name} · {(file.size / 1024).toFixed(0)} KB — {t(file.mime?.startsWith('image/') ? 'dm.preview' : 'dm.download')}</button>
    {url && <a href={url} download={file.name}><img src={url} alt={file.name} loading="lazy" /></a>}
    {error && <span role="alert">{t('dm.downloadError')}</span>}
  </div>;
}

export default function DirectConversation({ userId, peerId, peerName, myName, myAvatar, onUnreadReset }: {
  userId: string; peerId: string; peerName: string; myName: string; myAvatar: string | null;
  onUnreadReset: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  const busy = useRef(false);
  const resetUnread = useRef(onUnreadReset);
  resetUnread.current = onUnreadReset;
  // A fetch started before an INSERT/DELETE must never undo the live update.
  const revision = useRef(0);
  const loadSequence = useRef(0);
  const loadingRef = useRef(false);
  const nearBottom = useRef(true);
  const forceBottom = useRef(false);
  const belongs = useCallback((m: DirectMessage) => (m.sender_id === userId && m.recipient_id === peerId)
    || (m.sender_id === peerId && m.recipient_id === userId), [userId, peerId]);
  const read = useCallback(async () => {
    const { error } = await supabase.from('messages').update({ read_at: new Date().toISOString() }).eq('recipient_id', userId).eq('sender_id', peerId).is('read_at', null);
    if (alive.current && !error) resetUnread.current(peerId);
  }, [userId, peerId]);
  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const seq = ++loadSequence.current;
    const version = revision.current;
    try {
      const filter = `and(sender_id.eq.${userId},recipient_id.eq.${peerId}),and(sender_id.eq.${peerId},recipient_id.eq.${userId})`;
      const { data, error } = await supabase.from('messages').select('*').or(filter).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(300);
      if (error) throw error;
      if (!alive.current || seq !== loadSequence.current) return;
      setLoadError('');
      // Replace an authoritative snapshot unless local/realtime updates raced it.
      if (version === revision.current) setMessages(mergeDirectMessages([], data ?? []));
      await read();
    } catch { if (alive.current) setLoadError(t('dm.loadError')); }
    finally { loadingRef.current = false; if (alive.current && seq === loadSequence.current) setLoading(false); }
  }, [userId, peerId, read, t]);

  useEffect(() => {
    alive.current = true;
    void load();
    const channel = supabase.channel(`dm:${userId}:${peerId}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, payload => {
      const message = payload.new as DirectMessage;
      if (!alive.current || !belongs(message)) return;
      revision.current++;
      setMessages(previous => mergeDirectMessages(previous, [message]));
      if (message.recipient_id === userId) void read();
    }).subscribe();
    const refresh = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = setInterval(refresh, 10000);
    document.addEventListener('visibilitychange', refresh);
    return () => { alive.current = false; loadingRef.current = false; ++loadSequence.current; clearInterval(timer); document.removeEventListener('visibilitychange', refresh); void supabase.removeChannel(channel); };
  }, [load, belongs, read, userId, peerId]);

  useEffect(() => {
    if (nearBottom.current || forceBottom.current) {
      box.current?.scrollTo?.({ top: box.current.scrollHeight, behavior: 'smooth' });
      forceBottom.current = false;
    }
  }, [messages]);

  const send = async () => {
    if (busy.current || (!text.trim() && !files.length)) return;
    busy.current = true; setSending(true); setError('');
    const form = new FormData(); form.set('peerId', peerId); form.set('content', text);
    files.forEach(file => form.append('files', file));
    try {
      const response = await authFetch('/api/messages', { method: 'POST', body: form });
      const result = await response.json();
      if (!response.ok || !result.message || !belongs(result.message)) throw new Error(result.error || t('dm.sendError'));
      if (!alive.current) return;
      revision.current++;
      forceBottom.current = true;
      // Use the actual committed row; no dependency on Realtime delivery.
      setMessages(previous => mergeDirectMessages(previous, [result.message]));
      setText(''); setFiles([]); setEmojiOpen(false);
      input.current?.focus();
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : t('dm.sendError')); }
    finally { busy.current = false; if (alive.current) setSending(false); }
  };
  const remove = async (id: string | number) => {
    try {
      const response = await authFetch(`/api/messages/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('delete');
      if (alive.current) { revision.current++; setMessages(previous => previous.filter(message => String(message.id) !== String(id))); }
    } catch { if (alive.current) setError(t('dm.deleteError')); }
  };
  const wrap = (before: string, after = before) => {
    const start = input.current?.selectionStart ?? text.length;
    const end = input.current?.selectionEnd ?? start;
    const replacement = before + text.slice(start, end) + after;
    if (text.length - (end - start) + replacement.length > DM_MAX_TEXT) return;
    setText(text.slice(0, start) + replacement + text.slice(end));
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(start + before.length, end + before.length); });
  };
  const addFiles = (selected: FileList | null) => {
    const next = [...files, ...Array.from(selected ?? [])];
    if (next.length > DM_MAX_FILES || next.some(file => !file.size || file.size > DM_MAX_FILE_BYTES) || next.reduce((sum, file) => sum + file.size, 0) > DM_MAX_TOTAL_BYTES) { setError(t('dm.limit')); return; }
    if (next.some(file => !DM_EXTENSIONS.includes(fileExtension(file.name)))) { setError(t('dm.fileType')); return; }
    setError(''); setFiles(next);
  };
  return <section className="dm-conversation" aria-label={peerName}>
    <header className="dm-header"><strong>{peerName}</strong><Link href={`/cmdr/${encodeURIComponent(peerName)}`}>{t('frnd.profile')}</Link></header>
    <div className="dm-messages" ref={box} role="log" aria-live="polite" onScroll={() => { const node = box.current; if (node) nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}>
      {loading && <p role="status">{t('frnd.loading')}</p>}
      {!loading && !messages.length && <p>{t('frnd.emptyChat')}</p>}
      {messages.map(message => <article key={message.id} className={message.sender_id === userId ? 'dm-message dm-mine' : 'dm-message'}>
        <div className="dm-meta"><PilotIdentity userId={message.sender_id} cmdrName={message.author_name || (message.sender_id === userId ? myName : peerName)} avatarUrl={message.avatar_url ?? (message.sender_id === userId ? myAvatar : null)} size={24} fontSize={11} showTier={false} />
          <time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString(locale)}</time>
          {message.sender_id === userId && <button type="button" aria-label={t('frnd.deleteMessage')} onClick={() => void remove(message.id)}>×</button>}
        </div>
        <div className="dm-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} skipHtml components={{
          a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>,
          // Remote Markdown images could leak private conversation readers' IPs.
          img: ({ alt }) => <span>{alt}</span>,
        }}>{message.content}</ReactMarkdown></div>
        {(Array.isArray(message.attachments) ? message.attachments : []).filter(file => attachmentValidForMessage(file, message)).map(file => <Attachment key={file.id} file={file} messageId={message.id} />)}
      </article>)}
    </div>
    <div className="dm-composer">
      {(error || loadError) && <div role="alert">{error || loadError} <button type="button" onClick={() => { setError(''); setLoadError(''); void load(); }}>{t('dm.retry')}</button></div>}
      <div className="dm-toolbar" role="toolbar" aria-label={t('dm.format')}>
        <button type="button" disabled={sending} title={t('dm.bold')} onClick={() => wrap('**')}><b>B</b></button>
        <button type="button" disabled={sending} title={t('dm.italic')} onClick={() => wrap('*')}><i>I</i></button>
        <button type="button" disabled={sending} title={t('dm.strike')} onClick={() => wrap('~~')}><s>S</s></button>
        <button type="button" disabled={sending} title={t('dm.code')} onClick={() => wrap('`')}>{'</>'}</button>
        <button type="button" disabled={sending} title={t('dm.link')} onClick={() => wrap('[', '](https://)')}>↗</button>
        <button type="button" disabled={sending} aria-label={t('dm.emoji')} aria-expanded={emojiOpen} onClick={() => setEmojiOpen(!emojiOpen)}>☺</button>
        <label className="dm-file-label">{t('dm.attach')}<input aria-label={t('dm.attach')} type="file" multiple accept={DM_ACCEPT} disabled={sending} onChange={event => { addFiles(event.target.files); event.target.value = ''; }} /></label>
      </div>
      {emojiOpen && <div className="dm-toolbar">{['😀','😊','😂','😎','🤔','👍','👎','❤️','🚀','🪐','⭐','🎉','✅','🔥','👋','🫡'].map(emoji => <button type="button" key={emoji} disabled={sending} onClick={() => wrap(emoji, '')}>{emoji}</button>)}</div>}
      {!!files.length && <ul className="dm-files">{files.map((file, i) => <li key={i}>{file.name} <button type="button" disabled={sending} aria-label={t('dm.removeFile')} onClick={() => setFiles(files.filter((_, index) => index !== i))}>×</button></li>)}</ul>}
      <div className="dm-input"><textarea ref={input} value={text} maxLength={DM_MAX_TEXT} rows={3} disabled={sending} placeholder={t('frnd.messagePlaceholder')} aria-label={t('frnd.messagePlaceholder')}
        onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
        <button type="button" className="btn btn-cyan" disabled={sending || (!text.trim() && !files.length)} onClick={() => void send()}>{t(sending ? 'dm.sending' : 'forum.send')}</button></div>
      <small>{t('dm.hint')}</small>
    </div>
  </section>;
}
