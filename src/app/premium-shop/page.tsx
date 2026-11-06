"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ShopItem, UserInventoryItem, EquippedCosmetics, UserBalance, UserSubscription, BillingPlan, CreditPack, PublicPaymentProvider } from "@/types/billing";
import CosmeticAvatar from "@/components/Cosmetics/CosmeticAvatar";
import CosmeticBadge from "@/components/Cosmetics/CosmeticBadge";
import CosmeticCallsign from "@/components/Cosmetics/CosmeticCallsign";
import CosmeticTitle from "@/components/Cosmetics/CosmeticTitle";
import { invalidateCosmetics } from "@/components/Cosmetics/useCosmetics";
import { previewSkin } from "@/components/Cosmetics/HudSkinProvider";
import { authFetch } from "@/lib/supabaseClient";
import { IconCheck, IconX, IconSearch, IconLock, IconCreditCard } from "@/components/Icons";
import { ThemeSwatch } from "@/components/Admin/Billing/ProductManager";
import type { TFn } from '@/lib/i18n/gameLabels';
import { useI18n } from '@/lib/i18n/I18nContext';

type Category = "all" | "frame" | "badge" | "skin" | "glow" | "title" | "inventory";

const CATEGORY_LABEL: Record<string, string> = { frame: 'shop.catFrame', badge: 'shop.catBadge', skin: 'shop.catSkin', glow: 'shop.catGlow', title: 'shop.catTitle' };
const RARITY_COLOR: Record<string, string> = { legendary: "#fbbf24", epic: "#c084fc", rare: "#38bdf8", common: "#9ca3af" };
const METHOD_LABEL: Record<string, string> = { card: 'shop.methodCard', sbp: 'shop.methodSbp', crypto: 'shop.methodCrypto', manual: 'shop.methodManual' };

/** Small visual preview of an item, driven by its preview_data. */
function ItemPreview({ item, size = "md" }: { item: ShopItem; size?: "sm" | "md" | "lg" }) {
  const s = size === "sm" ? 32 : size === "lg" ? 64 : 48;
  const color = item.preview_data?.color || "#e67e22";
  switch (item.category) {
    case "frame":
      return <CosmeticAvatar frameId={item.id} framePreview={item.preview_data} size={s} showScanlines />;
    case "badge":
      return <CosmeticBadge badgeId={item.id} badgePreview={item.preview_data} title={item.title} size={Math.round(s * 0.7)} />;
    case "glow":
      return <CosmeticCallsign name="CMDR PILOT" glowId={item.id} glowPreview={item.preview_data} fontSize={size === "sm" ? 12 : 15} />;
    case "title":
      return <CosmeticTitle titleId={item.id} titlePreview={item.preview_data} text={item.title} />;
    case "skin":
      if (size === "sm") return <span style={{ width: s, height: Math.round(s * 0.6), borderRadius: 3, background: `linear-gradient(135deg, ${item.preview_data?.theme?.bg || "#1e2022"}, ${color})`, border: `1px solid ${color}`, boxShadow: `0 0 8px ${color}55`, display: "inline-block" }} />;
      return <div style={{ width: size === "lg" ? 240 : 180 }}><ThemeSwatch theme={item.preview_data?.theme} accent={color} compact /></div>;
    default:
      return null;
  }
}

export default function PremiumShopPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [items, setItems] = useState<ShopItem[]>([]);
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [inventory, setInventory] = useState<UserInventoryItem[]>([]);
  const [equipped, setEquipped] = useState<EquippedCosmetics>({ user_id: "" });
  const [balance, setBalance] = useState<UserBalance | null>(null);
  const [subscription, setSubscription] = useState<UserSubscription | null>(null);
  const [cmdrName, setCmdrName] = useState("CMDR");
  const [userId, setUserId] = useState<string | null>(null);
  const [userRole, setUserRole] = useState("guest");
  const [authenticated, setAuthenticated] = useState(false);
  const [isPreview, setIsPreview] = useState(false);
  const [providers, setProviders] = useState<PublicPaymentProvider[]>([]);
  const [packs, setPacks] = useState<CreditPack[]>([]);
  const [pendingPayments, setPendingPayments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [category, setCategory] = useState<Category>("all");
  const [search, setSearch] = useState("");

  const [preview, setPreview] = useState<Partial<Record<"frame" | "badge" | "glow" | "title" | "skin", string | null>>>({});

  // modals
  const [showTopup, setShowTopup] = useState(false);
  const [selectedPack, setSelectedPack] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [buyingItem, setBuyingItem] = useState<ShopItem | null>(null);
  const [busy, setBusy] = useState(false);
  const equipLock = useRef(false);
  const [equipping, setEquipping] = useState(false);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);

  const showToast = (text: string, ok = true) => {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 5000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [itemsRes, stateRes] = await Promise.all([authFetch("/api/shop/items", { cache: "no-store" }), authFetch("/api/shop/user-state", { cache: "no-store" })]);
      const [itemsData, st] = await Promise.all([itemsRes.json(), stateRes.json()]);
      if (!stateRes.ok || !st.success) throw new Error(st.error || t('shop.subStatusFailed'));
      if (itemsRes.ok && itemsData.success) setItems(itemsData.items || []);
      else if (itemsRes.status !== 401 && itemsRes.status !== 403) {
        throw new Error(itemsData.error || t('shop.catalogFailed'));
      } else if (st.subscription || st.isPreview || (["admin", "moderator", "support_manager"].includes(st.role) && st.authenticated)) {
        throw new Error(itemsData.error || t('shop.accessFailed'));
      }
      if (st.success) {
        setAuthenticated(Boolean(st.authenticated || st.isPreview));
        setIsPreview(Boolean(st.isPreview));
        setCmdrName(st.cmdrName || "CMDR");
        setUserId(st.userId || null);
        setUserRole(st.role || "guest");
        setBalance(st.balance);
        setSubscription(st.subscription || null);
        setInventory(st.inventory || []);
        setPlans(st.plans || []);
        setProviders(st.providers || []);
        setPacks(st.settings?.credit_packs || []);
        setPendingPayments(st.pendingPayments || []);
        const eq = st.equipped || { user_id: "" };
        setEquipped(eq);
        setPreview({ frame: eq.frame_id, badge: eq.badge_id, glow: eq.glow_id, title: eq.title_id, skin: eq.skin_id });
        if (!selectedProvider && st.providers?.length) setSelectedProvider(st.providers[0].id);
        if (!selectedPack && st.settings?.credit_packs?.length) setSelectedPack(st.settings.credit_packs[1]?.id || st.settings.credit_packs[0].id);
      }
    } catch (e: any) {
      const message = t('shop.loadError', { message: e.message });
      setLoadError(message);
      showToast(message, false);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
    const q = new URLSearchParams(window.location.search);
    if (q.get("tab") === "plans") {
      router.replace("/subscriptions");
      return;
    }
    if (q.get("topup")) setShowTopup(true);
  }, [load, router]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const itemOf = (id?: string | null) => (id ? byId.get(id) || inventory.find((v) => v.item_id === id)?.item : undefined);
  const isOwned = (id: string) => inventory.some((v) => v.item_id === id);
  const isEquipped = (item: ShopItem) => (equipped as any)[`${item.category}_id`] === item.id;
  const counts = useMemo(() => items.reduce<Record<string, number>>((a, i) => ((a[i.category] = (a[i.category] || 0) + 1), a), {}), [items]);

  const filtered = items.filter((i) => {
    if (category !== "all" && i.category !== category) return false;
    const q = search.toLowerCase();
    return !q || i.title.toLowerCase().includes(q) || (i.description || "").toLowerCase().includes(q);
  });

  const requireAuth = () => {
    if (!authenticated) {
      showToast(t('shop.loginRequired'), false);
      return false;
    }
    return true;
  };

  const tryOn = (item: ShopItem) => {
    setPreview((p) => ({ ...p, [item.category]: item.id }));
    if (item.category === "skin") {
      previewSkin({ id: item.id, preview: item.preview_data });
      showToast(t('shop.skinPreviewApplied', { title: item.title }));
      return;
    }
    showToast(t('shop.tryOnToast', { title: item.title }));
  };

  const resetPreview = () => {
    setPreview({ frame: equipped.frame_id, badge: equipped.badge_id, glow: equipped.glow_id, title: equipped.title_id, skin: equipped.skin_id });
    previewSkin(null);
  };

  // leaving the shop drops any temporary site-wide skin preview
  useEffect(() => () => previewSkin(null), []);

  const toggleEquip = async (item: ShopItem, on: boolean) => {
    if (!requireAuth() || equipLock.current) return;
    equipLock.current = true; setEquipping(true);
    try {
      const res = await authFetch("/api/shop/equip", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: item.category, itemId: on ? item.id : null }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('shop.genericError'));
      setEquipped(data.equipped);
      setPreview((p) => ({ ...p, [item.category]: on ? item.id : null }));
      if (item.category === "skin") previewSkin(null);
      invalidateCosmetics(userId || undefined);
      window.dispatchEvent(new Event("cosmetics:changed"));
      showToast(on ? t('shop.equippedToast', { title: item.title }) : t('shop.unequippedToast', { title: item.title }));
      load();
    } catch (e: any) {
      showToast(e.message, false);
    } finally { equipLock.current = false; setEquipping(false); }
  };

  const buyWithCredits = async () => {
    if (!buyingItem || !requireAuth()) return;
    setBusy(true);
    try {
      const res = await authFetch("/api/shop/purchase", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: buyingItem.id, autoEquip: true }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('shop.purchaseError'));
      showToast(t('shop.purchasedToast', { title: buyingItem.title, id: data.transaction?.id }));
      setBuyingItem(null);
      if (buyingItem.category === "skin") previewSkin(null);
      invalidateCosmetics(userId || undefined);
      window.dispatchEvent(new Event("cosmetics:changed"));
      load();
    } catch (e: any) {
      showToast(e.message, false);
    } finally {
      setBusy(false);
    }
  };

  const checkout = async (payload: Record<string, any>) => {
    if (!requireAuth()) return;
    if (!selectedProvider) {
      showToast(t('shop.providersMissing'), false);
      return;
    }
    setBusy(true);
    try {
      const res = await authFetch("/api/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: selectedProvider, ...payload }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('shop.paymentFailed'));
      if (data.paymentUrl) window.location.href = data.paymentUrl;
      else showToast(t('shop.paymentCreated'));
    } catch (e: any) {
      showToast(e.message, false);
    } finally {
      setBusy(false);
    }
  };

  const pack = packs.find((p) => p.id === selectedPack);
  const credits = balance?.credits || 0;
  const pFrame = itemOf(preview.frame);
  const pBadge = itemOf(preview.badge);
  const pGlow = itemOf(preview.glow);
  const pTitle = itemOf(preview.title);
  const pSkin = itemOf(preview.skin);
  const hasShopAccess = Boolean(subscription) || (authenticated && isPreview);

  if (loading) {
    return <div className="card" role="status" style={{ maxWidth: 760, margin: "40px auto", padding: 28, textAlign: "center", color: "var(--muted)" }}>{t('shop.checkingAccess')}</div>;
  }

  if (loadError) {
    return (
      <div className="card" role="alert" style={{ maxWidth: 760, margin: "40px auto", padding: 28, textAlign: "center", borderTop: "2px solid #e74c3c" }}>
        <p style={{ color: "#ff8b7e" }}>{loadError}</p>
        <button type="button" onClick={() => void load()}>{t('shop.retryCheck')}</button>
      </div>
    );
  }

  if (!hasShopAccess) {
    return (
      <div className="card" style={{ maxWidth: 760, margin: "40px auto", padding: "clamp(22px, 5vw, 42px)", borderTop: "2px solid var(--orange)", textAlign: "center" }}>
        <IconLock size={28} color="var(--orange)" />
        <div className="kicker" style={{ marginTop: 14 }}>{t('shop.accessLimited')}</div>
        <h1 style={{ margin: "10px 0", fontSize: "clamp(22px, 4vw, 32px)" }}>{t('shop.subscribersOnly')}</h1>
        <p style={{ maxWidth: 580, margin: "0 auto 20px", color: "var(--muted)", lineHeight: 1.7 }}>
          {t('shop.subscribersOnlyLead')}
        </p>
        <div style={{ display: "flex", justifyContent: "center", gap: 10, flexWrap: "wrap" }}>
          <Link href="/subscriptions" className="btn btn-orange">{t('shop.viewSubscriptions')}</Link>
          {!authenticated && <Link href="/login" className="btn btn-cyan">{t('shop.login')}</Link>}
        </div>
      </div>
    );
  }

  const ProviderPicker = () =>
    providers.length === 0 ? (
      <div style={{ fontSize: 12, color: "#f39c12", padding: "8px 10px", border: "1px solid rgba(243,156,18,0.4)", background: "rgba(243,156,18,0.08)" }}>
        {t('shop.noPayments')}
      </div>
    ) : (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1 }}>{t('shop.paymentMethod')}</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {providers.map((p) => (
            <button key={p.id} type="button" onClick={() => setSelectedProvider(p.id)} style={{ fontSize: 11, padding: "5px 10px", borderColor: selectedProvider === p.id ? "var(--orange)" : "var(--line)", color: selectedProvider === p.id ? "var(--orange)" : "var(--muted)", background: selectedProvider === p.id ? "rgba(230,126,34,0.12)" : "transparent", display: "inline-flex", gap: 6, alignItems: "center" }}>
              <IconCreditCard size={11} /> {p.name} <span style={{ opacity: 0.7 }}>({p.methods.map((m) => (METHOD_LABEL[m] ? t(METHOD_LABEL[m]) : m)).join("/")})</span>
              {p.test_mode && <span style={{ fontSize: 9, color: "#f39c12" }}>TEST</span>}
            </button>
          ))}
        </div>
      </div>
    );

  return (
    <div className="shop-page" style={{ width: "100%", maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 22, padding: "10px 0 40px" }}>
      {toast && (
        <div className="shop-toast" style={{ position: "fixed", top: 24, right: 24, zIndex: 9999, padding: "12px 18px", borderRadius: 3, background: toast.ok ? "rgba(46,204,113,0.2)" : "rgba(231,76,60,0.2)", border: `1px solid ${toast.ok ? "#2ecc71" : "#e74c3c"}`, color: toast.ok ? "#2ecc71" : "#e74c3c", fontSize: 13, display: "flex", alignItems: "center", gap: 10, boxShadow: "0 4px 20px rgba(0,0,0,0.5)", maxWidth: 420 }}>
          {toast.ok ? <IconCheck size={16} /> : <IconX size={16} />}
          <span>{toast.text}</span>
        </div>
      )}

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div className="kicker">{t('shop.kicker')}</div>
          <h1 style={{ margin: "4px 0 0" }}>{t('shop.heading')}</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--muted)" }}>{t('shop.lead')}</p>
        </div>
        {["admin", "moderator", "support_manager"].includes(userRole) && (
          <Link href="/admin?tab=billing" style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", padding: "6px 12px", border: "1px solid var(--line)", color: "var(--cyan)" }}>
            {t('shop.billingPanel')}
          </Link>
        )}
      </div>

      {!authenticated && !loading && (
        <div style={{ padding: "10px 14px", border: "1px solid rgba(52,152,219,0.5)", background: "rgba(52,152,219,0.08)", fontSize: 13 }}>
          {t('shop.guestNotice')} <Link href="/login" style={{ color: "var(--cyan)" }}>{t('shop.login')}</Link>{t('shop.guestNoticeTail')}
        </div>
      )}

      {pendingPayments.length > 0 && (
        <div style={{ padding: "10px 14px", border: "1px solid #f39c12", background: "rgba(243,156,18,0.08)", fontSize: 13 }}>
          <b style={{ color: "#f39c12" }}>{t('shop.pendingPayments')}</b>{" "}
          {pendingPayments.map((p) => (
            <Link key={p.id} href={`/premium-shop/pay/${p.id}`} style={{ marginRight: 12, color: "var(--orange)" }}>
              {p.amount_rub} ₽ ({p.provider_id}) →
            </Link>
          ))}
        </div>
      )}

      {/* Status card */}
      <div className="card" style={{ margin: 0, padding: "18px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <CosmeticAvatar frameId={equipped.frame_id} framePreview={itemOf(equipped.frame_id)?.preview_data} size={54} />
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <CosmeticBadge badgeId={equipped.badge_id} badgePreview={itemOf(equipped.badge_id)?.preview_data} title={itemOf(equipped.badge_id)?.title} size={22} />
              <CosmeticCallsign name={cmdrName} glowId={equipped.glow_id} glowPreview={itemOf(equipped.glow_id)?.preview_data} tier={subscription?.plan?.badge_label || null} tierColor={subscription?.plan?.color || null} fontSize={18} />
            </div>
            <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {equipped.title_id ? <CosmeticTitle titleId={equipped.title_id} titlePreview={itemOf(equipped.title_id)?.preview_data} text={itemOf(equipped.title_id)?.title} /> : <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "ui-monospace, monospace" }}>{t('shop.noTitle')}</span>}
              {subscription ? (
                <span style={{ fontSize: 11, color: "#2ecc71", fontFamily: "ui-monospace, monospace" }}>{t('shop.subUntil', { plan: subscription.plan?.name ?? '', date: new Date(subscription.expires_at || "").toLocaleDateString(locale), pct: subscription.plan?.discount_pct || 0 })}</span>
              ) : (
                <Link href="/subscriptions" style={{ fontSize: 11, color: "var(--cyan)", fontFamily: "ui-monospace, monospace" }}>{t('shop.standardStatus')}</Link>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "ui-monospace, monospace" }}>{t('shop.creditBalance')}</div>
            <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "#38bdf8" }}>
              {credits.toLocaleString(locale)} <span style={{ fontSize: 13, color: "var(--muted)" }}>{t('shop.creditsShort')}</span>
            </div>
          </div>
          <button type="button" className="btn-orange" onClick={() => (requireAuth() ? setShowTopup(true) : null)} style={{ padding: "8px 16px" }}>{t('shop.topup')}</button>
        </div>
      </div>

      {/* Fitting room */}
      <div className="card" style={{ margin: 0, background: "radial-gradient(ellipse at center, #2e3236 0%, #202225 100%)", border: "1px solid var(--orange)", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 10 }}>
          <h3 style={{ margin: 0, letterSpacing: 2, color: "var(--orange)", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 8, height: 8, background: "#2ecc71", borderRadius: "50%", boxShadow: "0 0 8px #2ecc71" }} /> {t('shop.fittingRoom')}
          </h3>
          <button type="button" onClick={resetPreview} style={{ fontSize: 11, padding: "4px 10px", borderColor: "var(--line)", color: "var(--muted)" }}>{t('shop.resetToCurrent')}</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 20, padding: "16px 20px", background: "#181a1c", border: "1px dashed rgba(230,126,34,0.4)", borderRadius: 4 }}>
          <div className="shop-fitting-identity" style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <CosmeticAvatar frameId={preview.frame} framePreview={pFrame?.preview_data} size={76} showScanlines />
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <CosmeticBadge badgeId={preview.badge} badgePreview={pBadge?.preview_data} title={pBadge?.title} size={26} />
                <CosmeticCallsign name={cmdrName} glowId={preview.glow} glowPreview={pGlow?.preview_data} tier={subscription?.plan?.badge_label || "CMDR"} tierColor={subscription?.plan?.color || null} fontSize={20} />
              </div>
              <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                {preview.title ? <CosmeticTitle titleId={preview.title} titlePreview={pTitle?.preview_data} text={pTitle?.title} /> : <span style={{ fontSize: 12, color: "var(--muted)", fontStyle: "italic" }}>{t('shop.chooseTitle')}</span>}
                {pSkin && <span style={{ fontSize: 11, color: pSkin.preview_data?.color || "var(--orange)", fontFamily: "ui-monospace, monospace" }}>[{t('shop.skinScheme', { title: pSkin.title })}{preview.skin !== equipped.skin_id ? t('shop.skinPreviewTail') : ''}]</span>}
              </div>
            </div>
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", maxWidth: 320, lineHeight: 1.5 }}>{t('shop.fittingHintHead')} <strong>{t('shop.tryOn')}</strong> {t('shop.fittingHintTail')}</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button type="button" className={category === "all" ? "tab tab-active" : "tab"} onClick={() => setCategory("all")}>{t('shop.tabAll', { count: items.length })}</button>
        {(["frame", "badge", "skin", "glow", "title"] as const).map((c) => (
          <button key={c} type="button" className={category === c ? "tab tab-active" : "tab"} onClick={() => setCategory(c)}>{t(CATEGORY_LABEL[c]).toUpperCase()} ({counts[c] || 0})</button>
        ))}
        <button type="button" className={category === "inventory" ? "tab tab-active" : "tab"} onClick={() => setCategory("inventory")} style={{ borderColor: "var(--cyan)", color: category === "inventory" ? "var(--cyan)" : "var(--muted)" }}>{t('shop.tabInventory', { count: inventory.length })}</button>
      </div>

      {/* Inventory */}
      {category === "inventory" && (
        <div className="card" style={{ margin: 0 }}>
          <h3 style={{ margin: "0 0 16px" }}>{t('shop.inventoryTitle')}</h3>
          {inventory.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: "var(--muted)" }}>{t('shop.inventoryEmpty')}</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: 16 }}>
              {inventory.map((inv) => {
                const item = inv.item || byId.get(inv.item_id);
                if (!item) return null;
                const active = isEquipped(item);
                return (
                  <div key={inv.id} style={{ padding: 16, background: "#25282b", border: active ? "1px solid var(--orange)" : "1px solid var(--line)", borderRadius: 3, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                        <span style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase" }}>{t(CATEGORY_LABEL[item.category])}</span>
                        {active && <span style={{ fontSize: 10, color: "#2ecc71", fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>{t('shop.equippedBadge')}</span>}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                        <ItemPreview item={item} size="sm" />
                        <div>
                          <div style={{ fontWeight: 600, color: "var(--text)" }}>{item.title}</div>
                          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{t('shop.purchasedAt', { date: new Date(inv.purchased_at).toLocaleDateString(locale), price: inv.price_paid_credits ? t('shop.forCredits', { value: inv.price_paid_credits }) : inv.price_paid_rub ? t('shop.forRub', { value: inv.price_paid_rub }) : '' })}</div>
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" onClick={() => tryOn(item)} style={{ flex: 1, padding: 6, fontSize: 11, borderColor: "var(--line)" }}>{t('shop.tryOn')}</button>
                      {active ? (
                        <button type="button" disabled={equipping} onClick={() => toggleEquip(item, false)} style={{ flex: 1, padding: 6, fontSize: 11, borderColor: "rgba(231,76,60,0.4)", color: "#e74c3c" }}>{t('shop.unequip')}</button>
                      ) : (
                        <button type="button" className="btn-orange" disabled={equipping} onClick={() => toggleEquip(item, true)} style={{ flex: 1, padding: 6, fontSize: 11 }}>{t('shop.equip')}</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Catalog */}
      {category !== "inventory" && (
        <>
          <div style={{ position: "relative", maxWidth: 360 }}>
            <input type="text" placeholder={t('shop.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: "100%", paddingLeft: 32 }} />
            <span style={{ position: "absolute", left: 10, top: 12, pointerEvents: "none" }}><IconSearch size={14} color="#9ca3af" /></span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))", gap: 18 }}>
            {loading ? (
              <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: 60, color: "var(--muted)" }}>{t('shop.catalogLoading')}</div>
            ) : filtered.length === 0 ? (
              <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: 60, color: "var(--muted)" }}>{t('shop.nothingFound')}</div>
            ) : (
              filtered.map((item) => {
                const owned = isOwned(item.id);
                const eq = isEquipped(item);
                const rc = RARITY_COLOR[item.rarity] || "#9ca3af";
                const disc = item.applied_discount_pct || 0;
                const finalCredits = item.final_price_credits ?? item.price_credits;
                const finalRub = item.final_price_rub ?? item.price_rub;
                const reqPlan = item.requires_subscription ? plans.find((p) => p.id === item.requires_subscription) : null;
                return (
                  <div key={item.id} className="card" style={{ margin: 0, padding: 18, display: "flex", flexDirection: "column", justifyContent: "space-between", borderTop: `2px solid ${rc}`, opacity: item.is_locked_for_user ? 0.85 : 1 }}>
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                        <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 2, background: `${rc}20`, color: rc, border: `1px solid ${rc}60`, fontFamily: "ui-monospace, monospace", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>{item.rarity}{item.is_featured ? " ★" : ""}</span>
                        <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "ui-monospace, monospace" }}>{t(CATEGORY_LABEL[item.category])}</span>
                      </div>
                      <div style={{ height: 90, background: "#1c1e20", borderRadius: 3, border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 12, position: "relative", overflow: "hidden" }}>
                        <ItemPreview item={item} size="lg" />
                        {item.is_locked_for_user && (
                          <span title={t('shop.requiresSubscription', { plan: reqPlan?.name || item.requires_subscription || '' })} style={{ position: "absolute", top: 6, right: 6, display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9, padding: "2px 6px", background: "rgba(0,0,0,0.6)", color: reqPlan?.color || "#c084fc", border: `1px solid ${reqPlan?.color || "#c084fc"}` }}>
                            <IconLock size={9} /> {reqPlan?.badge_label || "PREMIUM"}
                          </span>
                        )}
                      </div>
                      <h3 style={{ margin: "0 0 6px", fontSize: 15, color: "var(--text)" }}>{item.title}</h3>
                      <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>{item.description}</p>
                    </div>
                    <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
                        <div>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                            <span style={{ fontSize: 18, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "#38bdf8" }}>{finalCredits.toLocaleString(locale)} {t('shop.creditsShort')}</span>
                            {disc > 0 && <span style={{ fontSize: 11, color: "var(--muted)", textDecoration: "line-through" }}>{item.price_credits.toLocaleString(locale)}</span>}
                            {finalRub > 0 && <span style={{ fontSize: 12, color: "var(--muted)" }}>· {finalRub} ₽</span>}
                          </div>
                          {disc > 0 ? <div style={{ fontSize: 10, color: "#2ecc71", fontFamily: "ui-monospace, monospace" }}>{t('shop.discountYours', { pct: disc })}</div> : item.subscriber_discount_pct > 0 ? <div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "ui-monospace, monospace" }}>{t('shop.discountForSubs', { pct: item.subscriber_discount_pct })}</div> : null}
                        </div>
                        {owned && <span style={{ fontSize: 11, color: "#2ecc71", fontFamily: "ui-monospace, monospace", fontWeight: 700 }}>{eq ? t('shop.worn') : t('shop.inInventory')}</span>}
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button type="button" onClick={() => tryOn(item)} style={{ flex: 1, padding: 8, fontSize: 11, borderColor: "var(--line)", color: "var(--text)" }}>{t('shop.tryOn')}</button>
                        {owned ? (
                          eq ? (
                            <button type="button" disabled={equipping} onClick={() => toggleEquip(item, false)} style={{ flex: 1, padding: 8, fontSize: 11, borderColor: "rgba(231,76,60,0.4)", color: "#e74c3c" }}>{t('shop.unequip')}</button>
                          ) : (
                            <button type="button" className="btn-orange" disabled={equipping} onClick={() => toggleEquip(item, true)} style={{ flex: 1, padding: 8, fontSize: 11 }}>{t('shop.wear')}</button>
                          )
                        ) : item.is_locked_for_user ? (
                          <Link href="/subscriptions" className="btn" style={{ flex: 1, textAlign: "center", padding: 8, fontSize: 11, borderColor: reqPlan?.color || "#c084fc", color: reqPlan?.color || "#c084fc" }}>{t('shop.needSubscription')}</Link>
                        ) : (
                          <button type="button" className="btn-orange" onClick={() => (requireAuth() ? setBuyingItem(item) : null)} style={{ flex: 1, padding: 8, fontSize: 11 }}>{t('shop.buy')}</button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      {/* Purchase modal */}
      {buyingItem && (
        <Modal title={t('shop.confirmTitle')} onClose={() => setBuyingItem(null)}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
            <ItemPreview item={buyingItem} size="md" />
            <div>
              <div style={{ fontWeight: 700, color: "var(--text)", fontSize: 16 }}>{buyingItem.title}</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>{t(CATEGORY_LABEL[buyingItem.category])} • {buyingItem.rarity}</div>
            </div>
          </div>
          <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 14 }}>{buyingItem.description}</p>
          <div style={{ padding: "12px 14px", background: "#1c1e20", border: "1px solid var(--line)", borderRadius: 2, marginBottom: 14, fontSize: 13 }}>
            <Row label={t('shop.priceCredits')} value={`${(buyingItem.final_price_credits ?? buyingItem.price_credits).toLocaleString(locale)} ${t('shop.creditsShort')}`} color="#38bdf8" />
            <Row label={t('shop.yourBalance')} value={`${credits.toLocaleString(locale)} ${t('shop.creditsShort')}`} />
            {(buyingItem.final_price_rub ?? buyingItem.price_rub) > 0 && <Row label={t('shop.orByCard')} value={`${buyingItem.final_price_rub ?? buyingItem.price_rub} ₽`} color="var(--orange)" />}
            {(buyingItem.applied_discount_pct || 0) > 0 && <Row label={t('shop.subscriberDiscount')} value={`−${buyingItem.applied_discount_pct}%`} color="#2ecc71" />}
          </div>
          {(buyingItem.final_price_rub ?? buyingItem.price_rub) > 0 && <div style={{ marginBottom: 14 }}><ProviderPicker /></div>}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button type="button" onClick={() => setBuyingItem(null)} style={{ borderColor: "var(--line)", color: "var(--muted)" }}>{t('shop.cancel')}</button>
            {(buyingItem.final_price_rub ?? buyingItem.price_rub) > 0 && providers.length > 0 && (
              <button type="button" className="btn-cyan" disabled={busy} onClick={() => checkout({ purpose: "shop_purchase", itemId: buyingItem.id })}>{busy ? "..." : t('shop.payRub', { price: buyingItem.final_price_rub ?? buyingItem.price_rub })}</button>
            )}
            <button type="button" className="btn-orange" disabled={busy || credits < (buyingItem.final_price_credits ?? buyingItem.price_credits)} onClick={buyWithCredits}>
              {busy ? t('shop.writeOff') : credits < (buyingItem.final_price_credits ?? buyingItem.price_credits) ? t('shop.notEnoughCredits') : t('shop.payWithCredits')}
            </button>
          </div>
          {credits < (buyingItem.final_price_credits ?? buyingItem.price_credits) && (
            <div style={{ marginTop: 10, textAlign: "right" }}>
              <button type="button" onClick={() => { setBuyingItem(null); setShowTopup(true); }} style={{ fontSize: 11, border: "none", color: "var(--cyan)", background: "transparent" }}>{t('shop.topupBalance')}</button>
            </div>
          )}
        </Modal>
      )}

      {/* Top-up modal */}
      {showTopup && (
        <Modal title={t('shop.topupTitle')} onClose={() => setShowTopup(false)} width={500}>
          <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 14 }}>{t('shop.topupLead')}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
            {packs.map((p) => {
              const total = Math.round(p.credits * (1 + (p.bonus_pct || 0) / 100));
              const sel = selectedPack === p.id;
              return (
                <div key={p.id} onClick={() => setSelectedPack(p.id)} style={{ padding: "12px 16px", background: sel ? "rgba(230,126,34,0.15)" : "#25282b", border: sel ? "1px solid var(--orange)" : "1px solid var(--line)", borderRadius: 2, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 600, color: "var(--text)", fontSize: 14 }}>{t('shop.creditsAdded', { count: total.toLocaleString(locale) })}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{p.label}{p.bonus_pct ? t('shop.bonus', { pct: p.bonus_pct }) : ""}</div>
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "var(--orange)" }}>{p.price_rub} ₽</div>
                </div>
              );
            })}
          </div>
          <div style={{ marginBottom: 16 }}><ProviderPicker /></div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button type="button" onClick={() => setShowTopup(false)} style={{ borderColor: "var(--line)", color: "var(--muted)" }}>{t('shop.cancel')}</button>
            <button type="button" className="btn-orange" disabled={busy || !pack || providers.length === 0} onClick={() => pack && checkout({ purpose: "credit_topup", packId: pack.id })}>
              {busy ? t('shop.creatingPayment') : pack ? t('shop.payRub', { price: pack.price_rub }) : t('shop.choosePack')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, onClose, children, width = 460 }: { title: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }} onClick={onClose}>
      <div className="card" style={{ maxWidth: width, width: "100%", margin: 0, padding: 22, maxHeight: "90vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h3 style={{ margin: 0, color: "var(--orange)", fontSize: 14, letterSpacing: 1 }}>{title}</h3>
          <button type="button" onClick={onClose} style={{ border: "none", color: "var(--muted)", padding: 4, background: "transparent" }}><IconX size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <strong style={{ color: color || "var(--text)", fontFamily: "ui-monospace, monospace" }}>{value}</strong>
    </div>
  );
}
