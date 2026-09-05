'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { authFetch, getAuthenticatedSupabase } from '@/lib/supabaseClient';
import type { SupabaseClient } from '@supabase/supabase-js';
import { IconSend, IconTrash, IconLock } from '@/components/Icons';

interface ChatMessage {
  id: number;
  squadron_id: number;
  user_id: string;
  content: string;
  chat_type: 'general' | 'officer';
  created_at: string;
  updated_at: string;
  profiles?: {
    cmdr_name: string | null;
    avatar_url: string | null;
  } | null;
}

interface Props {
  squadronId: number;
  userId: string;
  isOfficer: boolean;
  members: { user_id: string; cmdr_name: string | null; avatar_url: string | null }[];
}

// Parse @mentions and render with orange highlight
function renderMentions(text: string) {
  const parts = text.split(/(@[A-Za-z0-9_\-]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith('@')) {
      return (
        <span key={i} style={{ color: 'var(--orange)', fontWeight: 600 }}>
          {part}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export default function SquadronChat({ squadronId, userId, isOfficer, members }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [chatType, setChatType] = useState<'general' | 'officer'>('general');
  const [loading, setLoading] = useState(false);
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);
  const [mentionQuery, setMentionQuery] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Initialize authenticated supabase client
  useEffect(() => {
    let mounted = true;
    getAuthenticatedSupabase().then((client) => {
      if (mounted) setSupabase(client);
    });
    return () => { mounted = false };
  }, []);

  const loadMessages = useCallback(async () => {
    try {
      const res = await authFetch(`/api/squadrons/${squadronId}/chat?chat_type=${chatType}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('[CHAT] GET error:', err);
        return;
      }
      const data = await res.json();
      setMessages(data.messages || []);
    } catch (e) {
      console.error('[CHAT] GET exception:', e);
    }
  }, [squadronId, chatType]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Real-time subscription
  useEffect(() => {
    if (!supabase) return;
    const channel = supabase
      .channel(`squadron_chat_${squadronId}_${chatType}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'squadron_chat_messages',
          filter: `squadron_id=eq.${squadronId}`,
        },
        (payload) => {
          const msg = payload.new as ChatMessage;
          if (msg.chat_type === chatType) {
            const member = members.find((m) => m.user_id === msg.user_id);
            const enrichedMsg: ChatMessage = {
              ...msg,
              profiles: member
                ? { cmdr_name: member.cmdr_name, avatar_url: member.avatar_url }
                : null,
            };
            setMessages((prev) => {
              if (prev.find((m) => m.id === msg.id)) return prev;
              return [...prev, enrichedMsg];
            });
          }
        }
      )
      .subscribe((status) => {
        console.log('[CHAT] Realtime status:', status);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, squadronId, chatType, members]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim()) return;
    setLoading(true);
    try {
      const res = await authFetch(`/api/squadrons/${squadronId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: input, chat_type: chatType }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('[CHAT] POST error:', err);
        return;
      }
      setInput('');
      setShowMentions(false);
    } catch (e) {
      console.error('[CHAT] POST exception:', e);
    } finally {
      setLoading(false);
    }
  };

  const deleteMessage = async (messageId: number) => {
    if (!confirm('Удалить сообщение?')) return;
    try {
      const res = await authFetch(`/api/squadrons/${squadronId}/chat/${messageId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('[CHAT] DELETE error:', err);
        return;
      }
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
    } catch (e) {
      console.error('[CHAT] DELETE exception:', e);
    }
  };

  const formatDateTime = (iso: string) => {
    const d = new Date(iso);
    const date = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return `${date} ${time}`;
  };

  // Mention autocomplete
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setInput(value);

    const lastAt = value.lastIndexOf('@');
    if (lastAt !== -1) {
      const afterAt = value.slice(lastAt + 1);
      if (!afterAt.includes(' ')) {
        setMentionQuery(afterAt.toLowerCase());
        setShowMentions(true);
        return;
      }
    }
    setShowMentions(false);
  };

  const insertMention = (cmdrName: string) => {
    const lastAt = input.lastIndexOf('@');
    const before = input.slice(0, lastAt);
    const newValue = `${before}@${cmdrName} `;
    setInput(newValue);
    setShowMentions(false);
    inputRef.current?.focus();
  };

  const filteredMembers = members
    .filter((m) => m.cmdr_name && m.cmdr_name.toLowerCase().includes(mentionQuery))
    .slice(0, 5);

  return (
    <div>
      {/* Tabs */}
      <div className="flex gap-2 mb-3">
        <button
          className={`btn ${chatType === 'general' ? 'btn-primary' : 'btn-outline'}`}
          onClick={() => setChatType('general')}
        >
          Общий
        </button>
        {isOfficer && (
          <button
            className={`btn ${chatType === 'officer' ? 'btn-primary' : 'btn-outline'} flex items-center gap-1`}
            onClick={() => setChatType('officer')}
          >
            <IconLock size={12} /> Офицерский
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="chat-box">
        {messages.map((msg) => {
          const isMe = msg.user_id === userId;
          const name = msg.profiles?.cmdr_name || 'Неизвестный';
          const avatar = msg.profiles?.avatar_url;
          return (
            <div
              key={msg.id}
              className="chat-msg"
              style={{ flexDirection: isMe ? 'row-reverse' : 'row' }}
            >
              {/* Avatar column */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                {avatar ? (
                  <img src={avatar} alt="" className="avatar-sm" />
                ) : (
                  <span
                    className="avatar-sm"
                    style={{ background: '#3a3d40', display: 'inline-block' }}
                  />
                )}
                {isMe && (
                  <button
                    onClick={() => deleteMessage(msg.id)}
                    title="Удалить"
                    style={{
                      color: '#ef4444',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <IconTrash size={12} />
                  </button>
                )}
              </div>

              {/* Message body */}
              <div className="chat-body" style={isMe ? { marginRight: 8, borderColor: 'var(--orange)' } : { marginLeft: 8 }}>
                <span className="chat-meta">
                  {name}
                  <span className="chat-time">{formatDateTime(msg.created_at)}</span>
                </span>
                <div className="chat-text">{renderMentions(msg.content)}</div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input with mention autocomplete */}
      <div className="chat-form" style={{ position: 'relative' }}>
        {showMentions && filteredMembers.length > 0 && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: 4,
              padding: '4px 0',
              minWidth: 200,
              zIndex: 10,
              marginBottom: 4,
            }}
          >
            {filteredMembers.map((m) => (
              <button
                key={m.user_id}
                onClick={() => insertMention(m.cmdr_name!)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 12px',
                  width: '100%',
                  textAlign: 'left',
                  background: 'none',
                  border: 'none',
                  color: 'var(--text)',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--line)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
              >
                {m.avatar_url ? (
                  <img src={m.avatar_url} alt="" style={{ width: 24, height: 24, borderRadius: '50%' }} />
                ) : (
                  <span style={{ width: 24, height: 24, borderRadius: '50%', background: '#3a3d40', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10 }}>
                    {m.cmdr_name?.[0]?.toUpperCase() || '?'}
                  </span>
                )}
                <span style={{ color: 'var(--orange)' }}>@{m.cmdr_name}</span>
              </button>
            ))}
          </div>
        )}
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={handleInputChange}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !showMentions) sendMessage();
          }}
          placeholder="Написать сообщение..."
        />
        <button
          onClick={sendMessage}
          disabled={loading || !input.trim()}
          className="btn btn-primary flex items-center gap-1"
        >
          <IconSend size={14} /> Отправить
        </button>
      </div>
    </div>
  );
}
