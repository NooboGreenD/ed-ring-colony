"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import PilotIdentity from "@/components/Cosmetics/PilotIdentity";
import { useFriends } from "@/hooks/useFriends";
import { supabase } from "@/lib/supabaseClient";
import Avatar from "@/components/Avatar";
import DirectConversation from "@/components/DirectConversation";
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  IconSearch,
  IconCheck,
  IconError,
  IconTrash,
  IconMessage
} from "@/components/Icons";

type Props = { userId: string; myName: string; myAvatar: string | null };

export default function FriendsPanel({ userId, myName, myAvatar }: Props) {
  const { t } = useI18n();
  const {
    friends, pendingIncoming, pendingOutgoing,
    loading, error, sendRequest, acceptRequest, rejectRequest, removeFriend
  } = useFriends(userId);

  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [chatPeer, setChatPeer] = useState<string | null>(null);
  const [chatPeerName, setChatPeerName] = useState<string>("");
  const [tab, setTab] = useState<"friends" | "requests">("friends");
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});

  // Считаем непрочитанные сообщения от каждого друга
  useEffect(() => {
    const loadUnread = async () => {
      if (!friends.length) return;
      const counts: Record<string, number> = {};
      for (const f of friends) {
        const fid = f.friend_id;
        if (!fid) continue;
        const { count: c } = await supabase
          .from("messages")
          .select("*", { count: "exact", head: true })
          .eq("sender_id", fid)
          .eq("recipient_id", userId)
          .is("read_at", null);
        counts[fid] = c || 0;
      }
      setUnreadCounts(counts);
    };
    void loadUnread();
  }, [friends, userId]);

  const doSearch = async () => {
    if (!search.trim()) return;
    setSearching(true);
    // public_profiles: поиск по позывным не должен открывать приватные
    // колонки profiles (email, role, privacy_settings).
    const { data } = await supabase
      .from("public_profiles")
      .select("id, cmdr_name, avatar_url")
      .ilike("cmdr_name", `%${search.trim()}%`)
      .limit(20);
    setSearchResults((data || []).filter((u: any) => u.id !== userId));
    setSearching(false);
  };

  const selectFriend = (friend: any) => {
    const fid = friend.friend_id || null;
    setChatPeer(fid);
    setChatPeerName(friend.friend_name || "Unknown");
    // Сбрасываем badge непрочитанных для выбранного друга
    setUnreadCounts((prev) => ({ ...prev, [fid]: 0 }));
  };

  return (
    <div className="friends-layout">
      {/* Левая панель: список друзей */}
      <div className="friends-sidebar">
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button className={tab === "friends" ? "tab tab-active" : "tab"} onClick={() => setTab("friends")}>
            {t('frnd.tabFriends', { count: friends.length })}
          </button>
          <button className={tab === "requests" ? "tab tab-active" : "tab"} onClick={() => setTab("requests")}>
            {t('frnd.tabRequests')} {pendingIncoming.length > 0 && `(${pendingIncoming.length})`}
          </button>
        </div>

        {error && (
          <p role="alert" style={{ color: "#f59e0b", fontSize: 12, margin: "0 0 10px" }}>
            {t('frnd.staleData', { error })}
          </p>
        )}

        {tab === "friends" && (
          <>
            {/* Поиск друзей */}
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('frnd.searchPlaceholder')}
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
                  {t('frnd.searchResults')}
                </div>
                {searchResults.map((u) => (
                  <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid #25282b" }}>
                    <PilotIdentity userId={u.id} cmdrName={u.cmdr_name || "Unknown"} avatarUrl={u.avatar_url} size={28} fontSize={13} style={{ flex: 1 }} />
                    <button
                      onClick={async () => {
                        const { ok } = await sendRequest(u.id);
                        if (ok) setSearchResults((prev) => prev.filter((x) => x.id !== u.id));
                      }}
                      className="btn btn-cyan"
                      style={{ fontSize: 11, padding: "4px 10px" }}
                    >
                      {t('frnd.add')}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Список друзей */}
            {friends.length === 0 && !loading && (
              <p style={{ color: "#9ca3af", fontSize: 13 }}>
                {t('frnd.noFriends')}{" "}
                <Link href="/cmdrs" style={{ color: "#e67e22" }}>{t('frnd.commanders')}</Link>.
              </p>
            )}
            {friends.map((f) => {
              const fid = f.friend_id;
              if (!fid) return null;
              const unread = unreadCounts[fid] || 0;
              return (
                <button
                  key={f.id}
                  className={chatPeer === f.friend_id ? "peer peer-active" : "peer"}
                  onClick={() => selectFriend(f)}
                  style={{ position: "relative" }}
                >
                  <PilotIdentity userId={f.friend_id} cmdrName={f.friend_name || "Unknown"} avatarUrl={f.friend_avatar} size={28} fontSize={13} link={false} showTier={false} style={{ flex: 1, textAlign: "left" }} />
                  {unread > 0 && (
                    <div style={{
                      position: "absolute",
                      top: 2,
                      right: 24,
                      background: "#e74c3c",
                      color: "#fff",
                      borderRadius: "50%",
                      width: 20,
                      height: 20,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      fontWeight: 700,
                      fontFamily: "ui-monospace, monospace",
                      border: "2px solid #1a1c1e",
                    }}>
                      {unread > 9 ? "9+" : unread}
                    </div>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); removeFriend(f.id); }}
                    style={{ background: "none", border: "none", cursor: "pointer", opacity: 0.4, padding: 2 }}
                    title={t('frnd.removeFriend')}
                  >
                    <IconTrash size={12} color="#e74c3c" />
                  </button>
                </button>
              );
            })}
          </>
        )}

        {tab === "requests" && (
          <>
            {/* Входящие запросы */}
            {pendingIncoming.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: "#e67e22", marginBottom: 8, fontFamily: "ui-monospace, monospace" }}>
                  {t('frnd.incoming')}
                </div>
                {pendingIncoming.map((f) => (
                  <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px", background: "#1a1c1e", borderRadius: 6, marginBottom: 6 }}>
                    <Avatar url={f.friend_avatar} name={f.friend_name} size={34} className="avatar-sm" />
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
                  {t('frnd.outgoing')}
                </div>
                {pendingOutgoing.map((f) => (
                  <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px", background: "#1a1c1e", borderRadius: 6, marginBottom: 6, opacity: 0.7 }}>
                    <Avatar url={f.friend_avatar} name={f.friend_name} size={34} className="avatar-sm" />
                    <span style={{ flex: 1, fontSize: 13 }}>{f.friend_name}</span>
                    <span style={{ fontSize: 11, color: "#9ca3af" }}>{t('frnd.waiting')}</span>
                    <button onClick={() => rejectRequest(f.id)} className="btn" style={{ fontSize: 11, padding: "4px 8px", borderColor: "#e74c3c", color: "#e74c3c" }}>
                      {t('frnd.cancelRequest')}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {pendingIncoming.length === 0 && pendingOutgoing.length === 0 && (
              <p style={{ color: "#9ca3af", fontSize: 13 }}>{t('frnd.noRequests')}</p>
            )}
          </>
        )}
      </div>

      {/* Правая панель: чат */}
      <div className="friends-chat">
        {!chatPeer && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", color: "#9ca3af" }}>
            <div style={{ fontSize: 48, marginBottom: 16, display: "flex", justifyContent: "center" }}><IconMessage size={48} color="#9ca3af" /></div>
            <p>{t('frnd.pickFriend')}</p>
          </div>
        )}
        {chatPeer && (
          <DirectConversation
            key={`${userId}:${chatPeer}`}
            userId={userId}
            peerId={chatPeer}
            peerName={chatPeerName}
            myName={myName}
            myAvatar={myAvatar}
            onUnreadReset={(pid) => setUnreadCounts((prev) => ({ ...prev, [pid]: 0 }))}
          />
        )}
      </div>
    </div>
  );
}
