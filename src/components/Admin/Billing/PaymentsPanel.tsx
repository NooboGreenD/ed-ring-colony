"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { PaymentIntent, BillingSettings, CreditPack } from "@/types/billing";
import { authFetch } from "@/lib/supabaseClient";
import ProfilePicker, { type PickedProfile } from "./ProfilePicker";
import { IconRefresh, IconCoins } from "@/components/Icons";

const PURPOSE: Record<string, string> = { credit_topup: "Пополнение", subscription: "Подписка", shop_purchase: "Товар" };
const STATUS: Record<string, { label: string; color: string }> = {
  processing: { label: "Обработка покупки", color: "#f39c12" },
  pending: { label: "ожидает", color: "#f39c12" },
  paid: { label: "оплачен", color: "#2ecc71" },
  failed: { label: "ошибка", color: "#e74c3c" },
  canceled: { label: "отменён", color: "#9ca3af" },
  expired: { label: "истёк", color: "#9ca3af" },
};

/** Payment intents (real-money flow), webhook log, manual credit grants and billing settings. */
export default function PaymentsPanel({ onChanged }: { onChanged?: () => void }) {
  const [intents, setIntents] = useState<PaymentIntent[]>([]);
  const [webhooks, setWebhooks] = useState<any[]>([]);
  const [status, setStatus] = useState("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);

  // credit grant
  const [grantProfile, setGrantProfile] = useState<PickedProfile | null>(null);
  const [grantAmount, setGrantAmount] = useState(1000);
  const [grantReason, setGrantReason] = useState("");

  // settings
  const [settings, setSettings] = useState<BillingSettings | null>(null);
  const [backend, setBackend] = useState<string>("");
  const [savingSettings, setSavingSettings] = useState(false);

  const say = (text: string, ok = true) => {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 5000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [iRes, sRes] = await Promise.all([authFetch(`/api/admin/billing/intents?status=${status}&limit=100`, { cache: "no-store" }), authFetch("/api/admin/billing/settings", { cache: "no-store" })]);
      const i = await iRes.json();
      const s = await sRes.json();
      if (i.success) { setIntents(i.intents || []); setWebhooks(i.webhooks || []); }
      if (s.success) { setSettings(s.settings); setBackend(s.backend || ""); }
    } catch (e: any) {
      say(e.message, false);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  const act = async (id: string, action: "confirm" | "cancel") => {
    if (action === "confirm" && !confirm("Подтвердить платёж вручную? Кредиты/подписка/товар будут выданы немедленно.")) return;
    setBusy(id);
    try {
      const res = await authFetch("/api/admin/billing/intents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      say(action === "confirm" ? (data.already ? "Платёж уже был исполнен" : "Платёж подтверждён и исполнен") : "Платёж отменён");
      load();
      onChanged?.();
    } catch (e: any) {
      say(e.message, false);
    } finally {
      setBusy(null);
    }
  };

  const grant = async () => {
    if (!grantProfile || !grantAmount) return;
    setBusy("grant");
    try {
      const res = await authFetch("/api/admin/billing/credits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: grantProfile.id, cmdrName: grantProfile.cmdr_name, amountCredits: grantAmount, reason: grantReason || undefined }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      say(`${grantAmount > 0 ? "Начислено" : "Списано"} ${Math.abs(grantAmount)} Кр. пилоту ${grantProfile.cmdr_name || grantProfile.id}. Баланс: ${data.balance?.credits ?? "—"}`);
      setGrantProfile(null);
      setGrantReason("");
      onChanged?.();
    } catch (e: any) {
      say(e.message, false);
    } finally {
      setBusy(null);
    }
  };

  const saveSettings = async () => {
    if (!settings) return;
    setSavingSettings(true);
    try {
      const res = await authFetch("/api/admin/billing/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSettings(data.settings);
      say("Настройки сохранены");
    } catch (e: any) {
      say(e.message, false);
    } finally {
      setSavingSettings(false);
    }
  };

  const setPack = (idx: number, patch: Partial<CreditPack>) => setSettings((s) => (s ? { ...s, credit_packs: s.credit_packs.map((p, i) => (i === idx ? { ...p, ...patch } : p)) } : s));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {toast && (
        <div style={{ position: "fixed", top: 24, right: 24, zIndex: 9999, padding: "10px 16px", background: toast.ok ? "rgba(46,204,113,0.2)" : "rgba(231,76,60,0.2)", border: `1px solid ${toast.ok ? "#2ecc71" : "#e74c3c"}`, color: toast.ok ? "#2ecc71" : "#e74c3c", fontSize: 13, maxWidth: 420 }}>{toast.text}</div>
      )}

      {/* Credit grant */}
      <div className="card" style={{ margin: 0, padding: 16 }}>
        <h3 style={{ margin: "0 0 10px", fontSize: 13, letterSpacing: 1, color: "var(--cyan)", display: "flex", gap: 8, alignItems: "center" }}><IconCoins size={14} /> РУЧНОЕ НАЧИСЛЕНИЕ КРЕДИТОВ</h3>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 120px 2fr auto", gap: 10, alignItems: "end" }}>
          <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 4 }}>Пилот<ProfilePicker value={grantProfile} onChange={setGrantProfile} /></label>
          <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 4 }}>Сумма (− списать)<input type="number" value={grantAmount} onChange={(e) => setGrantAmount(Number(e.target.value))} /></label>
          <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 4 }}>Причина<input value={grantReason} placeholder="Компенсация, конкурс, оплата вручную…" onChange={(e) => setGrantReason(e.target.value)} /></label>
          <button type="button" className="btn-orange" disabled={!grantProfile || !grantAmount || busy === "grant"} onClick={grant}>Провести</button>
        </div>
      </div>

      {/* Intents */}
      <div className="card" style={{ margin: 0, padding: 0 }}>
        <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid var(--line)" }}>
          <h3 style={{ margin: 0, fontSize: 13, letterSpacing: 1, color: "var(--orange)" }}>ПЛАТЕЖИ (INTENTS)</h3>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ fontSize: 12 }}>
            <option value="all">все</option>
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={load} style={{ fontSize: 11, display: "inline-flex", gap: 4, alignItems: "center" }}><IconRefresh size={11} /> Обновить</button>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "#1c1e20", color: "var(--muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>
                {["Дата", "Пилот", "Цель", "Сумма", "Провайдер", "Внешний ID", "Статус", ""].map((h) => <th key={h} style={{ padding: "8px 12px", textAlign: "left" }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>Загрузка…</td></tr>
              ) : intents.length === 0 ? (
                <tr><td colSpan={8} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>Платежей нет</td></tr>
              ) : (
                intents.map((it) => {
                  const st = STATUS[it.status] || { label: it.status, color: "#9ca3af" };
                  return (
                    <tr key={it.id} style={{ borderTop: "1px solid var(--line)" }}>
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap", color: "var(--muted)" }}>{new Date(it.created_at).toLocaleString("ru-RU")}</td>
                      <td style={{ padding: "8px 12px" }}>{it.cmdr_name || <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 10 }}>{it.user_id?.slice(0, 8)}</span>}</td>
                      <td style={{ padding: "8px 12px" }}>{PURPOSE[it.purpose] || it.purpose}<div style={{ fontSize: 10, color: "var(--muted)" }}>{it.metadata?.description}</div></td>
                      <td style={{ padding: "8px 12px", fontFamily: "ui-monospace, monospace" }}>{it.amount_rub} ₽{it.amount_credits ? <div style={{ color: "#38bdf8", fontSize: 10 }}>+{it.amount_credits} Кр.</div> : null}</td>
                      <td style={{ padding: "8px 12px" }}>{it.provider_id}</td>
                      <td style={{ padding: "8px 12px", fontFamily: "ui-monospace, monospace", fontSize: 10, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }} title={it.external_id || ""}>{it.external_id || "—"}</td>
                      <td style={{ padding: "8px 12px" }}><span style={{ fontSize: 10, padding: "1px 6px", border: `1px solid ${st.color}`, color: st.color }}>{st.label.toUpperCase()}</span></td>
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                        {it.status === "pending" && (
                          <>
                            <button type="button" disabled={busy === it.id} onClick={() => act(it.id, "confirm")} style={{ fontSize: 10, padding: "2px 8px", borderColor: "#2ecc71", color: "#2ecc71", marginRight: 4 }}>Подтвердить</button>
                            <button type="button" disabled={busy === it.id} onClick={() => act(it.id, "cancel")} style={{ fontSize: 10, padding: "2px 8px", borderColor: "rgba(231,76,60,0.4)", color: "#e74c3c" }}>Отменить</button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Webhooks */}
      <div className="card" style={{ margin: 0, padding: 0 }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}><h3 style={{ margin: 0, fontSize: 13, letterSpacing: 1, color: "var(--muted)" }}>ЖУРНАЛ WEBHOOK-УВЕДОМЛЕНИЙ</h3></div>
        <div style={{ maxHeight: 260, overflowY: "auto" }}>
          {webhooks.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>Уведомлений от платёжных систем ещё не было</div>
          ) : (
            webhooks.map((w) => (
              <div key={w.id} style={{ padding: "8px 16px", borderTop: "1px solid rgba(255,255,255,0.04)", fontSize: 11, display: "flex", gap: 12, alignItems: "center" }}>
                <span style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{new Date(w.created_at).toLocaleString("ru-RU")}</span>
                <b>{w.provider_id}</b>
                <span>{w.event_type}</span>
                <span style={{ fontFamily: "ui-monospace, monospace", color: "var(--muted)" }}>{w.external_id}</span>
                <span style={{ marginLeft: "auto", color: w.processed ? "#2ecc71" : "#e74c3c" }}>{w.processed ? "обработан" : `ошибка: ${w.error || "?"}`}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Settings */}
      {settings && (
        <div className="card" style={{ margin: 0, padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 13, letterSpacing: 1, color: "var(--orange)" }}>НАСТРОЙКИ БИЛЛИНГА</h3>
            <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "ui-monospace, monospace" }}>хранилище: {backend || "?"}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 4 }}>Приветственные кредиты новым пилотам<input type="number" value={settings.welcome_credits} onChange={(e) => setSettings({ ...settings, welcome_credits: Number(e.target.value) })} /></label>
            <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 4 }}>Валюта<input value={settings.currency} onChange={(e) => setSettings({ ...settings, currency: e.target.value })} /></label>
            <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", gap: 8, alignItems: "center", marginTop: 18 }}><input type="checkbox" checked={settings.shop_enabled} onChange={(e) => setSettings({ ...settings, shop_enabled: e.target.checked })} /> Магазин включён</label>
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Пакеты пополнения кредитов</div>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead><tr style={{ color: "var(--muted)", fontSize: 10 }}><th style={{ textAlign: "left", padding: 4 }}>ID</th><th style={{ textAlign: "left", padding: 4 }}>Название</th><th style={{ textAlign: "left", padding: 4 }}>Кредиты</th><th style={{ textAlign: "left", padding: 4 }}>Цена ₽</th><th style={{ textAlign: "left", padding: 4 }}>Бонус %</th><th /></tr></thead>
            <tbody>
              {settings.credit_packs.map((p, i) => (
                <tr key={i}>
                  <td style={{ padding: 4 }}><input value={p.id} onChange={(e) => setPack(i, { id: e.target.value })} style={{ width: 110, fontFamily: "ui-monospace, monospace" }} /></td>
                  <td style={{ padding: 4 }}><input value={p.label} onChange={(e) => setPack(i, { label: e.target.value })} style={{ width: "100%" }} /></td>
                  <td style={{ padding: 4 }}><input type="number" value={p.credits} onChange={(e) => setPack(i, { credits: Number(e.target.value) })} style={{ width: 90 }} /></td>
                  <td style={{ padding: 4 }}><input type="number" value={p.price_rub} onChange={(e) => setPack(i, { price_rub: Number(e.target.value) })} style={{ width: 80 }} /></td>
                  <td style={{ padding: 4 }}><input type="number" value={p.bonus_pct} onChange={(e) => setPack(i, { bonus_pct: Number(e.target.value) })} style={{ width: 60 }} /></td>
                  <td style={{ padding: 4 }}><button type="button" onClick={() => setSettings({ ...settings, credit_packs: settings.credit_packs.filter((_, j) => j !== i) })} style={{ fontSize: 10, padding: "2px 6px", color: "#e74c3c", borderColor: "rgba(231,76,60,0.4)" }}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 10, marginTop: 10, justifyContent: "space-between" }}>
            <button type="button" onClick={() => setSettings({ ...settings, credit_packs: [...settings.credit_packs, { id: `pack_${Date.now().toString(36)}`, label: "Новый пакет", credits: 1000, price_rub: 100, bonus_pct: 0 }] })} style={{ fontSize: 11 }}>+ Пакет</button>
            <button type="button" className="btn-orange" disabled={savingSettings} onClick={saveSettings}>{savingSettings ? "…" : "Сохранить настройки"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
