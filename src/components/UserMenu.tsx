"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createSupabaseClient } from "@/lib/supabaseClient";
import { avatarFromUser, nickFromUser } from "@/lib/authProfile";
import { useI18n } from "@/lib/i18n/I18nContext";

type Profile = {
  cmdr_name?: string | null;
  avatar_url?: string | null;
  role?: string | null;
};

function getCookie(name: string) {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}

const LS_KEY = 'sb-sgukfplhxdhmkqponwft-auth-token';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://sgukfplhxdhmkqponwft.supabase.co';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

function decodeJwt(token: string): any {
  try {
    const base64 = token.split('.')[1];
    const json = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function restoreSession(): Promise<any | null> {
  // 1. OAuth callback cookie (one-time)
  const sessionCookie = getCookie('sb-session');
  if (sessionCookie) {
    try {
      const session = JSON.parse(sessionCookie);
      const user = decodeJwt(session.access_token);
      localStorage.setItem(LS_KEY, JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        expires_in: 3600,
        token_type: 'bearer',
        user: user,
      }));
      document.cookie = 'sb-session=; path=/; max-age=0; SameSite=Lax; Secure';
    } catch {
      /* ignore */
    }
  }

  // 2. Check localStorage and verify token via direct fetch
  const lsToken = localStorage.getItem(LS_KEY);
  if (!lsToken) return null;

  let session: any;
  try {
    session = JSON.parse(lsToken);
  } catch {
    return null;
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': ANON_KEY,
      },
    });
    if (res.ok) {
      return await res.json();
    }
  } catch {
    /* ignore */
  }

  return null;
}

export default function UserMenu() {
  const router = useRouter();
  const { t } = useI18n();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [open, setOpen] = useState(false);
  const [msgCount, setMsgCount] = useState(0);
  const [friendRequestCount, setFriendRequestCount] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const supabaseRef = useRef<ReturnType<typeof createSupabaseClient> | null>(null);

  const load = async () => {
    console.log('[UserMenu] load() start');
    const u = await restoreSession();
    console.log('[UserMenu] restoreSession returned:', u ? u.id : 'null');
    setUser(u);
    if (!u) {
      setProfile(null);
      setReady(true);
      return;
    }
    
    // Create client for DB queries
    if (!supabaseRef.current) {
      supabaseRef.current = createSupabaseClient();
    }
    const { data: p } = await supabaseRef.current
      .from("profiles")
      .select("cmdr_name, avatar_url, role")
      .eq("id", u.id)
      .maybeSingle();
    setProfile(p);
    setReady(true);
  };

  const loadUnread = useCallback(async () => {
    if (!user || !supabaseRef.current) { setMsgCount(0); return; }
    try {
      const res = await fetch("/api/friends?status=accepted", { credentials: "include" });
      if (!res.ok) return;
      const { count } = await supabaseRef.current
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("recipient_id", user.id)
        .is("read_at", null);
      setMsgCount(count ?? 0);
    } catch { setMsgCount(0); }
  }, [user]);

  const loadFriendRequests = useCallback(async () => {
    if (!user || !supabaseRef.current) { setFriendRequestCount(0); return; }
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
  }, []);

  useEffect(() => {
    loadUnread();
    const t = setInterval(loadUnread, 20000);
    return () => clearInterval(t);
  }, [loadUnread]);

  useEffect(() => {
    loadFriendRequests();
    const t2 = setInterval(loadFriendRequests, 30000);
    return () => clearInterval(t2);
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
      <Link href="/login" className="btn btn-orange btn-login">{t('account.login')}</Link>
    );
  }

  const nick = nickFromUser(user, profile);
  const avatar = avatarFromUser(user, profile);
  const staff = ["admin", "moderator"].includes(profile?.role ?? "");
  const statsHref = profile?.cmdr_name ? "/cmdr/" + encodeURIComponent(profile.cmdr_name) : "/account";

  const logout = async () => {
    setOpen(false);
    if (supabaseRef.current) {
      await supabaseRef.current.auth.signOut();
    }
    localStorage.removeItem(LS_KEY);
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
          <Link href="/account" className="user-menu-item" onClick={() => setOpen(false)}>{t('account.profile')}</Link>
          <Link href="/account/friends" className="user-menu-item" onClick={() => setOpen(false)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>{t('account.friends') || 'Друзья'}</span>
            {friendRequestCount > 0 && (
              <span style={{ background: "#e67e22", color: "#fff", fontSize: 11, fontWeight: 700, minWidth: 18, height: 18, borderRadius: 9, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 5px" }}>
                {friendRequestCount > 99 ? "99+" : friendRequestCount}
              </span>
            )}
          </Link>
          <Link href="/account/messages" className="user-menu-item" onClick={() => setOpen(false)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>{t('account.messages') || 'Сообщения'}</span>
            {msgCount > 0 && (
              <span style={{ background: "#e74c3c", color: "#fff", fontSize: 11, fontWeight: 700, minWidth: 18, height: 18, borderRadius: 9, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 5px" }}>
                {msgCount > 99 ? "99+" : msgCount}
              </span>
            )}
          </Link>
          <Link href={statsHref} className="user-menu-item" onClick={() => setOpen(false)}>{t('account.myStats') || 'Моя статистика'}</Link>
          {staff && <Link href="/admin" className="user-menu-item" onClick={() => setOpen(false)}>{t('account.admin') || 'Админ-панель'}</Link>}
          <button type="button" className="user-menu-item" onClick={logout}>{t('account.logout')}</button>
        </div>
      )}
    </div>
  );
}
