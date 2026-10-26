"use client";
import {
  IconChevronDown,
  IconCoins,
  IconDownload,
  IconGear,
  IconHeadphones,
  IconNote,
  IconPlane,
  IconProfile,
  IconUsers,
} from "@/components/Icons";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authFetch, createSupabaseClient, getCurrentUser } from "@/lib/supabaseClient";
import { avatarFromUser, nickFromUser } from "@/lib/authProfile";
import { useI18n } from "@/lib/i18n/I18nContext";
import CosmeticAvatar from "@/components/Cosmetics/CosmeticAvatar";
import Avatar from "@/components/Avatar";
import CosmeticCallsign from "@/components/Cosmetics/CosmeticCallsign";
import { useCosmeticsFor } from "@/components/Cosmetics/useCosmetics";
import { IconStore } from "@/components/Icons";

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
  const dropRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cosmetics = useCosmeticsFor(user?.id || null);
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

  // Меню ведёт себя как настоящее выпадающее: фокус уходит на первый пункт,
  // стрелки перемещают по пунктам, Escape возвращает фокус на кнопку.
  useEffect(() => {
    if (!open) return;
    const first = dropRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = Array.from(dropRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || []);
      if (items.length === 0) return;
      event.preventDefault();
      const currentIndex = items.findIndex((item) => item === document.activeElement);
      let nextIndex = 0;
      if (event.key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
      if (event.key === "ArrowUp") nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
      if (event.key === "End") nextIndex = items.length - 1;
      items[nextIndex]?.focus();
    };
    const node = dropRef.current;
    node?.addEventListener("keydown", onKeyDown);
    return () => node?.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  const roleLabel = useMemo(() => {
    const role = profile?.role || "";
    if (role === "admin") return t("account.admin") || "Админ-панель";
    if (role === "moderator") return "Модератор";
    if (role === "support_manager") return t("support.title") || "Техподдержка";
    return profile?.cmdr_name ? "Командир" : t("account.profile") || "Профиль";
  }, [profile?.cmdr_name, profile?.role, t]);

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
      <button
        type="button"
        ref={triggerRef}
        className={`user-menu-btn${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {cosmetics?.frame ? (
          <CosmeticAvatar avatarUrl={avatar} cmdrName={nick} frameId={cosmetics.frame.id} framePreview={cosmetics.frame.preview} size={30} />
        ) : (
          <Avatar url={avatar} name={nick} size={30} className="avatar-sm" />
        )}
        <span className="user-menu-nick">
          {cosmetics?.glow || cosmetics?.tier ? (
            <CosmeticCallsign name={nick} glowId={cosmetics.glow?.id} glowPreview={cosmetics.glow?.preview} tier={cosmetics.tier?.label || null} tierColor={cosmetics.tier?.color || null} fontSize={13} monospace={false} />
          ) : nick}
        </span>
        <IconChevronDown size={12} className="user-menu-chevron" />
      </button>
      {open && (
        <div className="user-menu-drop" role="menu" ref={dropRef} aria-label={t('account.title') || 'Личный кабинет'}>
          <div className="user-menu-head">
            <div className="user-menu-head-avatar">
              {cosmetics?.frame ? (
                <CosmeticAvatar avatarUrl={avatar} cmdrName={nick} frameId={cosmetics.frame.id} framePreview={cosmetics.frame.preview} size={44} />
              ) : (
                <Avatar url={avatar} name={nick} size={44} />
              )}
            </div>
            <div className="user-menu-head-meta">
              <span className="user-menu-head-name">{nick}</span>
              <span className="user-menu-head-role">{roleLabel}</span>
              {mySquadron && (
                <Link href={`/squadrons/${mySquadron.id}`} className="user-menu-head-squadron" onClick={close} role="menuitem">
                  <IconPlane size={11} />
                  {mySquadron.tag ? `[${mySquadron.tag}] ` : ""}{mySquadron.name}
                </Link>
              )}
            </div>
          </div>

          <div className="user-menu-body">
            <div className="user-menu-section" role="group" aria-label={t('account.group.profile')}>
              <div className="user-menu-section-title">{t('account.group.profile')}</div>
              <Link href="/account" className="user-menu-item" onClick={close} role="menuitem">
                <IconProfile size={15} />
                <span className="user-menu-item-label">{t('account.profile')}</span>
              </Link>
              <Link href={statsHref} className="user-menu-item" onClick={close} role="menuitem">
                <IconUsers size={15} />
                <span className="user-menu-item-label">{t('account.myStats')}</span>
              </Link>
              <Link href="/account?tab=builds" className="user-menu-item" onClick={close} role="menuitem">
                <IconWrench size={15} />
                <span className="user-menu-item-label">{t('account.myBuilds')}</span>
              </Link>
              {/* Сообщения и друзья — один пункт: переписка возможна только с
                  друзьями, и держать для неё отдельную страницу незачем.
                  Счётчики остаются раздельными: оранжевый — заявки в друзья,
                  красный — непрочитанные сообщения. */}
              <Link href="/account/friends" className="user-menu-item" onClick={close} role="menuitem">
                <IconNote size={15} />
                <span className="user-menu-item-label">{t('account.messagesAndFriends')}</span>
                <span className="user-menu-badges">
                  {friendRequestCount > 0 && (
                    <span
                      className="user-menu-badge requests"
                      title={t('account.friends') || 'Друзья'}
                    >
                      {friendRequestCount > 99 ? "99+" : friendRequestCount}
                    </span>
                  )}
                  {msgCount > 0 && (
                    <span
                      className="user-menu-badge messages"
                      title={t('account.messages') || 'Сообщения'}
                    >
                      {msgCount > 99 ? "99+" : msgCount}
                    </span>
                  )}
                </span>
              </Link>
            </div>

            <div className="user-menu-section" role="group" aria-label={t('account.group.services')}>
              <div className="user-menu-section-title">{t('account.group.services')}</div>
              <Link href="/premium-shop" className="user-menu-item" onClick={close} role="menuitem">
                <IconStore size={15} />
                <span className="user-menu-item-label">{t('account.shop')}</span>
              </Link>
              <a href="/api/uploader/launcher/win64" download className="user-menu-item" onClick={close} role="menuitem">
                <IconDownload size={15} />
                <span className="user-menu-item-label">{t('account.downloadColonialHelper')}</span>
              </a>
              <Link href="/support" className="user-menu-item" onClick={close} role="menuitem">
                <IconHeadphones size={15} />
                <span className="user-menu-item-label">{t('support.title')}</span>
              </Link>
            </div>

            {staff && (
              <div className="user-menu-section" role="group" aria-label={t('account.group.staff')}>
                <div className="user-menu-section-title">{t('account.group.staff')}</div>
                <Link href="/admin" className="user-menu-item" onClick={close} role="menuitem">
                  <IconGear size={15} />
                  <span className="user-menu-item-label">{t('account.admin')}</span>
                </Link>
                {profile?.role === "admin" && (
                  <Link href="/admin?tab=billing" className="user-menu-item" onClick={close} role="menuitem">
                    <IconCoins size={15} color="#e67e22" />
                    <span className="user-menu-item-label">{t('account.billing')}</span>
                  </Link>
                )}
              </div>
            )}

            <div className="user-menu-section user-menu-section-plain">
              <button type="button" className="user-menu-item danger" onClick={logout} role="menuitem">
                <IconExit />
                <span className="user-menu-item-label">{t('account.logout')}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function IconWrench({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M14.7 6.3a4 4 0 1 0 5 5L21 21H3l1.3-9.7a4 4 0 0 1 5-5z" />
    </svg>
  );
}

function IconExit({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}
