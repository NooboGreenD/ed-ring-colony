"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

interface Notification {
  id: string;
  type:
    | "message"
    | "news"
    | "forum_reply"
    | "forum_mention"
    | "squadron_chat_mention"
    | "project_invite"
    | "squadron_invite"
    | "project_update"
    | "project_system_status"
    | "route_status_change"
    | "route_progress"
    | "friend_request";
  title: string;
  subtitle?: string;
  href: string;
  createdAt: string;
  senderId?: string;
  isRead?: boolean;
  dbId?: string; // UUID из user_notifications
}

export default function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [totalUnread, setTotalUnread] = useState(0);
  const [pushEnabled, setPushEnabled] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Загрузка пользователя
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user));
  }, []);

  // Проверка push-разрешения
  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      setPushEnabled(Notification.permission === "granted");
    }
  }, []);

  // Загрузка уведомлений
  const loadNotifications = useCallback(async () => {
    if (!user) {
      setNotifications([]);
      setTotalUnread(0);
      return;
    }

    const list: Notification[] = [];

    // 1. Непрочитанные сообщения — группируем по отправителю
    const { data: unreadMsgs } = await supabase
      .from("messages")
      .select("sender_id, author_name, content, created_at")
      .eq("recipient_id", user.id)
      .is("read_at", null)
      .order("created_at", { ascending: false });

    const msgGroups: Record<string, { count: number; name: string; lastAt: string; lastContent: string }> = {};
    (unreadMsgs ?? []).forEach((m: any) => {
      if (!msgGroups[m.sender_id]) {
        msgGroups[m.sender_id] = {
          count: 0,
          name: m.author_name || "Пилот",
          lastAt: m.created_at,
          lastContent: m.content,
        };
      }
      msgGroups[m.sender_id].count++;
      if (m.created_at > msgGroups[m.sender_id].lastAt) {
        msgGroups[m.sender_id].lastAt = m.created_at;
        msgGroups[m.sender_id].lastContent = m.content;
      }
    });

    Object.entries(msgGroups).forEach(([senderId, g]) => {
      list.push({
        id: `msg-${senderId}`,
        type: "message",
        title: g.name,
        subtitle: `${g.count} новых · ${g.lastContent.slice(0, 40)}${g.lastContent.length > 40 ? "…" : ""}`,
        href: "/account/messages",
        createdAt: g.lastAt,
        senderId,
        isRead: false,
      });
    });

    // 2. Уведомления форума (подписанные темы)
    const { data: forumNotifs } = await supabase
      .from("forum_notifications")
      .select("id, thread_id, post_id, title, body, is_read, created_at")
      .eq("user_id", user.id)
      .eq("is_read", false)
      .order("created_at", { ascending: false })
      .limit(20);

    (forumNotifs ?? []).forEach((n: any) => {
      list.push({
        id: n.id,
        type: "forum_reply",
        title: n.title,
        subtitle: n.body?.slice(0, 60) + (n.body?.length > 60 ? "…" : ""),
        href: `/forum/thread/${n.thread_id}#post-${n.post_id}`,
        createdAt: n.created_at,
        isRead: n.is_read,
      });
    });

    // 3. Новые статьи
    const lastRead = typeof window !== "undefined" ? localStorage.getItem("lastReadNewsAt") : null;
    const { data: news } = await supabase
      .from("news")
      .select("id, title, published_at")
      .order("published_at", { ascending: false })
      .limit(5);

    const unreadNews = (news ?? []).filter((n: any) => {
      if (!lastRead) return true;
      return new Date(n.published_at) > new Date(lastRead);
    });

    unreadNews.forEach((n: any) => {
      list.push({
        id: `news-${n.id}`,
        type: "news",
        title: "Новая статья",
        subtitle: n.title,
        href: "/news",
        createdAt: n.published_at,
        isRead: false,
      });
    });

    // 4. Универсальные уведомления (проекты, эскадрильи, маршрут)
    const { data: userNotifs } = await supabase
      .from("user_notifications")
      .select("id, type, title, body, href, metadata, is_read, created_at")
      .eq("user_id", user.id)
      .eq("is_read", false)
      .order("created_at", { ascending: false })
      .limit(30);

    (userNotifs ?? []).forEach((n: any) => {
      list.push({
        id: n.id,
        dbId: n.id,
        type: n.type,
        title: n.title,
        subtitle: n.body?.slice(0, 80) + (n.body?.length > 80 ? "…" : ""),
        href: n.href || "/",
        createdAt: n.created_at,
        isRead: n.is_read,
      });
    });

    // Сортируем по времени
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    setNotifications(list);
    setTotalUnread(list.filter((n) => !n.isRead).length);
  }, [user]);

  useEffect(() => {
    loadNotifications();
    const t = setInterval(loadNotifications, 15000);
    const channel = supabase
      .channel("notifications")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages" },
        () => loadNotifications()
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "forum_notifications", filter: `user_id=eq.${user?.id}` },
        () => loadNotifications()
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "user_notifications", filter: `user_id=eq.${user?.id}` },
        (payload) => {
          loadNotifications();
          // Показать браузерное уведомление если вкладка не активна
          if (document.hidden && "Notification" in window && Notification.permission === "granted") {
            const n = payload.new as any;
            new Notification(n.title, {
              body: n.body || "",
              icon: "/icon-192.png",
              tag: n.type,
            });
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "friends", filter: `addressee_id=eq.${user?.id}` },
        () => loadNotifications()
      )
      .subscribe();
    return () => {
      clearInterval(t);
      supabase.removeChannel(channel);
    };
  }, [loadNotifications, user?.id]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const handleClick = async (n: Notification) => {
    setOpen(false);

    // Mark forum notification as read
    if (n.type === "forum_reply" && n.id && !n.id.startsWith("msg-") && !n.id.startsWith("news-")) {
      await supabase
        .from("forum_notifications")
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq("id", n.id)
        .eq("user_id", user.id);
    }

    // Mark user_notification as read
    if (n.dbId) {
      await supabase
        .from("user_notifications")
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq("id", n.dbId)
        .eq("user_id", user.id);
    }

    if (n.type === "news") {
      localStorage.setItem("lastReadNewsAt", new Date().toISOString());
    }
    router.push(n.href);
    loadNotifications();
  };

  const markAllRead = async () => {
    if (!user) return;

    // Mark messages read
    await supabase
      .from("messages")
      .update({ read_at: new Date().toISOString() })
      .eq("recipient_id", user.id)
      .is("read_at", null);

    // Mark forum notifications read
    await supabase
      .from("forum_notifications")
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .eq("is_read", false);

    // Mark user notifications read
    await supabase
      .from("user_notifications")
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .eq("is_read", false);

    localStorage.setItem("lastReadNewsAt", new Date().toISOString());
    loadNotifications();
  };

  // === Web Push Subscription ===
  const subscribePush = async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      alert("Push-уведомления не поддерживаются этим браузером");
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      alert("Разрешение на уведомления не получено");
      return;
    }

    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(
          process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!
        ),
      });

      const { endpoint } = sub;
      const key = sub.getKey("p256dh");
      const auth = sub.getKey("auth");

      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint,
          p256dh: key ? btoa(String.fromCharCode(...new Uint8Array(key))) : "",
          auth: auth ? btoa(String.fromCharCode(...new Uint8Array(auth))) : "",
        }),
      });

      setPushEnabled(true);
    } catch (err) {
      console.error("Push subscription failed:", err);
      alert("Не удалось подписаться на push-уведомления");
    }
  };

  const unsubscribePush = async () => {
    if (!("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await sub.unsubscribe();
      await fetch("/api/push/subscribe", { method: "DELETE" });
    }
    setPushEnabled(false);
  };

  const dotColor = (type: string) => {
    switch (type) {
      case "news": return "#3b82f6";
      case "message": return "#e67e22";
      case "forum_reply": return "#8b5cf6";
      case "forum_mention": return "#ec4899";
      case "squadron_chat_mention": return "#e67e22";
      case "project_invite": return "#3b82f6";
      case "squadron_invite": return "#8b5cf6";
      case "project_update": return "#e67e22";
      case "project_system_status": return "#22c55e";
      case "route_status_change": return "#06b6d4";
      case "route_progress": return "#10b981";
      case "friend_request": return "#e67e22";
      default: return "#9ca3af";
    }
  };

  const typeLabel = (type: string) => {
    switch (type) {
      case "project_invite": return "📁 Проект";
      case "squadron_invite": return "🛡️ Эскадрилья";
      case "project_update": return "📁 Проект";
      case "project_system_status": return "🌌 Система";
      case "route_status_change": return "🌌 Маршрут";
      case "route_progress": return "🌌 Прогресс";
      case "message": return "💬 Сообщение";
      case "forum_reply": return "💬 Форум";
      case "squadron_chat_mention": return "💬 Эскадрилья";
      case "news": return "📰 Новости";
      case "friend_request": return "👥 Друзья";
      default: return "";
    }
  };

  return (
    <div ref={boxRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Уведомления"
        aria-expanded={open}
        style={{
          background: "transparent",
          border: "none",
          color: "#9ca3af",
          cursor: "pointer",
          padding: 6,
          display: "flex",
          alignItems: "center",
          position: "relative",
          borderRadius: 6,
          transition: "color 0.2s, background 0.2s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "#e67e22";
          e.currentTarget.style.background = "rgba(255,157,46,0.08)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "#9ca3af";
          e.currentTarget.style.background = "transparent";
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {totalUnread > 0 && (
          <span style={{
            position: "absolute",
            top: 0,
            right: 0,
            background: "#e74c3c",
            color: "#fff",
            fontSize: 10,
            fontWeight: 700,
            minWidth: 16,
            height: 16,
            borderRadius: 8,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 4px",
            transform: "translate(25%, -25%)",
          }}>
            {totalUnread > 99 ? "99+" : totalUnread}
          </span>
        )}
      </button>

      {open && (
        <div style={{
          position: "absolute",
          top: "calc(100% + 8px)",
          right: 0,
          width: 360,
          maxHeight: 520,
          overflowY: "auto",
          background: "#25282b",
          border: "1px solid #323538",
          borderRadius: 10,
          boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
          zIndex: 200,
          display: "flex",
          flexDirection: "column",
        }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 14px",
            borderBottom: "1px solid #323538",
            fontSize: 13,
            fontWeight: 600,
            color: "#eeeeee",
          }}>
            <span>Уведомления</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {totalUnread > 0 && (
                <button
                  onClick={markAllRead}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#e67e22",
                    fontSize: 11,
                    cursor: "pointer",
                    padding: "2px 6px",
                    borderRadius: 4,
                  }}
                >
                  Прочитать всё
                </button>
              )}
            </div>
          </div>

          {/* Push toggle */}
          {user && (
            <div style={{
              padding: "8px 14px",
              borderBottom: "1px solid #323538",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}>
              <span style={{ fontSize: 11, color: "#9ca3af" }}>
                📱 Push на телефон
              </span>
              {pushEnabled ? (
                <button
                  onClick={unsubscribePush}
                  style={{
                    fontSize: 11,
                    padding: "3px 8px",
                    background: "rgba(239,68,68,0.1)",
                    border: "1px solid rgba(239,68,68,0.3)",
                    color: "#e74c3c",
                    borderRadius: 4,
                    cursor: "pointer",
                  }}
                >
                  Отключить
                </button>
              ) : (
                <button
                  onClick={subscribePush}
                  style={{
                    fontSize: 11,
                    padding: "3px 8px",
                    background: "rgba(34,197,94,0.1)",
                    border: "1px solid rgba(34,197,94,0.3)",
                    color: "#22c55e",
                    borderRadius: 4,
                    cursor: "pointer",
                  }}
                >
                  Включить
                </button>
              )}
            </div>
          )}

          {notifications.length === 0 && (
            <div style={{ padding: 24, textAlign: "center", color: "#9ca3af", fontSize: 13 }}>
              Нет новых уведомлений
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column" }}>
            {notifications.map((n) => (
              <button
                key={n.id}
                onClick={() => handleClick(n)}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "10px 14px",
                  border: "none",
                  background: n.isRead ? "transparent" : "rgba(139,92,246,0.06)",
                  textAlign: "left",
                  cursor: "pointer",
                  width: "100%",
                  borderBottom: "1px solid #25282b",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "#323538"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = n.isRead ? "transparent" : "rgba(139,92,246,0.06)"; }}
              >
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: dotColor(n.type),
                  marginTop: 5,
                  flexShrink: 0,
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 10, color: "#9ca3af", textTransform: "uppercase", letterSpacing: 0.5 }}>
                      {typeLabel(n.type)}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#eeeeee", marginTop: 1 }}>
                    {n.title}
                  </div>
                  {n.subtitle && (
                    <div style={{
                      fontSize: 11,
                      color: "#9ca3af",
                      marginTop: 2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>
                      {n.subtitle}
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 3 }}>
                    {new Date(n.createdAt).toLocaleString("ru-RU", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
