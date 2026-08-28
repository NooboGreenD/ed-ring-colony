"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabaseClient";

type Props = { userId: string; myName: string; myAvatar: string | null };

export default function DirectChat({ userId, myName, myAvatar }: Props) {
  const [users, setUsers] = useState<any[]>([]);
  const [peer, setPeer] = useState("");
  const [messages, setMessages] = useState<any[]>([]);
  const [text, setText] = useState("");
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const boxRef = useRef<HTMLDivElement>(null);

  // Загрузка списка пилотов
  useEffect(() => {
    supabase
      .from("profiles")
      .select("id,cmdr_name,email,avatar_url")
      .order("cmdr_name")
      .then(({ data }) =>
        setUsers((data ?? []).filter((u: any) => u.id !== userId))
      );
  }, [userId]);

  // Загрузка непрочитанных счётчиков
  const loadUnread = useCallback(async () => {
    const { data } = await supabase
      .from("messages")
      .select("sender_id")
      .eq("recipient_id", userId)
      .is("read_at", null);

    const counts: Record<string, number> = {};
    (data ?? []).forEach((m: any) => {
      counts[m.sender_id] = (counts[m.sender_id] || 0) + 1;
    });
    setUnreadCounts(counts);
  }, [userId]);

  useEffect(() => {
    loadUnread();
    const t = setInterval(loadUnread, 10000);
    return () => clearInterval(t);
  }, [loadUnread]);

  // Загрузка сообщений диалога
  const load = async (peerId: string) => {
    if (!peerId) {
      setMessages([]);
      return;
    }
    const filter =
      "and(sender_id.eq." +
      userId +
      ",recipient_id.eq." +
      peerId +
      ")," +
      "and(sender_id.eq." +
      peerId +
      ",recipient_id.eq." +
      userId +
      ")";
    const { data } = await supabase
      .from("messages")
      .select("*")
      .or(filter)
      .order("created_at", { ascending: true })
      .limit(300);
    setMessages(data ?? []);
    // Помечаем входящие прочитанными
    await supabase
      .from("messages")
      .update({ read_at: new Date().toISOString() })
      .eq("recipient_id", userId)
      .eq("sender_id", peerId)
      .is("read_at", null);
    // Сбрасываем счётчик для этого собеседника
    setUnreadCounts((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  };

  useEffect(() => {
    load(peer);
  }, [peer]);

  // Realtime
  useEffect(() => {
    const channel = supabase
      .channel("dm")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (p) => {
          const m: any = p.new;
          const inDialog =
            (m.sender_id === userId && m.recipient_id === peer) ||
            (m.sender_id === peer && m.recipient_id === userId);
          if (inDialog) {
            setMessages((prev) =>
              prev.some((x) => x.id === m.id) ? prev : [...prev, m]
            );
            if (m.recipient_id === userId) {
              supabase
                .from("messages")
                .update({ read_at: new Date().toISOString() })
                .eq("id", m.id);
            }
          } else if (m.recipient_id === userId) {
            // Новое сообщение в другом диалоге — обновляем счётчик
            setUnreadCounts((prev) => ({
              ...prev,
              [m.sender_id]: (prev[m.sender_id] || 0) + 1,
            }));
          }
        }
      )
      .subscribe();
    const t = setInterval(() => load(peer), 10000);
    return () => {
      supabase.removeChannel(channel);
      clearInterval(t);
    };
  }, [peer, userId]);

  useEffect(() => {
    boxRef.current?.scrollTo({
      top: boxRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const send = async () => {
    const content = text.trim();
    if (!content || !peer) return;
    setText("");
    const { error } = await supabase.from("messages").insert({
      sender_id: userId,
      recipient_id: peer,
      author_name: myName,
      avatar_url: myAvatar,
      content,
    });
    if (error) alert(error.message);
  };

  const remove = async (id: number) => {
    await supabase.from("messages").delete().eq("id", id);
    setMessages((prev) => prev.filter((m) => m.id !== id));
  };

  const handleSelectPeer = (peerId: string) => {
    setPeer(peerId);
    // Сразу сбрасываем счётчик визуально
    setUnreadCounts((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  };

  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
      <div style={{ flex: "0 0 230px", minWidth: 200 }}>
        {users.length === 0 && (
          <p style={{ color: "#9ca3af" }}>Других пилотов пока нет.</p>
        )}
        {users.map((u) => {
          const unread = unreadCounts[u.id] || 0;
          return (
            <button
              key={u.id}
              className={peer === u.id ? "peer peer-active" : "peer"}
              onClick={() => handleSelectPeer(u.id)}
              style={{ position: "relative" }}
            >
              {u.avatar_url ? (
                <img src={u.avatar_url} className="avatar-sm" alt="" />
              ) : (
                <span
                  className="avatar-sm"
                  style={{ background: "#3a3d40", display: "inline-block" }}
                />
              )}
              <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis" }}>
                {u.cmdr_name || u.email}
              </span>
              {unread > 0 && (
                <span
                  style={{
                    background: "#e74c3c",
                    color: "#fff",
                    fontSize: 11,
                    fontWeight: 700,
                    minWidth: 18,
                    height: 18,
                    borderRadius: 9,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "0 5px",
                    marginLeft: 6,
                  }}
                >
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div style={{ flex: 1, minWidth: 280 }}>
        {!peer && (
          <p style={{ color: "#9ca3af" }}>
            Выберите пилота слева, чтобы открыть переписку.
          </p>
        )}
        {peer && (
          <div>
            <div className="chat-box" ref={boxRef}>
              {messages.length === 0 && (
                <p style={{ color: "#9ca3af" }}>
                  Переписка пуста. Отправьте первое сообщение.
                </p>
              )}
              {messages.map((m) => (
                <div key={m.id} className="chat-msg">
                  {m.avatar_url ? (
                    <img src={m.avatar_url} className="avatar-sm" alt="" />
                  ) : (
                    <span
                      className="avatar-sm"
                      style={{ background: "#3a3d40", display: "inline-block" }}
                    />
                  )}
                  <div className="chat-body">
                    <span className="chat-meta">
                      {m.author_name}
                      <span className="chat-time">
                        {new Date(m.created_at).toLocaleString("ru-RU")}
                      </span>
                    </span>
                    <div className="chat-text">{m.content}</div>
                  </div>
                  {m.sender_id === userId && (
                    <button
                      style={{ fontSize: 10, padding: "4px 8px" }}
                      onClick={() => remove(m.id)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="chat-form">
              <input
                value={text}
                maxLength={1000}
                placeholder="Сообщение пилоту..."
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
              />
              <button onClick={send}>Отправить</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
