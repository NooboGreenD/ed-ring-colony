"use client";

import React, { useState } from "react";
import type { ProjectBillingStats, ChartDataPoint, PilotGrowthPoint } from "@/types/billing";
import {
  IconActivity,
  IconChart,
  IconCoins,
  IconBuilding,
  IconAnchor,
  IconRadio,
  IconUsers,
  IconSatellite,
} from "@/components/Icons";

interface Props {
  stats: ProjectBillingStats;
  period: "7d" | "30d" | "90d" | "1y" | "all";
  onPeriodChange: (p: "7d" | "30d" | "90d" | "1y" | "all") => void;
  onRefresh: () => void;
  onExport: (format: "json" | "csv") => void;
  loading: boolean;
}

export default function BillingInfographics({
  stats,
  period,
  onPeriodChange,
  onRefresh,
  onExport,
  loading,
}: Props) {
  const [hoveredRevenue, setHoveredRevenue] = useState<ChartDataPoint | null>(null);
  const [hoveredGrowth, setHoveredGrowth] = useState<PilotGrowthPoint | null>(null);

  const { kpis, charts, telemetry } = stats;

  // Max value for revenue chart
  const maxRevenue = Math.max(100, ...charts.revenueTimeline.map((p) => p.total));
  const maxPilots = Math.max(100, ...charts.pilotGrowth.map((p) => p.totalPilots));

  return (
    <div className="billing-infographics" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* ── Top Bar: Period Switcher & Actions ── */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
          padding: "12px 16px",
          background: "#25282b",
          border: "1px solid var(--line, #3a3d40)",
          borderRadius: 2,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: 11,
              fontFamily: "ui-monospace, monospace",
              color: "var(--muted, #9ca3af)",
              textTransform: "uppercase",
              letterSpacing: 1,
              marginRight: 6,
            }}
          >
            Период выборки:
          </span>
          {(["7d", "30d", "90d", "1y", "all"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onPeriodChange(p)}
              style={{
                padding: "4px 10px",
                fontSize: 11,
                fontFamily: "ui-monospace, monospace",
                border: period === p ? "1px solid var(--orange, #e67e22)" : "1px solid var(--line, #3a3d40)",
                color: period === p ? "var(--orange, #e67e22)" : "var(--muted, #9ca3af)",
                background: period === p ? "rgba(230, 126, 34, 0.12)" : "transparent",
                borderRadius: 2,
                cursor: "pointer",
              }}
            >
              {p === "7d"
                ? "7 ДНЕЙ"
                : p === "30d"
                ? "30 ДНЕЙ"
                : p === "90d"
                ? "90 ДНЕЙ"
                : p === "1y"
                ? "1 ГОД"
                : "ВСЁ ВРЕМЯ"}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 12px",
              fontSize: 11,
              border: "1px solid var(--line, #3a3d40)",
              color: "var(--text, #eeeeee)",
            }}
          >
            <IconActivity size={12} color="#e67e22" />
            {loading ? "Сбор данных..." : "Обновить телеметрию"}
          </button>

          <button
            type="button"
            onClick={() => onExport("csv")}
            style={{
              padding: "5px 12px",
              fontSize: 11,
              border: "1px solid var(--line, #3a3d40)",
              color: "var(--cyan, #3498db)",
            }}
          >
            CSV Экспорт
          </button>
          <button
            type="button"
            onClick={() => onExport("json")}
            style={{
              padding: "5px 12px",
              fontSize: 11,
              border: "1px solid var(--line, #3a3d40)",
              color: "var(--cyan, #3498db)",
            }}
          >
            JSON
          </button>
        </div>
      </div>

      {/* ── Key Performance Indicators (KPI HUD Cards) ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 14,
        }}
      >
        {/* MRR */}
        <div className="card" style={{ margin: 0, padding: "16px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <span style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: "var(--muted, #9ca3af)", letterSpacing: 1.5, textTransform: "uppercase" }}>
              MRR (Выручка/мес)
            </span>
            <span style={{ fontSize: 11, color: "#2ecc71", fontFamily: "ui-monospace, monospace", fontWeight: 700 }}>
              +{kpis.mrrDelta}% ▲
            </span>
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "var(--orange, #e67e22)", margin: "8px 0 4px" }}>
            {kpis.mrr.toLocaleString("ru-RU")} ₽
          </div>
          <div style={{ fontSize: 11, color: "var(--muted, #9ca3af)" }}>
            ARR: {(kpis.mrr * 12).toLocaleString("ru-RU")} ₽ / год
          </div>
        </div>

        {/* Gross Revenue */}
        <div className="card" style={{ margin: 0, padding: "16px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <span style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: "var(--muted, #9ca3af)", letterSpacing: 1.5, textTransform: "uppercase" }}>
              Валовый доход
            </span>
            <span style={{ fontSize: 11, color: "#2ecc71", fontFamily: "ui-monospace, monospace", fontWeight: 700 }}>
              +{kpis.grossRevenueDelta}% ▲
            </span>
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "#3498db", margin: "8px 0 4px" }}>
            {kpis.grossRevenue.toLocaleString("ru-RU")} ₽
          </div>
          <div style={{ fontSize: 11, color: "var(--muted, #9ca3af)" }}>
            Включая магазин и пополнения
          </div>
        </div>

        {/* Active Subscribers */}
        <div className="card" style={{ margin: 0, padding: "16px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <span style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: "var(--muted, #9ca3af)", letterSpacing: 1.5, textTransform: "uppercase" }}>
              Премиум-пилоты
            </span>
            <span style={{ fontSize: 11, color: "#2ecc71", fontFamily: "ui-monospace, monospace", fontWeight: 700 }}>
              +{kpis.activeSubscribersDelta}% ▲
            </span>
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "#a855f7", margin: "8px 0 4px" }}>
            {kpis.activeSubscribers}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted, #9ca3af)" }}>
            Отток (Churn): {kpis.churnRate}% / мес
          </div>
        </div>

        {/* ARPU */}
        <div className="card" style={{ margin: 0, padding: "16px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <span style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: "var(--muted, #9ca3af)", letterSpacing: 1.5, textTransform: "uppercase" }}>
              ARPU (Доход/пилот)
            </span>
            <span style={{ fontSize: 11, color: "var(--muted, #9ca3af)", fontFamily: "ui-monospace, monospace" }}>
              LTV ~4 800 ₽
            </span>
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "#2ecc71", margin: "8px 0 4px" }}>
            {kpis.arpu.toLocaleString("ru-RU")} ₽
          </div>
          <div style={{ fontSize: 11, color: "var(--muted, #9ca3af)" }}>
            Средний чек: {kpis.averageOrderValue.toLocaleString("ru-RU")} ₽
          </div>
        </div>

        {/* Cosmetics Sold */}
        <div className="card" style={{ margin: 0, padding: "16px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <span style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: "var(--muted, #9ca3af)", letterSpacing: 1.5, textTransform: "uppercase" }}>
              Продажи магазина
            </span>
            <span style={{ fontSize: 11, color: "var(--muted, #9ca3af)", fontFamily: "ui-monospace, monospace" }}>
              {kpis.cosmeticsSoldTotal} шт
            </span>
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "#fbbf24", margin: "8px 0 4px" }}>
            {kpis.cosmeticsRevenue.toLocaleString("ru-RU")} ₽
          </div>
          <div style={{ fontSize: 11, color: "var(--muted, #9ca3af)" }}>
            Рамки, темы, свечения, значки
          </div>
        </div>
      </div>

      {/* ── Infographics Chart 1: Revenue Dynamics (Bar & Stacked HUD Chart) ── */}
      <div className="card" style={{ margin: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
              <IconChart size={16} color="#e67e22" />
              ДИНАМИКА ДОХОДОВ И ПОДПИСОК (MRR / STORE)
            </h3>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--muted, #9ca3af)" }}>
              Распределение выручки между регулярными подписками и покупками в премиум-магазине
            </p>
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 11, fontFamily: "ui-monospace, monospace" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 10, height: 10, background: "#e67e22", borderRadius: 1 }} />
              Подписки
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 10, height: 10, background: "#3498db", borderRadius: 1 }} />
              Магазин UI
            </span>
          </div>
        </div>

        {/* Hover info tooltip */}
        <div
          style={{
            minHeight: 28,
            fontSize: 12,
            fontFamily: "ui-monospace, monospace",
            color: "var(--text, #eeeeee)",
            marginBottom: 8,
          }}
        >
          {hoveredRevenue ? (
            <span style={{ background: "#1e2022", padding: "4px 10px", border: "1px solid var(--line, #3a3d40)", borderRadius: 2 }}>
              Срез от {hoveredRevenue.date}: Итого <strong style={{ color: "#e67e22" }}>{hoveredRevenue.total.toLocaleString("ru-RU")} ₽</strong> (Подписки: {hoveredRevenue.subscriptions.toLocaleString("ru-RU")} ₽ | Магазин: {hoveredRevenue.shop.toLocaleString("ru-RU")} ₽)
            </span>
          ) : (
            <span style={{ color: "var(--muted, #9ca3af)" }}>
              Наведите курсор на колонку для детализации финансового среза
            </span>
          )}
        </div>

        {/* Visual Bar Chart */}
        <div
          style={{
            height: 190,
            display: "flex",
            alignItems: "flex-end",
            gap: 10,
            paddingTop: 10,
            borderBottom: "1px solid var(--line, #3a3d40)",
          }}
        >
          {charts.revenueTimeline.map((item, idx) => {
            const totalHeightPct = Math.min(100, Math.round((item.total / (maxRevenue || 1)) * 100));
            const subPct = item.total > 0 ? (item.subscriptions / item.total) * 100 : 60;
            const shopPct = 100 - subPct;

            return (
              <div
                key={idx}
                onMouseEnter={() => setHoveredRevenue(item)}
                onMouseLeave={() => setHoveredRevenue(null)}
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  height: "100%",
                  justifyContent: "flex-end",
                  cursor: "pointer",
                }}
              >
                <div
                  style={{
                    width: "100%",
                    maxWidth: 34,
                    height: `${Math.max(6, totalHeightPct)}%`,
                    display: "flex",
                    flexDirection: "column",
                    background: "rgba(230, 126, 34, 0.15)",
                    border: "1px solid rgba(230, 126, 34, 0.4)",
                    borderRadius: "2px 2px 0 0",
                    transition: "all 0.2s ease",
                    overflow: "hidden",
                    position: "relative",
                  }}
                >
                  {/* Subscription portion */}
                  <div
                    style={{
                      height: `${subPct}%`,
                      background: "rgba(230, 126, 34, 0.75)",
                    }}
                  />
                  {/* Shop portion */}
                  <div
                    style={{
                      height: `${shopPct}%`,
                      background: "rgba(52, 152, 219, 0.75)",
                    }}
                  />
                </div>
                <span
                  style={{
                    fontSize: 10,
                    fontFamily: "ui-monospace, monospace",
                    color: "var(--muted, #9ca3af)",
                    marginTop: 8,
                  }}
                >
                  {item.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Grid: Tiers Radial Ring + Category Sales Breakdown ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 20,
        }}
      >
        {/* Tier Distribution Infographic */}
        <div className="card" style={{ margin: 0 }}>
          <h3 style={{ margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
            <IconCoins size={16} color="#e67e22" />
            РАСПРЕДЕЛЕНИЕ ТАРИФОВ ПОДПИСКИ
          </h3>
          <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--muted, #9ca3af)" }}>
            Доли активных премиум-командиров по категориям привилегий
          </p>

          <div style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
            {/* Donut Ring Infographic */}
            <div style={{ position: "relative", width: 130, height: 130, flexShrink: 0 }}>
              <svg viewBox="0 0 42 42" style={{ width: "100%", height: "100%", transform: "rotate(-90deg)" }}>
                <circle cx="21" cy="21" r="15.915" fill="transparent" stroke="#25282b" strokeWidth="6" />
                {(() => {
                  let accumulatedOffset = 0;
                  return charts.tierDistribution.map((t, i) => {
                    const strokeDasharray = `${t.percentage} ${100 - t.percentage}`;
                    const strokeDashoffset = -accumulatedOffset;
                    accumulatedOffset += t.percentage;
                    return (
                      <circle
                        key={i}
                        cx="21"
                        cy="21"
                        r="15.915"
                        fill="transparent"
                        stroke={t.color}
                        strokeWidth="6"
                        strokeDasharray={strokeDasharray}
                        strokeDashoffset={strokeDashoffset}
                      />
                    );
                  });
                })()}
              </svg>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                <span style={{ fontSize: 18, fontWeight: 700, color: "var(--text, #eeeeee)" }}>
                  {stats.kpis.activeSubscribers}
                </span>
                <span style={{ fontSize: 9, color: "var(--muted, #9ca3af)", letterSpacing: 1 }}>
                  СУБСКРИБЕРОВ
                </span>
              </div>
            </div>

            {/* Legend & Details */}
            <div style={{ flex: 1, minWidth: 160, display: "flex", flexDirection: "column", gap: 10 }}>
              {charts.tierDistribution.map((tier) => (
                <div
                  key={tier.planId}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: 12,
                    fontFamily: "ui-monospace, monospace",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 10, height: 10, background: tier.color, borderRadius: 1 }} />
                    <span style={{ color: "var(--text, #eeeeee)" }}>{tier.name}</span>
                  </div>
                  <div style={{ display: "flex", gap: 12 }}>
                    <span style={{ color: "var(--muted, #9ca3af)" }}>{tier.count} пил.</span>
                    <strong style={{ color: tier.color, minWidth: 32, textAlign: "right" }}>
                      {tier.percentage}%
                    </strong>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Shop Category Sales Gauges */}
        <div className="card" style={{ margin: 0 }}>
          <h3 style={{ margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
            <IconActivity size={16} color="#e67e22" />
            ПРОДАЖИ ПО КАТЕГОРИЯМ МАГАЗИНА
          </h3>
          <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--muted, #9ca3af)" }}>
            Спрос на визуальные модификации интерфейса и позывного
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {charts.categorySales.map((cat) => (
              <div key={cat.category}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 12,
                    fontFamily: "ui-monospace, monospace",
                    marginBottom: 4,
                  }}
                >
                  <span style={{ color: "var(--text, #eeeeee)" }}>{cat.name}</span>
                  <span style={{ color: "var(--muted, #9ca3af)" }}>
                    <strong style={{ color: cat.color }}>{cat.unitsSold} шт</strong> · {cat.revenueRub.toLocaleString("ru-RU")} ₽ ({cat.percentage}%)
                  </span>
                </div>
                <div style={{ height: 6, background: "#25282b", borderRadius: 2, overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${cat.percentage}%`,
                      background: cat.color,
                      transition: "width 0.6s ease",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Grid: Conversion Funnel + Colony Infrastructure Telemetry ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 20,
        }}
      >
        {/* Conversion Funnel */}
        <div className="card" style={{ margin: 0 }}>
          <h3 style={{ margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
            <IconUsers size={16} color="#e67e22" />
            ВОРОНКА КОНВЕРСИИ КОММАНДЕРОВ
          </h3>
          <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--muted, #9ca3af)" }}>
            Путь от первого посещения портала до высшего ранга мецената
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {charts.conversionFunnel.map((step, idx) => (
              <div key={idx}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: 12,
                    fontFamily: "ui-monospace, monospace",
                    marginBottom: 3,
                  }}
                >
                  <span style={{ color: "var(--text, #eeeeee)" }}>{step.step}</span>
                  <span>
                    <strong style={{ color: "#e67e22" }}>{step.count.toLocaleString("ru-RU")}</strong>
                    <span style={{ color: "var(--muted, #9ca3af)", marginLeft: 6 }}>
                      ({step.percentage}%)
                    </span>
                  </span>
                </div>
                <div style={{ height: 5, background: "#25282b", borderRadius: 2, overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${Math.max(4, step.percentage)}%`,
                      background:
                        idx === 0
                          ? "#3498db"
                          : idx === 1
                          ? "#06b6d4"
                          : idx === 2
                          ? "#2ecc71"
                          : idx === 3
                          ? "#f39c12"
                          : idx === 4
                          ? "#e67e22"
                          : "#9b59b6",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Colony Infrastructure & Operations Telemetry */}
        <div className="card" style={{ margin: 0 }}>
          <h3 style={{ margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
            <IconSatellite size={16} color="#e67e22" />
            ТЕЛЕМЕТРИЯ СЕТИ И КОЛОНИЗАЦИИ
          </h3>
          <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--muted, #9ca3af)" }}>
            Инфраструктурные показатели и техническое состояние узла
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
            }}
          >
            <div style={{ padding: "10px 12px", background: "#25282b", border: "1px solid var(--line, #3a3d40)", borderRadius: 2 }}>
              <div style={{ fontSize: 10, color: "var(--muted, #9ca3af)", textTransform: "uppercase", letterSpacing: 1 }}>
                Заявлено систем
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "#3498db", marginTop: 4 }}>
                {telemetry.totalSystemsClaimed} хабов
              </div>
            </div>

            <div style={{ padding: "10px 12px", background: "#25282b", border: "1px solid var(--line, #3a3d40)", borderRadius: 2 }}>
              <div style={{ fontSize: 10, color: "var(--muted, #9ca3af)", textTransform: "uppercase", letterSpacing: 1 }}>
                Построено станций
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "#2ecc71", marginTop: 4 }}>
                {telemetry.totalFacilitiesBuilt} объектов
              </div>
            </div>

            <div style={{ padding: "10px 12px", background: "#25282b", border: "1px solid var(--line, #3a3d40)", borderRadius: 2 }}>
              <div style={{ fontSize: 10, color: "var(--muted, #9ca3af)", textTransform: "uppercase", letterSpacing: 1 }}>
                Доставлено груза
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "#e67e22", marginTop: 4 }}>
                {telemetry.totalTonnageHauled.toLocaleString("ru-RU")} т
              </div>
            </div>

            <div style={{ padding: "10px 12px", background: "#25282b", border: "1px solid var(--line, #3a3d40)", borderRadius: 2 }}>
              <div style={{ fontSize: 10, color: "var(--muted, #9ca3af)", textTransform: "uppercase", letterSpacing: 1 }}>
                Парсер журналов
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "#a855f7", marginTop: 4 }}>
                {telemetry.journalEventsParsed.toLocaleString("ru-RU")} соб.
              </div>
            </div>

            <div style={{ padding: "10px 12px", background: "#25282b", border: "1px solid var(--line, #3a3d40)", borderRadius: 2 }}>
              <div style={{ fontSize: 10, color: "var(--muted, #9ca3af)", textTransform: "uppercase", letterSpacing: 1 }}>
                Отклик сервера
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "#10b981", marginTop: 4 }}>
                {telemetry.avgLatencyMs} ms
              </div>
            </div>

            <div style={{ padding: "10px 12px", background: "#25282b", border: "1px solid var(--line, #3a3d40)", borderRadius: 2 }}>
              <div style={{ fontSize: 10, color: "var(--muted, #9ca3af)", textTransform: "uppercase", letterSpacing: 1 }}>
                Аптайм платформы
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "#2ecc71", marginTop: 4 }}>
                {telemetry.serverUptimePct}%
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
