"use client";

import React from "react";
import { resolvePreview, withAlpha } from "./types";

interface CosmeticCallsignProps {
  name: string;
  glowId?: string | null;
  glowPreview?: Record<string, any> | null;
  tag?: string | null;
  /** subscription badge label (e.g. ELITE) */
  tier?: string | null;
  tierColor?: string | null;
  className?: string;
  fontSize?: number;
  monospace?: boolean;
}

export default function CosmeticCallsign({ name, glowId, glowPreview, tag, tier, tierColor, className = "", fontSize = 16, monospace = true }: CosmeticCallsignProps) {
  const p = resolvePreview(glowId, glowPreview);

  const textStyle: React.CSSProperties = {
    fontFamily: monospace ? "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" : "inherit",
    fontWeight: 700,
    letterSpacing: monospace ? "1px" : undefined,
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    fontSize,
  };

  let nameStyle: React.CSSProperties = { color: "inherit", transition: "all 0.3s ease" };
  if (p) {
    const color = p.color || "#e67e22";
    if (p.gradient) {
      nameStyle = {
        background: p.gradient,
        backgroundSize: "200% auto",
        WebkitBackgroundClip: "text",
        WebkitTextFillColor: "transparent",
        filter: `drop-shadow(0 0 8px ${withAlpha(color, 0.6)})`,
        animation: "cosmeticHyperGlow 4s linear infinite",
      };
    } else {
      nameStyle = {
        color: p.textColor || "#f8fafc",
        textShadow: `0 0 8px ${color}, 0 0 16px ${withAlpha(color, 0.7)}, 0 0 26px ${withAlpha(color, 0.4)}`,
      };
    }
  }

  const tc = tierColor || (tier === "VIP ADMIRAL" ? "#9b59b6" : tier === "ELITE" ? "#e67e22" : "#3498db");

  return (
    <span className={`cmdr-callsign ${className}`} style={textStyle}>
      <style>{`@keyframes cosmeticHyperGlow { 0% { background-position: 0% center; } 100% { background-position: 200% center; } }`}</style>
      {tier && (
        <span style={{ fontSize: Math.max(9, Math.round(fontSize * 0.6)), padding: "1px 5px", borderRadius: 2, background: withAlpha(tc, 0.2), border: `1px solid ${tc}`, color: tc, fontWeight: 700, letterSpacing: 1, lineHeight: 1.4, whiteSpace: "nowrap" }}>
          {tier}
        </span>
      )}
      {tag && <span style={{ color: "var(--muted, #9ca3af)", fontSize: fontSize * 0.85 }}>[{tag}]</span>}
      <span style={nameStyle}>{name}</span>
    </span>
  );
}
