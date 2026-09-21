"use client";

import React from "react";
import Link from "next/link";
import CosmeticAvatar from "./CosmeticAvatar";
import CosmeticBadge from "./CosmeticBadge";
import CosmeticCallsign from "./CosmeticCallsign";
import CosmeticTitle from "./CosmeticTitle";
import { useCosmeticsFor } from "./useCosmetics";
import type { PilotCosmetics } from "./types";

interface PilotIdentityProps {
  userId?: string | null;
  cmdrName: string;
  avatarUrl?: string | null;
  /** pre-loaded cosmetics (skips the fetch) */
  cosmetics?: PilotCosmetics | null;
  size?: number;
  fontSize?: number;
  showTitle?: boolean;
  showTier?: boolean;
  showAvatar?: boolean;
  link?: boolean;
  tag?: string | null;
  subtitle?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  monospace?: boolean;
}

/**
 * Avatar + callsign + badge + title of a pilot with all purchased cosmetics
 * applied. Drop-in replacement for the plain `<img/><span>name</span>` blocks
 * used across the site (forum, comments, registry, leaderboard, chats).
 */
export default function PilotIdentity({
  userId,
  cmdrName,
  avatarUrl,
  cosmetics,
  size = 32,
  fontSize = 13,
  showTitle = false,
  showTier = true,
  showAvatar = true,
  link = true,
  tag,
  subtitle,
  className = "",
  style,
  monospace = false,
}: PilotIdentityProps) {
  const fetched = useCosmeticsFor(cosmetics ? null : userId);
  const c = cosmetics || fetched;
  const name = cmdrName || "Unknown";

  const callsign = (
    <CosmeticCallsign
      name={name}
      glowId={c?.glow?.id}
      glowPreview={c?.glow?.preview}
      tier={showTier ? c?.tier?.label || null : null}
      tierColor={c?.tier?.color || null}
      tag={tag}
      fontSize={fontSize}
      monospace={monospace}
    />
  );

  return (
    <span className={`pilot-identity ${className}`} style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, ...style }}>
      {showAvatar && <CosmeticAvatar avatarUrl={avatarUrl} cmdrName={name} frameId={c?.frame?.id} framePreview={c?.frame?.preview} size={size} />}
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {c?.badge && <CosmeticBadge badgeId={c.badge.id} badgePreview={c.badge.preview} title={c.badge.title} size={Math.max(16, Math.round(fontSize * 1.4))} />}
          {link && name !== "Unknown" ? (
            <Link href={`/cmdr/${encodeURIComponent(name)}`} style={{ textDecoration: "none", color: "inherit", minWidth: 0 }}>
              {callsign}
            </Link>
          ) : (
            callsign
          )}
        </span>
        {showTitle && c?.title && <CosmeticTitle titleId={c.title.id} titlePreview={c.title.preview} text={c.title.title} size={Math.max(9, Math.round(fontSize * 0.75))} />}
        {subtitle && <span style={{ fontSize: Math.max(10, fontSize - 2), color: "var(--muted, #9ca3af)" }}>{subtitle}</span>}
      </span>
    </span>
  );
}
