"use client";

import React from "react";
import { resolvePreview, withAlpha } from "./types";

interface CosmeticTitleProps {
  titleId?: string | null;
  titlePreview?: Record<string, any> | null;
  /** item title (fallback text when preview has no subTitle) */
  text?: string | null;
  className?: string;
  size?: number;
}

export default function CosmeticTitle({ titleId, titlePreview, text, className = "", size = 11 }: CosmeticTitleProps) {
  const p = resolvePreview(titleId, titlePreview);
  if (!p) return null;
  const label = p.subTitle || text;
  if (!label) return null;
  const color = p.color || "#e67e22";
  return (
    <div className={`cmdr-honorary-title ${className}`} style={{ display: "inline-flex", alignItems: "center", padding: "2px 8px", borderRadius: 2, background: withAlpha(color, 0.1), border: `1px solid ${withAlpha(color, 0.4)}`, color, fontSize: size, fontFamily: "ui-monospace, monospace", fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", whiteSpace: "nowrap" }}>
      «{label}»
    </div>
  );
}
