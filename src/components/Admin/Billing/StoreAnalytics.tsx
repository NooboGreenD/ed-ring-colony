"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import type { ShopItem, ProjectBillingStats } from "@/types/billing";
import { IconStore, IconExternalLink, IconDiamond, IconCrown, IconSearch } from "@/components/Icons";
import { authFetch } from "@/lib/supabaseClient";
import CosmeticAvatar from "@/components/Cosmetics/CosmeticAvatar";
import CosmeticBadge from "@/components/Cosmetics/CosmeticBadge";
import CosmeticCallsign from "@/components/Cosmetics/CosmeticCallsign";
import CosmeticTitle from "@/components/Cosmetics/CosmeticTitle";

interface Props {
  stats: ProjectBillingStats;
}

export default function StoreAnalytics({ stats }: Props) {
  const [items, setItems] = useState<ShopItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    authFetch("/api/shop/items")
      .then((res) => res.json())
      .then((data) => {
        if (data.success) setItems(data.items || []);
      })
      .finally(() => setLoading(false));
  }, []);

  const filteredItems = items.filter((i) => {
    if (categoryFilter !== "all" && i.category !== categoryFilter) return false;
    if (search && !i.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* ── Top Bar & Link to WIP Store ── */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
          padding: "16px 20px",
          background: "linear-gradient(90deg, rgba(230,126,34,0.1) 0%, rgba(52,152,219,0.05) 100%)",
          border: "1px solid rgba(230,126,34,0.3)",
          borderRadius: 2,
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontSize: 10,
                padding: "2px 6px",
                background: "rgba(230,126,34,0.2)",
                color: "#e67e22",
                border: "1px solid #e67e22",
                fontWeight: 700,
                letterSpacing: 1,
              }}
            >
              WIP // CLOSED BETA
            </span>
            <h3 style={{ margin: 0, color: "var(--text, #eeeeee)", fontSize: 16 }}>
              МОДУЛЬ ПРЕМИУМ-МАГАЗИНА ДЛЯ ПОЛЬЗОВАТЕЛЕЙ
            </h3>
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--muted, #9ca3af)" }}>
            Страница магазина скрыта от общего меню и находится на этапе разработки и тестирования.
          </p>
        </div>

        <Link
          href="/premium-shop"
          target="_blank"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 18px",
            background: "rgba(230,126,34,0.15)",
            border: "1px solid var(--orange, #e67e22)",
            color: "var(--orange, #e67e22)",
            fontFamily: "ui-monospace, monospace",
            fontSize: 12,
            letterSpacing: 1.5,
            textTransform: "uppercase",
            borderRadius: 2,
          }}
        >
          <IconStore size={14} color="#e67e22" />
          <span>Перейти в закрытый магазин (Beta)</span>
          <IconExternalLink size={12} />
        </Link>
      </div>

      {/* ── Top Spenders Commercial Leaderboard ── */}
      <div className="card" style={{ margin: 0 }}>
        <h3 style={{ margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
          <IconCrown size={16} color="#fbbf24" />
          ТОП МЕЦЕНАТОВ И ПОКУПАТЕЛЕЙ КОЛОНИИ
        </h3>
        <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--muted, #9ca3af)" }}>
          Пилоты, внесшие наибольший вклад в финансирование инфраструктуры и приобретение модификаций
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 12,
          }}
        >
          {stats.topSpenders.map((spender, idx) => (
            <div
              key={idx}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 14px",
                background: "#25282b",
                border: "1px solid var(--line, #3a3d40)",
                borderRadius: 2,
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 2,
                  background:
                    idx === 0
                      ? "rgba(251, 191, 36, 0.2)"
                      : idx === 1
                      ? "rgba(156, 163, 175, 0.2)"
                      : "rgba(230, 126, 34, 0.15)",
                  color: idx === 0 ? "#fbbf24" : idx === 1 ? "#e5e7eb" : "#e67e22",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: "ui-monospace, monospace",
                  fontWeight: 700,
                  fontSize: 12,
                  flexShrink: 0,
                }}
              >
                #{idx + 1}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: "var(--text, #eeeeee)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {spender.cmdrName}
                </div>
                <div style={{ fontSize: 11, color: "var(--muted, #9ca3af)", fontFamily: "ui-monospace, monospace" }}>
                  {spender.purchasesCount} операций · <strong style={{ color: "var(--orange, #e67e22)" }}>{spender.totalSpentRub.toLocaleString("ru-RU")} ₽</strong>
                </div>
              </div>

              <span
                style={{
                  fontSize: 9,
                  padding: "1px 4px",
                  borderRadius: 2,
                  background: "rgba(155, 89, 182, 0.2)",
                  color: "#c084fc",
                  border: "1px solid #9b59b6",
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                {spender.tier}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Cosmetic Catalog Analytics Table ── */}
      <div className="card" style={{ margin: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
          <div>
            <h3 style={{ margin: 0 }}>КАТАЛОГ ПРЕДМЕТОВ И СТАТИСТИКА ПРОДАЖ</h3>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--muted, #9ca3af)" }}>
              Популярность и доходность каждой косметической модификации
            </p>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ position: "relative", minWidth: 200 }}>
              <input
                type="text"
                placeholder="Поиск по названию..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ width: "100%", paddingLeft: 28 }}
              />
              <span style={{ position: "absolute", left: 8, top: 11, pointerEvents: "none" }}>
                <IconSearch size={14} color="#9ca3af" />
              </span>
            </div>

            <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              <option value="all">Все категории</option>
              <option value="frame">Рамки аватара</option>
              <option value="badge">Знаки отличия</option>
              <option value="skin">HUD-темы интерфейса</option>
              <option value="glow">Свечение ника</option>
              <option value="title">Почетные титулы</option>
            </select>
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>ПРЕВЬЮ / НАЗВАНИЕ</th>
                <th style={{ textAlign: "left" }}>КАТЕГОРИЯ</th>
                <th style={{ textAlign: "left" }}>РЕДКОСТЬ</th>
                <th style={{ textAlign: "right" }}>ЦЕНА В КРЕДИТАХ</th>
                <th style={{ textAlign: "right" }}>ЦЕНА В РУБЛЯХ</th>
                <th style={{ textAlign: "right" }}>ПРОДАНО ШТУК</th>
                <th style={{ textAlign: "right" }}>ДОХОД (ОЦЕНКА)</th>
                <th style={{ textAlign: "center" }}>СТАТУС</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: "center", padding: 24, color: "var(--muted, #9ca3af)" }}>
                    Загрузка каталога...
                  </td>
                </tr>
              ) : (
                filteredItems.map((item) => {
                  const estRev = (item.sales_count || 0) * item.price_rub;
                  return (
                    <tr key={item.id}>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          {item.category === "frame" && (
                            <CosmeticAvatar frameId={item.id} size={32} />
                          )}
                          {item.category === "badge" && (
                            <CosmeticBadge badgeId={item.id} size={24} />
                          )}
                          {item.category === "glow" && (
                            <CosmeticCallsign name="CMDR" glowId={item.id} fontSize={12} />
                          )}
                          {item.category === "title" && (
                            <CosmeticTitle titleId={item.id} />
                          )}
                          {item.category === "skin" && (
                            <span
                              style={{
                                width: 24,
                                height: 16,
                                background: item.preview_data.color || "#e67e22",
                                borderRadius: 2,
                                display: "inline-block",
                                border: "1px solid rgba(255,255,255,0.2)",
                              }}
                            />
                          )}

                          <div>
                            <div style={{ fontWeight: 600, color: "var(--text, #eeeeee)" }}>{item.title}</div>
                            <div style={{ fontSize: 11, color: "var(--muted, #9ca3af)" }}>{item.id}</div>
                          </div>
                        </div>
                      </td>

                      <td style={{ fontSize: 12, color: "var(--muted, #9ca3af)", textTransform: "uppercase" }}>
                        {item.category === "frame"
                          ? "Рамка"
                          : item.category === "badge"
                          ? "Знак отличия"
                          : item.category === "skin"
                          ? "HUD-тема"
                          : item.category === "glow"
                          ? "Свечение"
                          : "Титул"}
                      </td>

                      <td>
                        <span
                          style={{
                            fontSize: 10,
                            padding: "2px 6px",
                            borderRadius: 2,
                            fontFamily: "ui-monospace, monospace",
                            textTransform: "uppercase",
                            background:
                              item.rarity === "legendary"
                                ? "rgba(234, 179, 8, 0.15)"
                                : item.rarity === "epic"
                                ? "rgba(168, 85, 247, 0.15)"
                                : item.rarity === "rare"
                                ? "rgba(56, 189, 248, 0.15)"
                                : "rgba(156, 163, 175, 0.15)",
                            color:
                              item.rarity === "legendary"
                                ? "#fbbf24"
                                : item.rarity === "epic"
                                ? "#c084fc"
                                : item.rarity === "rare"
                                ? "#38bdf8"
                                : "#9ca3af",
                            border: "1px solid currentColor",
                          }}
                        >
                          {item.rarity}
                        </span>
                      </td>

                      <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", color: "#38bdf8" }}>
                        {item.price_credits.toLocaleString("ru-RU")} Кр.
                      </td>

                      <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", color: "var(--text, #eeeeee)" }}>
                        {item.price_rub} ₽
                      </td>

                      <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", fontWeight: 700, color: "var(--orange, #e67e22)" }}>
                        {item.sales_count || 0}
                      </td>

                      <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", color: "var(--text, #eeeeee)" }}>
                        {estRev.toLocaleString("ru-RU")} ₽
                      </td>

                      <td style={{ textAlign: "center" }}>
                        <span style={{ fontSize: 10, color: "#2ecc71", fontFamily: "ui-monospace, monospace" }}>
                          АКТИВЕН
                        </span>
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
