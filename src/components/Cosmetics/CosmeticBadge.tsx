"use client";

import React from "react";
import { IconCrown, IconDiamond, IconSword, IconAnchor, IconStar } from "@/components/Icons";

interface CosmeticBadgeProps {
  badgeId?: string | null;
  size?: number;
  showTitleTooltip?: boolean;
}

export default function CosmeticBadge({
  badgeId,
  size = 22,
  showTitleTooltip = true,
}: CosmeticBadgeProps) {
  if (!badgeId) return null;

  let title = "Знак отличия";
  let content = null;
  let bg = "#1e2022";
  let border = "#3a3d40";

  switch (badgeId) {
    case "badge-founder":
      title = "Орден Основателя Кольца (Legendary)";
      bg = "rgba(251, 191, 36, 0.15)";
      border = "#fbbf24";
      content = <IconCrown size={size - 6} color="#fbbf24" />;
      break;

    case "badge-explorer":
      title = "Звездный Первопроходец (Rare)";
      bg = "rgba(56, 189, 248, 0.15)";
      border = "#38bdf8";
      content = <IconStar size={size - 6} color="#38bdf8" />;
      break;

    case "badge-titan":
      title = "Покоритель Титанов (Epic)";
      bg = "rgba(16, 185, 129, 0.15)";
      border = "#10b981";
      content = <IconSword size={size - 6} color="#10b981" />;
      break;

    case "badge-carrier":
      title = "Владелец Флагмана (Epic)";
      bg = "rgba(96, 165, 250, 0.15)";
      border = "#60a5fa";
      content = <IconAnchor size={size - 6} color="#60a5fa" />;
      break;

    case "badge-mining":
      title = "Мастер Глубинного Бурения (Common)";
      bg = "rgba(163, 230, 53, 0.15)";
      border = "#a3e635";
      content = <IconDiamond size={size - 6} color="#a3e635" />;
      break;

    default:
      return null;
  }

  return (
    <span
      title={showTitleTooltip ? title : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: 3,
        background: bg,
        border: `1px solid ${border}`,
        boxShadow: `0 0 6px ${border}40`,
        verticalAlign: "middle",
        flexShrink: 0,
        cursor: "help",
      }}
    >
      {content}
    </span>
  );
}
