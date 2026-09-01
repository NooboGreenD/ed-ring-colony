"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabaseClient";
import { IconSend, IconTrash, IconLock } from "@/components/Icons";

interface ChatMessage {
  id: number;
  squadron_id: number;
  user_id: string;
  content: string;
  chat_type: "general" | "officer";
  created_at: string;
  updated_at: string;
  profiles?: {
    cmdr_name: string | null;
    avatar_url: string | null;
  } | null;
}

interface SquadronMember {
  user_id: string;
  cmdr_name: string | null;
  avatar_url: string | null;
}

interface Props {
  squadronId: number;
  userId: string;
  isOfficer: boolean;
  members: SquadronMember[];
}

export default function SquadronChat({ squadronId, userId, isOfficer, members }: Props) {
  const [chatType, setChatType] = useState<"general" | "officer">("general");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [showMentions, setShowMentions] = useState(false);
  const [cursorPos, setCursorPos] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [error, setError] = useState<string | null>(null);

  const loadMessages = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/squadrons/${squadronId}/chat?type=${chatType}&limit=50`);
      const json = await res.json();
      if (!res.ok) {
        console.error('[CHAT] GET error:', json);
        setError(json.error || 'Ошибка загрузки сообщений');
        setMessages([]);
      } else if (json.messages) {
        setMessages(json.messages.reverse());
      }
    } catch (e: any) {
      console.error('[CHAT] GET exception:', e);
      setError('Ошибка сети');
      setMessages([]);
    }
    setLoading(false);
  }, [squadronId, chatType]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Real-time subscription
  useEffect(() => {
    const channel = supabase
      .channel(`squadron_chat_${squadronId}_${chatType}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "squadron_chat_messages",
          filter: `squadron_id=eq.${squadronId}`,
        },
        (payload) => {
          const msg = payload.new as ChatMessage;
          if (msg.chat_type === chatType) {
            setMessages((prev) => {
              if (prev.find((m) => m.id === msg.id)) return prev;
              return [...prev, msg];
            });
          }
        }
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "squadron_chat_messages",
          filter: `squadron_id=eq.${squadronId}`,
        },
        (payload) => {
          const deletedId = payload.old.id;
          setMessages((prev) => prev.filter((m) => m.id !== deletedId));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [squadronId, chatType]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);

    // Check for @mention
    const beforeCursor = value.slice(0, e.target.selectionStart || 0);
    const match = beforeCursor.match(/@([A-Za-z0-9_\-]*)$/);
    if (match) {
      setMentionQuery(match[1]);
      setShowMentions(true);
      setCursorPos(e.target.selectionStart || 0);
    } else {
      setShowMentions(false);
    }
  };

  const insertMention = (cmdrName: string) => {
    const beforeCursor = input.slice(0, cursorPos);
    const afterCursor = input.slice(cursorPos);
    const newBefore = beforeCursor.replace(/@[A-Za-z0-9_\-]*$/, `@${cmdrName} `);
    setInput(newBefore + afterCursor);
    setShowMentions(false);
    inputRef.current?.focus();
  };

  const filteredMembers = mentionQuery
    ? members.filter(
        (m) =>
          m.cmdr_name?.toLowerCase().includes(mentionQuery.toLowerCase()) &&
          m.user_id !== userId
      )
    : [];

  const sendMessage = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/squadrons/${squadronId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: input.trim(), chat_type: chatType }),
      });
      const json = await res.json();
      if (!res.ok) {
        console.error('[CHAT] POST error:', json);
        setError(json.error || 'Ошибка отправки сообщения');
      } else {
        setInput("");
        setShowMentions(false);
      }
    } catch (e: any) {
      console.error('[CHAT] POST exception:', e);
      setError('Ошибка сети при отправке');
    }
    setSending(false);
  };

  const deleteMessage = async (messageId: number) => {
    if (!confirm("Удалить сообщение?")) return;
    await fetch(`/api/squadrons/${squadronId}/chat/${messageId}`, {
      method: "DELETE",
    });
  };

  const formatTime = (date: string) => {
    return new Date(date).toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "short",
    });
  };

  const isSameDay = (a: string, b: string) => {
    return new Date(a).toDateString() === new Date(b).toDateString();
  };

  const renderContent = (content: string) => {
    // Highlight @mentions
    const parts = content.split(/(@[A-Za-z0-9_\-]+)/g);
    return parts.map((part, i) => {
      if (part.startsWith("@")) {
        return (
          <span key={i} style={{ color: "#e67e22", fontWeight: 600 }}>
            {part}
          </span>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  return (
    <div>
      {/* Chat type tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          onClick={() => setChatType("general")}
          className={chatType === "general" ? "tab tab-active" : "tab"}
        >
          Общий чат
        </button>
        <button
          onClick={() => isOfficer && setChatType("officer")}
          className={chatType === "officer" ? "tab tab-active" : "tab"}
          disabled={!isOfficer}
          title={!isOfficer ? "Доступно только офицерам" : ""}
          style={{ opacity: isOfficer ? 1 : 0.5 }}
        >
          <IconLock size={12} color={chatType === "officer" ? "#e67e22" : "#9ca3af"} /> Офицерский
        </button>
      </div>

      {/* Messages */}
      {error && (
        <div style={{
          padding: "10px 14px",
          marginBottom: 12,
          background: "rgba(231,76,60,0.12)",
          border: "1px solid rgba(231,76,60,0.3)",
          borderRadius: 4,
          color: "#e74c3c",
          fontSize: 12,
          fontFamily: "ui-monospace, monospace",
        }}>
          {error}
        </div>
      )}
      <div
        ref={scrollRef}
        style={{
          height: 400,
          overflowY: "auto",
          background: "#1a1c1e",
          border: "1px solid #2d3033",
          borderRadius: 8,
          padding: "12px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {loading && messages.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--muted)", padding: 40, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            Загрузка сообщений...
          </div>
        )}

        {messages.length === 0 && !loading && (
          <div style={{ textAlign: "center", color: "var(--muted)", padding: 40, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            {chatType === "officer" ? "Офицерский чат пуст" : "Напишите первое сообщение..."}
          </div>
        )}

        {messages.map((msg, idx) => {
          const showDate = idx === 0 || !isSameDay(msg.created_at, messages[idx - 1].created_at);
          const isMe = msg.user_id === userId;
          const canDelete = isMe || isOfficer;

          return (
            <div key={msg.id}>
              {showDate && (
                <div style={{
                  textAlign: "center",
                  margin: "12px 0",
                  fontSize: 11,
                  color: "#6b7280",
                  fontFamily: "ui-monospace, monospace",
                }}>
                  {formatDate(msg.created_at)}
                </div>
              )}
              <div style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                flexDirection: isMe ? "row-reverse" : "row",
              }}>
                {/* Avatar */}
                <div style={{ flexShrink: 0, marginTop: 2 }}>
                  {msg.profiles?.avatar_url ? (
                    <img
                      src={msg.profiles.avatar_url}
                      alt=""
                      style={{ width: 32, height: 32, borderRadius: "50%", objectFit: "cover" }}
                    />
                  ) : (
                    <div style={{
                      width: 32, height: 32, borderRadius: "50%",
                      background: "#323538",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 12, color: "#9ca3af", fontWeight: 600,
                    }}>
                      {(msg.profiles?.cmdr_name || "?")[0]?.toUpperCase()}
                    </div>
                  )}
                </div>

                {/* Message bubble */}
                <div style={{ maxWidth: "70%" }}>
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 2,
                    flexDirection: isMe ? "row-reverse" : "row",
                  }}>
                    <span style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: isMe ? "#e67e22" : "#9ca3af",
                      fontFamily: "ui-monospace, monospace",
                    }}>
                      {msg.profiles?.cmdr_name || "Неизвестный"}
                    </span>
                    <span style={{
                      fontSize: 10,
                      color: "#6b7280",
                      fontFamily: "ui-monospace, monospace",
                    }}>
                      {formatTime(msg.created_at)}
                    </span>
                    {canDelete && (
                      <button
                        onClick={() => deleteMessage(msg.id)}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          padding: 0,
                          opacity: 0.4,
                          transition: "opacity 0.2s",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                        onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.4")}
                        title="Удалить"
                      >
                        <IconTrash size={12} color="#e74c3c" />
                      </button>
                    )}
                  </div>
                  <div style={{
                    background: isMe ? "rgba(230,126,34,0.12)" : "#25282b",
                    border: `1px solid ${isMe ? "rgba(230,126,34,0.2)" : "#2d3033"}`,
                    borderRadius: isMe ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                    padding: "8px 12px",
                    fontSize: 13,
                    lineHeight: 1.5,
                    color: "var(--text)",
                    wordBreak: "break-word",
                  }}>
                    {renderContent(msg.content)}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Input */}
      <div style={{ position: "relative", marginTop: 12 }}>
        {/* Mention autocomplete */}
        {showMentions && filteredMembers.length > 0 && (
          <div style={{
            position: "absolute",
            bottom: "100%",
            left: 0,
            right: 0,
            background: "#1e2124",
            border: "1px solid #2d3033",
            borderRadius: 6,
            maxHeight: 160,
            overflowY: "auto",
            zIndex: 10,
            marginBottom: 4,
          }}>
            {filteredMembers.map((m) => (
              <button
                key={m.user_id}
                onClick={() => insertMention(m.cmdr_name || "Unknown")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "8px 12px",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text)",
                  fontSize: 13,
                  textAlign: "left",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#25282b")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                {m.avatar_url ? (
                  <img src={m.avatar_url} alt="" style={{ width: 24, height: 24, borderRadius: "50%" }} />
                ) : (
                  <div style={{ width: 24, height: 24, borderRadius: "50%", background: "#323538" }} />
                )}
                <span style={{ fontFamily: "ui-monospace, monospace" }}>{m.cmdr_name || "Unknown"}</span>
              </button>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder={chatType === "officer" ? "Сообщение офицерам..." : "Напишите сообщение... (@имя для упоминания)"}
            style={{
              flex: 1,
              minHeight: 44,
              maxHeight: 120,
              resize: "none",
              padding: "10px 14px",
              fontSize: 13,
              background: "#1a1c1e",
              border: "1px solid #2d3033",
              borderRadius: 6,
              color: "var(--text)",
              fontFamily: "inherit",
            }}
            maxLength={2000}
          />
          <button
            onClick={sendMessage}
            disabled={sending || !input.trim()}
            className="btn btn-cyan"
            style={{
              padding: "10px 16px",
              alignSelf: "flex-end",
              opacity: sending || !input.trim() ? 0.5 : 1,
            }}
          >
            <IconSend size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
