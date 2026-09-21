"use client";

import React from "react";
import { IconProfile } from "@/components/Icons";
import { resolvePreview, withAlpha } from "./types";

interface CosmeticAvatarProps {
  avatarUrl?: string | null;
  cmdrName?: string | null;
  /** id of the frame item (legacy) */
  frameId?: string | null;
  /** preview_data of the frame item (preferred: works for any admin-created frame) */
  framePreview?: Record<string, any> | null;
  size?: number;
  className?: string;
  showScanlines?: boolean;
}

/**
 * Avatar with an optional holographic frame. Frame look is fully driven by
 * `preview_data` ({ frameStyle, color, accentColor, glowColor, borderWidth }).
 */
export default function CosmeticAvatar({
  avatarUrl,
  cmdrName,
  frameId,
  framePreview,
  size = 64,
  className = "",
  showScanlines = false,
}: CosmeticAvatarProps) {
  const p = resolvePreview(frameId, framePreview);
  const hasFrame = Boolean(p);
  const pad = hasFrame ? Math.max(4, Math.round(size * 0.08)) : 0;
  const innerSize = size - pad * 2;

  const color = p?.color || "#e67e22";
  const accent = p?.accentColor || color;
  const glow = p?.glowColor || withAlpha(color, 0.6);
  const bw = p?.borderWidth || 2;
  const style = p?.frameStyle || "ring";

  const renderFrame = () => {
    if (!p) return null;
    switch (style) {
      case "singularity":
        return (
          <>
            <div style={{ position: "absolute", inset: -3, borderRadius: "50%", background: `conic-gradient(from 0deg, ${color}, ${accent}, #ec4899, ${color})`, opacity: 0.85, animation: "cosmeticSpin 6s linear infinite", filter: "blur(1px)", zIndex: 1 }} />
            <div style={{ position: "absolute", inset: -1, borderRadius: "50%", boxShadow: `0 0 12px ${glow}, inset 0 0 8px ${withAlpha(accent, 0.5)}`, zIndex: 3, pointerEvents: "none" }} />
          </>
        );
      case "vanguard":
        return (
          <>
            <div style={{ position: "absolute", inset: -4, border: `${bw}px solid ${color}`, boxShadow: `0 0 10px ${glow}`, clipPath: "polygon(0% 25%, 25% 0%, 75% 0%, 100% 25%, 100% 75%, 75% 100%, 25% 100%, 0% 75%)", zIndex: 2, pointerEvents: "none" }} />
            {[{ top: -2, left: -2 }, { top: -2, right: -2 }, { bottom: -2, left: -2 }, { bottom: -2, right: -2 }].map((pos, i) => (
              <span key={i} style={{ position: "absolute", ...pos, width: 4, height: 4, background: accent, zIndex: 4 }} />
            ))}
          </>
        );
      case "subzero":
        return <div style={{ position: "absolute", inset: -3, border: `${bw}px solid ${color}`, borderRadius: "14%", boxShadow: `0 0 12px ${glow}, inset 0 0 6px ${withAlpha(accent, 0.4)}`, animation: "cosmeticPulse 3s ease-in-out infinite alternate", zIndex: 2, pointerEvents: "none" }} />;
      case "solar":
        return <div style={{ position: "absolute", inset: -3, borderRadius: "50%", background: `radial-gradient(circle, ${withAlpha(color, 0.8)} 0%, ${withAlpha(accent, 0.2)} 70%, transparent 100%)`, boxShadow: `0 0 16px ${glow}, 0 0 6px ${withAlpha(accent, 0.6)}`, border: `${bw}px solid ${color}`, zIndex: 2, pointerEvents: "none" }} />;
      case "stealth":
        return (
          <>
            <div style={{ position: "absolute", inset: -2, border: `${bw}px solid ${color}`, borderRadius: 4, boxShadow: `0 0 8px ${glow}`, zIndex: 2, pointerEvents: "none" }} />
            <div style={{ position: "absolute", top: -4, left: "50%", width: 2, height: 4, background: color, zIndex: 4, transform: "translateX(-50%)" }} />
            <div style={{ position: "absolute", bottom: -4, left: "50%", width: 2, height: 4, background: color, zIndex: 4, transform: "translateX(-50%)" }} />
            <div style={{ position: "absolute", left: -4, top: "50%", width: 4, height: 2, background: color, zIndex: 4, transform: "translateY(-50%)" }} />
            <div style={{ position: "absolute", right: -4, top: "50%", width: 4, height: 2, background: color, zIndex: 4, transform: "translateY(-50%)" }} />
          </>
        );
      case "hex":
        return <div style={{ position: "absolute", inset: -4, background: `linear-gradient(135deg, ${color}, ${accent})`, clipPath: "polygon(50% 0%, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%)", boxShadow: `0 0 12px ${glow}`, zIndex: 1, pointerEvents: "none" }} />;
      case "square":
        return <div style={{ position: "absolute", inset: -3, border: `${bw}px solid ${color}`, borderRadius: 4, boxShadow: `0 0 10px ${glow}`, zIndex: 2, pointerEvents: "none" }} />;
      case "gradient":
        return <div style={{ position: "absolute", inset: -3, borderRadius: "50%", background: p.gradient || `linear-gradient(135deg, ${color}, ${accent})`, boxShadow: `0 0 12px ${glow}`, zIndex: 1, pointerEvents: "none" }} />;
      case "ring":
      default:
        return <div style={{ position: "absolute", inset: -3, borderRadius: "50%", border: `${bw}px solid ${color}`, boxShadow: `0 0 12px ${glow}, inset 0 0 6px ${withAlpha(accent, 0.35)}`, zIndex: 2, pointerEvents: "none" }} />;
    }
  };

  const squarish = ["vanguard", "stealth", "subzero", "square"].includes(style);
  const hexish = style === "hex";
  const radius = hexish ? "0" : squarish ? "4px" : "50%";
  const clip = hexish ? "polygon(50% 0%, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%)" : undefined;

  return (
    <div className={`cosmetic-avatar-wrapper ${className}`} style={{ position: "relative", width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <style>{`
        @keyframes cosmeticSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes cosmeticPulse { 0% { opacity: .75; filter: brightness(.9);} 100% { opacity: 1; filter: brightness(1.15);} }
      `}</style>
      {renderFrame()}
      <div style={{ position: "relative", width: innerSize, height: innerSize, borderRadius: radius, clipPath: clip, overflow: "hidden", background: "#25282b", border: hasFrame ? "none" : "1px solid var(--line, #3a3d40)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2 }}>
        {avatarUrl ? (
          <img src={avatarUrl} alt={cmdrName || "CMDR"} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#323538" }}>
            <IconProfile size={Math.round(innerSize * 0.55)} color="#9ca3af" />
          </div>
        )}
        {showScanlines && <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(0deg, rgba(0,0,0,0.15) 0px, rgba(0,0,0,0.15) 1px, transparent 1px, transparent 2px)", pointerEvents: "none" }} />}
      </div>
    </div>
  );
}
