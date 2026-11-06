"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { PaymentProviderView, ProviderConfigField } from "@/types/billing";
import { authFetch } from "@/lib/supabaseClient";
import { IconCheck, IconX, IconRefresh, IconCreditCard } from "@/components/Icons";
import { useI18n } from '@/lib/i18n/I18nContext';

const METHOD_LABEL: Record<string, string> = { card: "ppv.mCard", sbp: "ppv.mSbp", crypto: "ppv.mCrypto", manual: "ppv.mManual" };

export default function PaymentProvidersPanel() {
  const { t, locale } = useI18n();
  const [providers, setProviders] = useState<PaymentProviderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, any>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);

  const say = (text: string, ok = true) => {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 5000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch("/api/admin/billing/providers", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setProviders(data.providers || []);
    } catch (e: any) {
      say(t('ppv.loadError', { error: e.message }), false);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const patch = async (id: string, body: Record<string, any>, okText?: string) => {
    setBusy(id);
    try {
      const res = await authFetch("/api/admin/billing/providers", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...body }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setProviders(data.providers);
      setDrafts((d) => ({ ...d, [id]: {} }));
      if (okText) say(okText);
    } catch (e: any) {
      say(e.message, false);
    } finally {
      setBusy(null);
    }
  };

  const check = async (id: string) => {
    setBusy(id);
    try {
      const res = await authFetch("/api/admin/billing/providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action: "check" }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setProviders(data.providers);
      say(data.result.message, data.result.ok);
    } catch (e: any) {
      say(e.message, false);
    } finally {
      setBusy(null);
    }
  };

  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => say(t('ppv.copied')));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {toast && (
        <div style={{ position: "fixed", top: 24, right: 24, zIndex: 9999, padding: "10px 16px", background: toast.ok ? "rgba(46,204,113,0.2)" : "rgba(231,76,60,0.2)", border: `1px solid ${toast.ok ? "#2ecc71" : "#e74c3c"}`, color: toast.ok ? "#2ecc71" : "#e74c3c", fontSize: 13, maxWidth: 420 }}>{toast.text}</div>
      )}

      <div className="card" style={{ margin: 0, padding: 16, fontSize: 13, lineHeight: 1.6 }}>
        <b style={{ color: "var(--orange)" }}>{t('ppv.introBold')}</b>{' '} {t('ppv.intro1')}{' '}{t('ppv.intro2')}
        {providers.length > 0 && !providers.some((p) => p.is_enabled) && <div style={{ color: "#f39c12", marginTop: 6 }}>{t('ppv.noneEnabled')}</div>}
      </div>

      {loading ? (
        <div className="card" style={{ margin: 0, padding: 30, textAlign: "center", color: "var(--muted)" }}>{t('ppv.loading')}</div>
      ) : (
        providers.map((p) => {
          const open = openId === p.id;
          const draft = drafts[p.id] || {};
          const dirty = Object.keys(draft).length > 0;
          const statusColor = p.is_enabled ? "#2ecc71" : p.configured ? "#f39c12" : "var(--muted)";
          return (
            <div key={p.id} className="card" style={{ margin: 0, padding: 0, borderLeft: `3px solid ${statusColor}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 18px", cursor: "pointer" }} onClick={() => setOpenId(open ? null : p.id)}>
                <IconCreditCard size={18} color={statusColor} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <b style={{ color: "var(--text)", fontSize: 14 }}>{p.name}</b>
                    <span style={{ fontSize: 10, padding: "1px 6px", border: `1px solid ${statusColor}`, color: statusColor, letterSpacing: 1 }}>{p.is_enabled ? t('ppv.on') : p.configured ? t('ppv.offConfigured') : t('ppv.notConfigured')}</span>
                    {p.test_mode && <span style={{ fontSize: 10, padding: "1px 6px", border: "1px solid #f39c12", color: "#f39c12" }}>{t('ppv.test')}</span>}
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>{p.methods.map((m) => (METHOD_LABEL[m] ? t(METHOD_LABEL[m]) : m)).join(" · ")}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{p.description}</div>
                  {p.last_check_at && (
                    <div style={{ fontSize: 11, marginTop: 2, color: p.last_check_ok ? "#2ecc71" : "#e74c3c" }}>
                      {t('ppv.checkAt', { at: new Date(p.last_check_at).toLocaleString(locale), msg: p.last_check_msg ?? '' })}
                    </div>
                  )}
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }} onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={p.is_enabled} disabled={busy === p.id || (!p.is_enabled && !p.configured)} onChange={(e) => patch(p.id, { is_enabled: e.target.checked }, e.target.checked ? t('ppv.enabledForPay', { name: p.name }) : t('ppv.disabled', { name: p.name }))} />
                  {t('ppv.toggle')}
                </label>
                <span style={{ color: "var(--muted)", fontSize: 12 }}>{open ? "▲" : "▼"}</span>
              </div>

              {open && (
                <div style={{ borderTop: "1px solid var(--line)", padding: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  {p.config_fields.map((f: ProviderConfigField) => (
                    <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--muted)", gridColumn: f.type === "url" || f.key === "instructions" ? "1 / -1" : undefined }}>
                      <span>{f.label}{f.required && <span style={{ color: "var(--orange)" }}> *</span>}</span>
                      {f.type === "select" ? (
                        <select value={draft[f.key] ?? p.config[f.key] ?? ""} onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: { ...draft, [f.key]: e.target.value } }))}>
                          <option value="">—</option>
                          {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      ) : f.type === "boolean" ? (
                        <input type="checkbox" checked={Boolean(draft[f.key] ?? p.config[f.key])} onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: { ...draft, [f.key]: e.target.checked } }))} />
                      ) : f.key === "instructions" ? (
                        <textarea rows={3} value={draft[f.key] ?? p.config[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: { ...draft, [f.key]: e.target.value } }))} />
                      ) : (
                        <input type={f.type === "secret" ? "password" : "text"} value={draft[f.key] ?? (f.type === "secret" ? "" : p.config[f.key] ?? "")} placeholder={f.type === "secret" && p.config[f.key] ? t('ppv.savedMask', { value: p.config[f.key] }) : f.placeholder} autoComplete="off" onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: { ...draft, [f.key]: e.target.value } }))} />
                      )}
                      {f.help && <span style={{ fontSize: 10, opacity: 0.8 }}>{f.help}</span>}
                    </label>
                  ))}

                  <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--muted)" }}>
                    <span>{t('ppv.webhook')}</span>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input readOnly value={p.webhook_url} style={{ flex: 1, fontFamily: "ui-monospace, monospace", fontSize: 12 }} onFocus={(e) => e.target.select()} />
                      <button type="button" onClick={() => copy(p.webhook_url)} style={{ fontSize: 11 }}>{t('ppv.copy')}</button>
                    </div>
                    {p.docs_url && <a href={p.docs_url} target="_blank" rel="noreferrer" style={{ color: "var(--cyan)", fontSize: 11 }}>{t('ppv.docs')}</a>}
                  </div>

                  <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", borderTop: "1px solid var(--line)", paddingTop: 12 }}>
                    <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
                      <input type="checkbox" checked={p.test_mode} disabled={busy === p.id} onChange={(e) => patch(p.id, { test_mode: e.target.checked })} /> {t('ppv.sandbox')}
                    </label>
                    <div style={{ flex: 1 }} />
                    <button type="button" disabled={busy === p.id} onClick={() => check(p.id)} style={{ fontSize: 12, display: "inline-flex", gap: 6, alignItems: "center" }}><IconRefresh size={12} /> {p.id === "tbank" ? t('ppv.checkSettings') : t('ppv.checkConnection')}</button>
                    <button type="button" className="btn-orange" disabled={!dirty || busy === p.id} onClick={() => patch(p.id, { config: draft }, t('ppv.settingsSaved'))} style={{ fontSize: 12 }}>
                      {busy === p.id ? "…" : t('ppv.saveKeys')}
                    </button>
                    {dirty && <button type="button" onClick={() => setDrafts((d) => ({ ...d, [p.id]: {} }))} style={{ fontSize: 12, borderColor: "var(--line)", color: "var(--muted)" }}><IconX size={11} /> {t('ppv.revert')}</button>}
                    {!dirty && p.configured && <span style={{ fontSize: 11, color: "#2ecc71", display: "inline-flex", gap: 4, alignItems: "center" }}><IconCheck size={11} /> {t('ppv.requiredDone')}</span>}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
