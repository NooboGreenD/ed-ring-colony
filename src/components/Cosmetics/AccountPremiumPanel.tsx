"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { authFetch } from "@/lib/supabaseClient";
import type { BillingTransaction, EquippedCosmetics, UserBalance, UserInventoryItem, UserSubscription, BillingPlan } from "@/types/billing";
import { IconCoins, IconCrown, IconStore, IconCheck, IconX } from "@/components/Icons";
import CosmeticAvatar from "./CosmeticAvatar";
import CosmeticBadge from "./CosmeticBadge";
import CosmeticCallsign from "./CosmeticCallsign";
import CosmeticTitle from "./CosmeticTitle";
import { invalidateCosmetics } from "./useCosmetics";

const CATEGORY_LABEL: Record<string, string> = { frame: "Рамка", badge: "Знак", skin: "HUD-тема", glow: "Свечение", title: "Титул" };
const TX_LABEL: Record<string, string> = { subscription: "Подписка", shop_purchase: "Покупка", credit_topup: "Пополнение", refund: "Возврат", admin_grant: "Начисление" };

/** "Премиум и покупки" tab on /account: everything the pilot owns, in one place. */
export default function AccountPremiumPanel() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<UserBalance | null>(null);
  const [subscription, setSubscription] = useState<UserSubscription | null>(null);
  const [inventory, setInventory] = useState<UserInventoryItem[]>([]);
  const [equipped, setEquipped] = useState<EquippedCosmetics | null>(null);
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [cmdrName, setCmdrName] = useState("CMDR");
  const [userId, setUserId] = useState<string | null>(null);
  const [txs, setTxs] = useState<BillingTransaction[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<any[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch("/api/shop/user-state", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Ошибка загрузки");
      setBalance(data.balance);
      setSubscription(data.subscription);
      setInventory(data.inventory || []);
      setEquipped(data.equipped);
      setPlans(data.plans || []);
      setCmdrName(data.cmdrName || "CMDR");
      setUserId(data.userId || null);
      setPending(data.pendingPayments || []);
      const txRes = await authFetch("/api/billing/my-transactions?limit=30", { cache: "no-store" });
      const txData = await txRes.json().catch(() => ({}));
      if (txRes.ok) setTxs(txData.transactions || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleEquip = async (inv: UserInventoryItem) => {
    if (!inv.item) return;
    setBusy(inv.item_id);
    try {
      const res = await authFetch("/api/shop/equip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: inv.item.category, itemId: inv.is_equipped ? null : inv.item_id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка");
      setEquipped(data.equipped);
      setInventory((list) => list.map((i) => (i.item?.category === inv.item?.category ? { ...i, is_equipped: !inv.is_equipped && i.item_id === inv.item_id } : i)));
      invalidateCosmetics(userId || undefined);
      window.dispatchEvent(new Event("cosmetics:changed"));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <p style={{ color: "var(--muted)" }}>Загрузка данных премиум-аккаунта…</p>;

  const eqItem = (id?: string | null) => inventory.find((i) => i.item_id === id)?.item;
  const frame = eqItem(equipped?.frame_id);
  const badge = eqItem(equipped?.badge_id);
  const glow = eqItem(equipped?.glow_id);
  const title = eqItem(equipped?.title_id);
  const skin = eqItem(equipped?.skin_id);
  const daysLeft = subscription?.expires_at ? Math.max(0, Math.ceil((new Date(subscription.expires_at).getTime() - Date.now()) / 86400000)) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {error && <div style={{ padding: "10px 14px", border: "1px solid #e74c3c", color: "#e74c3c", background: "rgba(231,76,60,0.1)", fontSize: 13 }}>{error}</div>}

      {/* Status cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
        <div className="card" style={{ margin: 0, padding: "14px 18px" }}>
          <div style={{ fontSize: 11, color: "var(--muted)", letterSpacing: 1, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6 }}><IconCoins size={12} color="#e67e22" /> Баланс кредитов</div>
          <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "var(--orange)", margin: "6px 0 2px" }}>{(balance?.credits || 0).toLocaleString("ru-RU")}</div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>Потрачено: {(balance?.total_spent_credits || 0).toLocaleString("ru-RU")} кр. / {(balance?.total_spent_rub || 0).toLocaleString("ru-RU")} ₽</div>
          <Link href="/premium-shop?topup=1" className="btn btn-orange" style={{ marginTop: 10, fontSize: 11, padding: "5px 12px", display: "inline-block" }}>Пополнить</Link>
        </div>

        <div className="card" style={{ margin: 0, padding: "14px 18px", borderColor: subscription?.plan?.color || undefined }}>
          <div style={{ fontSize: 11, color: "var(--muted)", letterSpacing: 1, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6 }}><IconCrown size={12} color={subscription?.plan?.color || "#9ca3af"} /> Подписка</div>
          {subscription ? (
            <>
              <div style={{ fontSize: 18, fontWeight: 700, color: subscription.plan?.color || "var(--text)", margin: "6px 0 2px" }}>{subscription.plan?.name || subscription.plan_id}</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>
                До {subscription.expires_at ? new Date(subscription.expires_at).toLocaleDateString("ru-RU") : "—"} {daysLeft !== null && `(${daysLeft} дн.)`} • скидка в магазине {subscription.plan?.discount_pct || 0}%
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>Оплата: {subscription.payment_method}{subscription.auto_renew ? " • автопродление" : ""}</div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 15, color: "var(--text)", margin: "6px 0 2px" }}>Стандартный статус</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>Подписка даёт скидки до {Math.max(0, ...plans.map((p) => p.discount_pct || 0))}% и доступ к эксклюзивам.</div>
            </>
          )}
          <Link href="/premium-shop?tab=plans" className="btn btn-cyan" style={{ marginTop: 10, fontSize: 11, padding: "5px 12px", display: "inline-block" }}>{subscription ? "Продлить / сменить" : "Оформить"}</Link>
        </div>

        <div className="card" style={{ margin: 0, padding: "14px 18px" }}>
          <div style={{ fontSize: 11, color: "var(--muted)", letterSpacing: 1, textTransform: "uppercase" }}>Как вас видят другие</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
            <CosmeticAvatar frameId={frame?.id} framePreview={frame?.preview_data} size={48} />
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {badge && <CosmeticBadge badgeId={badge.id} badgePreview={badge.preview_data} title={badge.title} size={20} />}
                <CosmeticCallsign name={cmdrName} glowId={glow?.id} glowPreview={glow?.preview_data} tier={subscription?.plan?.badge_label || null} tierColor={subscription?.plan?.color || null} fontSize={14} />
              </div>
              <div style={{ marginTop: 4 }}>{title ? <CosmeticTitle titleId={title.id} titlePreview={title.preview_data} text={title.title} /> : <span style={{ fontSize: 11, color: "var(--muted)" }}>Титул не выбран</span>}</div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>HUD-тема: {skin ? <span style={{ color: skin.preview_data?.color }}>{skin.title}</span> : "стандартная"}</div>
        </div>
      </div>

      {pending.length > 0 && (
        <div style={{ padding: "10px 14px", border: "1px solid #f39c12", background: "rgba(243,156,18,0.08)", fontSize: 13 }}>
          <b style={{ color: "#f39c12" }}>Ожидают оплаты:</b>{" "}
          {pending.map((p) => (
            <Link key={p.id} href={`/premium-shop/pay/${p.id}`} style={{ marginRight: 12, color: "var(--orange)" }}>
              {TX_LABEL[p.purpose] || p.purpose} • {p.amount_rub} ₽
            </Link>
          ))}
        </div>
      )}

      {/* Inventory */}
      <div>
        <h3 style={{ margin: "0 0 10px", display: "flex", alignItems: "center", gap: 8 }}><IconStore size={16} color="#e67e22" /> Мои улучшения ({inventory.length})</h3>
        {inventory.length === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>
            Пока ничего не куплено. <Link href="/premium-shop" style={{ color: "var(--orange)" }}>Открыть премиум-магазин →</Link>
          </p>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
            {inventory.map((inv) => {
              const it = inv.item;
              if (!it) return null;
              const color = it.preview_data?.color || "#e67e22";
              return (
                <div key={inv.id} style={{ padding: 12, background: "#25282b", border: `1px solid ${inv.is_equipped ? color : "var(--line)"}`, borderRadius: 3, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ width: 34, height: 34, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {it.category === "frame" && <CosmeticAvatar frameId={it.id} framePreview={it.preview_data} size={32} />}
                      {it.category === "badge" && <CosmeticBadge badgeId={it.id} badgePreview={it.preview_data} title={it.title} size={26} />}
                      {it.category === "glow" && <span style={{ width: 20, height: 20, borderRadius: "50%", background: it.preview_data?.gradient || color, boxShadow: `0 0 10px ${color}` }} />}
                      {it.category === "title" && <span style={{ fontSize: 16, color }}>«»</span>}
                      {it.category === "skin" && <span style={{ width: 22, height: 22, borderRadius: 3, background: `linear-gradient(135deg, ${color}, ${it.preview_data?.accentColor || color})` }} />}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.title}</div>
                      <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1 }}>{CATEGORY_LABEL[it.category] || it.category} • {it.rarity}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 10, color: "var(--muted)" }}>Куплено {new Date(inv.purchased_at).toLocaleDateString("ru-RU")}</span>
                    <button type="button" onClick={() => toggleEquip(inv)} disabled={busy === inv.item_id} className={inv.is_equipped ? "btn btn-cyan" : "btn btn-orange"} style={{ fontSize: 10, padding: "3px 10px", display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {inv.is_equipped ? <><IconX size={10} /> Снять</> : <><IconCheck size={10} /> Надеть</>}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Transactions */}
      <div>
        <h3 style={{ margin: "0 0 10px" }}>История операций</h3>
        {txs.length === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>Операций пока нет.</p>
        ) : (
          <div className="table-scroll">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ color: "var(--muted)", textAlign: "left", borderBottom: "1px solid var(--line)" }}>
                  <th style={{ padding: "6px 8px" }}>Дата</th>
                  <th style={{ padding: "6px 8px" }}>Тип</th>
                  <th style={{ padding: "6px 8px" }}>Описание</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>₽</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>Кредиты</th>
                  <th style={{ padding: "6px 8px" }}>Статус</th>
                </tr>
              </thead>
              <tbody>
                {txs.map((t) => (
                  <tr key={t.id} style={{ borderBottom: "1px solid #25282b" }}>
                    <td style={{ padding: "6px 8px", fontFamily: "ui-monospace, monospace", whiteSpace: "nowrap" }}>{new Date(t.created_at).toLocaleString("ru-RU")}</td>
                    <td style={{ padding: "6px 8px" }}>{TX_LABEL[t.type] || t.type}</td>
                    <td style={{ padding: "6px 8px" }}>{t.item_title}<span style={{ color: "var(--muted)", marginLeft: 6, fontSize: 10 }}>{t.id}</span></td>
                    <td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "ui-monospace, monospace" }}>{t.amount_rub ? t.amount_rub.toLocaleString("ru-RU") : "—"}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "ui-monospace, monospace", color: t.type === "shop_purchase" || (t.type === "subscription" && t.amount_credits) ? "#e74c3c" : "#2ecc71" }}>
                      {t.amount_credits ? `${t.type === "shop_purchase" || t.type === "subscription" ? "−" : "+"}${Math.abs(t.amount_credits).toLocaleString("ru-RU")}` : "—"}
                    </td>
                    <td style={{ padding: "6px 8px", color: t.status === "completed" ? "#2ecc71" : t.status === "refunded" ? "#f39c12" : "#9ca3af" }}>{t.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
