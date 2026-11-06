"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { PaymentIntent, BillingSettings, CreditPack } from "@/types/billing";
import { authFetch } from "@/lib/supabaseClient";
import ProfilePicker, { type PickedProfile } from "./ProfilePicker";
import { IconRefresh, IconCoins } from "@/components/Icons";
import { useI18n } from '@/lib/i18n/I18nContext';

const PURPOSE: Record<string, string> = { credit_topup: "pay.purposeTopup", subscription: "pay.purposeSub", shop_purchase: "pay.purposeShop" };
const STATUS: Record<string, { label: string; color: string }> = {
  processing: { label: "pay.stProcessing", color: "#f39c12" },
  pending: { label: "pay.stPending", color: "#f39c12" },
  paid: { label: "pay.stPaid", color: "#2ecc71" },
  failed: { label: "pay.stFailed", color: "#e74c3c" },
  canceled: { label: "pay.stCanceled", color: "#9ca3af" },
  expired: { label: "pay.stExpired", color: "#9ca3af" },
};

/** Payment intents (real-money flow), webhook log, manual credit grants and billing settings. */
export default function PaymentsPanel({ onChanged }: { onChanged?: () => void }) {
  const { t, locale } = useI18n();
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
    if (action === "confirm" && !confirm(t('pay.confirmManual'))) return;
    setBusy(id);
    try {
      const res = await authFetch("/api/admin/billing/intents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      say(action === "confirm" ? (data.already ? t('pay.alreadyDone') : t('pay.confirmed')) : t('pay.canceledMsg'));
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
      say(t(grantAmount > 0 ? 'pay.grantAdded' : 'pay.grantRemoved', { amount: Math.abs(grantAmount), name: grantProfile.cmdr_name || grantProfile.id, balance: data.balance?.credits ?? "—" }));
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
      say(t('pay.settingsSaved'));
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
        <h3 style={{ margin: "0 0 10px", fontSize: 13, letterSpacing: 1, color: "var(--cyan)", display: "flex", gap: 8, alignItems: "center" }}><IconCoins size={14} /> {t('pay.grantTitle')}</h3>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 120px 2fr auto", gap: 10, alignItems: "end" }}>
          <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 4 }}>{t('pay.grantPilot')}<ProfilePicker value={grantProfile} onChange={setGrantProfile} /></label>
          <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 4 }}>{t('pay.grantAmount')}<input type="number" value={grantAmount} onChange={(e) => setGrantAmount(Number(e.target.value))} /></label>
          <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 4 }}>{t('pay.grantReason')}<input value={grantReason} placeholder={t('pay.grantReasonPlaceholder')} onChange={(e) => setGrantReason(e.target.value)} /></label>
          <button type="button" className="btn-orange" disabled={!grantProfile || !grantAmount || busy === "grant"} onClick={grant}>{t('pay.grantRun')}</button>
        </div>
      </div>

      {/* Intents */}
      <div className="card" style={{ margin: 0, padding: 0 }}>
        <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid var(--line)" }}>
          <h3 style={{ margin: 0, fontSize: 13, letterSpacing: 1, color: "var(--orange)" }}>{t('pay.intentsTitle')}</h3>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ fontSize: 12 }}>
            <option value="all">{t('pay.all')}</option>
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{t(v.label)}</option>)}
          </select>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={load} style={{ fontSize: 11, display: "inline-flex", gap: 4, alignItems: "center" }}><IconRefresh size={11} /> {t('pay.refresh')}</button>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "#1c1e20", color: "var(--muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>
                {["pay.colDate", "pay.colPilot", "pay.colPurpose", "pay.colAmount", "pay.colProvider", "pay.colExternalId", "pay.colStatus", ""].map((h) => <th key={h} style={{ padding: "8px 12px", textAlign: "left" }}>{h ? t(h) : ""}</th>)}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>{t('pay.loading')}</td></tr>
              ) : intents.length === 0 ? (
                <tr><td colSpan={8} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>{t('pay.noPayments')}</td></tr>
              ) : (
                intents.map((it) => {
                  const st = STATUS[it.status] || { label: it.status, color: "#9ca3af" };
                  return (
                    <tr key={it.id} style={{ borderTop: "1px solid var(--line)" }}>
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap", color: "var(--muted)" }}>{new Date(it.created_at).toLocaleString(locale)}</td>
                      <td style={{ padding: "8px 12px" }}>{it.cmdr_name || <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 10 }}>{it.user_id?.slice(0, 8)}</span>}</td>
                      <td style={{ padding: "8px 12px" }}>{PURPOSE[it.purpose] ? t(PURPOSE[it.purpose]) : it.purpose}<div style={{ fontSize: 10, color: "var(--muted)" }}>{it.metadata?.description}</div></td>
                      <td style={{ padding: "8px 12px", fontFamily: "ui-monospace, monospace" }}>{it.amount_rub} ₽{it.amount_credits ? <div style={{ color: "#38bdf8", fontSize: 10 }}>+{t('pay.creditsAmount', { amount: it.amount_credits })}</div> : null}</td>
                      <td style={{ padding: "8px 12px" }}>{it.provider_id}</td>
                      <td style={{ padding: "8px 12px", fontFamily: "ui-monospace, monospace", fontSize: 10, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }} title={it.external_id || ""}>{it.external_id || "—"}</td>
                      <td style={{ padding: "8px 12px" }}><span style={{ fontSize: 10, padding: "1px 6px", border: `1px solid ${st.color}`, color: st.color }}>{t(st.label).toUpperCase()}</span></td>
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                        {it.status === "pending" && (
                          <>
                            <button type="button" disabled={busy === it.id} onClick={() => act(it.id, "confirm")} style={{ fontSize: 10, padding: "2px 8px", borderColor: "#2ecc71", color: "#2ecc71", marginRight: 4 }}>{t('pay.confirmButton')}</button>
                            <button type="button" disabled={busy === it.id} onClick={() => act(it.id, "cancel")} style={{ fontSize: 10, padding: "2px 8px", borderColor: "rgba(231,76,60,0.4)", color: "#e74c3c" }}>{t('pay.cancelButton')}</button>
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
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}><h3 style={{ margin: 0, fontSize: 13, letterSpacing: 1, color: "var(--muted)" }}>{t('pay.webhookTitle')}</h3></div>
        <div style={{ maxHeight: 260, overflowY: "auto" }}>
          {webhooks.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>{t('pay.webhookEmpty')}</div>
          ) : (
            webhooks.map((w) => (
              <div key={w.id} style={{ padding: "8px 16px", borderTop: "1px solid rgba(255,255,255,0.04)", fontSize: 11, display: "flex", gap: 12, alignItems: "center" }}>
                <span style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{new Date(w.created_at).toLocaleString(locale)}</span>
                <b>{w.provider_id}</b>
                <span>{w.event_type}</span>
                <span style={{ fontFamily: "ui-monospace, monospace", color: "var(--muted)" }}>{w.external_id}</span>
                <span style={{ marginLeft: "auto", color: w.processed ? "#2ecc71" : "#e74c3c" }}>{w.processed ? t('pay.processed') : t('pay.webhookError', { error: w.error || '?' })}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Settings */}
      {settings && (
        <div className="card" style={{ margin: 0, padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 13, letterSpacing: 1, color: "var(--orange)" }}>{t('pay.settingsTitle')}</h3>
            <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "ui-monospace, monospace" }}>{t('pay.storage', { backend: backend || '?' })}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 4 }}>{t('pay.welcomeCredits')}<input type="number" value={settings.welcome_credits} onChange={(e) => setSettings({ ...settings, welcome_credits: Number(e.target.value) })} /></label>
            <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 4 }}>{t('pay.currency')}<input value={settings.currency} onChange={(e) => setSettings({ ...settings, currency: e.target.value })} /></label>
            <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", gap: 8, alignItems: "center", marginTop: 18 }}><input type="checkbox" checked={settings.shop_enabled} onChange={(e) => setSettings({ ...settings, shop_enabled: e.target.checked })} /> {t('pay.shopEnabled')}</label>
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>{t('pay.packsTitle')}</div>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead><tr style={{ color: "var(--muted)", fontSize: 10 }}><th style={{ textAlign: "left", padding: 4 }}>ID</th><th style={{ textAlign: "left", padding: 4 }}>{t('pay.colName')}</th><th style={{ textAlign: "left", padding: 4 }}>{t('pay.colCredits')}</th><th style={{ textAlign: "left", padding: 4 }}>{t('pay.colPriceRub')}</th><th style={{ textAlign: "left", padding: 4 }}>{t('pay.colBonus')}</th><th /></tr></thead>
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
            <button type="button" onClick={() => setSettings({ ...settings, credit_packs: [...settings.credit_packs, { id: `pack_${Date.now().toString(36)}`, label: t('pay.newPack'), credits: 1000, price_rub: 100, bonus_pct: 0 }] })} style={{ fontSize: 11 }}>{t('pay.addPack')}</button>
            <button type="button" className="btn-orange" disabled={savingSettings} onClick={saveSettings}>{savingSettings ? '…' : t('pay.saveSettings')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
