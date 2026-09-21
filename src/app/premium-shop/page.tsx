"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  ShopItem,
  UserInventoryItem,
  EquippedCosmetics,
  UserBalance,
  UserSubscription,
} from "@/types/billing";
import CosmeticAvatar from "@/components/Cosmetics/CosmeticAvatar";
import CosmeticBadge from "@/components/Cosmetics/CosmeticBadge";
import CosmeticCallsign from "@/components/Cosmetics/CosmeticCallsign";
import CosmeticTitle from "@/components/Cosmetics/CosmeticTitle";
import {
  IconStore,
  IconCoins,
  IconCrown,
  IconCheck,
  IconX,
  IconSearch,
  IconDiamond,
  IconActivity,
  IconExternalLink,
} from "@/components/Icons";

export default function PremiumShopPage() {
  const [items, setItems] = useState<ShopItem[]>([]);
  const [inventory, setInventory] = useState<UserInventoryItem[]>([]);
  const [equipped, setEquipped] = useState<EquippedCosmetics>({ user_id: "" });
  const [balance, setBalance] = useState<UserBalance>({
    user_id: "",
    credits: 1500,
    total_spent_rub: 0,
    total_spent_credits: 0,
    updated_at: "",
  });
  const [subscription, setSubscription] = useState<UserSubscription | null>(null);
  const [cmdrName, setCmdrName] = useState("CMDR Navigator");
  const [userRole, setUserRole] = useState("user");
  const [loading, setLoading] = useState(true);

  // Active Category Filter
  const [category, setCategory] = useState<"all" | "frame" | "badge" | "skin" | "glow" | "title" | "inventory">("all");
  const [search, setSearch] = useState("");

  // Fitting room preview state (previewing before buying or equipping)
  const [previewFrame, setPreviewFrame] = useState<string | null>(null);
  const [previewBadge, setPreviewBadge] = useState<string | null>(null);
  const [previewGlow, setPreviewGlow] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState<string | null>(null);
  const [previewSkin, setPreviewSkin] = useState<string | null>(null);

  // Top-up Modal
  const [showTopupModal, setShowTopupModal] = useState(false);
  const [topupCredits, setTopupCredits] = useState(1500);
  const [topupRub, setTopupRub] = useState(199);
  const [topupBusy, setTopupBusy] = useState(false);

  // Purchase Modal
  const [buyingItem, setBuyingItem] = useState<ShopItem | null>(null);
  const [purchasing, setPurchasing] = useState(false);

  // Toast
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);

  const showToast = (text: string, ok = true) => {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 4000);
  };

  const loadShopData = useCallback(async () => {
    setLoading(true);
    try {
      const [itemsRes, userStateRes] = await Promise.all([
        fetch("/api/shop/items"),
        fetch("/api/shop/user-state"),
      ]);

      const itemsData = await itemsRes.json();
      const userStateData = await userStateRes.json();

      if (itemsData.success) setItems(itemsData.items || []);
      if (userStateData.success) {
        setCmdrName(userStateData.cmdrName || "CMDR Navigator");
        setUserRole(userStateData.role || "user");
        setBalance(userStateData.balance || { user_id: "", credits: 1500, total_spent_rub: 0, total_spent_credits: 0, updated_at: "" });
        setSubscription(userStateData.subscription || null);
        setInventory(userStateData.inventory || []);

        const eq = userStateData.equipped || { user_id: "" };
        setEquipped(eq);
        // Initialize fitting room with currently equipped cosmetics
        setPreviewFrame(eq.frame_id || null);
        setPreviewBadge(eq.badge_id || null);
        setPreviewGlow(eq.glow_id || null);
        setPreviewTitle(eq.title_id || null);
        setPreviewSkin(eq.skin_id || null);
      }
    } catch (err: any) {
      showToast("Ошибка загрузки магазина: " + err.message, false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadShopData();
  }, [loadShopData]);

  // Try on cosmetic
  const handleTryOn = (item: ShopItem) => {
    switch (item.category) {
      case "frame":
        setPreviewFrame(item.id);
        break;
      case "badge":
        setPreviewBadge(item.id);
        break;
      case "glow":
        setPreviewGlow(item.id);
        break;
      case "title":
        setPreviewTitle(item.id);
        break;
      case "skin":
        setPreviewSkin(item.id);
        break;
    }
    showToast(`Примерка: «${item.title}» в примерочной блоке выше`);
  };

  // Reset fitting room to currently equipped
  const handleResetFitting = () => {
    setPreviewFrame(equipped.frame_id || null);
    setPreviewBadge(equipped.badge_id || null);
    setPreviewGlow(equipped.glow_id || null);
    setPreviewTitle(equipped.title_id || null);
    setPreviewSkin(equipped.skin_id || null);
    showToast("Примерочная сброшена к текущему снаряжению");
  };

  // Equip / unequip owned item
  const handleToggleEquip = async (categoryType: string, itemId: string | null) => {
    try {
      const res = await fetch("/api/shop/equip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: categoryType, itemId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setEquipped(data.equipped);
      if (itemId === null) {
        showToast("Улучшение снято");
      } else {
        showToast("Улучшение успешно экипировано!");
      }
      loadShopData();
    } catch (err: any) {
      showToast(err.message, false);
    }
  };

  // Confirm Purchase
  const handleConfirmPurchase = async (useCredits = true) => {
    if (!buyingItem) return;
    setPurchasing(true);
    try {
      const res = await fetch("/api/shop/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: buyingItem.id,
          useCredits,
          autoEquip: true,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка покупки");

      showToast(`Успешно приобретено: «${buyingItem.title}»! Транзакция #${data.transaction?.id} зафиксирована в биллинге.`);
      setBuyingItem(null);
      loadShopData();
    } catch (err: any) {
      showToast(err.message, false);
    } finally {
      setPurchasing(false);
    }
  };

  // Confirm Top-up
  const handleTopup = async () => {
    setTopupBusy(true);
    try {
      const res = await fetch("/api/shop/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountCredits: topupCredits,
          amountRub: topupRub,
          paymentMethod: "sbp",
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка пополнения");

      showToast(`Счет пополнен на +${topupCredits.toLocaleString("ru-RU")} Кредитов! Чек #${data.transaction?.id}`);
      setShowTopupModal(false);
      loadShopData();
    } catch (err: any) {
      showToast(err.message, false);
    } finally {
      setTopupBusy(false);
    }
  };

  const isOwned = (itemId: string) => inventory.some((inv) => inv.item_id === itemId);
  const isEquipped = (itemId: string, cat: string) => {
    switch (cat) {
      case "frame":
        return equipped.frame_id === itemId;
      case "badge":
        return equipped.badge_id === itemId;
      case "glow":
        return equipped.glow_id === itemId;
      case "title":
        return equipped.title_id === itemId;
      case "skin":
        return equipped.skin_id === itemId;
      default:
        return false;
    }
  };

  const filteredItems = items.filter((i) => {
    if (category !== "all" && category !== "inventory" && i.category !== category) return false;
    if (search && !i.title.toLowerCase().includes(search.toLowerCase()) && !i.description.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div style={{ width: "100%", maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24, padding: "10px 0 40px" }}>
      {/* Toast */}
      {toast && (
        <div
          style={{
            position: "fixed",
            top: 24,
            right: 24,
            zIndex: 9999,
            padding: "12px 18px",
            borderRadius: 3,
            background: toast.ok ? "rgba(46, 204, 113, 0.2)" : "rgba(231, 76, 60, 0.2)",
            border: `1px solid ${toast.ok ? "#2ecc71" : "#e74c3c"}`,
            color: toast.ok ? "#2ecc71" : "#e74c3c",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            gap: 10,
            boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
          }}
        >
          {toast.ok ? <IconCheck size={16} /> : <IconX size={16} />}
          <span>{toast.text}</span>
        </div>
      )}

      {/* ── Top Sci-Fi WIP / Beta Banner ── */}
      <div
        style={{
          border: "1px solid rgba(230, 126, 34, 0.4)",
          background: "linear-gradient(90deg, rgba(230, 126, 34, 0.12) 0%, rgba(30, 32, 34, 0.8) 100%)",
          padding: "14px 20px",
          borderRadius: 2,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              fontSize: 10,
              padding: "3px 8px",
              background: "rgba(230, 126, 34, 0.25)",
              border: "1px solid var(--orange, #e67e22)",
              color: "var(--orange, #e67e22)",
              fontFamily: "ui-monospace, monospace",
              fontWeight: 700,
              letterSpacing: 1.5,
            }}
          >
            BETA // В СТАДИИ РАЗРАБОТКИ
          </span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text, #eeeeee)", letterSpacing: 1, textTransform: "uppercase" }}>
              СЕКТОР СНАБЖЕНИЯ // ПРЕМИУМ-МАГАЗИН МОДИФИКАЦИЙ
            </div>
            <div style={{ fontSize: 12, color: "var(--muted, #9ca3af)", marginTop: 2 }}>
              Закрытое тестирование модификаций интерфейса, знаков отличия и титулов командиров
            </div>
          </div>
        </div>

        {userRole === "admin" && (
          <Link
            href="/admin?tab=billing"
            style={{
              fontSize: 11,
              fontFamily: "ui-monospace, monospace",
              padding: "6px 12px",
              border: "1px solid var(--line, #3a3d40)",
              color: "var(--cyan, #3498db)",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span>🛠️ Перейти в панель биллинга</span>
          </Link>
        )}
      </div>

      {/* ── Status HUD & Balance Header ── */}
      <div
        className="card"
        style={{
          margin: 0,
          padding: "18px 24px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <CosmeticAvatar frameId={equipped.frame_id} size={54} />
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <CosmeticBadge badgeId={equipped.badge_id} size={22} />
              <CosmeticCallsign
                name={cmdrName}
                glowId={equipped.glow_id}
                tier={subscription?.plan?.badge_label || null}
                fontSize={18}
              />
            </div>
            <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 8 }}>
              {equipped.title_id ? (
                <CosmeticTitle titleId={equipped.title_id} />
              ) : (
                <span style={{ fontSize: 11, color: "var(--muted, #9ca3af)", fontFamily: "ui-monospace, monospace" }}>
                  Титул не выбран
                </span>
              )}
              {subscription ? (
                <span style={{ fontSize: 11, color: "#2ecc71", fontFamily: "ui-monospace, monospace" }}>
                  • Подписка активна (до {new Date(subscription.expires_at || "").toLocaleDateString("ru-RU")})
                </span>
              ) : (
                <span style={{ fontSize: 11, color: "var(--muted, #9ca3af)", fontFamily: "ui-monospace, monospace" }}>
                  • Стандартный статус
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Balance & Topup button */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, color: "var(--muted, #9ca3af)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "ui-monospace, monospace" }}>
              Баланс снабжения
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "#38bdf8" }}>
              {balance.credits.toLocaleString("ru-RU")}{" "}
              <span style={{ fontSize: 13, color: "var(--muted, #9ca3af)" }}>Кр.</span>
            </div>
          </div>

          <button
            type="button"
            className="btn-orange"
            onClick={() => setShowTopupModal(true)}
            style={{ padding: "8px 16px" }}
          >
            + Пополнить счет
          </button>
        </div>
      </div>

      {/* ── Interactive Fitting Room (Примерочная) ── */}
      <div
        className="card"
        style={{
          margin: 0,
          background: "radial-gradient(ellipse at center, #2e3236 0%, #202225 100%)",
          border: "1px solid var(--orange, #e67e22)",
          padding: 24,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 8, height: 8, background: "#2ecc71", borderRadius: "50%", boxShadow: "0 0 8px #2ecc71" }} />
            <h3 style={{ margin: 0, letterSpacing: 2, color: "var(--orange, #e67e22)" }}>
              ГОЛОГРАФИЧЕСКАЯ ПРИМЕРОЧНАЯ (LIVE PREVIEW)
            </h3>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={handleResetFitting}
              style={{
                fontSize: 11,
                padding: "4px 10px",
                borderColor: "var(--line, #3a3d40)",
                color: "var(--muted, #9ca3af)",
              }}
            >
              Сбросить вид
            </button>
          </div>
        </div>

        {/* Live Fitting Preview Showcase */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 20,
            padding: "16px 20px",
            background: "#181a1c",
            border: "1px dashed rgba(230, 126, 34, 0.4)",
            borderRadius: 4,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <CosmeticAvatar
              frameId={previewFrame}
              size={76}
              showScanlines={true}
            />

            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <CosmeticBadge badgeId={previewBadge} size={26} />
                <CosmeticCallsign
                  name={cmdrName}
                  glowId={previewGlow}
                  tier={subscription?.plan?.badge_label || "COMMANDER"}
                  fontSize={20}
                />
              </div>

              <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 10 }}>
                {previewTitle ? (
                  <CosmeticTitle titleId={previewTitle} />
                ) : (
                  <span style={{ fontSize: 12, color: "var(--muted, #9ca3af)", fontStyle: "italic" }}>
                    Выберите титул в каталоге
                  </span>
                )}

                {previewSkin && (
                  <span style={{ fontSize: 11, color: "var(--orange, #e67e22)", fontFamily: "ui-monospace, monospace" }}>
                    [Тема: {previewSkin}]
                  </span>
                )}
              </div>
            </div>
          </div>

          <div style={{ fontSize: 12, color: "var(--muted, #9ca3af)", maxWidth: 320, lineHeight: 1.5 }}>
            Нажимайте <strong>«Примерить»</strong> на любых товарах ниже, чтобы в реальном времени оценить их вид на карточке коммандера.
          </div>
        </div>
      </div>

      {/* ── Category Filter Tabs ── */}
      <div
        className="tabs"
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          className={category === "all" ? "tab tab-active" : "tab"}
          onClick={() => setCategory("all")}
        >
          ВСЕ ТОВАРЫ ({items.length})
        </button>
        <button
          type="button"
          className={category === "frame" ? "tab tab-active" : "tab"}
          onClick={() => setCategory("frame")}
        >
          РАМКИ АВАТАРА (5)
        </button>
        <button
          type="button"
          className={category === "badge" ? "tab tab-active" : "tab"}
          onClick={() => setCategory("badge")}
        >
          ЗНАКИ ОТЛИЧИЯ (5)
        </button>
        <button
          type="button"
          className={category === "skin" ? "tab tab-active" : "tab"}
          onClick={() => setCategory("skin")}
        >
          HUD-ТЕМЫ (5)
        </button>
        <button
          type="button"
          className={category === "glow" ? "tab tab-active" : "tab"}
          onClick={() => setCategory("glow")}
        >
          СВЕЧЕНИЕ ПОЗЫВНОГО (4)
        </button>
        <button
          type="button"
          className={category === "title" ? "tab tab-active" : "tab"}
          onClick={() => setCategory("title")}
        >
          ПОЧЕТНЫЕ ТИТУЛЫ (4)
        </button>
        <button
          type="button"
          className={category === "inventory" ? "tab tab-active" : "tab"}
          onClick={() => setCategory("inventory")}
          style={{ borderColor: "var(--cyan, #3498db)", color: category === "inventory" ? "var(--cyan, #3498db)" : "var(--muted, #9ca3af)" }}
        >
          МОЙ ИНВЕНТАРЬ ({inventory.length})
        </button>
      </div>

      {/* ── Search Bar ── */}
      {category !== "inventory" && (
        <div style={{ position: "relative", maxWidth: 360 }}>
          <input
            type="text"
            placeholder="Поиск по каталогу модификаций..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: "100%", paddingLeft: 32 }}
          />
          <span style={{ position: "absolute", left: 10, top: 12, pointerEvents: "none" }}>
            <IconSearch size={14} color="#9ca3af" />
          </span>
        </div>
      )}

      {/* ── Inventory View ── */}
      {category === "inventory" && (
        <div className="card" style={{ margin: 0 }}>
          <h3 style={{ margin: "0 0 16px" }}>ВАШИ ПРИОБРЕТЕННЫЕ МОДИФИКАЦИИ</h3>
          {inventory.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: "var(--muted, #9ca3af)" }}>
              У вас пока нет купленных украшений. Ознакомьтесь с каталогом товаров выше!
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                gap: 16,
              }}
            >
              {inventory.map((inv) => {
                const item = inv.item || items.find((i) => i.id === inv.item_id);
                if (!item) return null;
                const active = isEquipped(item.id, item.category);

                return (
                  <div
                    key={inv.id}
                    style={{
                      padding: "16px",
                      background: "#25282b",
                      border: active ? "1px solid var(--orange, #e67e22)" : "1px solid var(--line, #3a3d40)",
                      borderRadius: 3,
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                    }}
                  >
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                        <span style={{ fontSize: 10, color: "var(--muted, #9ca3af)", textTransform: "uppercase" }}>
                          {item.category}
                        </span>
                        {active && (
                          <span style={{ fontSize: 10, color: "#2ecc71", fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>
                            ✓ ЭКИПИРОВАНО
                          </span>
                        )}
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                        {item.category === "frame" && <CosmeticAvatar frameId={item.id} size={42} />}
                        {item.category === "badge" && <CosmeticBadge badgeId={item.id} size={30} />}
                        {item.category === "glow" && <CosmeticCallsign name="CMDR" glowId={item.id} fontSize={14} />}
                        {item.category === "title" && <CosmeticTitle titleId={item.id} />}
                        {item.category === "skin" && (
                          <span style={{ width: 32, height: 20, background: item.preview_data.color || "#e67e22", borderRadius: 2 }} />
                        )}

                        <div>
                          <div style={{ fontWeight: 600, color: "var(--text, #eeeeee)" }}>{item.title}</div>
                          <div style={{ fontSize: 11, color: "var(--muted, #9ca3af)", marginTop: 2 }}>{item.description}</div>
                        </div>
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                      <button
                        type="button"
                        onClick={() => handleTryOn(item)}
                        style={{ flex: 1, padding: "6px", fontSize: 11, borderColor: "var(--line, #3a3d40)" }}
                      >
                        Примерить
                      </button>

                      {active ? (
                        <button
                          type="button"
                          onClick={() => handleToggleEquip(item.category, null)}
                          style={{ flex: 1, padding: "6px", fontSize: 11, borderColor: "rgba(231,76,60,0.4)", color: "#e74c3c" }}
                        >
                          Снять
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn-orange"
                          onClick={() => handleToggleEquip(item.category, item.id)}
                          style={{ flex: 1, padding: "6px", fontSize: 11 }}
                        >
                          Экипировать
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Catalog Grid ── */}
      {category !== "inventory" && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            gap: 18,
          }}
        >
          {loading ? (
            <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: 60, color: "var(--muted, #9ca3af)" }}>
              Загрузка каталога магазина...
            </div>
          ) : filteredItems.length === 0 ? (
            <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: 60, color: "var(--muted, #9ca3af)" }}>
              По вашему запросу товары не найдены
            </div>
          ) : (
            filteredItems.map((item) => {
              const owned = isOwned(item.id);
              const equippedNow = isEquipped(item.id, item.category);

              // Colors by rarity
              const rarityColor =
                item.rarity === "legendary"
                  ? "#fbbf24"
                  : item.rarity === "epic"
                  ? "#c084fc"
                  : item.rarity === "rare"
                  ? "#38bdf8"
                  : "#9ca3af";

              return (
                <div
                  key={item.id}
                  className="card"
                  style={{
                    margin: 0,
                    padding: 20,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    borderTop: `2px solid ${rarityColor}`,
                  }}
                >
                  <div>
                    {/* Header tags */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                      <span
                        style={{
                          fontSize: 9,
                          padding: "2px 6px",
                          borderRadius: 2,
                          background: `${rarityColor}20`,
                          color: rarityColor,
                          border: `1px solid ${rarityColor}60`,
                          fontFamily: "ui-monospace, monospace",
                          fontWeight: 700,
                          letterSpacing: 1,
                          textTransform: "uppercase",
                        }}
                      >
                        {item.rarity}
                      </span>

                      <span style={{ fontSize: 11, color: "var(--muted, #9ca3af)", fontFamily: "ui-monospace, monospace" }}>
                        {item.category === "frame"
                          ? "Рамка аватара"
                          : item.category === "badge"
                          ? "Знак отличия"
                          : item.category === "skin"
                          ? "HUD-тема"
                          : item.category === "glow"
                          ? "Свечение позывного"
                          : "Почетный титул"}
                      </span>
                    </div>

                    {/* Visual Preview Box */}
                    <div
                      style={{
                        height: 90,
                        background: "#1c1e20",
                        borderRadius: 3,
                        border: "1px solid var(--line, #3a3d40)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        marginBottom: 14,
                        position: "relative",
                        overflow: "hidden",
                      }}
                    >
                      {item.category === "frame" && (
                        <CosmeticAvatar frameId={item.id} size={56} showScanlines={true} />
                      )}

                      {item.category === "badge" && (
                        <CosmeticBadge badgeId={item.id} size={40} />
                      )}

                      {item.category === "glow" && (
                        <CosmeticCallsign name="CMDR PILOT" glowId={item.id} fontSize={16} />
                      )}

                      {item.category === "title" && (
                        <CosmeticTitle titleId={item.id} />
                      )}

                      {item.category === "skin" && (
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <span
                            style={{
                              width: 48,
                              height: 28,
                              background: item.preview_data.color || "#e67e22",
                              borderRadius: 2,
                              border: "1px solid rgba(255,255,255,0.3)",
                            }}
                          />
                          <span style={{ fontSize: 11, color: "var(--muted, #9ca3af)", fontFamily: "ui-monospace, monospace" }}>
                            Цветовая палитра
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Title & Lore Description */}
                    <h3 style={{ margin: "0 0 6px", fontSize: 15, color: "var(--text, #eeeeee)" }}>
                      {item.title}
                    </h3>

                    <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--muted, #9ca3af)", lineHeight: 1.5 }}>
                      {item.description}
                    </p>
                  </div>

                  {/* Pricing and Action */}
                  <div style={{ borderTop: "1px solid var(--line, #3a3d40)", paddingTop: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                      <div>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                          <span style={{ fontSize: 18, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "#38bdf8" }}>
                            {item.price_credits.toLocaleString("ru-RU")} Кр.
                          </span>
                          <span style={{ fontSize: 12, color: "var(--muted, #9ca3af)" }}>
                            ({item.price_rub} ₽)
                          </span>
                        </div>
                        {item.subscriber_discount_pct > 0 && (
                          <div style={{ fontSize: 10, color: "#2ecc71", fontFamily: "ui-monospace, monospace" }}>
                            Скидка подписчикам: -{item.subscriber_discount_pct}%
                          </div>
                        )}
                      </div>

                      {owned && (
                        <span style={{ fontSize: 11, color: "#2ecc71", fontFamily: "ui-monospace, monospace", fontWeight: 700 }}>
                          {equippedNow ? "✓ НАДЕТО" : "В ИНВЕНТАРЕ"}
                        </span>
                      )}
                    </div>

                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => handleTryOn(item)}
                        style={{
                          flex: 1,
                          padding: "8px",
                          fontSize: 11,
                          borderColor: "var(--line, #3a3d40)",
                          color: "var(--text, #eeeeee)",
                        }}
                      >
                        Примерить
                      </button>

                      {owned ? (
                        equippedNow ? (
                          <button
                            type="button"
                            onClick={() => handleToggleEquip(item.category, null)}
                            style={{
                              flex: 1,
                              padding: "8px",
                              fontSize: 11,
                              borderColor: "rgba(231,76,60,0.4)",
                              color: "#e74c3c",
                            }}
                          >
                            Снять
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn-orange"
                            onClick={() => handleToggleEquip(item.category, item.id)}
                            style={{ flex: 1, padding: "8px", fontSize: 11 }}
                          >
                            Надеть
                          </button>
                        )
                      ) : (
                        <button
                          type="button"
                          className="btn-orange"
                          onClick={() => setBuyingItem(item)}
                          style={{ flex: 1, padding: "8px", fontSize: 11 }}
                        >
                          Купить
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ── Purchase Modal ── */}
      {buyingItem && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.8)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 16,
          }}
        >
          <div className="card" style={{ maxWidth: 440, margin: 0, padding: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0, color: "var(--orange, #e67e22)" }}>ПОДТВЕРЖДЕНИЕ ПРИОБРЕТЕНИЯ</h3>
              <button
                type="button"
                onClick={() => setBuyingItem(null)}
                style={{ border: "none", color: "var(--muted, #9ca3af)", padding: 4 }}
              >
                <IconX size={18} />
              </button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
              {buyingItem.category === "frame" && <CosmeticAvatar frameId={buyingItem.id} size={50} />}
              {buyingItem.category === "badge" && <CosmeticBadge badgeId={buyingItem.id} size={36} />}
              {buyingItem.category === "glow" && <CosmeticCallsign name="CMDR" glowId={buyingItem.id} fontSize={16} />}
              {buyingItem.category === "title" && <CosmeticTitle titleId={buyingItem.id} />}
              {buyingItem.category === "skin" && (
                <span style={{ width: 36, height: 24, background: buyingItem.preview_data.color || "#e67e22", borderRadius: 2 }} />
              )}
              <div>
                <div style={{ fontWeight: 700, color: "var(--text, #eeeeee)", fontSize: 16 }}>{buyingItem.title}</div>
                <div style={{ fontSize: 11, color: "var(--muted, #9ca3af)" }}>{buyingItem.category.toUpperCase()}</div>
              </div>
            </div>

            <p style={{ fontSize: 13, color: "var(--muted, #9ca3af)", marginBottom: 18 }}>
              {buyingItem.description}
            </p>

            <div
              style={{
                padding: "12px 14px",
                background: "#1c1e20",
                border: "1px solid var(--line, #3a3d40)",
                borderRadius: 2,
                marginBottom: 20,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                <span style={{ color: "var(--muted, #9ca3af)" }}>Стоимость:</span>
                <strong style={{ color: "#38bdf8", fontFamily: "ui-monospace, monospace" }}>
                  {buyingItem.price_credits.toLocaleString("ru-RU")} Кр.
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span style={{ color: "var(--muted, #9ca3af)" }}>Ваш текущий баланс:</span>
                <span style={{ fontFamily: "ui-monospace, monospace", color: "var(--text, #eeeeee)" }}>
                  {balance.credits.toLocaleString("ru-RU")} Кр.
                </span>
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setBuyingItem(null)}
                style={{ borderColor: "var(--line, #3a3d40)", color: "var(--muted, #9ca3af)" }}
              >
                Отмена
              </button>

              <button
                type="button"
                className="btn-orange"
                disabled={purchasing || balance.credits < buyingItem.price_credits}
                onClick={() => handleConfirmPurchase(true)}
              >
                {purchasing
                  ? "Списание..."
                  : balance.credits < buyingItem.price_credits
                  ? "Недостаточно кредитов"
                  : "Оплатить кредитами"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Top-up Modal ── */}
      {showTopupModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.8)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 16,
          }}
        >
          <div className="card" style={{ maxWidth: 480, margin: 0, padding: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0, color: "var(--orange, #e67e22)" }}>ПОПОЛНЕНИЕ БАЛАНСА СНАБЖЕНИЯ</h3>
              <button
                type="button"
                onClick={() => setShowTopupModal(false)}
                style={{ border: "none", color: "var(--muted, #9ca3af)", padding: 4 }}
              >
                <IconX size={18} />
              </button>
            </div>

            <p style={{ fontSize: 13, color: "var(--muted, #9ca3af)", marginBottom: 16 }}>
              Выберите пакет кредитов для приобретения интерфейсных украшений и пожертвований на развитие инфраструктуры Кольца:
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
              {[
                { credits: 1500, rub: 199, label: "Стартовый набор пилота", bonus: null },
                { credits: 3500, rub: 399, label: "Набор исследователя дальних рубежей", bonus: "+250 Кр. БОНУС" },
                { credits: 7500, rub: 799, label: "Казначейский пакет эскадрильи", bonus: "+800 Кр. БОНУС" },
                { credits: 18000, rub: 1690, label: "Флагманский запас Основателя", bonus: "+3000 Кр. БОНУС" },
              ].map((pack) => (
                <div
                  key={pack.credits}
                  onClick={() => {
                    setTopupCredits(pack.credits);
                    setTopupRub(pack.rub);
                  }}
                  style={{
                    padding: "12px 16px",
                    background: topupCredits === pack.credits ? "rgba(230, 126, 34, 0.15)" : "#25282b",
                    border: topupCredits === pack.credits ? "1px solid var(--orange, #e67e22)" : "1px solid var(--line, #3a3d40)",
                    borderRadius: 2,
                    cursor: "pointer",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, color: "var(--text, #eeeeee)", fontSize: 14 }}>
                      +{pack.credits.toLocaleString("ru-RU")} Кредитов
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted, #9ca3af)", marginTop: 2 }}>
                      {pack.label}
                    </div>
                  </div>

                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: "var(--orange, #e67e22)" }}>
                      {pack.rub} ₽
                    </div>
                    {pack.bonus && (
                      <span style={{ fontSize: 9, color: "#2ecc71", fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>
                        {pack.bonus}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                type="button"
                onClick={() => setShowTopupModal(false)}
                style={{ borderColor: "var(--line, #3a3d40)", color: "var(--muted, #9ca3af)" }}
              >
                Отмена
              </button>

              <button
                type="button"
                className="btn-orange"
                disabled={topupBusy}
                onClick={handleTopup}
              >
                {topupBusy ? "Обработка платежа..." : `Оплатить ${topupRub} ₽ (СБП/Карта)`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
