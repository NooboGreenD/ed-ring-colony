"use client";

import React, { useState, useEffect, useCallback } from "react";
import type { BillingTransaction } from "@/types/billing";
import { IconSearch, IconCheck, IconX, IconRefresh } from "@/components/Icons";
import { authFetch } from "@/lib/supabaseClient";
import { useI18n } from "@/lib/i18n/I18nContext";

const KIND_KEYS: Record<string, string> = {
  subscription: "tl.kindSubscription",
  shop_purchase: "tl.kindShop",
  credit_topup: "tl.kindTopup",
  admin_grant: "tl.kindGrant",
  refund: "tl.kindRefund",
};

const METHOD_KEYS: Record<string, string> = {
  sbp: "tl.methodSbp",
  card: "tl.methodCard",
  credits: "tl.methodCredits",
  admin: "tl.methodAdmin",
};


interface Props {
  onRefreshStats?: () => void;
}

export default function TransactionLedger({ onRefreshStats }: Props) {
  const { t, locale } = useI18n();
  const [transactions, setTransactions] = useState<BillingTransaction[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [refundingId, setRefundingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const showToast = (text: string, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 4000);
  };

  const loadTransactions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(
        `/api/admin/billing/transactions?type=${typeFilter}&status=${statusFilter}&search=${encodeURIComponent(search)}&limit=100`
      );
      const data = await res.json();
      if (data.success) {
        setTransactions(data.transactions || []);
        setTotal(data.total || 0);
      }
    } catch (err: any) {
      showToast(t("tl.loadFailed", { error: err.message }), false);
    } finally {
      setLoading(false);
    }
  }, [typeFilter, statusFilter, search]);

  useEffect(() => {
    loadTransactions();
  }, [loadTransactions]);

  const handleRefund = async (txId: string) => {
    const reason = prompt(t("tl.refundPrompt"));
    if (!reason) return;

    setRefundingId(txId);
    try {
      const res = await authFetch("/api/admin/billing/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId: txId, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("tl.refundFailed"));

      showToast(t("tl.refundDone", { id: txId }));
      loadTransactions();
      if (onRefreshStats) onRefreshStats();
    } catch (err: any) {
      showToast(err.message, false);
    } finally {
      setRefundingId(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Toast */}
      {msg && (
        <div
          style={{
            padding: "10px 16px",
            borderRadius: 2,
            background: msg.ok ? "rgba(46, 204, 113, 0.15)" : "rgba(231, 76, 60, 0.15)",
            border: `1px solid ${msg.ok ? "#2ecc71" : "#e74c3c"}`,
            color: msg.ok ? "#2ecc71" : "#e74c3c",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {msg.ok ? <IconCheck size={14} /> : <IconX size={14} />}
          {msg.text}
        </div>
      )}

      {/* Header & Controls */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, color: "var(--text, #eeeeee)" }}>
            {t("tl.title")}
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--muted, #9ca3af)" }}>
            {t("tl.subtitle")}
          </p>
        </div>

        <button
          type="button"
          onClick={loadTransactions}
          disabled={loading}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 12px",
            fontSize: 11,
          }}
        >
          <IconRefresh size={12} />
          {t("tl.refresh")}
        </button>
      </div>

      {/* Filter Bar */}
      <div className="card" style={{ margin: 0, padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ position: "relative", minWidth: 240, flex: 1 }}>
            <input
              type="text"
              placeholder={t("tl.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: "100%", paddingLeft: 30 }}
            />
            <span style={{ position: "absolute", left: 8, top: 11, pointerEvents: "none" }}>
              <IconSearch size={14} color="#9ca3af" />
            </span>
          </div>

          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="all">{t("tl.allTypes")}</option>
            <option value="subscription">{t("tl.typeSubscription")}</option>
            <option value="shop_purchase">{t("tl.typeShop")}</option>
            <option value="credit_topup">{t("tl.typeTopup")}</option>
            <option value="refund">{t("tl.typeRefund")}</option>
            <option value="admin_grant">{t("tl.typeGrant")}</option>
          </select>

          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">{t("tl.allStatuses")}</option>
            <option value="completed">{t("tl.statusCompleted")}</option>
            <option value="refunded">{t("tl.statusRefunded")}</option>
            <option value="pending">{t("tl.statusPending")}</option>
          </select>

          <div style={{ fontSize: 12, color: "var(--muted, #9ca3af)", fontFamily: "ui-monospace, monospace" }}>
            {t("tl.shown", { shown: transactions.length, total })}
          </div>
        </div>
      </div>

      {/* Ledger Table */}
      <div className="card" style={{ margin: 0 }}>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>{t("tl.colId")}</th>
                <th style={{ textAlign: "left" }}>{t("tl.colTime")}</th>
                <th style={{ textAlign: "left" }}>{t("tl.colCmdr")}</th>
                <th style={{ textAlign: "left" }}>{t("tl.colType")}</th>
                <th style={{ textAlign: "left" }}>{t("tl.colName")}</th>
                <th style={{ textAlign: "right" }}>{t("tl.colAmount")}</th>
                <th style={{ textAlign: "right" }}>{t("tl.colCredits")}</th>
                <th style={{ textAlign: "left" }}>{t("tl.colMethod")}</th>
                <th style={{ textAlign: "left" }}>{t("tl.colStatus")}</th>
                <th style={{ textAlign: "right" }}>{t("tl.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={10} style={{ textAlign: "center", padding: 24, color: "var(--muted, #9ca3af)" }}>
                    {t("tl.loading")}
                  </td>
                </tr>
              ) : transactions.length === 0 ? (
                <tr>
                  <td colSpan={10} style={{ textAlign: "center", padding: 24, color: "var(--muted, #9ca3af)" }}>
                    {t("tl.empty")}
                  </td>
                </tr>
              ) : (
                transactions.map((tx) => {
                  const isRefunded = tx.status === "refunded";
                  return (
                    <tr key={tx.id} style={{ opacity: isRefunded ? 0.6 : 1 }}>
                      <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#3498db" }}>
                        {tx.id}
                      </td>

                      <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "var(--muted, #9ca3af)" }}>
                        {new Date(tx.created_at).toLocaleString(locale, {
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>

                      <td style={{ fontWeight: 600, color: "var(--text, #eeeeee)" }}>
                        {tx.cmdr_name}
                      </td>

                      <td>
                        <span
                          style={{
                            fontSize: 10,
                            padding: "2px 5px",
                            borderRadius: 2,
                            fontFamily: "ui-monospace, monospace",
                            background:
                              tx.type === "subscription"
                                ? "rgba(230, 126, 34, 0.15)"
                                : tx.type === "shop_purchase"
                                ? "rgba(168, 85, 247, 0.15)"
                                : tx.type === "credit_topup"
                                ? "rgba(46, 204, 113, 0.15)"
                                : "rgba(156, 163, 175, 0.15)",
                            color:
                              tx.type === "subscription"
                                ? "#e67e22"
                                : tx.type === "shop_purchase"
                                ? "#a855f7"
                                : tx.type === "credit_topup"
                                ? "#2ecc71"
                                : "#9ca3af",
                            border: "1px solid currentColor",
                          }}
                        >
                          {t(KIND_KEYS[tx.type] ?? "tl.kindRefund")}
                        </span>
                      </td>

                      <td style={{ fontSize: 13, color: "var(--text, #eeeeee)", maxWidth: 220, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {tx.item_title}
                      </td>

                      <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", fontWeight: 700, color: tx.amount_rub > 0 ? "var(--text, #eeeeee)" : "var(--muted, #9ca3af)" }}>
                        {tx.amount_rub > 0 ? `${tx.amount_rub.toLocaleString(locale)} ₽` : "—"}
                      </td>

                      <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", color: tx.amount_credits > 0 ? "#38bdf8" : "var(--muted, #9ca3af)" }}>
                        {tx.amount_credits > 0 ? t("tl.creditsAmount", { value: tx.amount_credits.toLocaleString(locale) }) : "—"}
                      </td>

                      <td style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: "var(--muted, #9ca3af)", textTransform: "uppercase" }}>
                        {t(METHOD_KEYS[tx.payment_method ?? ""] ?? "tl.methodAdmin")}
                      </td>

                      <td>
                        <span
                          style={{
                            fontSize: 10,
                            padding: "2px 6px",
                            borderRadius: 2,
                            fontFamily: "ui-monospace, monospace",
                            background: isRefunded ? "rgba(231, 76, 60, 0.15)" : "rgba(46, 204, 113, 0.15)",
                            color: isRefunded ? "#e74c3c" : "#2ecc71",
                            border: `1px solid ${isRefunded ? "#e74c3c" : "#2ecc71"}`,
                          }}
                        >
                          {isRefunded ? t("tl.stateRefunded") : t("tl.statePaid")}
                        </span>
                      </td>

                      <td style={{ textAlign: "right" }}>
                        {!isRefunded && tx.type !== "admin_grant" && (
                          <button
                            type="button"
                            onClick={() => handleRefund(tx.id)}
                            disabled={refundingId === tx.id}
                            style={{
                              padding: "2px 6px",
                              fontSize: 10,
                              borderColor: "rgba(231, 76, 60, 0.3)",
                              color: "#e74c3c",
                            }}
                          >
                            {refundingId === tx.id ? "..." : t("tl.refund")}
                          </button>
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
    </div>
  );
}
