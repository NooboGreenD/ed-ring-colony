"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useFriends } from "@/hooks/useFriends";
import { supabase } from "@/lib/supabaseClient";
import {
  IconSearch,
  IconCheck,
  IconError,
  IconTrash,
  IconSend,
} from "@/components/Icons";

type Props = { userId: string; myName: string; myAvatar: string | null };

export default function FriendsPanel({ userId, myName, myAvatar }: Props) {
  const {
    friends, pendingIncoming, pendingOutgoing,
    loading, sendRequest, acceptRequest, rejectRequest, removeFriend
  } = useFriends(userId);

  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [chatPeer, setChatPeer] = useState<string | null>(null);
  const [chatPeerName, setChatPeerName] = useState<string>("");
  const [chatPeerAvatar, setChatPeerAvatar] = useState<string | null>(null);
  const [tab, setTab] = useState<"friends" | "requests">("friends");

  const doSearch = async () => {
    if (!search.trim()) return;
    setSearching(true);
    const { data } = await supabase
      .from("profiles")
      .select("id, cmdr_name, avatar_url")
      .ilike("cmdr_name", `%${search.trim()}%`)
      .limit(20);
    setSearchResults((data || []).filter((u: any) => u.id !== userId));
    setSearching(false);
  };

  const selectFriend = (friend: any) => {
    setChatPeer(friend.friend_id || null);
    setChatPeerName(friend.friend_name || "Unknown");
    setChatPeerAvatar(friend.friend_avatar || null);
  };

  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
      {/* Левая панель: список друзей */}
      <div style={{ flex: "0 0 280px", minWidth: 240 }}>
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button className={tab === "friends" ? "tab tab-active" : "tab"} onClick={() => setTab("friends")}>
            Друзья ({friends.length})
          </button>
          <button className={tab === "requests" ? "tab tab-active" : "tab"} onClick={() => setTab("requests")}>
            Запросы {pendingIncoming.length > 0 && `(${pendingIncoming.length})`}
          </button>
        </div>

        {tab === "friends" && (
          <>
            {/* Поиск друзей */}
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Найти пилота..."
                onKeyDown={(e) => e.key === "Enter" && doSearch()}
                style={{ flex: 1, fontSize: 13 }}
              />
              <button onClick={doSearch} disabled={searching} className="btn" style={{ padding: "6px 10px" }}>
                <IconSearch size={14} />
              </button>
            </div>

            {/* Результаты поиска */}
            {searchResults.length > 0 && (
              <div style={{ marginBottom: 16, background: "#1a1c1e", border: "1px solid #2d3033", borderRadius: 6, padding: 8 }}>
                <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 6, fontFamily: "ui-monospace, monospace" }}>
                  Результаты поиска
                </div>
                {searchResults.map((u) => (
                  <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid #25282b" }}>
                    {u.avatar_url ? <img src={u.avatar_url} className="avatar-sm" alt="" /> : <div className="avatar-sm" style={{ background: "#323538" }} />}
                    <span style={{ flex: 1, fontSize: 13 }}>{u.cmdr_name || "Unknown"}</span>
                    <button
                      onClick={async () => {
                        const { ok } = await sendRequest(u.id);
                        if (ok) setSearchResults((prev) => prev.filter((x) => x.id !== u.id));
                      }}
                      className="btn btn-cyan"
                      style={{ fontSize: 11, padding: "4px 10px" }}
                    >
                      Добавить
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Список друзей */}
            {friends.length === 0 && !loading && (
              <p style={{ color: "#9ca3af", fontSize: 13 }}>
                У вас пока нет друзей. Найдите пилотов через поиск выше или на странице{" "}
                <Link href="/cmdrs" style={{ color: "#e67e22" }}>Командиры</Link>.
              </p>
            )}
            {friends.map((f) => (
              <button
                key={f.id}
                className={chatPeer === f.friend_id ? "peer peer-active" : "peer"}
                onClick={() => selectFriend(f)}
                style={{ position: "relative" }}
              >
                {f.friend_avatar ? (
                  <img src={f.friend_avatar} className="avatar-sm" alt="" />
                ) : (
                  <span className="avatar-sm" style={{ background: "#3a3d40", display: "inline-block" }} />
                )}
                <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {f.friend_name || "Unknown"}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); removeFriend(f.id); }}
                  style={{ background: "none", border: "none", cursor: "pointer", opacity: 0.4, padding: 2 }}
                  title="Удалить из друзей"
                >
                  <IconTrash size={12} color="#e74c3c" />
                </button>
              </button>
            ))}
          </>
        )}

        {tab === "requests" && (
          <>
            {/* Входящие запросы */}
            {pendingIncoming.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: "#e67e22", marginBottom: 8, fontFamily: "ui-monospace, monospace" }}>
                  Входящие запросы
                </div>
                {pendingIncoming.map((f) => (
                  <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px", background: "#1a1c1e", borderRadius: 6, marginBottom: 6 }}>
                    {f.friend_avatar ? <img src={f.friend_avatar} className="avatar-sm" alt="" /> : <div className="avatar-sm" style={{ background: "#323538" }} />}
                    <span style={{ flex: 1, fontSize: 13 }}>{f.friend_name}</span>
                    <button onClick={() => acceptRequest(f.id)} className="btn btn-cyan" style={{ fontSize: 11, padding: "4px 8px" }}>
                      <IconCheck size={12} />
                    </button>
                    <button onClick={() => rejectRequest(f.id)} className="btn" style={{ fontSize: 11, padding: "4px 8px", borderColor: "#e74c3c", color: "#e74c3c" }}>
                      <IconError size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Исходящие запросы */}
            {pendingOutgoing.length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 8, fontFamily: "ui-monospace, monospace" }}>
                  Ожидают ответа
                </div>
                {pendingOutgoing.map((f) => (
                  <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px", background: "#1a1c1e", borderRadius: 6, marginBottom: 6, opacity: 0.7 }}>
                    {f.friend_avatar ? <img src={f.friend_avatar} className="avatar-sm" alt="" /> : <div className="avatar-sm" style={{ background: "#323538" }} />}
                    <span style={{ flex: 1, fontSize: 13 }}>{f.friend_name}</span>
                    <span style={{ fontSize: 11, color: "#9ca3af" }}>Ожидание...</span>
                    <button onClick={() => rejectRequest(f.id)} className="btn" style={{ fontSize: 11, padding: "4px 8px", borderColor: "#e74c3c", color: "#e74c3c" }}>
                      Отменить
                    </button>
                  </div>
                ))}
              </div>
            )}

            {pendingIncoming.length === 0 && pendingOutgoing.length === 0 && (
              <p style={{ color: "#9ca3af", fontSize: 13 }}>Нет активных запросов.</p>
            )}
          </>
        )}
      </div>

      {/* Правая панель: чат */}
      <div style={{ flex: 1, minWidth: 280 }}>
        {!chatPeer && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "#9ca3af" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>💬</div>
            <p>Выберите друга слева, чтобы открыть переписку.</p>
          </div>
        )}
        {chatPeer && (
          <DirectChat
            userId={userId}
            peerId={chatPeer}
            peerName={chatPeerName}
            peerAvatar={chatPeerAvatar}
            myName={myName}
            myAvatar={myAvatar}
          />
        )}
      </div>
    </div>
  );
}

// ========== Встроенный DirectChat для друзей ==========
function DirectChat({
  userId,
  peerId,
  peerName,
  peerAvatar,
  myName,
  myAvatar,
}: {
  userId: string;
  peerId: string;
  peerName: string;
  peerAvatar: string | null;
  myName: string;
  myAvatar: string | null;
}) {
  const [messages, setMessages] = useState<any[]>([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const loadMessages = async () => {
    if (!peerId) { setMessages([]); return; }
    setLoading(true);
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
    setLoading(false);
  };

  useEffect(() => {
    loadMessages();
  }, [peerId]);

  // Realtime
  useEffect(() => {
    const channel = supabase
      .channel(`dm_friend_${peerId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (p) => {
          const m: any = p.new;
          const inDialog =
            (m.sender_id === userId && m.recipient_id === peerId) ||
            (m.sender_id === peerId && m.recipient_id === userId);
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
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [peerId, userId]);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    const content = text.trim();
    if (!content || !peerId) return;
    setText("");
    const { error } = await supabase.from("messages").insert({
      sender_id: userId,
      recipient_id: peerId,
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

  const formatTime = (date: string) => {
    return new Date(date).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div>
      {/* Заголовок диалога */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "#1a1c1e", borderRadius: "6px 6px 0 0", borderBottom: "1px solid #2d3033" }}>
        {peerAvatar ? <img src={peerAvatar} style={{ width: 32, height: 32, borderRadius: "50%" }} alt="" /> : <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#323538" }} />}
        <span style={{ fontWeight: 600, fontSize: 14 }}>{peerName}</span>
        <Link href={`/cmdr/${encodeURIComponent(peerName)}`} style={{ marginLeft: "auto", fontSize: 11, color: "#e67e22" }}>
          Профиль
        </Link>
      </div>

      {/* Сообщения */}
      <div
        ref={boxRef}
        style={{
          height: 360, overflowY: "auto",
          background: "#1a1c1e", border: "1px solid #2d3033", borderTop: "none", borderRadius: "0 0 6px 6px",
          padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10,
        }}
      >
        {loading && messages.length === 0 && (
          <div style={{ textAlign: "center", color: "#9ca3af", padding: 40, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            Загрузка...
          </div>
        )}
        {messages.length === 0 && !loading && (
          <div style={{ textAlign: "center", color: "#9ca3af", padding: 40, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            Переписка пуста. Отправьте первое сообщение.
          </div>
        )}
        {messages.map((m) => {
          const isMe = m.sender_id === userId;
          return (
            <div key={m.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", flexDirection: isMe ? "row-reverse" : "row" }}>
              {m.avatar_url ? (
                <img src={m.avatar_url} style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0 }} alt="" />
              ) : (
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#323538", flexShrink: 0 }} />
              )}
              <div style={{ maxWidth: "70%" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2, flexDirection: isMe ? "row-reverse" : "row" }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: isMe ? "#e67e22" : "#9ca3af", fontFamily: "ui-monospace, monospace" }}>
                    {m.author_name || "Unknown"}
                  </span>
                  <span style={{ fontSize: 10, color: "#6b7280", fontFamily: "ui-monospace, monospace" }}>
                    {formatTime(m.created_at)}
                  </span>
                  {isMe && (
                    <button onClick={() => remove(m.id)} style={{ background: "none", border: "none", cursor: "pointer", opacity: 0.3, padding: 0 }} title="Удалить">
                      <IconTrash size={10} color="#e74c3c" />
                    </button>
                  )}
                </div>
                <div style={{
                  background: isMe ? "rgba(230,126,34,0.12)" : "#25282b",
                  border: `1px solid ${isMe ? "rgba(230,126,34,0.2)" : "#2d3033"}`,
                  borderRadius: isMe ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                  padding: "8px 12px", fontSize: 13, lineHeight: 1.5, color: "var(--text)", wordBreak: "break-word",
                }}>
                  {m.content}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Ввод */}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input
          value={text}
          maxLength={1000}
          placeholder="Сообщение..."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          style={{ flex: 1, fontSize: 13, padding: "10px 14px" }}
        />
        <button onClick={send} disabled={!text.trim()} className="btn btn-cyan" style={{ padding: "10px 14px" }}>
          <IconSend size={14} />
        </button>
      </div>
    </div>
  );
}
