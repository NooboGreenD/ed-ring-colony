"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { authFetch } from "@/lib/supabaseClient";
import { invalidateCosmetics } from "@/components/Cosmetics/useCosmetics";
import { useI18n } from "@/lib/i18n/I18nContext";
import { IconCheck, IconCrown, IconCreditCard, IconHeart, IconX } from "@/components/Icons";
import type { BillingPlan, PublicPaymentProvider, UserBalance, UserSubscription } from "@/types/billing";

const METHOD_LABEL: Record<string, string> = { card: "Карта", sbp: "СБП", crypto: "Крипто", manual: "Перевод" };

type PendingPayment = { id: string; purpose: string; amount_rub: number; provider_id: string };

export default function SubscriptionsPage() {
  const { locale } = useI18n();
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [subscription, setSubscription] = useState<UserSubscription | null>(null);
  const [balance, setBalance] = useState<UserBalance | null>(null);
  const [providers, setProviders] = useState<PublicPaymentProvider[]>([]);
  const [pendingPayments, setPendingPayments] = useState<PendingPayment[]>([]);
  const [authenticated, setAuthenticated] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<BillingPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch("/api/shop/user-state", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Не удалось загрузить подписки");
      setPlans(data.plans || []);
      setSubscription(data.subscription || null);
      setBalance(data.balance || null);
      setProviders(data.providers || []);
      setPendingPayments((data.pendingPayments || []).filter((payment: PendingPayment) => payment.purpose === "subscription"));
      setAuthenticated(Boolean(data.authenticated || data.isPreview));
      setSelectedProvider((current) => current || data.providers?.[0]?.id || null);
    } catch (loadError: any) {
      setError(loadError.message || "Не удалось загрузить подписки");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openPlan = (plan: BillingPlan) => {
    if (!authenticated) return;
    setError(null);
    setSelectedPlan(plan);
  };

  const payByProvider = async () => {
    if (!selectedPlan || !selectedProvider) {
      setError("Не подключён способ оплаты. Можно выбрать оплату кредитами, если на балансе достаточно средств.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await authFetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: selectedProvider, purpose: "subscription", planId: selectedPlan.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Не удалось создать платёж");
      if (data.paymentUrl) window.location.href = data.paymentUrl;
      else if (data.intent?.id) window.location.href = `/premium-shop/pay/${data.intent.id}`;
      else setNotice("Платёж создан. Проверьте ожидающие платежи ниже.");
    } catch (paymentError: any) {
      setError(paymentError.message || "Не удалось создать платёж");
    } finally {
      setBusy(false);
    }
  };

  const payByCredits = async () => {
    if (!selectedPlan) return;
    setBusy(true);
    setError(null);
    try {
      const response = await authFetch("/api/billing/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: selectedPlan.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Не удалось оформить подписку");
      setNotice(`Подписка «${selectedPlan.name}» активирована. Спасибо за поддержку проекта!`);
      setSelectedPlan(null);
      invalidateCosmetics();
      window.dispatchEvent(new Event("cosmetics:changed"));
      await load();
    } catch (paymentError: any) {
      setError(paymentError.message || "Не удалось оформить подписку");
    } finally {
      setBusy(false);
    }
  };

  const activePlanName = subscription?.plan?.name || subscription?.plan_id;
  const displayName = (plan: BillingPlan) => locale.startsWith("en") ? (plan.name_en || plan.name) : plan.name;
  const displayDescription = (plan: BillingPlan) => locale.startsWith("en") ? (plan.description_en || plan.description) : plan.description;

  return (
    <div style={{ width: "100%", maxWidth: 1120, margin: "0 auto", padding: "18px 0 48px", display: "flex", flexDirection: "column", gap: 22 }}>
      <header className="card" style={{ margin: 0, padding: "clamp(20px, 4vw, 34px)", borderTop: "2px solid var(--orange)", background: "radial-gradient(ellipse at top right, rgba(230,126,34,.14), transparent 58%), var(--panel)" }}>
        <div className="kicker" style={{ display: "flex", alignItems: "center", gap: 8 }}><IconHeart size={15} /> Поддержка проекта</div>
        <h1 style={{ margin: "8px 0", fontSize: "clamp(24px, 4vw, 38px)" }}>Подписки</h1>
        <p style={{ maxWidth: 760, color: "var(--muted)", margin: 0, lineHeight: 1.7 }}>
          Подписка помогает развивать ED Ring Colony и открывает премиум-магазин. Подойдёт любой активный тариф — выберите тот, который вам комфортен.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginTop: 18 }}>
          {subscription ? (
            <span style={{ fontSize: 13, color: "#2ecc71" }}>
              <IconCheck size={14} /> Активна подписка «{activePlanName}» до {subscription.expires_at ? new Date(subscription.expires_at).toLocaleDateString(locale) : "—"}.
            </span>
          ) : (
            <span style={{ fontSize: 12, color: "var(--muted)" }}>Разовая оплата за период, без автоматического списания.</span>
          )}
          {subscription && <Link href="/premium-shop" className="btn btn-orange" style={{ padding: "8px 14px", fontSize: 11 }}>Открыть премиум-магазин →</Link>}
        </div>
      </header>

      {error && <div role="alert" style={{ padding: "11px 14px", border: "1px solid #e74c3c", color: "#ff8b7e", background: "rgba(231,76,60,.08)", fontSize: 13 }}>{error}</div>}
      {notice && <div role="status" style={{ padding: "11px 14px", border: "1px solid #2ecc71", color: "#2ecc71", background: "rgba(46,204,113,.08)", fontSize: 13 }}>{notice}</div>}

      {pendingPayments.length > 0 && (
        <div style={{ padding: "11px 14px", border: "1px solid #f39c12", background: "rgba(243,156,18,.08)", fontSize: 13 }}>
          <b style={{ color: "#f39c12" }}>Ожидают оплаты:</b>{" "}
          {pendingPayments.map((payment) => (
            <Link key={payment.id} href={`/premium-shop/pay/${payment.id}`} style={{ marginRight: 12, color: "var(--orange)" }}>
              {payment.amount_rub} ₽ ({payment.provider_id}) →
            </Link>
          ))}
        </div>
      )}

      {loading ? (
        <div className="card" style={{ margin: 0, padding: 36, textAlign: "center", color: "var(--muted)" }}>Загрузка тарифов…</div>
      ) : plans.length === 0 ? (
        <div className="card" style={{ margin: 0, padding: 28, textAlign: "center", color: "var(--muted)" }}>
          {error ? "Не удалось загрузить тарифы." : "Сейчас нет доступных тарифов."} Попробуйте позже.
          {error && <div><button type="button" onClick={() => void load()} style={{ marginTop: 12 }}>Повторить</button></div>}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: 18 }}>
          {plans.map((plan) => {
            const active = subscription?.plan_id === plan.id;
            return (
              <article key={plan.id} className="card" style={{ margin: 0, padding: 20, borderTop: `3px solid ${plan.color}`, display: "flex", flexDirection: "column", justifyContent: "space-between", position: "relative" }}>
                {plan.is_popular && <span style={{ position: "absolute", top: 10, right: 10, fontSize: 9, padding: "2px 6px", background: `${plan.color}30`, color: plan.color, border: `1px solid ${plan.color}`, letterSpacing: 1, fontWeight: 700 }}>ПОПУЛЯРНЫЙ</span>}
                <div>
                  <div style={{ fontSize: 10, color: plan.color, letterSpacing: 2, fontWeight: 700 }}>{plan.badge_label}</div>
                  <h2 style={{ margin: "4px 0 6px", color: "var(--text)", fontSize: 19 }}>{displayName(plan)}</h2>
                  <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 12px", lineHeight: 1.6 }}>{displayDescription(plan)}</p>
                  <ul style={{ margin: "0 0 14px", paddingLeft: 18, fontSize: 12, color: "var(--text)", lineHeight: 1.7 }}>
                    {(plan.perks || []).map((perk, index) => <li key={`${plan.id}-${index}`}>{perk}</li>)}
                    {plan.discount_pct ? <li style={{ color: "#2ecc71" }}>Скидка {plan.discount_pct}% на товары магазина</li> : null}
                    <li style={{ color: "#f39c12" }}>Доступ в премиум-магазин на срок подписки</li>
                  </ul>
                </div>
                <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 20, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: plan.color }}>{plan.price_rub} ₽<span style={{ fontSize: 11, color: "var(--muted)" }}> / {plan.period_days} дн.</span></span>
                    {plan.price_credits > 0 && <span style={{ fontSize: 12, color: "#38bdf8", fontFamily: "ui-monospace, monospace" }}>или {plan.price_credits.toLocaleString(locale)} кр.</span>}
                  </div>
                  {authenticated ? (
                    <button type="button" className="btn-orange" style={{ width: "100%", padding: 9, fontSize: 12 }} onClick={() => openPlan(plan)}>
                      {active ? "Продлить подписку" : subscription ? "Сменить тариф" : "Выбрать подписку"}
                    </button>
                  ) : (
                    <Link href="/login" className="btn btn-orange" style={{ display: "block", textAlign: "center", padding: 9, fontSize: 12 }}>Войти, чтобы оформить</Link>
                  )}
                  {active && <div style={{ fontSize: 11, color: "#2ecc71", marginTop: 7, textAlign: "center" }}>✓ Активна до {subscription?.expires_at ? new Date(subscription.expires_at).toLocaleDateString(locale) : "—"}</div>}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div className="card" style={{ margin: 0, padding: 16, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: "var(--muted)" }}><IconCrown size={14} color="var(--orange)" /> Подписка действует до указанной даты; продление выполняется вручную.</div>
        <Link href="/support" style={{ fontSize: 12, color: "var(--cyan)" }}>Вопросы по подписке? Напишите в поддержку →</Link>
      </div>

      {selectedPlan && (
        <div role="presentation" onClick={() => !busy && setSelectedPlan(null)} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.8)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div role="dialog" aria-modal="true" aria-labelledby="subscription-modal-title" className="card" onClick={(event) => event.stopPropagation()} style={{ width: "100%", maxWidth: 500, margin: 0, padding: 22, maxHeight: "90vh", overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <h2 id="subscription-modal-title" style={{ margin: 0, color: "var(--orange)", fontSize: 16 }}>Подписка «{displayName(selectedPlan)}»</h2>
              <button type="button" aria-label="Закрыть" onClick={() => setSelectedPlan(null)} style={{ border: "none", color: "var(--muted)", padding: 4, background: "transparent" }}><IconX size={18} /></button>
            </div>
            <p style={{ fontSize: 13, color: "var(--muted)" }}>{displayDescription(selectedPlan)}</p>
            <div style={{ padding: "12px 14px", background: "#1c1e20", border: "1px solid var(--line)", marginBottom: 14, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><span style={{ color: "var(--muted)" }}>Период</span><b>{selectedPlan.period_days} дней</b></div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 5 }}><span style={{ color: "var(--muted)" }}>Стоимость</span><b style={{ color: selectedPlan.color }}>{selectedPlan.price_rub} ₽</b></div>
              {selectedPlan.price_credits > 0 && <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 5 }}><span style={{ color: "var(--muted)" }}>Оплата кредитами</span><b style={{ color: "#38bdf8" }}>{selectedPlan.price_credits.toLocaleString(locale)} кр. (баланс {(balance?.credits || 0).toLocaleString(locale)})</b></div>}
              {subscription && <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 5 }}><span style={{ color: "var(--muted)" }}>Текущая подписка</span><b style={{ color: subscription.plan_id === selectedPlan.id ? "#2ecc71" : "#f39c12" }}>{subscription.plan_id === selectedPlan.id ? "будет продлена" : "будет заменена"}</b></div>}
            </div>
            {providers.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                <span style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1 }}>Способ оплаты</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {providers.map((provider) => (
                    <button key={provider.id} type="button" onClick={() => setSelectedProvider(provider.id)} style={{ fontSize: 11, padding: "5px 10px", borderColor: selectedProvider === provider.id ? "var(--orange)" : "var(--line)", color: selectedProvider === provider.id ? "var(--orange)" : "var(--muted)", background: selectedProvider === provider.id ? "rgba(230,126,34,.12)" : "transparent", display: "inline-flex", gap: 6, alignItems: "center" }}>
                      <IconCreditCard size={11} /> {provider.name} <span style={{ opacity: .7 }}>({provider.methods.map((method) => METHOD_LABEL[method] || method).join("/")})</span>
                      {provider.test_mode && <span style={{ fontSize: 9, color: "#f39c12" }}>TEST</span>}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "#f39c12", padding: "8px 10px", border: "1px solid rgba(243,156,18,.4)", background: "rgba(243,156,18,.08)", marginBottom: 14 }}>
                Онлайн-оплата пока не подключена. Если тариф позволяет, его можно оплатить кредитами.
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
              <button type="button" disabled={busy} onClick={() => setSelectedPlan(null)} style={{ borderColor: "var(--line)", color: "var(--muted)" }}>Отмена</button>
              {providers.length > 0 && selectedPlan.price_rub > 0 && <button type="button" className="btn-cyan" disabled={busy} onClick={payByProvider}>{busy ? "Создание платежа…" : `Оплатить ${selectedPlan.price_rub} ₽`}</button>}
              {selectedPlan.price_credits > 0 && <button type="button" className="btn-orange" disabled={busy || (balance?.credits || 0) < selectedPlan.price_credits} onClick={payByCredits}>{busy ? "Обработка…" : (balance?.credits || 0) < selectedPlan.price_credits ? "Недостаточно кредитов" : "Оплатить кредитами"}</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
