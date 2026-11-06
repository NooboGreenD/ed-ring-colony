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
import { useI18n } from "@/lib/i18n/I18nContext";

const CATEGORIES: { id: CosmeticCategory; label: string }[] = [
  { id: "frame", label: "pm.catFrame" },
  { id: "badge", label: "pm.catBadge" },
  { id: "skin", label: "pm.catSkin" },
  { id: "glow", label: "pm.catGlow" },
  { id: "title", label: "pm.catTitle" },
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
  const { t } = useI18n();
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
      return <CosmeticTitle titleId={id} titlePreview={p} text={item.title || t("pm.defaultTitle")} />;
    case "skin":
      return <span style={{ width: 56, height: 32, borderRadius: 3, background: `linear-gradient(135deg, ${p.color || "#e67e22"}, ${p.accentColor || p.color || "#e67e22"})`, border: "1px solid rgba(255,255,255,0.25)" }} />;
    default:
      return null;
  }
}

export default function ProductManager({ onChanged }: { onChanged?: () => void }) {
  const { t } = useI18n();
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
      say(t("pm.loadError", { message: e.message }), false);
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
    if (!editing.title?.trim()) return say(t("pm.enterTitle"), false);
    setSaving(true);
    try {
      const isNew = !editing.id;
      const res = await authFetch("/api/admin/billing/items", {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("pm.saveError"));
      say(isNew ? t("pm.created", { name: data.item.title }) : t("pm.updated", { name: data.item.title }));
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
    if (!confirm(t("pm.confirmDelete", { name: item.title }))) return;
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
      say(t("pm.granted", { name: granting.title, pilot: grantProfile.cmdr_name || grantProfile.id }));
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
          <option value="all">{t("pm.catAll")}</option>
          {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <input type="text" placeholder={t("pm.searchPlaceholder")} value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        <label style={{ fontSize: 12, color: "var(--muted)", display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> {t("pm.showInactive")}
        </label>
        <button type="button" className="btn-orange" onClick={() => setEditing(emptyDraft())}>{t("pm.newItem")}</button>
      </div>

      <div className="card" style={{ margin: 0, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#1c1e20", color: "var(--muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>
              {[t("pm.colPreview"), t("pm.colItem"), t("pm.colCategory"), t("pm.colRarity"), t("pm.colPrice"), t("pm.colDiscount"), t("pm.colSales"), t("pm.colStatus"), ""].map((h) => <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600 }}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} style={{ padding: 30, textAlign: "center", color: "var(--muted)" }}>{t("pm.loading")}</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={9} style={{ padding: 30, textAlign: "center", color: "var(--muted)" }}>{t("pm.none")}</td></tr>
            ) : (
              visible.map((item) => (
                <tr key={item.id} style={{ borderTop: "1px solid var(--line)", opacity: item.is_active ? 1 : 0.55 }}>
                  <td style={{ padding: "8px 12px" }}><div style={{ display: "flex", alignItems: "center", justifyContent: "center", minWidth: 70 }}><Preview item={item as Draft} name="CMDR" /></div></td>
                  <td style={{ padding: "8px 12px" }}>
                    <div style={{ fontWeight: 600, color: "var(--text)" }}>{item.title}{item.is_featured && <span style={{ color: "#fbbf24", marginLeft: 6 }}>★</span>}</div>
                    <div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "ui-monospace, monospace" }}>{item.id}</div>
                  </td>
                  <td style={{ padding: "8px 12px", color: "var(--muted)" }}>{t(CATEGORIES.find((c) => c.id === item.category)?.label ?? "")}</td>
                  <td style={{ padding: "8px 12px" }}><span style={{ color: RARITY_COLOR[item.rarity], fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>{item.rarity}</span></td>
                  <td style={{ padding: "8px 12px", fontFamily: "ui-monospace, monospace" }}><div style={{ color: "#38bdf8" }}>{t("pm.credits", { value: item.price_credits })}</div><div style={{ fontSize: 11, color: "var(--muted)" }}>{t("pm.rub", { value: item.price_rub })}</div></td>
                  <td style={{ padding: "8px 12px", fontSize: 11 }}>
                    {item.subscriber_discount_pct > 0 && <div style={{ color: "#2ecc71" }}>{t("pm.discount", { percent: item.subscriber_discount_pct })}</div>}
                    {item.requires_subscription && <div style={{ color: "#c084fc" }}>{t("pm.onlyPlan", { plan: plans.find((p) => p.id === item.requires_subscription)?.name || item.requires_subscription })}</div>}
                  </td>
                  <td style={{ padding: "8px 12px", fontFamily: "ui-monospace, monospace" }}>{item.sales_count}</td>
                  <td style={{ padding: "8px 12px" }}>
                    <button type="button" onClick={() => toggle(item, { is_active: !item.is_active })} style={{ fontSize: 10, padding: "2px 8px", borderColor: item.is_active ? "#2ecc71" : "var(--line)", color: item.is_active ? "#2ecc71" : "var(--muted)" }}>{item.is_active ? t("pm.onSale") : t("pm.hiddenState")}</button>
                  </td>
                  <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                    <button type="button" onClick={() => setEditing({ ...item, preview_data: { ...item.preview_data } })} style={{ fontSize: 11, padding: "3px 8px", marginRight: 4 }}>{t("pm.edit")}</button>
                    <button type="button" onClick={() => { setGranting(item); setGrantProfile(null); }} style={{ fontSize: 11, padding: "3px 8px", marginRight: 4, borderColor: "var(--cyan)", color: "var(--cyan)" }}>{t("pm.grant")}</button>
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
              <h3 style={{ margin: 0, color: "var(--orange)" }}>{editing.id ? t("pm.editHeader") : t("pm.newHeader")}</h3>
              <button type="button" onClick={() => setEditing(null)} style={{ border: "none", background: "transparent", color: "var(--muted)" }}><IconX size={18} /></button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 260px", gap: 20 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label={t("pm.fCategory")}>
                  <select value={editing.category} disabled={!!editing.id} onChange={(e) => setEditing({ ...editing, category: e.target.value as CosmeticCategory })}>
                    {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                </Field>
                <Field label={t("pm.fRarity")}>
                  <select value={editing.rarity} onChange={(e) => setEditing({ ...editing, rarity: e.target.value as ItemRarity })}>{RARITIES.map((r) => <option key={r} value={r}>{r}</option>)}</select>
                </Field>
                <Field label={t("pm.fTitleRu")} full><input value={editing.title || ""} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></Field>
                <Field label={t("pm.fTitleEn")} full><input value={editing.title_en || ""} onChange={(e) => setEditing({ ...editing, title_en: e.target.value })} /></Field>
                <Field label={t("pm.fDescRu")} full><textarea rows={2} value={editing.description || ""} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></Field>
                <Field label={t("pm.fDescEn")} full><textarea rows={2} value={editing.description_en || ""} onChange={(e) => setEditing({ ...editing, description_en: e.target.value })} /></Field>
                <Field label={t("pm.fPriceCredits")}><input type="number" min={0} value={editing.price_credits ?? 0} onChange={(e) => setEditing({ ...editing, price_credits: Number(e.target.value) })} /></Field>
                <Field label={t("pm.fPriceRub")}><input type="number" min={0} value={editing.price_rub ?? 0} onChange={(e) => setEditing({ ...editing, price_rub: Number(e.target.value) })} /></Field>
                <Field label={t("pm.fDiscount")}><input type="number" min={0} max={100} value={editing.subscriber_discount_pct ?? 0} onChange={(e) => setEditing({ ...editing, subscriber_discount_pct: Number(e.target.value) })} /></Field>
                <Field label={t("pm.fRequiresSub")}>
                  <select value={editing.requires_subscription || ""} onChange={(e) => setEditing({ ...editing, requires_subscription: e.target.value || null })}>
                    <option value="">{t("pm.fAll")}</option>
                    {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </Field>
                <Field label={t("pm.fOrder")}><input type="number" value={editing.display_order ?? 100} onChange={(e) => setEditing({ ...editing, display_order: Number(e.target.value) })} /></Field>
                <div style={{ display: "flex", gap: 16, alignItems: "flex-end", fontSize: 12 }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={!!editing.is_active} onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })} /> {t("pm.fOnSale")}</label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={!!editing.is_featured} onChange={(e) => setEditing({ ...editing, is_featured: e.target.checked })} /> {t("pm.fFeatured")}</label>
                </div>

                <div style={{ gridColumn: "1 / -1", borderTop: "1px solid var(--line)", paddingTop: 10, marginTop: 4, fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1 }}>{t("pm.appearance")}</div>
                <Field label={t("pm.fColor")}><ColorInput value={editing.preview_data.color || "#e67e22"} onChange={(v) => setPD({ color: v })} /></Field>
                <Field label={t("pm.fAccent")}><ColorInput value={editing.preview_data.accentColor || editing.preview_data.color || "#e67e22"} onChange={(v) => setPD({ accentColor: v })} /></Field>
                <Field label={t("pm.fGlow")}><input value={editing.preview_data.glowColor || ""} placeholder="rgba(230,126,34,0.6)" onChange={(e) => setPD({ glowColor: e.target.value })} /></Field>
                {editing.category === "frame" && (
                  <>
                    <Field label={t("pm.fFrameStyle")}><select value={editing.preview_data.frameStyle || "ring"} onChange={(e) => setPD({ frameStyle: e.target.value })}>{FRAME_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
                    <Field label={t("pm.fBorderWidth")}><input type="number" min={1} max={6} value={editing.preview_data.borderWidth || 2} onChange={(e) => setPD({ borderWidth: Number(e.target.value) })} /></Field>
                  </>
                )}
                {editing.category === "badge" && (
                  <Field label={t("pm.fIcon")} full>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {Object.entries(BADGE_ICONS).map(([k, Icon]) => (
                        <button key={k} type="button" title={k} onClick={() => setPD({ icon: k })} style={{ padding: 6, borderColor: editing.preview_data.icon === k ? "var(--orange)" : "var(--line)" }}><Icon size={16} color={editing.preview_data.color} /></button>
                      ))}
                    </div>
                  </Field>
                )}
                {editing.category === "skin" && (
                  <>
                    <Field label={t("pm.fHudClass")} full><input value={editing.preview_data.hudSkinClass || ""} placeholder="skin-my-theme" onChange={(e) => setPD({ hudSkinClass: e.target.value })} /></Field>
                    <div style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1, marginTop: 4 }}>{t("pm.palette")}</div>
                    {([["bg", "pm.palBg"], ["panel", "pm.palPanel"], ["panelHover", "pm.palPanelHover"], ["line", "pm.palLine"], ["text", "pm.palText"], ["muted", "pm.palMuted"], ["orange", "pm.palOrange"], ["orangeHover", "pm.palOrangeHover"], ["cyan", "pm.palCyan"], ["green", "pm.palGreen"], ["red", "pm.palRed"]] as [string, string][]).map(([k, label]) => (
                      <Field key={k} label={t(label)}>
                        <ColorInput value={(editing.preview_data.theme as any)?.[k] || ""} onChange={(v) => setPD({ theme: { ...(editing.preview_data.theme || {}), [k]: v } })} />
                      </Field>
                    ))}
                    <Field label={t("pm.fBackground")} full><input value={editing.preview_data.theme?.background || ""} placeholder="radial-gradient(ellipse at top, #222 0%, #111 60%)" onChange={(e) => setPD({ theme: { ...(editing.preview_data.theme || {}), background: e.target.value } })} /></Field>
                    <Field label={t("pm.fEffect")}>
                      <select value={editing.preview_data.theme?.effect || ""} onChange={(e) => setPD({ theme: { ...(editing.preview_data.theme || {}), effect: e.target.value } })}>
                        <option value="">{t("pm.effNone")}</option>
                        <option value="scanlines">{t("pm.effScanlines")}</option>
                        <option value="grid">{t("pm.effGrid")}</option>
                        <option value="stars">{t("pm.effStars")}</option>
                        <option value="vignette">{t("pm.effVignette")}</option>
                        <option value="glow">{t("pm.effGlow")}</option>
                      </select>
                    </Field>
                    <Field label={t("pm.fFont")}><input value={editing.preview_data.theme?.font || ""} placeholder="'JetBrains Mono', monospace" onChange={(e) => setPD({ theme: { ...(editing.preview_data.theme || {}), font: e.target.value } })} /></Field>
                    <div style={{ gridColumn: "1 / -1" }}><ThemeSwatch theme={editing.preview_data.theme} accent={editing.preview_data.color} /></div>
                  </>
                )}
                {editing.category === "title" && (
                  <Field label={t("pm.fSubtitle")} full><input value={editing.preview_data.subTitle || ""} onChange={(e) => setPD({ subTitle: e.target.value })} /></Field>
                )}
                {editing.category === "glow" && (
                  <Field label={t("pm.fGradient")} full><input value={editing.preview_data.gradient || ""} placeholder="linear-gradient(90deg,#f00,#00f)" onChange={(e) => setPD({ gradient: e.target.value })} /></Field>
                )}
              </div>

              <div>
                <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>{t("pm.livePreview")}</div>
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
                      {editing.category === "title" && <CosmeticTitle titleId={editing.id || "draft"} titlePreview={editing.preview_data} text={editing.title || t("pm.defaultTitle")} />}
                    </div>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 8 }}>{t("pm.previewHint")}</div>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
              <button type="button" onClick={() => setEditing(null)} style={{ borderColor: "var(--line)", color: "var(--muted)" }}>{t("pm.cancel")}</button>
              <button type="button" className="btn-orange" disabled={saving} onClick={save}>{saving ? t("pm.saving") : editing.id ? t("pm.save") : t("pm.createItem")}</button>
            </div>
          </div>
        </div>
      )}

      {/* Grant */}
      {granting && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setGranting(null)}>
          <div className="card" style={{ maxWidth: 440, width: "100%", margin: 0, padding: 22 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 12px", color: "var(--cyan)" }}>{t("pm.grantHeader", { name: granting.title.toUpperCase() })}</h3>
            <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 12px" }}>{t("pm.grantHint")}</p>
            <ProfilePicker value={grantProfile} onChange={setGrantProfile} autoFocus />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
              <button type="button" onClick={() => setGranting(null)} style={{ borderColor: "var(--line)", color: "var(--muted)" }}>{t("pm.cancel")}</button>
              <button type="button" className="btn-orange" disabled={!grantProfile} onClick={grant}><IconCheck size={12} /> {t("pm.grant")}</button>
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

/** Miniature of the site rendered with the given colour scheme. */
export function ThemeSwatch({ theme, accent, compact }: { theme?: ShopItemPreviewData["theme"]; accent?: string; compact?: boolean }) {
  const { t } = useI18n();
  const th = theme || {};
  const bg = th.bg || "#1e2022", panel = th.panel || "#2a2d30", line = th.line || "#3a3d40", text = th.text || "#eeeeee", muted = th.muted || "#9ca3af", orange = th.orange || accent || "#e67e22", cyan = th.cyan || "#3498db";
  const h = compact ? 64 : 110;
  return (
    <div style={{ background: th.background || bg, border: `1px solid ${line}`, borderRadius: 4, padding: compact ? 6 : 10, height: h, display: "flex", flexDirection: "column", gap: compact ? 4 : 6, fontFamily: th.font || undefined, overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ width: compact ? 22 : 40, height: compact ? 4 : 6, background: orange, borderRadius: 2 }} />
        <span style={{ width: compact ? 16 : 28, height: compact ? 4 : 6, background: muted, borderRadius: 2, opacity: 0.6 }} />
        <span style={{ width: compact ? 16 : 28, height: compact ? 4 : 6, background: muted, borderRadius: 2, opacity: 0.6 }} />
        <span style={{ marginLeft: "auto", width: compact ? 14 : 24, height: compact ? 4 : 6, background: cyan, borderRadius: 2 }} />
      </div>
      <div style={{ display: "flex", gap: 6, flex: 1 }}>
        <div style={{ flex: 2, background: panel, border: `1px solid ${line}`, borderRadius: 3, padding: compact ? 4 : 8 }}>
          {!compact && <div style={{ fontSize: 9, color: orange, letterSpacing: 1, fontWeight: 700 }}>{t("pm.panel")}</div>}
          <div style={{ width: "70%", height: 4, background: text, opacity: 0.8, borderRadius: 2, marginTop: compact ? 0 : 4 }} />
          <div style={{ width: "50%", height: 4, background: muted, opacity: 0.6, borderRadius: 2, marginTop: 4 }} />
        </div>
        <div style={{ flex: 1, background: panel, border: `1px solid ${line}`, borderRadius: 3, padding: compact ? 4 : 8, display: "flex", alignItems: "flex-end" }}>
          <span style={{ width: "100%", height: compact ? 8 : 14, background: orange, borderRadius: 2, opacity: 0.9 }} />
        </div>
      </div>
    </div>
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
