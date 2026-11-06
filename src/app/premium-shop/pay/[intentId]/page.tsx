"use client";

import React, { useEffect, useState, useCallback, use } from "react";
import Link from "next/link";
import { authFetch } from "@/lib/supabaseClient";
import { invalidateCosmetics } from "@/components/Cosmetics/useCosmetics";
import type { PaymentIntent } from "@/types/billing";
import { useI18n } from '@/lib/i18n/I18nContext';

const PURPOSE: Record<string, string> = { credit_topup: "payi.purposeTopup", subscription: "payi.purposeSub", shop_purchase: "payi.purposeShop" };
const STATUS: Record<string, { label: string; color: string }> = {
  processing: { label: "payi.stProcessing", color: "#f39c12" },
  pending: { label: "payi.stPending", color: "#f39c12" },
  paid: { label: "payi.stPaid", color: "#2ecc71" },
  failed: { label: "payi.stFailed", color: "#e74c3c" },
  canceled: { label: "payi.stCanceled", color: "#9ca3af" },
  expired: { label: "payi.stExpired", color: "#9ca3af" },
};

export default function PayStatusPage({ params }: { params: Promise<{ intentId: string }> }) {
  const { t, locale } = useI18n();
  const { intentId } = use(params);
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [provider, setProvider] = useState<{ id: string; name: string; test_mode: boolean } | null>(null);
  const [manual, setManual] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await authFetch(`/api/billing/intent/${intentId}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('payi.error'));
      setIntent(data.intent);
      setProvider(data.provider);
      setManual(data.manualInstructions);
      if (data.intent.status === "paid") invalidateCosmetics();
    } catch (e: any) {
      setError(e.message);
    }
  }, [intentId, t]);

  useEffect(() => { load(); }, [load, tick]);
  useEffect(() => {
    if (!intent || !["pending", "processing"].includes(intent.status)) return;
    const t = setTimeout(() => setTick((x) => x + 1), 4000);
    return () => clearTimeout(t);
  }, [intent, tick]);

  const st = intent ? STATUS[intent.status] || { label: intent.status, color: "#9ca3af" } : null;
  const final = intent && !["pending", "processing"].includes(intent.status);

  return (
    <div style={{ maxWidth: 560, margin: "20px auto", display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="kicker">{t('payi.kicker')}</div>
      <div className="card" style={{ margin: 0, padding: 24, borderTop: `3px solid ${st?.color || "var(--line)"}` }}>
        {error ? (
          <div style={{ color: "#e74c3c" }}>{error}</div>
        ) : !intent ? (
          <div style={{ color: "var(--muted)" }}>{t('payi.loading')}</div>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>{PURPOSE[intent.purpose] ? t(PURPOSE[intent.purpose]) : intent.purpose}</h2>
              <span style={{ fontSize: 11, padding: "3px 10px", border: `1px solid ${st!.color}`, color: st!.color, fontFamily: "ui-monospace, monospace", letterSpacing: 1 }}>{t(st!.label).toUpperCase()}</span>
            </div>
            <div style={{ fontSize: 13, display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", marginBottom: 16 }}>
              <span style={{ color: "var(--muted)" }}>{t('payi.amount')}</span><b style={{ fontFamily: "ui-monospace, monospace" }}>{intent.amount_rub} ₽</b>
              {intent.amount_credits ? <><span style={{ color: "var(--muted)" }}>{t('payi.credits')}</span><b style={{ color: "#38bdf8", fontFamily: "ui-monospace, monospace" }}>+{intent.amount_credits}</b></> : null}
              <span style={{ color: "var(--muted)" }}>{t('payi.description')}</span><span>{intent.metadata?.description || "—"}</span>
              <span style={{ color: "var(--muted)" }}>{t('payi.provider')}</span><span>{provider?.name || intent.provider_id}{provider?.test_mode ? t('payi.testMode') : ""}</span>
              <span style={{ color: "var(--muted)" }}>{t('payi.paymentId')}</span><span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{intent.id}</span>
              <span style={{ color: "var(--muted)" }}>{t('payi.created')}</span><span>{new Date(intent.created_at).toLocaleString(locale)}</span>
            </div>

            {intent.status === "pending" && manual && (
              <div style={{ padding: 12, border: "1px solid #f39c12", background: "rgba(243,156,18,0.08)", fontSize: 13, whiteSpace: "pre-wrap", marginBottom: 14 }}>
                <b style={{ color: "#f39c12" }}>{t('payi.manualTitle')}</b>{"\n"}{manual}{"\n\n"}{t('payi.manualCode')} <b style={{ fontFamily: "ui-monospace, monospace" }}>{intent.id.slice(0, 8).toUpperCase()}</b>{t('payi.manualAfter')}
              </div>
            )}

            {intent.status === "pending" && !manual && intent.payment_url && (
              <a href={intent.payment_url} className="btn-orange" style={{ display: "inline-block", padding: "8px 16px", marginBottom: 14 }}>{t('payi.goToPay')}</a>
            )}
            {!final && <div style={{ fontSize: 12, color: "var(--muted)" }}>{t('payi.autoRefresh')}</div>}
            {intent.status === "paid" && (
              <div style={{ fontSize: 13, color: "#2ecc71" }}>
                {intent.purpose === "credit_topup" ? t('payi.paidTopup') : intent.purpose === "subscription" ? t('payi.paidSub') : t('payi.paidShop')}
              </div>
            )}
            {intent.status === "processing" && <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 10 }}>{t('payi.noResubmit')}</div>}
            {intent.purpose === "subscription" && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 10 }}>{t('payi.oneTime')}</div>}
            {intent.status === "failed" && intent.metadata?.error && <div style={{ fontSize: 13, color: "#e74c3c" }}>{intent.metadata?.error}</div>}
          </>
        )}
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <Link href="/subscriptions" style={{ color: "var(--cyan)", fontSize: 13 }}>{t('payi.linkSubs')}</Link>
        <Link href="/premium-shop" style={{ color: "var(--cyan)", fontSize: 13 }}>{t('payi.linkShop')}</Link>
        <Link href="/account?tab=premium" style={{ color: "var(--cyan)", fontSize: 13 }}>{t('payi.linkCabinet')}</Link>
      </div>
    </div>
  );
}
