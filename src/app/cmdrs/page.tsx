"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import PilotIdentity from "@/components/Cosmetics/PilotIdentity";
import { supabase } from "@/lib/supabaseClient";
import { useFriends } from "@/hooks/useFriends";
import { IconSearch, IconCheck, IconError } from "@/components/Icons";
import { useI18n } from '@/lib/i18n/I18nContext';

export default function CmdrsPage() {
  const { t, locale } = useI18n();
  const [user, setUser] = useState<any>(null);
  const [search, setSearch] = useState("");
  const [allCmdrs, setAllCmdrs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [optimisticIds, setOptimisticIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);
  const { sendRequest, isFriend, hasPending, refresh } = useFriends(user?.id || null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user));
    loadAllCmdrs();
  }, []);

  const loadAllCmdrs = async () => {
    setLoading(true);
    // Публичный список пилотов — из представления без приватных колонок.
    const { data } = await supabase
      .from("public_profiles")
      .select("id, cmdr_name, avatar_url, created_at")
      .order("cmdr_name")
      .limit(500);
    setAllCmdrs(data || []);
    setLoading(false);
  };

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return allCmdrs;
    return allCmdrs.filter((c) =>
      (c.cmdr_name || "").toLowerCase().includes(term)
    );
  }, [allCmdrs, search]);

  const handleSend = async (cmdrId: string, cmdrName: string) => {
    if (sendingId) return;
    setSendingId(cmdrId);
    const { ok, status } = await sendRequest(cmdrId);
    setSendingId(null);
    if (ok) {
      setOptimisticIds((prev) => new Set(prev).add(cmdrId));
      setToast({ msg: t('cmdr.requestSent', { name: cmdrName }), type: "ok" });
    } else if (status === 409) {
      setToast({ msg: t('cmdr.alreadyFriends'), type: "ok" });
      refresh();
    } else {
      setToast({ msg: t('cmdr.requestFailed'), type: "err" });
    }
    setTimeout(() => setToast(null), 3000);
  };

  const showPending = (cmdrId: string) =>
    hasPending(cmdrId) || optimisticIds.has(cmdrId);

  return (
    <main className="card" style={{ width: "100%" }}>
      <div className="kicker">{t('cmdr.kicker')}</div>
      <h1 style={{ marginTop: 8 }}>{t('cmdr.title')}</h1>
      <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 4 }}>
        {t('cmdr.total', { count: allCmdrs.length })}
      </p>

      {/* Toast */}
      {toast && (
        <div style={{
          position: "fixed", top: 20, right: 20, zIndex: 9999,
          padding: "12px 18px", borderRadius: 6, fontSize: 13, fontWeight: 500,
          background: toast.type === "ok" ? "rgba(34,197,94,0.15)" : "rgba(231,76,60,0.15)",
          border: `1px solid ${toast.type === "ok" ? "#22c55e" : "#e74c3c"}`,
          color: toast.type === "ok" ? "#22c55e" : "#e74c3c",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          {toast.type === "ok" ? <IconCheck size={14} /> : <IconError size={14} />}
          {toast.msg}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, margin: "20px 0", maxWidth: 500 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('cmdr.filterPlaceholder')}
          style={{ flex: 1 }}
        />
        <button className="btn btn-cyan" style={{ opacity: 0.6, cursor: "default" }}>
          <IconSearch size={16} />
        </button>
      </div>

      {loading && (
        <p style={{ color: "var(--muted)", textAlign: "center", padding: 40 }}>{t('cmdr.loading')}</p>
      )}

      {!loading && filtered.length === 0 && (
        <p style={{ color: "var(--muted)" }}>{t('cmdr.noneFound')}</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {filtered.map((cmdr) => {
          const friend = isFriend(cmdr.id);
          const pending = showPending(cmdr.id);
          const isSelf = cmdr.id === user?.id;
          const isSending = sendingId === cmdr.id;
          return (
            <div key={cmdr.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, background: "#1a1c1e", borderRadius: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <PilotIdentity
                  userId={cmdr.id}
                  cmdrName={cmdr.cmdr_name || "Unknown"}
                  avatarUrl={cmdr.avatar_url}
                  size={40}
                  fontSize={14}
                  showTitle
                  subtitle={t('cmdr.withUsSince', { date: new Date(cmdr.created_at).toLocaleDateString(locale) })}
                />
              </div>
              {isSelf ? (
                <span style={{ color: "#e67e22", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>{t('cmdr.you')}</span>
              ) : friend ? (
                <span style={{ color: "#22c55e", fontSize: 12, fontFamily: "ui-monospace, monospace", display: "flex", alignItems: "center", gap: 4 }}>
                  <IconCheck size={12} /> {t('cmdr.friend')}
                </span>
              ) : pending ? (
                <span style={{ color: "#9ca3af", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>{t('cmdr.requestPending')}</span>
              ) : user ? (
                <button
                  onClick={() => handleSend(cmdr.id, cmdr.cmdr_name || "")}
                  disabled={isSending}
                  className="btn btn-cyan"
                  style={{ fontSize: 12, padding: "6px 14px", opacity: isSending ? 0.6 : 1 }}
                >
                  {isSending ? t('cmdr.sending') : t('cmdr.addFriend')}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </main>
  );
}
