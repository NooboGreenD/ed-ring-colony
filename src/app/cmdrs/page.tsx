"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { useFriends } from "@/hooks/useFriends";
import { IconSearch, IconCheck, IconError } from "@/components/Icons";

export default function CmdrsPage() {
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
    const { data } = await supabase
      .from("profiles")
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
      setToast({ msg: `Запрос в друзья отправлен ${cmdrName}`, type: "ok" });
    } else if (status === 409) {
      setToast({ msg: "Вы уже друзья с этим пилотом", type: "ok" });
      refresh();
    } else {
      setToast({ msg: "Не удалось отправить запрос", type: "err" });
    }
    setTimeout(() => setToast(null), 3000);
  };

  const showPending = (cmdrId: string) =>
    hasPending(cmdrId) || optimisticIds.has(cmdrId);

  return (
    <main className="card" style={{ width: "100%" }}>
      <div className="kicker">Реестр пилотов</div>
      <h1 style={{ marginTop: 8 }}>Командиры</h1>
      <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 4 }}>
        Всего в реестре: {allCmdrs.length} пилотов
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
          placeholder="Фильтр по имени CMDR..."
          style={{ flex: 1 }}
        />
        <button className="btn btn-cyan" style={{ opacity: 0.6, cursor: "default" }}>
          <IconSearch size={16} />
        </button>
      </div>

      {loading && (
        <p style={{ color: "var(--muted)", textAlign: "center", padding: 40 }}>Загрузка реестра...</p>
      )}

      {!loading && filtered.length === 0 && (
        <p style={{ color: "var(--muted)" }}>Пилотов не найдено.</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {filtered.map((cmdr) => {
          const friend = isFriend(cmdr.id);
          const pending = showPending(cmdr.id);
          const isSelf = cmdr.id === user?.id;
          const isSending = sendingId === cmdr.id;
          return (
            <div key={cmdr.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, background: "#1a1c1e", borderRadius: 6 }}>
              {cmdr.avatar_url ? (
                <img src={cmdr.avatar_url} style={{ width: 40, height: 40, borderRadius: "50%" }} alt="" />
              ) : (
                <div style={{ width: 40, height: 40, borderRadius: "50%", background: "#323538" }} />
              )}
              <div style={{ flex: 1 }}>
                <Link href={`/cmdr/${encodeURIComponent(cmdr.cmdr_name || "")}`} style={{ color: "var(--text)", fontWeight: 600, textDecoration: "none" }}>
                  {cmdr.cmdr_name || "Unknown"}
                </Link>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>
                  С нами с {new Date(cmdr.created_at).toLocaleDateString("ru-RU")}
                </div>
              </div>
              {isSelf ? (
                <span style={{ color: "#e67e22", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>Вы</span>
              ) : friend ? (
                <span style={{ color: "#22c55e", fontSize: 12, fontFamily: "ui-monospace, monospace", display: "flex", alignItems: "center", gap: 4 }}>
                  <IconCheck size={12} /> Друг
                </span>
              ) : pending ? (
                <span style={{ color: "#9ca3af", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>Запрос отправлен</span>
              ) : user ? (
                <button
                  onClick={() => handleSend(cmdr.id, cmdr.cmdr_name || "")}
                  disabled={isSending}
                  className="btn btn-cyan"
                  style={{ fontSize: 12, padding: "6px 14px", opacity: isSending ? 0.6 : 1 }}
                >
                  {isSending ? "Отправка..." : "Добавить в друзья"}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </main>
  );
}
