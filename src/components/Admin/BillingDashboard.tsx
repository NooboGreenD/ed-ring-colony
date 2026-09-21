"use client";

import React, { useState, useEffect, useCallback } from "react";
import type { ProjectBillingStats } from "@/types/billing";
import BillingInfographics from "./Billing/BillingInfographics";
import SubscriptionManager from "./Billing/SubscriptionManager";
import TransactionLedger from "./Billing/TransactionLedger";
import StoreAnalytics from "./Billing/StoreAnalytics";
import ProductManager from "./Billing/ProductManager";
import PaymentProvidersPanel from "./Billing/PaymentProvidersPanel";
import PaymentsPanel from "./Billing/PaymentsPanel";
import { authFetch } from "@/lib/supabaseClient";
import { IconChart, IconCoins, IconCreditCard, IconStore, IconActivity, IconSettings } from "@/components/Icons";

interface Props {
  currentUser?: {
    cmdr_name?: string | null;
    email?: string | null;
    role?: string | null;
  } | null;
}

export default function BillingDashboard({ currentUser }: Props) {
  const [subTab, setSubTab] = useState<"infographics" | "products" | "subscriptions" | "payments" | "providers" | "transactions" | "store">("infographics");
  const [period, setPeriod] = useState<"7d" | "30d" | "90d" | "1y" | "all">("30d");
  const [stats, setStats] = useState<ProjectBillingStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`/api/admin/billing/stats?period=${period}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Не удалось загрузить статистику");
      }
      setStats(data.stats);
    } catch (err: any) {
      console.error("[BillingDashboard] Error fetching stats:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const handleExport = (format: "json" | "csv") => {
    window.open(`/api/admin/billing/export?format=${format}`, "_blank");
  };

  return (
    <div className="billing-system" style={{ width: "100%", display: "flex", flexDirection: "column", gap: 20 }}>
      {/* ── Sub-navigation Tabs ── */}
      <div
        className="tabs"
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          borderBottom: "1px solid var(--line, #3a3d40)",
          paddingBottom: 10,
        }}
      >
        <button
          type="button"
          className={subTab === "infographics" ? "tab tab-active" : "tab"}
          onClick={() => setSubTab("infographics")}
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          <IconChart size={13} />
          ИНФОГРАФИКА И МЕТРИКИ
        </button>

        <button
          type="button"
          className={subTab === "subscriptions" ? "tab tab-active" : "tab"}
          onClick={() => setSubTab("subscriptions")}
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          <IconCoins size={13} />
          УПРАВЛЕНИЕ ПОДПИСКАМИ
        </button>

        <button type="button" className={subTab === "products" ? "tab tab-active" : "tab"} onClick={() => setSubTab("products")} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <IconStore size={13} />
          ТОВАРЫ МАГАЗИНА
        </button>

        <button type="button" className={subTab === "payments" ? "tab tab-active" : "tab"} onClick={() => setSubTab("payments")} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <IconCreditCard size={13} />
          ПЛАТЕЖИ И НАСТРОЙКИ
        </button>

        <button type="button" className={subTab === "providers" ? "tab tab-active" : "tab"} onClick={() => setSubTab("providers")} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <IconSettings size={13} />
          ПЛАТЁЖНЫЕ СИСТЕМЫ
        </button>

        <button
          type="button"
          className={subTab === "transactions" ? "tab tab-active" : "tab"}
          onClick={() => setSubTab("transactions")}
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          <IconActivity size={13} />
          РЕЕСТР ТРАНЗАКЦИЙ
        </button>

        <button
          type="button"
          className={subTab === "store" ? "tab tab-active" : "tab"}
          onClick={() => setSubTab("store")}
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          <IconStore size={13} />
          АНАЛИТИКА МАГАЗИНА
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: "12px 16px",
            background: "rgba(231, 76, 60, 0.15)",
            border: "1px solid #e74c3c",
            color: "#e74c3c",
            borderRadius: 2,
            fontSize: 13,
          }}
        >
          Ошибка загрузки данных: {error}
        </div>
      )}

      {/* ── Tab Views ── */}
      {subTab === "infographics" && (
        <>
          {loading && !stats ? (
            <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--muted, #9ca3af)" }}>
              Инициализация системы сбора статистики и аналитики...
            </div>
          ) : stats ? (
            <BillingInfographics
              stats={stats}
              period={period}
              onPeriodChange={setPeriod}
              onRefresh={fetchStats}
              onExport={handleExport}
              loading={loading}
            />
          ) : null}
        </>
      )}

      {subTab === "subscriptions" && (
        <SubscriptionManager
          currentAdminCmdr={currentUser?.cmdr_name || "Администратор"}
          onRefreshStats={fetchStats}
        />
      )}

      {subTab === "products" && <ProductManager onChanged={fetchStats} />}
      {subTab === "payments" && <PaymentsPanel onChanged={fetchStats} />}
      {subTab === "providers" && <PaymentProvidersPanel />}

      {subTab === "transactions" && (
        <TransactionLedger onRefreshStats={fetchStats} />
      )}

      {subTab === "store" && stats && (
        <StoreAnalytics stats={stats} />
      )}
    </div>
  );
}
