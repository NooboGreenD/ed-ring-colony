"use client";

import React from "react";
import { IconCrown, IconDiamond, IconSword, IconAnchor, IconStar, IconShield, IconRocket, IconBolt, IconFlame, IconHeart, IconGlobe, IconTarget, IconSun, IconRingPlanet } from "@/components/Icons";
import { resolvePreview, withAlpha } from "./types";

interface CosmeticBadgeProps {
  badgeId?: string | null;
  badgePreview?: Record<string, any> | null;
  title?: string | null;
  size?: number;
  showTitleTooltip?: boolean;
}

export const BADGE_ICONS: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  crown: IconCrown,
  diamond: IconDiamond,
  sword: IconSword,
  anchor: IconAnchor,
  star: IconStar,
  shield: IconShield,
  rocket: IconRocket,
  bolt: IconBolt,
  flame: IconFlame,
  heart: IconHeart,
  globe: IconGlobe,
  target: IconTarget,
  sun: IconSun,
  planet: IconRingPlanet,
};

export default function CosmeticBadge({ badgeId, badgePreview, title, size = 22, showTitleTooltip = true }: CosmeticBadgeProps) {
  const p = resolvePreview(badgeId, badgePreview);
  if (!p) return null;
  const color = p.color || "#fbbf24";
  const Icon = BADGE_ICONS[p.icon || "star"] || IconStar;
  const label = title || p.subTitle || "Знак отличия";

  return (
    <span
      title={showTitleTooltip ? label : undefined}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: size, height: size, borderRadius: 3, background: withAlpha(color, 0.15), border: `1px solid ${color}`, boxShadow: `0 0 6px ${withAlpha(color, 0.25)}`, verticalAlign: "middle", flexShrink: 0, cursor: "help" }}
    >
      {p.emoji ? <span style={{ fontSize: size - 8, lineHeight: 1 }}>{p.emoji}</span> : <Icon size={size - 6} color={color} />}
    </span>
  );
}
