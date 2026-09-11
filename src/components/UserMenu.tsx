"use client";
import { IconHeadphones } from "@/components/Icons";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authFetch, createSupabaseClient, getCurrentUser } from "@/lib/supabaseClient";
import { avatarFromUser, nickFromUser } from "@/lib/authProfile";
import { useI18n } from "@/lib/i18n/I18nContext";

type Profile = {
  cmdr_name?: string | null;
  avatar_url?: string | null;
  role?: string | null;
};


export default function UserMenu() {
  const router = useRouter();
  const { t } = useI18n();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [open, setOpen] = useState(false);
  const [msgCount, setMsgCount] = useState(0);
  const [friendRequestCount, setFriendRequestCount] = useState(0);
  const [mySquadron, setMySquadron] = useState<{ id: number; name: string; tag?: string | null } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const supabaseRef = useRef<ReturnType<typeof createSupabaseClient> | null>(null);

  const load = useCallback(async () => {
    try {
      const u = await getCurrentUser();
      setUser(u);

      if (!u) {
        setProfile(null);
        setMySquadron(null);
        return;
      }

      if (!supabaseRef.current) {
        supabaseRef.current = createSupabaseClient();
      }

      const { data: profileData } = await supabaseRef.current
        .from("profiles")
        .select("cmdr_name, avatar_url, role")
        .eq("id", u.id)
        .maybeSingle();
      setProfile(profileData);

      // Load the same compatibility endpoint as the account page. The profile
      // menu previously had no squadron entry at all, and querying the old
      // read-model directly made the membership look absent on older schemas.
      try {
        const squadronResponse = await authFetch("/api/squadrons/my", { cache: "no-store" });
        const squadronData = await squadronResponse.json().catch(() => ({}));
        const squadron = squadronResponse.ok ? squadronData.squadron : null;
        setMySquadron(squadron?.id ? {
          id: Number(squadron.id),
          name: String(squadron.name || "Эскадрилья"),
          tag: squadron.tag ?? null,
        } : null);
      } catch {
        setMySquadron(null);
      }
    } catch (loadError) {
      console.error("[UserMenu] Could not load session:", loadError);
      setUser(null);
      setProfile(null);
    } finally {
      setReady(true);
    }
  }, []);

  const loadUnread = useCallback(async () => {
    if (!user || !supabaseRef.current) { setMsgCount(0); return; }
    try {
      const res = await authFetch("/api/friends?status=accepted");
      if (!res.ok) { setMsgCount(0); return; }
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
      const res = await authFetch("/api/friends?status=pending");
      if (!res.ok) { setFriendRequestCount(0); return; }
      const json = await res.json();
      const allPending = json.friends || [];
      const incoming = allPending.filter((f: any) => f.addressee_id === user.id);
      setFriendRequestCount(incoming.length);
    } catch { setFriendRequestCount(0); }
  }, [user]);

  useEffect(() => {
    void load();
    const { data: { subscription } } = createSupabaseClient().auth.onAuthStateChange(() => {
      // Avoid re-entering Supabase auth while it is notifying subscribers.
      window.setTimeout(() => void load(), 0);
    });

    return () => subscription.unsubscribe();
  }, [load]);

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
  const staff = ["admin", "moderator", "support_manager"].includes(profile?.role ?? "");
  const statsHref = profile?.cmdr_name ? "/cmdr/" + encodeURIComponent(profile.cmdr_name) : "/account";

  const logout = async () => {
    setOpen(false);
    await createSupabaseClient().auth.signOut();
    setUser(null);
    setProfile(null);
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
          {mySquadron && (
            <Link href={`/squadrons/${mySquadron.id}`} className="user-menu-item" onClick={() => setOpen(false)}>
              <span>{mySquadron.tag ? `[${mySquadron.tag}] ` : ""}{mySquadron.name}</span>
            </Link>
          )}
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
          <Link href="/support" className="user-menu-item" onClick={() => setOpen(false)}><IconHeadphones size={14} /> {t('support.title') || 'Техподдержка'}</Link>
          {staff && <Link href="/admin" className="user-menu-item" onClick={() => setOpen(false)}>{t('account.admin') || 'Админ-панель'}</Link>}
          <button type="button" className="user-menu-item" onClick={logout}>{t('account.logout')}</button>
        </div>
      )}
    </div>
  );
}
