import type { ShopItemPreviewData } from "@/types/billing";

export interface CosmeticRef {
  id: string;
  title?: string;
  rarity?: string;
  preview: ShopItemPreviewData & Record<string, any>;
}

export interface PilotCosmetics {
  user_id: string;
  frame: CosmeticRef | null;
  badge: CosmeticRef | null;
  skin: CosmeticRef | null;
  glow: CosmeticRef | null;
  title: CosmeticRef | null;
  tier: { id: string; label: string; color: string } | null;
}

export const EMPTY_COSMETICS = (userId = ""): PilotCosmetics => ({
  user_id: userId,
  frame: null,
  badge: null,
  skin: null,
  glow: null,
  title: null,
  tier: null,
});

/** Legacy fallbacks for the seeded catalogue so old ids keep rendering without preview data. */
export const LEGACY_PREVIEW: Record<string, ShopItemPreviewData & Record<string, any>> = {
  "frame-singularity": { color: "#a855f7", accentColor: "#3b82f6", glowColor: "rgba(168,85,247,0.65)", frameStyle: "singularity", borderWidth: 3 },
  "frame-vanguard": { color: "#e67e22", accentColor: "#f39c12", glowColor: "rgba(230,126,34,0.55)", frameStyle: "vanguard", borderWidth: 2 },
  "frame-subzero": { color: "#06b6d4", accentColor: "#38bdf8", glowColor: "rgba(6,182,212,0.6)", frameStyle: "subzero", borderWidth: 2 },
  "frame-solar": { color: "#f97316", accentColor: "#eab308", glowColor: "rgba(249,115,22,0.7)", frameStyle: "solar", borderWidth: 3 },
  "frame-stealth": { color: "#ef4444", accentColor: "#991b1b", glowColor: "rgba(239,68,68,0.5)", frameStyle: "stealth", borderWidth: 2 },
  "badge-founder": { color: "#fbbf24", icon: "crown" },
  "badge-explorer": { color: "#38bdf8", icon: "star" },
  "badge-titan": { color: "#10b981", icon: "sword" },
  "badge-carrier": { color: "#60a5fa", icon: "anchor" },
  "badge-mining": { color: "#a3e635", icon: "diamond" },
  "glow-hyperspace": { color: "#8b5cf6", gradient: "linear-gradient(90deg, #ec4899, #8b5cf6, #06b6d4, #ec4899)" },
  "glow-neutron": { color: "#38bdf8", gradient: "linear-gradient(90deg, #38bdf8, #e0f2fe, #38bdf8)" },
  "glow-solar": { color: "#f59e0b", gradient: "linear-gradient(90deg, #f59e0b, #fef08a, #f59e0b)" },
  "glow-voidpulse": { color: "#9333ea", gradient: "linear-gradient(90deg, #9333ea, #e9d5ff, #9333ea)" },
  "title-architect": { color: "#f97316", subTitle: "Архитектор Нового Рубежа" },
  "title-trailblazer": { color: "#a855f7", subTitle: "Первопроходец Бездны" },
  "title-jaques": { color: "#38bdf8", subTitle: "Легенда Жак-Стейшн" },
  "title-marshal": { color: "#eab308", subTitle: "Маршал Звездного Пути" },
  "skin-amber": { color: "#f59e0b", accentColor: "#fbbf24", hudSkinClass: "skin-colonia-amber" },
  "skin-cyber": { color: "#ec4899", accentColor: "#06b6d4", hudSkinClass: "skin-cyberpunk-3309" },
  "skin-void": { color: "#3b82f6", accentColor: "#8b5cf6", hudSkinClass: "skin-void-navigator" },
  "skin-imperial": { color: "#eab308", accentColor: "#f5f5f4", hudSkinClass: "skin-imperial-gold" },
  "skin-emerald": { color: "#10b981", accentColor: "#34d399", hudSkinClass: "skin-emerald-outpost" },
};

export function resolvePreview(id?: string | null, preview?: Record<string, any> | null): (ShopItemPreviewData & Record<string, any>) | null {
  if (!id) return null;
  const legacy = LEGACY_PREVIEW[id] || {};
  return { ...legacy, ...(preview || {}) };
}

/** Convert #rrggbb to rgba(r,g,b,a). Falls back to the input for other formats. */
export function withAlpha(color: string | undefined, alpha: number, fallback = "rgba(230,126,34,0.5)"): string {
  if (!color) return fallback;
  const m = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return color;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
