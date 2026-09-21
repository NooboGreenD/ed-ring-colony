"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ShopItem, BillingPlan, CosmeticCategory, ItemRarity, ShopItemPreviewData } from "@/types/billing";
import { authFetch } from "@/lib/supabaseClient";
import CosmeticAvatar from "@/components/Cosmetics/CosmeticAvatar";
import CosmeticBadge, { BADGE_ICONS } from "@/components/Cosmetics/CosmeticBadge";
import CosmeticCallsign from "@/components/Cosmetics/CosmeticCallsign";
import CosmeticTitle from "@/components/Cosmetics/CosmeticTitle";
import ProfilePicker, { type PickedProfile } from "./ProfilePicker";
import { IconX, IconCheck } from "@/components/Icons";

const CATEGORIES: { id: CosmeticCategory; label: string }[] = [
  { id: "frame", label: "Рамка аватара" },
  { id: "badge", label: "Знак отличия" },
  { id: "skin", label: "HUD-тема" },
  { id: "glow", label: "Свечение позывного" },
  { id: "title", label: "Почётный титул" },
];
const RARITIES: ItemRarity[] = ["common", "rare", "epic", "legendary"];
const RARITY_COLOR: Record<string, string> = { legendary: "#fbbf24", epic: "#c084fc", rare: "#38bdf8", common: "#9ca3af" };
const FRAME_STYLES = ["ring", "singularity", "vanguard", "subzero", "solar", "stealth", "hex", "square", "gradient"];

type Draft = Partial<ShopItem> & { preview_data: ShopItemPreviewData };

const emptyDraft = (): Draft => ({
  category: "frame",
  title: "",
  description: "",
  price_credits: 500,
  price_rub: 99,
  rarity: "common",
  subscriber_discount_pct: 0,
  requires_subscription: null,
  is_active: true,
  is_featured: false,
  display_order: 100,
  preview_data: { color: "#e67e22", accentColor: "#f5b041", glowColor: "rgba(230,126,34,0.6)", frameStyle: "ring", icon: "star" },
});

function Preview({ item, name = "CMDR PILOT" }: { item: Draft; name?: string }) {
  const id = item.id || "draft";
  const p = item.preview_data;
  switch (item.category) {
    case "frame":
      return <CosmeticAvatar frameId={id} framePreview={p} size={56} showScanlines />;
    case "badge":
      return <CosmeticBadge badgeId={id} badgePreview={p} title={item.title} size={34} />;
    case "glow":
      return <CosmeticCallsign name={name} glowId={id} glowPreview={p} fontSize={16} />;
    case "title":
      return <CosmeticTitle titleId={id} titlePreview={p} text={item.title || "Титул"} />;
    case "skin":
      return <span style={{ width: 56, height: 32, borderRadius: 3, background: `linear-gradient(135deg, ${p.color || "#e67e22"}, ${p.accentColor || p.color || "#e67e22"})`, border: "1px solid rgba(255,255,255,0.25)" }} />;
    default:
      return null;
  }
}

export default function ProductManager({ onChanged }: { onChanged?: () => void }) {
  const [items, setItems] = useState<ShopItem[]>([]);
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterCat, setFilterCat] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(true);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [granting, setGranting] = useState<ShopItem | null>(null);
  const [grantProfile, setGrantProfile] = useState<PickedProfile | null>(null);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);

  const say = (text: string, ok = true) => {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 4500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch("/api/admin/billing/items", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setItems(data.items || []);
      setPlans(data.plans || []);
    } catch (e: any) {
      say("Ошибка загрузки: " + e.message, false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(
    () => items.filter((i) => (filterCat === "all" || i.category === filterCat) && (showInactive || i.is_active) && (!search || i.title.toLowerCase().includes(search.toLowerCase()) || i.id.includes(search))),
    [items, filterCat, showInactive, search],
  );

  const save = async () => {
    if (!editing) return;
    if (!editing.title?.trim()) return say("Введите название", false);
    setSaving(true);
    try {
      const isNew = !editing.id;
      const res = await authFetch("/api/admin/billing/items", {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка сохранения");
      say(isNew ? `Товар «${data.item.title}» создан` : `Товар «${data.item.title}» обновлён`);
      setEditing(null);
      load();
      onChanged?.();
    } catch (e: any) {
      say(e.message, false);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (item: ShopItem, patch: Partial<ShopItem>) => {
    try {
      const res = await authFetch("/api/admin/billing/items", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id, ...patch }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setItems((l) => l.map((i) => (i.id === item.id ? data.item : i)));
    } catch (e: any) {
      say(e.message, false);
    }
  };

  const remove = async (item: ShopItem) => {
    if (!confirm(`Удалить товар «${item.title}»? Если у пилотов есть этот предмет, он будет архивирован (снят с продажи), а не удалён.`)) return;
    try {
      const res = await authFetch(`/api/admin/billing/items?id=${item.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      say(data.message);
      load();
      onChanged?.();
    } catch (e: any) {
      say(e.message, false);
    }
  };

  const grant = async () => {
    if (!granting || !grantProfile) return;
    try {
      const res = await authFetch("/api/admin/billing/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "grant", userId: grantProfile.id, cmdrName: grantProfile.cmdr_name, itemId: granting.id }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      say(`«${granting.title}» выдан пилоту ${grantProfile.cmdr_name || grantProfile.id}`);
      setGranting(null);
      setGrantProfile(null);
      onChanged?.();
    } catch (e: any) {
      say(e.message, false);
    }
  };

  const setPD = (patch: Partial<ShopItemPreviewData>) => setEditing((d) => (d ? { ...d, preview_data: { ...d.preview_data, ...patch } } : d));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {toast && (
        <div style={{ position: "fixed", top: 24, right: 24, zIndex: 9999, padding: "10px 16px", background: toast.ok ? "rgba(46,204,113,0.2)" : "rgba(231,76,60,0.2)", border: `1px solid ${toast.ok ? "#2ecc71" : "#e74c3c"}`, color: toast.ok ? "#2ecc71" : "#e74c3c", fontSize: 13 }}>{toast.text}</div>
      )}

      <div className="card" style={{ margin: 0, padding: 16, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)} style={{ minWidth: 160 }}>
          <option value="all">Все категории</option>
          {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <input type="text" placeholder="Поиск по названию / id" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        <label style={{ fontSize: 12, color: "var(--muted)", display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> показывать снятые с продажи
        </label>
        <button type="button" className="btn-orange" onClick={() => setEditing(emptyDraft())}>+ Новый товар</button>
      </div>

      <div className="card" style={{ margin: 0, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#1c1e20", color: "var(--muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>
              {["Превью", "Товар", "Категория", "Редкость", "Цена", "Скидка/Доступ", "Продажи", "Статус", ""].map((h) => <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600 }}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} style={{ padding: 30, textAlign: "center", color: "var(--muted)" }}>Загрузка…</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={9} style={{ padding: 30, textAlign: "center", color: "var(--muted)" }}>Товаров нет</td></tr>
            ) : (
              visible.map((item) => (
                <tr key={item.id} style={{ borderTop: "1px solid var(--line)", opacity: item.is_active ? 1 : 0.55 }}>
                  <td style={{ padding: "8px 12px" }}><div style={{ display: "flex", alignItems: "center", justifyContent: "center", minWidth: 70 }}><Preview item={item as Draft} name="CMDR" /></div></td>
                  <td style={{ padding: "8px 12px" }}>
                    <div style={{ fontWeight: 600, color: "var(--text)" }}>{item.title}{item.is_featured && <span style={{ color: "#fbbf24", marginLeft: 6 }}>★</span>}</div>
                    <div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "ui-monospace, monospace" }}>{item.id}</div>
                  </td>
                  <td style={{ padding: "8px 12px", color: "var(--muted)" }}>{CATEGORIES.find((c) => c.id === item.category)?.label}</td>
                  <td style={{ padding: "8px 12px" }}><span style={{ color: RARITY_COLOR[item.rarity], fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>{item.rarity}</span></td>
                  <td style={{ padding: "8px 12px", fontFamily: "ui-monospace, monospace" }}><div style={{ color: "#38bdf8" }}>{item.price_credits} Кр.</div><div style={{ fontSize: 11, color: "var(--muted)" }}>{item.price_rub} ₽</div></td>
                  <td style={{ padding: "8px 12px", fontSize: 11 }}>
                    {item.subscriber_discount_pct > 0 && <div style={{ color: "#2ecc71" }}>−{item.subscriber_discount_pct}% подписчикам</div>}
                    {item.requires_subscription && <div style={{ color: "#c084fc" }}>только {plans.find((p) => p.id === item.requires_subscription)?.name || item.requires_subscription}</div>}
                  </td>
                  <td style={{ padding: "8px 12px", fontFamily: "ui-monospace, monospace" }}>{item.sales_count}</td>
                  <td style={{ padding: "8px 12px" }}>
                    <button type="button" onClick={() => toggle(item, { is_active: !item.is_active })} style={{ fontSize: 10, padding: "2px 8px", borderColor: item.is_active ? "#2ecc71" : "var(--line)", color: item.is_active ? "#2ecc71" : "var(--muted)" }}>{item.is_active ? "В ПРОДАЖЕ" : "СКРЫТ"}</button>
                  </td>
                  <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                    <button type="button" onClick={() => setEditing({ ...item, preview_data: { ...item.preview_data } })} style={{ fontSize: 11, padding: "3px 8px", marginRight: 4 }}>Изменить</button>
                    <button type="button" onClick={() => { setGranting(item); setGrantProfile(null); }} style={{ fontSize: 11, padding: "3px 8px", marginRight: 4, borderColor: "var(--cyan)", color: "var(--cyan)" }}>Выдать</button>
                    <button type="button" onClick={() => remove(item)} style={{ fontSize: 11, padding: "3px 8px", borderColor: "rgba(231,76,60,0.4)", color: "#e74c3c" }}>✕</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Editor */}
      {editing && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setEditing(null)}>
          <div className="card" style={{ maxWidth: 820, width: "100%", margin: 0, padding: 22, maxHeight: "92vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0, color: "var(--orange)" }}>{editing.id ? "РЕДАКТИРОВАНИЕ ТОВАРА" : "НОВЫЙ ТОВАР"}</h3>
              <button type="button" onClick={() => setEditing(null)} style={{ border: "none", background: "transparent", color: "var(--muted)" }}><IconX size={18} /></button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 260px", gap: 20 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Категория">
                  <select value={editing.category} disabled={!!editing.id} onChange={(e) => setEditing({ ...editing, category: e.target.value as CosmeticCategory })}>
                    {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                </Field>
                <Field label="Редкость">
                  <select value={editing.rarity} onChange={(e) => setEditing({ ...editing, rarity: e.target.value as ItemRarity })}>{RARITIES.map((r) => <option key={r} value={r}>{r}</option>)}</select>
                </Field>
                <Field label="Название (RU)" full><input value={editing.title || ""} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></Field>
                <Field label="Название (EN)" full><input value={editing.title_en || ""} onChange={(e) => setEditing({ ...editing, title_en: e.target.value })} /></Field>
                <Field label="Описание (RU)" full><textarea rows={2} value={editing.description || ""} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></Field>
                <Field label="Описание (EN)" full><textarea rows={2} value={editing.description_en || ""} onChange={(e) => setEditing({ ...editing, description_en: e.target.value })} /></Field>
                <Field label="Цена, кредиты"><input type="number" min={0} value={editing.price_credits ?? 0} onChange={(e) => setEditing({ ...editing, price_credits: Number(e.target.value) })} /></Field>
                <Field label="Цена, ₽ (0 = только за кредиты)"><input type="number" min={0} value={editing.price_rub ?? 0} onChange={(e) => setEditing({ ...editing, price_rub: Number(e.target.value) })} /></Field>
                <Field label="Скидка подписчикам, %"><input type="number" min={0} max={100} value={editing.subscriber_discount_pct ?? 0} onChange={(e) => setEditing({ ...editing, subscriber_discount_pct: Number(e.target.value) })} /></Field>
                <Field label="Только для подписки">
                  <select value={editing.requires_subscription || ""} onChange={(e) => setEditing({ ...editing, requires_subscription: e.target.value || null })}>
                    <option value="">— всем —</option>
                    {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </Field>
                <Field label="Порядок сортировки"><input type="number" value={editing.display_order ?? 100} onChange={(e) => setEditing({ ...editing, display_order: Number(e.target.value) })} /></Field>
                <div style={{ display: "flex", gap: 16, alignItems: "flex-end", fontSize: 12 }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={!!editing.is_active} onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })} /> В продаже</label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={!!editing.is_featured} onChange={(e) => setEditing({ ...editing, is_featured: e.target.checked })} /> ★ Рекомендуемый</label>
                </div>

                <div style={{ gridColumn: "1 / -1", borderTop: "1px solid var(--line)", paddingTop: 10, marginTop: 4, fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1 }}>Внешний вид (preview_data)</div>
                <Field label="Основной цвет"><ColorInput value={editing.preview_data.color || "#e67e22"} onChange={(v) => setPD({ color: v })} /></Field>
                <Field label="Акцентный цвет"><ColorInput value={editing.preview_data.accentColor || editing.preview_data.color || "#e67e22"} onChange={(v) => setPD({ accentColor: v })} /></Field>
                <Field label="Цвет свечения (CSS)"><input value={editing.preview_data.glowColor || ""} placeholder="rgba(230,126,34,0.6)" onChange={(e) => setPD({ glowColor: e.target.value })} /></Field>
                {editing.category === "frame" && (
                  <>
                    <Field label="Стиль рамки"><select value={editing.preview_data.frameStyle || "ring"} onChange={(e) => setPD({ frameStyle: e.target.value })}>{FRAME_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
                    <Field label="Толщина рамки, px"><input type="number" min={1} max={6} value={editing.preview_data.borderWidth || 2} onChange={(e) => setPD({ borderWidth: Number(e.target.value) })} /></Field>
                  </>
                )}
                {editing.category === "badge" && (
                  <Field label="Иконка" full>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {Object.entries(BADGE_ICONS).map(([k, Icon]) => (
                        <button key={k} type="button" title={k} onClick={() => setPD({ icon: k })} style={{ padding: 6, borderColor: editing.preview_data.icon === k ? "var(--orange)" : "var(--line)" }}><Icon size={16} color={editing.preview_data.color} /></button>
                      ))}
                    </div>
                  </Field>
                )}
                {editing.category === "skin" && (
                  <Field label="CSS-класс темы (hud-<класс> на <html>)" full><input value={editing.preview_data.hudSkinClass || ""} placeholder="skin-my-theme" onChange={(e) => setPD({ hudSkinClass: e.target.value })} /></Field>
                )}
                {editing.category === "title" && (
                  <Field label="Подзаголовок / надпись под титулом" full><input value={editing.preview_data.subTitle || ""} onChange={(e) => setPD({ subTitle: e.target.value })} /></Field>
                )}
                {editing.category === "glow" && (
                  <Field label="Градиент текста (CSS, опционально)" full><input value={editing.preview_data.gradient || ""} placeholder="linear-gradient(90deg,#f00,#00f)" onChange={(e) => setPD({ gradient: e.target.value })} /></Field>
                )}
              </div>

              <div>
                <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Живой превью</div>
                <div style={{ height: 130, background: "#181a1c", border: "1px dashed rgba(230,126,34,0.4)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
                  <Preview item={editing} />
                </div>
                <div style={{ padding: 12, background: "#1c1e20", border: "1px solid var(--line)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <CosmeticAvatar frameId={editing.category === "frame" ? editing.id || "draft" : null} framePreview={editing.category === "frame" ? editing.preview_data : undefined} size={40} />
                    <div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        {editing.category === "badge" && <CosmeticBadge badgeId={editing.id || "draft"} badgePreview={editing.preview_data} size={18} />}
                        <CosmeticCallsign name="CMDR PILOT" glowId={editing.category === "glow" ? editing.id || "draft" : null} glowPreview={editing.category === "glow" ? editing.preview_data : undefined} fontSize={14} />
                      </div>
                      {editing.category === "title" && <CosmeticTitle titleId={editing.id || "draft"} titlePreview={editing.preview_data} text={editing.title || "Титул"} />}
                    </div>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 8 }}>Так предмет будет виден в профиле, на форуме и в реестре.</div>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
              <button type="button" onClick={() => setEditing(null)} style={{ borderColor: "var(--line)", color: "var(--muted)" }}>Отмена</button>
              <button type="button" className="btn-orange" disabled={saving} onClick={save}>{saving ? "Сохранение…" : editing.id ? "Сохранить" : "Создать товар"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Grant */}
      {granting && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setGranting(null)}>
          <div className="card" style={{ maxWidth: 440, width: "100%", margin: 0, padding: 22 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 12px", color: "var(--cyan)" }}>ВЫДАТЬ «{granting.title.toUpperCase()}»</h3>
            <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 12px" }}>Предмет будет добавлен в инвентарь пилота бесплатно (транзакция admin_grant) и автоматически экипирован.</p>
            <ProfilePicker value={grantProfile} onChange={setGrantProfile} autoFocus />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
              <button type="button" onClick={() => setGranting(null)} style={{ borderColor: "var(--line)", color: "var(--muted)" }}>Отмена</button>
              <button type="button" className="btn-orange" disabled={!grantProfile} onClick={grant}><IconCheck size={12} /> Выдать</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--muted)", gridColumn: full ? "1 / -1" : undefined }}>
      {label}
      {children}
    </label>
  );
}

function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const hex = /^#([0-9a-f]{6})$/i.test(value) ? value : "#e67e22";
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <input type="color" value={hex} onChange={(e) => onChange(e.target.value)} style={{ width: 40, padding: 0, height: 34 }} />
      <input value={value} onChange={(e) => onChange(e.target.value)} style={{ flex: 1 }} />
    </div>
  );
}
