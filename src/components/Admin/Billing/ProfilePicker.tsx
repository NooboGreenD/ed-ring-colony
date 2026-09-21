"use client";

import React, { useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/supabaseClient";

export interface PickedProfile {
  id: string;
  cmdr_name: string | null;
  avatar_url?: string | null;
}

interface Props {
  value: PickedProfile | null;
  onChange: (p: PickedProfile | null) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

/** Search real pilots (profiles) by callsign. Used by grants (credits / items / subscriptions). */
export default function ProfilePicker({ value, onChange, placeholder = "Позывной командира или UUID…", autoFocus }: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PickedProfile[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef<any>(null);

  useEffect(() => {
    if (!q.trim() || value) {
      setResults([]);
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await authFetch(`/api/admin/billing/profiles?q=${encodeURIComponent(q.trim())}`);
        const data = await res.json();
        setResults(data.profiles || []);
        setOpen(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer.current);
  }, [q, value]);

  if (value) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", border: "1px solid var(--cyan)", background: "rgba(52,152,219,0.08)", fontSize: 13 }}>
        {value.avatar_url ? <img src={value.avatar_url} alt="" style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover" }} /> : <span style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--line)", display: "inline-block" }} />}
        <b style={{ color: "var(--text)" }}>{value.cmdr_name || "(без позывного)"}</b>
        <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "ui-monospace, monospace" }}>{value.id.slice(0, 8)}…</span>
        <button type="button" onClick={() => { onChange(null); setQ(""); }} style={{ marginLeft: "auto", border: "none", background: "transparent", color: "var(--muted)", fontSize: 12, padding: 2 }}>сменить</button>
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <input
        type="text"
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        style={{ width: "100%" }}
      />
      {loading && <span style={{ position: "absolute", right: 10, top: 10, fontSize: 10, color: "var(--muted)" }}>…</span>}
      {open && results.length > 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, background: "#1c1e20", border: "1px solid var(--line)", maxHeight: 220, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
          {results.map((p) => (
            <div key={p.id} onMouseDown={() => { onChange(p); setOpen(false); }} style={{ padding: "8px 10px", cursor: "pointer", display: "flex", gap: 8, alignItems: "center", fontSize: 13, borderBottom: "1px solid rgba(255,255,255,0.04)" }} className="profile-picker-row">
              {p.avatar_url ? <img src={p.avatar_url} alt="" style={{ width: 20, height: 20, borderRadius: "50%", objectFit: "cover" }} /> : <span style={{ width: 20, height: 20, borderRadius: "50%", background: "var(--line)", display: "inline-block" }} />}
              <span style={{ color: "var(--text)" }}>{p.cmdr_name || "(без позывного)"}</span>
              <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--muted)", fontFamily: "ui-monospace, monospace" }}>{p.id.slice(0, 8)}</span>
            </div>
          ))}
        </div>
      )}
      {open && !loading && q.trim() && results.length === 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, background: "#1c1e20", border: "1px solid var(--line)", padding: "8px 10px", fontSize: 12, color: "var(--muted)" }}>
          Пилот не найден. Можно ввести точный UUID.
          {/^[0-9a-f-]{36}$/i.test(q.trim()) && (
            <button type="button" onMouseDown={() => onChange({ id: q.trim(), cmdr_name: null })} style={{ marginLeft: 8, fontSize: 11, padding: "2px 8px" }}>Использовать UUID</button>
          )}
        </div>
      )}
    </div>
  );
}
