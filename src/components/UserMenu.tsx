"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { avatarFromUser, nickFromUser } from "@/lib/authProfile";

type Profile = {
  cmdr_name?: string | null;
  avatar_url?: string | null;
  role?: string | null;
};

export default function UserMenu() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [open, setOpen] = useState(false);
  const [msgCount, setMsgCount] = useState(0);
  const [friendRequestCount, setFriendRequestCount] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    const { data } = await supabase.auth.getUser();
    const u = data.user;
    setUser(u);
    if (!u) {
      setProfile(null);
      setReady(true);
      return;
    }
    const { data: p } = await supabase
      .from("profiles")
      .select("cmdr_name, avatar_url, role")
      .eq("id", u.id)
      .maybeSingle();
    setProfile(p);
    setReady(true);
  };

  const loadUnread = useCallback(async () => {
    if (!user) { setMsgCount(0); return; }
    try {
      const res = await fetch("/api/friends?status=accepted", { credentials: "include" });
      if (!res.ok) return;
      // Use supabase direct for messages (messages RLS is simpler)
      const { count } = await supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("recipient_id", user.id)
        .is("read_at", null);
      setMsgCount(count ?? 0);
    } catch { setMsgCount(0); }
  }, [user]);

  const loadFriendRequests = useCallback(async () => {
    if (!user) { setFriendRequestCount(0); return; }
    try {
      const res = await fetch("/api/friends?status=pending", { credentials: "include" });
      if (!res.ok) { setFriendRequestCount(0); return; }
      const json = await res.json();
      const allPending = json.friends || [];
      const incoming = allPending.filter((f: any) => f.addressee_id === user.id);
      setFriendRequestCount(incoming.length);
    } catch { setFriendRequestCount(0); }
  }, [user]);

  useEffect(() => {
    load();
    const { data: sub } = supabase.auth.onAuthStateChange(() => load());
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    loadUnread();
    const t = setInterval(loadUnread, 20000);
    const channel = supabase
      .channel("menu-unread")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => loadUnread())
      .subscribe();
    return () => { clearInterval(t); supabase.removeChannel(channel); };
  }, [loadUnread]);

  useEffect(() => {
    loadFriendRequests();
    const t2 = setInterval(loadFriendRequests, 30000);
    const channel2 = supabase
      .channel("menu-friends")
      .on("postgres_changes", { event: "*", schema: "public", table: "friends" }, () => loadFriendRequests())
      .subscribe();
    return () => { clearInterval(t2); supabase.removeChannel(channel2); };
  }, [loadFriendRequests]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  if (!ready) {
    return <span className="btn-login" style={{ opacity: 0.4, minWidth: 88 }} />;
  }

  if (!user) {
    return (
      <Link href="/login" className="btn btn-orange btn-login">Login</Link>
    );
  }

  const nick = nickFromUser(user, profile);
  const avatar = avatarFromUser(user, profile);
  const staff = ["admin", "moderator"].includes(profile?.role ?? "");
  const statsHref = profile?.cmdr_name ? "/cmdr/" + encodeURIComponent(profile.cmdr_name) : "/account";

  const logout = async () => {
    setOpen(false);
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  };

  return (
    <div className="user-menu" ref={boxRef}>
      <button type="button" className="user-menu-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {avatar ? <img src={avatar} alt="" className="avatar-sm" /> : <span className="avatar-sm" style={{ background: "#3a3d40", display: "inline-block" }} />}
        <span className="user-menu-nick">{nick}</span>
      </button>
      {open && (
        <div className="user-menu-drop">
          <Link href="/account" className="user-menu-item" onClick={() => setOpen(false)}>Профиль</Link>
          <Link href="/account/friends" className="user-menu-item" onClick={() => setOpen(false)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>Друзья</span>
            {friendRequestCount > 0 && (
              <span style={{ background: "#e67e22", color: "#fff", fontSize: 11, fontWeight: 700, minWidth: 18, height: 18, borderRadius: 9, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 5px" }}>
                {friendRequestCount > 99 ? "99+" : friendRequestCount}
              </span>
            )}
          </Link>
          <Link href="/account/messages" className="user-menu-item" onClick={() => setOpen(false)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>Сообщения</span>
            {msgCount > 0 && (
              <span style={{ background: "#e74c3c", color: "#fff", fontSize: 11, fontWeight: 700, minWidth: 18, height: 18, borderRadius: 9, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 5px" }}>
                {msgCount > 99 ? "99+" : msgCount}
              </span>
            )}
          </Link>
          <Link href={statsHref} className="user-menu-item" onClick={() => setOpen(false)}>Моя статистика</Link>
          {staff && <Link href="/admin" className="user-menu-item" onClick={() => setOpen(false)}>Админ-панель</Link>}
          <button type="button" className="user-menu-item" onClick={logout}>Выход из профиля</button>
        </div>
      )}
    </div>
  );
}
