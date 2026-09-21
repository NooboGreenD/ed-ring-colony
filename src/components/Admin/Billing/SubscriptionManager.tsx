"use client";

import React, { useState, useEffect, useCallback } from "react";
import type { BillingPlan, UserSubscription } from "@/types/billing";
import { IconCheck, IconCrown, IconSearch, IconX, IconRefresh } from "@/components/Icons";

interface Props {
  currentAdminCmdr?: string;
  onRefreshStats?: () => void;
}

export default function SubscriptionManager({ currentAdminCmdr, onRefreshStats }: Props) {
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [subscriptions, setSubscriptions] = useState<UserSubscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [planFilter, setPlanFilter] = useState("all");

  // Grant Modal
  const [showGrantModal, setShowGrantModal] = useState(false);
  const [grantCmdr, setGrantCmdr] = useState("");
  const [grantPlanId, setGrantPlanId] = useState("elite");
  const [grantDuration, setGrantDuration] = useState("30");
  const [grantNotes, setGrantNotes] = useState("");
  const [granting, setGranting] = useState(false);

  // Edit Plan Modal
  const [editingPlan, setEditingPlan] = useState<BillingPlan | null>(null);
  const [editPriceRub, setEditPriceRub] = useState(0);
  const [editPriceCredits, setEditPriceCredits] = useState(0);
  const [editPerks, setEditPerks] = useState<string[]>([]);
  const [savingPlan, setSavingPlan] = useState(false);

  // Status message
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const showToast = (text: string, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 4000);
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [plansRes, subsRes] = await Promise.all([
        fetch("/api/admin/billing/plans"),
        fetch(`/api/admin/billing/subscriptions?status=${statusFilter}&planId=${planFilter}&search=${encodeURIComponent(search)}`),
      ]);

      const plansData = await plansRes.json();
      const subsData = await subsRes.json();

      if (plansData.success) setPlans(plansData.plans || []);
      if (subsData.success) setSubscriptions(subsData.subscriptions || []);
    } catch (err: any) {
      showToast("Ошибка загрузки данных: " + err.message, false);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, planFilter, search]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleGrant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!grantCmdr.trim()) {
      showToast("Укажите позывной командира", false);
      return;
    }

    setGranting(true);
    try {
      const res = await fetch("/api/admin/billing/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "grant",
          cmdrName: grantCmdr.trim(),
          userId: `user-${grantCmdr.trim().toLowerCase().replace(/\s+/g, "_")}`,
          planId: grantPlanId,
          durationDays: Number(grantDuration),
          notes: grantNotes.trim() || "Назначено через панель администратора",
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка выдачи");

      showToast(`Подписка успешно выдана командиру ${grantCmdr}`);
      setShowGrantModal(false);
      setGrantCmdr("");
      setGrantNotes("");
      loadData();
      if (onRefreshStats) onRefreshStats();
    } catch (err: any) {
      showToast(err.message, false);
    } finally {
      setGranting(false);
    }
  };

  const handleExtend = async (subId: string, days = 30) => {
    try {
      const res = await fetch("/api/admin/billing/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "extend",
          subscriptionId: subId,
          durationDays: days,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showToast(`Подписка продлена на ${days} дней`);
      loadData();
      if (onRefreshStats) onRefreshStats();
    } catch (err: any) {
      showToast(err.message, false);
    }
  };

  const handleCancel = async (subId: string) => {
    if (!confirm("Вы уверены, что хотите отозвать эту подписку?")) return;
    try {
      const res = await fetch(`/api/admin/billing/subscriptions?id=${subId}&reason=Отозвано_администратором`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showToast("Подписка успешно отозвана");
      loadData();
      if (onRefreshStats) onRefreshStats();
    } catch (err: any) {
      showToast(err.message, false);
    }
  };

  const handleSelfVipGrant = async () => {
    const name = currentAdminCmdr || "Администратор";
    try {
      const res = await fetch("/api/admin/billing/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "grant",
          cmdrName: name,
          userId: "preview-user-guest",
          planId: "admiral",
          durationDays: 365,
          notes: "Тестовая VIP-подписка администратора",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showToast(`Вам активирована тестовая подписка «Флотоводец VIP» на 365 дней!`);
      loadData();
      if (onRefreshStats) onRefreshStats();
    } catch (err: any) {
      showToast(err.message, false);
    }
  };

  const handleSavePlan = async () => {
    if (!editingPlan) return;
    setSavingPlan(true);
    try {
      const res = await fetch("/api/admin/billing/plans", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingPlan.id,
          price_rub: editPriceRub,
          price_credits: editPriceCredits,
          perks: editPerks,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showToast(`Тариф «${editingPlan.name}» успешно обновлен`);
      setEditingPlan(null);
      loadData();
      if (onRefreshStats) onRefreshStats();
    } catch (err: any) {
      showToast(err.message, false);
    } finally {
      setSavingPlan(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
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

      {/* ── Action Bar: Plans Overview & Top Controls ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, color: "var(--text, #eeeeee)" }}>
            УПРАВЛЕНИЕ ТАРИФАМИ И ПОДПИСКАМИ
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--muted, #9ca3af)" }}>
            Назначение премиальных статусов, управление привилегиями и сроками действия
          </p>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={handleSelfVipGrant}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 14px",
              background: "rgba(155, 89, 182, 0.15)",
              borderColor: "#9b59b6",
              color: "#c084fc",
            }}
          >
            <IconCrown size={14} color="#c084fc" />
            Выдать VIP себе (Тест)
          </button>

          <button
            type="button"
            className="btn-orange"
            onClick={() => setShowGrantModal(true)}
            style={{ padding: "8px 16px" }}
          >
            + Выдать подписку
          </button>
        </div>
      </div>

      {/* ── Plan Cards Grid ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 16,
        }}
      >
        {plans.map((p) => {
          const subsCount = subscriptions.filter((s) => s.plan_id === p.id && s.status === "active").length;
          return (
            <div
              key={p.id}
              className="card"
              style={{
                margin: 0,
                borderTop: `3px solid ${p.color}`,
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                  <div>
                    <span
                      style={{
                        fontSize: 10,
                        padding: "1px 6px",
                        background: `${p.color}25`,
                        color: p.color,
                        border: `1px solid ${p.color}60`,
                        borderRadius: 2,
                        fontWeight: 700,
                        letterSpacing: 1,
                      }}
                    >
                      {p.badge_label}
                    </span>
                    <h3 style={{ margin: "6px 0 0", color: "var(--text, #eeeeee)", fontSize: 16 }}>{p.name}</h3>
                  </div>
                  <span style={{ fontSize: 11, color: "var(--muted, #9ca3af)", fontFamily: "ui-monospace, monospace" }}>
                    {subsCount} активных
                  </span>
                </div>

                <div style={{ margin: "10px 0 14px", display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ fontSize: 24, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: p.color }}>
                    {p.price_rub.toLocaleString("ru-RU")} ₽
                  </span>
                  <span style={{ fontSize: 12, color: "var(--muted, #9ca3af)" }}>/ 30 дней</span>
                  <span style={{ fontSize: 11, color: "var(--muted, #9ca3af)", marginLeft: 6 }}>
                    ({p.price_credits.toLocaleString("ru-RU")} Кр.)
                  </span>
                </div>

                <p style={{ fontSize: 12, color: "var(--muted, #9ca3af)", margin: "0 0 12px" }}>
                  {p.description}
                </p>

                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
                  {p.perks.map((perk, i) => (
                    <div key={i} style={{ fontSize: 12, color: "var(--text, #eeeeee)", display: "flex", gap: 6, alignItems: "flex-start" }}>
                      <span style={{ color: p.color }}>•</span>
                      <span>{perk}</span>
                    </div>
                  ))}
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  setEditingPlan(p);
                  setEditPriceRub(p.price_rub);
                  setEditPriceCredits(p.price_credits);
                  setEditPerks([...p.perks]);
                }}
                style={{
                  width: "100%",
                  padding: "6px 12px",
                  fontSize: 11,
                  border: "1px solid var(--line, #3a3d40)",
                  color: "var(--muted, #9ca3af)",
                }}
              >
                Настроить цену и перки
              </button>
            </div>
          );
        })}
      </div>

      {/* ── Subscribers Table Section ── */}
      <div className="card" style={{ margin: 0 }}>
        {/* Table Filters */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
            marginBottom: 16,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", flex: 1 }}>
            <div style={{ position: "relative", minWidth: 220 }}>
              <input
                type="text"
                placeholder="Поиск по позывному..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ width: "100%", paddingLeft: 30 }}
              />
              <span style={{ position: "absolute", left: 8, top: 11, pointerEvents: "none" }}>
                <IconSearch size={14} color="#9ca3af" />
              </span>
            </div>

            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">Все статусы</option>
              <option value="active">Только активные</option>
              <option value="trial">Пробные</option>
              <option value="canceled">Отмененные</option>
              <option value="expired">Истекшие</option>
            </select>

            <select value={planFilter} onChange={(e) => setPlanFilter(e.target.value)}>
              <option value="all">Все тарифы</option>
              <option value="pioneer">Пионер Кольца</option>
              <option value="elite">Элита Колонии</option>
              <option value="admiral">Флотоводец VIP</option>
            </select>
          </div>

          <div style={{ fontSize: 12, color: "var(--muted, #9ca3af)", fontFamily: "ui-monospace, monospace" }}>
            Найдено: {subscriptions.length} записей
          </div>
        </div>

        {/* Table */}
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>КОМАНДИР</th>
                <th style={{ textAlign: "left" }}>ТАРИФ</th>
                <th style={{ textAlign: "left" }}>СТАТУС</th>
                <th style={{ textAlign: "left" }}>СРОК ДЕЙСТВИЯ</th>
                <th style={{ textAlign: "left" }}>АВТОПРОДЛЕНИЕ</th>
                <th style={{ textAlign: "left" }}>ПРИМЕЧАНИЕ</th>
                <th style={{ textAlign: "right" }}>ДЕЙСТВИЯ</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: 24, color: "var(--muted, #9ca3af)" }}>
                    Загрузка подписок...
                  </td>
                </tr>
              ) : subscriptions.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: 24, color: "var(--muted, #9ca3af)" }}>
                    Подписки не найдены
                  </td>
                </tr>
              ) : (
                subscriptions.map((s) => {
                  const plan = s.plan || plans.find((p) => p.id === s.plan_id);
                  const isExpiring =
                    s.expires_at &&
                    new Date(s.expires_at).getTime() - Date.now() < 3 * 24 * 3600 * 1000 &&
                    new Date(s.expires_at).getTime() > Date.now();

                  return (
                    <tr key={s.id}>
                      <td style={{ fontWeight: 600, color: "var(--text, #eeeeee)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.status === "active" ? "#2ecc71" : "#e74c3c" }} />
                          {s.cmdr_name}
                        </div>
                      </td>

                      <td>
                        <span
                          style={{
                            fontSize: 10,
                            padding: "2px 6px",
                            borderRadius: 2,
                            background: `${plan?.color || "#3498db"}20`,
                            color: plan?.color || "#3498db",
                            border: `1px solid ${plan?.color || "#3498db"}50`,
                            fontFamily: "ui-monospace, monospace",
                            fontWeight: 700,
                          }}
                        >
                          {plan?.name || s.plan_id}
                        </span>
                      </td>

                      <td>
                        <span
                          style={{
                            fontSize: 11,
                            color:
                              s.status === "active"
                                ? isExpiring
                                  ? "#f39c12"
                                  : "#2ecc71"
                                : "#e74c3c",
                            fontFamily: "ui-monospace, monospace",
                            textTransform: "uppercase",
                          }}
                        >
                          {s.status === "active" ? (isExpiring ? "Истекает" : "Активна") : s.status}
                        </span>
                      </td>

                      <td style={{ fontSize: 12, fontFamily: "ui-monospace, monospace", color: "var(--muted, #9ca3af)" }}>
                        {s.expires_at ? new Date(s.expires_at).toLocaleDateString("ru-RU") : "Бессрочно"}
                      </td>

                      <td>
                        <span style={{ fontSize: 11, color: s.auto_renew ? "#2ecc71" : "var(--muted, #9ca3af)" }}>
                          {s.auto_renew ? "Включено" : "Выключено"}
                        </span>
                      </td>

                      <td style={{ fontSize: 12, color: "var(--muted, #9ca3af)", maxWidth: 180, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {s.notes || "—"}
                      </td>

                      <td style={{ textAlign: "right" }}>
                        <div style={{ display: "inline-flex", gap: 6 }}>
                          <button
                            type="button"
                            onClick={() => handleExtend(s.id, 30)}
                            style={{
                              padding: "3px 8px",
                              fontSize: 10,
                              borderColor: "var(--line, #3a3d40)",
                              color: "var(--cyan, #3498db)",
                            }}
                          >
                            +30 дн
                          </button>
                          {s.status === "active" && (
                            <button
                              type="button"
                              onClick={() => handleCancel(s.id)}
                              style={{
                                padding: "3px 8px",
                                fontSize: 10,
                                borderColor: "rgba(231, 76, 60, 0.4)",
                                color: "#e74c3c",
                              }}
                            >
                              Отозвать
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Grant Subscription Modal ── */}
      {showGrantModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 16,
          }}
        >
          <div className="card" style={{ maxWidth: 480, margin: 0, padding: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0, color: "var(--orange, #e67e22)" }}>ВЫДАЧА ПРЕМИУМ-ПОДПИСКИ</h3>
              <button
                type="button"
                onClick={() => setShowGrantModal(false)}
                style={{ border: "none", color: "var(--muted, #9ca3af)", padding: 4 }}
              >
                <IconX size={18} />
              </button>
            </div>

            <form onSubmit={handleGrant}>
              <label style={{ display: "block", marginBottom: 12 }}>
                <span style={{ fontSize: 11, color: "var(--muted, #9ca3af)", textTransform: "uppercase", letterSpacing: 1 }}>
                  Позывной командира (CMDR):
                </span>
                <input
                  type="text"
                  required
                  placeholder="Например: CMDR Valeriy_77"
                  value={grantCmdr}
                  onChange={(e) => setGrantCmdr(e.target.value)}
                  style={{ width: "100%" }}
                />
              </label>

              <label style={{ display: "block", marginBottom: 12 }}>
                <span style={{ fontSize: 11, color: "var(--muted, #9ca3af)", textTransform: "uppercase", letterSpacing: 1 }}>
                  Тарифный статус:
                </span>
                <select
                  value={grantPlanId}
                  onChange={(e) => setGrantPlanId(e.target.value)}
                  style={{ width: "100%" }}
                >
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.price_rub} ₽/мес)
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ display: "block", marginBottom: 12 }}>
                <span style={{ fontSize: 11, color: "var(--muted, #9ca3af)", textTransform: "uppercase", letterSpacing: 1 }}>
                  Срок действия:
                </span>
                <select
                  value={grantDuration}
                  onChange={(e) => setGrantDuration(e.target.value)}
                  style={{ width: "100%" }}
                >
                  <option value="30">30 дней (1 месяц)</option>
                  <option value="90">90 дней (3 месяца)</option>
                  <option value="180">180 дней (полгода)</option>
                  <option value="365">365 дней (1 год)</option>
                  <option value="3650">Бессрочно / Пожизненно</option>
                </select>
              </label>

              <label style={{ display: "block", marginBottom: 20 }}>
                <span style={{ fontSize: 11, color: "var(--muted, #9ca3af)", textTransform: "uppercase", letterSpacing: 1 }}>
                  Основание / Примечание:
                </span>
                <input
                  type="text"
                  placeholder="Например: Награда за победу в исследовательской экспедиции"
                  value={grantNotes}
                  onChange={(e) => setGrantNotes(e.target.value)}
                  style={{ width: "100%" }}
                />
              </label>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button
                  type="button"
                  onClick={() => setShowGrantModal(false)}
                  style={{ borderColor: "var(--line, #3a3d40)", color: "var(--muted, #9ca3af)" }}
                >
                  Отмена
                </button>
                <button type="submit" disabled={granting} className="btn-orange">
                  {granting ? "Выдача..." : "Подтвердить выдачу"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Edit Plan Modal ── */}
      {editingPlan && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 16,
          }}
        >
          <div className="card" style={{ maxWidth: 500, margin: 0, padding: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0, color: editingPlan.color }}>ТАРИФ: {editingPlan.name.toUpperCase()}</h3>
              <button
                type="button"
                onClick={() => setEditingPlan(null)}
                style={{ border: "none", color: "var(--muted, #9ca3af)", padding: 4 }}
              >
                <IconX size={18} />
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
              <label>
                <span style={{ fontSize: 11, color: "var(--muted, #9ca3af)", textTransform: "uppercase" }}>
                  Цена (руб):
                </span>
                <input
                  type="number"
                  value={editPriceRub}
                  onChange={(e) => setEditPriceRub(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              </label>
              <label>
                <span style={{ fontSize: 11, color: "var(--muted, #9ca3af)", textTransform: "uppercase" }}>
                  Цена (кредиты):
                </span>
                <input
                  type="number"
                  value={editPriceCredits}
                  onChange={(e) => setEditPriceCredits(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              </label>
            </div>

            <div style={{ marginBottom: 16 }}>
              <span style={{ fontSize: 11, color: "var(--muted, #9ca3af)", textTransform: "uppercase", display: "block", marginBottom: 6 }}>
                Привилегии и бонусы:
              </span>
              {editPerks.map((p, idx) => (
                <div key={idx} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                  <input
                    type="text"
                    value={p}
                    onChange={(e) => {
                      const next = [...editPerks];
                      next[idx] = e.target.value;
                      setEditPerks(next);
                    }}
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    onClick={() => setEditPerks(editPerks.filter((_, i) => i !== idx))}
                    style={{ color: "#e74c3c", borderColor: "rgba(231,76,60,0.3)" }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setEditPerks([...editPerks, "Новая привилегия"])}
                style={{ fontSize: 11, padding: "4px 8px", marginTop: 4 }}
              >
                + Добавить пункт
              </button>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                type="button"
                onClick={() => setEditingPlan(null)}
                style={{ borderColor: "var(--line, #3a3d40)", color: "var(--muted, #9ca3af)" }}
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleSavePlan}
                disabled={savingPlan}
                className="btn-orange"
              >
                {savingPlan ? "Сохранение..." : "Сохранить тариф"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
